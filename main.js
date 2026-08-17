// DeepSeek Harness — Windows desktop shell.
//
// Behavior:
//   * If a DSH web server is already listening on the target URL, connect to it.
//   * Otherwise locate the `dsh` CLI and start `dsh web` as a child process,
//     wait until the URL answers, then load it in the window.
//   * The server started by us is stopped when the last window closes; a
//     pre-existing server is left untouched.

const { app, BrowserWindow, dialog, shell } = require('electron');
const { spawn } = require('node:child_process');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// ---- configuration ------------------------------------------------------

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3080;
const URL = () => `http://${DEFAULT_HOST}:${DEFAULT_PORT}`;

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
      },
    });

    serverChild.stdout?.on('data', () => { /* keep pipe drained */ });
    serverChild.stderr?.on('data', () => { /* keep pipe drained */ });
    serverChild.on('exit', (code) => {
      if (!serverStartedByUs) return;
      serverStartedByUs = false;
      serverChild = null;
      resolve(false);
    });

    // Give the server time to bind, then poll.
    serverStartedByUs = true;
    setTimeout(async () => {
      const ok = await waitForServer(URL(), 90000);
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

  mainWindow.on('closed', () => { mainWindow = null; });
  return mainWindow;
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
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('ai.deepseek.harness.desktop');
    createSplash();

    let ok = await probe(URL());
    serverStartedByUs = false;
    if (!ok) {
      serverStartedByUs = await startServer();
      ok = serverStartedByUs;
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
    stopServer();
  });
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });
}
