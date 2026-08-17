// DeepSeek Harness — Windows desktop shell.
//
// Behavior:
//   * If a DSH web server is already listening on the target URL, connect to it.
//   * Otherwise locate the `dsh` CLI and start `dsh web` as a child process,
//     wait until the URL answers, then load it in the window.
//   * The server started by us is stopped when the last window closes; a
//     pre-existing server is left untouched.
//   * Feishu channel: the server is started with FEISHU_APP_ID/SECRET injected
//     (persisted user env wins, built-in fallback otherwise), so the
//     harness-lark plugin connects automatically. A tray menu shows the
//     channel status and offers a one-click start/restart.

const { app, BrowserWindow, dialog, shell, Tray, Menu, nativeImage } = require('electron');
const { spawn, execFile } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// ---- configuration ------------------------------------------------------

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3080;
const URL = () => `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

// Feishu channel credentials are read from the environment only.
// Configure them as user-level env vars (e.g. `setx FEISHU_APP_ID ...` and
// `setx FEISHU_APP_SECRET ...`) — do not commit secrets to the repository.

// Candidates for locating the `dsh` CLI. `DSH_DESKTOP_DSH` wins if set.
function dshCandidates() {
  const list = [];
  if (process.env.DSH_DESKTOP_DSH) list.push(process.env.DSH_DESKTOP_DSH);

  // `dsh` on PATH
  const pathDirs = (process.env.PATH || '').split(path.delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    for (const name of ['dsh.cmd', 'dsh.bat', 'dsh']) {
      const full = path.join(dir, name);
      if (fs.existsSync(full)) list.push(full);
    }
  }

  // The npm npx cache where this harness was installed. `npm exec`/`npx`
  // materialize the CLI under ...\npm-cache\_npx\<hash>\node_modules\.bin\dsh.cmd
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) {
    const npxRoot = path.join(home, 'AppData', 'Local', 'npm-cache', '_npx');
    if (fs.existsSync(npxRoot)) {
      for (const hash of fs.readdirSync(npxRoot)) {
        const bin = path.join(npxRoot, hash, 'node_modules', '.bin', 'dsh.cmd');
        if (fs.existsSync(bin)) list.push(bin);
      }
    }
  }

  // Node's global prefix bin
  try {
    const { execFileSync } = require('node:child_process');
    const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim();
    if (prefix) {
      const full = path.join(prefix, 'dsh.cmd');
      if (fs.existsSync(full)) list.push(full);
    }
  } catch (_) { /* ignore */ }

  return [...new Set(list)];
}

function findDsh() {
  const found = dshCandidates().find((p) => fs.existsSync(p));
  return found || null;
}

// ---- server probing -----------------------------------------------------

function probe(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode >= 200 && res.statusCode < 500);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function waitForServer(url, timeoutMs = 120000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await probe(url)) return true;
    await new Promise((r) => setTimeout(r, 700));
  }
  return false;
}

// ---- Feishu channel status ----------------------------------------------
//
// The channel is "connected" when the process listening on :3080 holds an
// established TLS connection whose certificate covers *.feishu.cn. We find
// the listener PID and handshake the peer with SNI to read its cert.

let feishuStatus = 'unknown'; // unknown | starting | connected | disconnected

function listenerPid() {
  return new Promise((resolve) => {
    execFile('netstat', ['-ano'], (err, stdout) => {
      if (err) return resolve(null);
      const line = stdout.split(/\r?\n/).find(
        (l) => l.includes(`:${DEFAULT_PORT}`) && l.includes('LISTENING')
      );
      if (!line) return resolve(null);
      const m = line.trim().split(/\s+/).pop();
      resolve(/^\d+$/.test(m) ? Number(m) : null);
    });
  });
}

function checkFeishuConnection() {
  return new Promise((resolve) => {
    listenerPid().then((pid) => {
      if (!pid) { feishuStatus = 'disconnected'; return resolve(false); }
      // List established connections owned by the server PID, TLS-handshake
      // each external peer, and accept any cert matching *.feishu.cn / lark.
      execFile(
        'powershell.exe',
        ['-NoProfile', '-Command', `
          $conns = Get-NetTCPConnection -OwningProcess ${pid} -ErrorAction SilentlyContinue |
            Where-Object { $_.State -eq 'Established' -and $_.RemoteAddress -notlike '127.*' -and $_.RemoteAddress -ne '::1' }
          foreach ($c in $conns) {
            try {
              $tcp = New-Object System.Net.Sockets.TcpClient
              $tcp.Connect($c.RemoteAddress, $c.RemotePort)
              $ssl = New-Object System.Net.Security.SslStream($tcp.GetStream(), $false, ([System.Net.Security.RemoteCertificateValidationCallback]{ $true }))
              $ssl.AuthenticateAsClient('open.feishu.cn')
              $subj = $ssl.RemoteCertificate.Subject
              $ssl.Dispose(); $tcp.Close()
              if ($subj -match 'feishu|larksuite|larkoffice') { Write-Output 'FEISHU_CONNECTED'; break }
            } catch { }
          }
        `],
        { windowsHide: true, timeout: 15000 },
        (_err, stdout) => {
          feishuStatus = stdout.includes('FEISHU_CONNECTED') ? 'connected' : 'disconnected';
          resolve(feishuStatus === 'connected');
        }
      );
    });
  });
}

// ---- server child process -----------------------------------------------

let serverChild = null;
let serverStartedByUs = false;
let serverPort = DEFAULT_PORT;

function stopServer() {
  if (serverChild && !serverChild.killed) {
    serverStartedByUs = false;
    const pid = serverChild.pid;
    serverChild = null;
    try {
      // On Windows, kill the whole process tree (cmd wrapper -> node -> children).
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (_) { /* ignore */ }
  }
}

async function startServer() {
  const dsh = findDsh();
  if (!dsh) {
    dialog.showErrorBox(
      'DeepSeek Harness',
      '找不到 dsh 命令行工具。\n\n请在 PATH 中安装 @deepseek-ai/dsh，或设置环境变量 DSH_DESKTOP_DSH 指向 dsh 的完整路径。'
    );
    return false;
  }

  return new Promise((resolve) => {
    // `dsh web` is a `.cmd` shim on Windows: spawn via cmd to resolve it.
    const args = ['/d', '/s', '/c', `"${dsh}" web --host ${DEFAULT_HOST} --port ${serverPort}`];
    serverChild = spawn('cmd.exe', args, {
      windowsHide: true,
      env: {
        ...process.env,
        DSH_HOME: process.env.DSH_HOME || path.join(process.env.USERPROFILE || '', '.dsh'),
        // Feishu channel: pass through the user's credentials (no fallback —
        // secrets live in the environment, never in this file).
        FEISHU_APP_ID: process.env.FEISHU_APP_ID || '',
        FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET || '',
      },
    });

    serverChild.stdout?.on('data', () => { /* keep pipe drained */ });
    serverChild.stderr?.on('data', () => { /* keep pipe drained */ });
    serverChild.on('exit', (code) => {
      if (!serverStartedByUs) return;
      serverStartedByUs = false;
      serverChild = null;
      feishuStatus = 'disconnected';
      refreshTray();
      resolve(false);
    });

    // Give the server time to bind, then poll.
    serverStartedByUs = true;
    setTimeout(async () => {
      const ok = await waitForServer(URL(), 90000);
      if (ok) {
        feishuStatus = 'starting';
        refreshTray();
        // Give the lark gateway a few seconds to open its WebSocket, then probe.
        setTimeout(() => {
          checkFeishuConnection().then(() => refreshTray());
        }, 8000);
      }
      resolve(ok);
    }, 500);
  });
}

// ---- window -------------------------------------------------------------

let mainWindow = null;
let splashWindow = null;

function createSplash() {
  splashWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    show: false,
    webPreferences: { sandbox: true },
  });
  splashWindow.loadFile(path.join(__dirname, 'splash.html'));
  splashWindow.once('ready-to-show', () => splashWindow.show());
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: 'DeepSeek Harness',
    backgroundColor: '#0b0e14',
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.removeMenu();
  mainWindow.loadURL(URL());
  mainWindow.once('ready-to-show', () => {
    if (splashWindow) { splashWindow.close(); splashWindow = null; }
    mainWindow.show();
  });

  // Open external links in the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // Closing the window hides to tray instead of quitting, so the server and
  // the Feishu channel keep running. Use the tray "Exit" to fully quit.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
}

// ---- tray ---------------------------------------------------------------

let tray = null;

function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.ico');
  const icon = nativeImage.createFromPath(iconPath);
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('DeepSeek Harness');
  refreshTray();
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
  });
}

function refreshTray() {
  if (!tray) return;
  const labels = {
    unknown: '未知',
    starting: '启动中…',
    connected: '已连接',
    disconnected: '未连接',
  };
  const menu = Menu.buildFromTemplate([
    {
      label: `飞书通道：${labels[feishuStatus] || feishuStatus}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '一键启动飞书通道',
      click: async () => {
        tray.setToolTip('DeepSeek Harness — 正在启动飞书通道…');
        feishuStatus = 'starting';
        refreshTray();
        // Ensure the server is up first.
        let ok = await probe(URL());
        if (!ok) {
          ok = await startServer();
        } else if (!serverStartedByUs) {
          // Server pre-exists: probe its channel; if not connected, we cannot
          // force-restart a foreign server, so prompt the user.
          const connected = await checkFeishuConnection();
          if (connected) {
            dialog.showMessageBox({
              type: 'info',
              title: '飞书通道',
              message: '飞书通道已连接',
              detail: '当前 DeepSeek Harness 服务已建立到飞书的连接。',
            });
            refreshTray();
            return;
          }
          dialog.showMessageBox({
            type: 'warning',
            title: '飞书通道',
            message: '服务已存在但飞书通道未连接',
            detail:
              '当前 3080 服务不是本应用启动的，无法自动重启。\n\n' +
              '请关闭现有服务后，用本应用的「一键启动飞书通道」重新启动。',
          });
          refreshTray();
          return;
        }
        if (!ok) {
          dialog.showErrorBox('飞书通道', '无法启动 DeepSeek Harness 服务。');
          feishuStatus = 'disconnected';
          refreshTray();
          return;
        }
        // Server (re)started by us with Feishu env injected: wait then probe.
        feishuStatus = 'starting';
        refreshTray();
        setTimeout(async () => {
          const connected = await checkFeishuConnection();
          refreshTray();
          dialog.showMessageBox({
            type: connected ? 'info' : 'warning',
            title: '飞书通道',
            message: connected ? '飞书通道已连接 🎉' : '飞书通道未检测到连接',
            detail: connected
              ? '服务已建立到飞书的连接，去飞书私聊机器人试试吧。'
              : '未检测到到飞书( *.feishu.cn )的连接。请检查：\n' +
                '1. 飞书后台「事件订阅」是否使用长连接并订阅 im.message.receive_v1\n' +
                '2. 应用是否已发布版本',
          });
        }, 10000);
      },
    },
    { type: 'separator' },
    { label: '打开主窗口', click: () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } } },
    {
      label: '退出',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

// ---- app lifecycle ------------------------------------------------------

// Single instance: focus the existing window on second launch.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('ai.deepseek.harness.desktop');
    createTray();
    createSplash();

    let ok = await probe(URL());
    serverStartedByUs = false;
    if (!ok) {
      serverStartedByUs = await startServer();
      ok = serverStartedByUs;
    } else {
      // Server pre-exists: probe its Feishu channel state in the background.
      setTimeout(() => { checkFeishuConnection().then(() => refreshTray()); }, 3000);
    }

    if (!ok) {
      dialog.showErrorBox(
        'DeepSeek Harness',
        '无法启动 DeepSeek Harness 服务（http://127.0.0.1:3080 无响应）。\n\n请确认已安装 dsh 并检查日志。'
      );
      if (splashWindow) splashWindow.close();
      app.quit();
      return;
    }

    createMainWindow();
  });

  // Shut down the server we started when the app fully quits.
  app.on('before-quit', () => {
    app.isQuitting = true;
    stopServer();
  });
  app.on('window-all-closed', () => {
    // Keep running in the tray (server + Feishu channel stay alive).
  });
}
