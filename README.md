# DeepSeek Harness 桌面应用（Windows）

把 DeepSeek Harness Web GUI 封装成 Windows 桌面应用（Electron）。

## 交付位置

**`D:\Abin\abincheung\WEB\DeepSeek-Harness-Windows\`** 是整理好的顶层交付文件夹（不再藏在 dist 深处）：

| 文件 | 说明 |
|------|------|
| `DeepSeek-Harness-1.0.0-portable.exe`（~70MB） | **便携版**：双击即用，无需安装 |
| `DeepSeek Harness Setup 1.0.0.exe`（~70MB） | **安装版**：NSIS 安装器，可装到任意目录/建桌面快捷方式 |
| `DeepSeek-Harness-1.0.0-windows.zip`（~70MB） | **一键解压包**：下载后解压即得便携版 + 使用说明 |
| `一键安装.bat` / `一键安装.ps1` | 一键安装：自动复制到桌面 + 创建桌面/开始菜单快捷方式 |
| `使用说明.txt` | 简明使用文档 |

原始构建产物在 `dsh-desktop/dist/`。

## 使用

直接双击 exe 即可。应用启动时会：

1. 检查 `http://127.0.0.1:3080` 是否已有 DSH 服务器在运行
   - **有** → 直接连接（不重复启动服务器）
   - **没有** → 自动用 `dsh web` 启动服务器，等它就绪后打开
2. 打开 DeepSeek Harness GUI 窗口
3. 关闭窗口时：如果服务器是**本应用启动的**则随之停止；如果是**预先存在**的则保留不动

## 重新构建

```powershell
# 首次安装（国内镜像）
$env:npm_config_cache   = "$PWD\.npm-cache"
$env:ELECTRON_CACHE     = "$PWD\.electron-cache"
$env:ELECTRON_MIRROR    = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm install

# 打包（portable + nsis）
$env:ELECTRON_MIRROR    = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
npm run dist
```

## 配置

- 应用自动定位 `dsh`：优先用环境变量 `DSH_DESKTOP_DSH` 指定完整路径，其次 PATH，再其次 npm npx 缓存。
- 端口固定 3080（同 DSH Web 默认端口）。
- 服务器由应用启动时，继承当前用户环境并读取 `$DSH_HOME`（默认 `~/.dsh`）下的凭据。

## 项目结构

```
dsh-desktop/
├── main.js          # Electron 主进程：找 dsh、启动/连接服务器、开窗口、生命周期
├── preload.js       # 预加载脚本（无特权 API）
├── splash.html      # 启动加载页
├── build/icon.ico   # 应用图标
└── dist/            # 构建产物
```
