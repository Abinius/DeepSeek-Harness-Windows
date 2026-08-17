# DeepSeek Harness 一键安装脚本
# 用法: powershell -ExecutionPolicy Bypass -File "一键安装.ps1"
# 作用: 复制便携版 exe 到桌面，创建桌面 + 开始菜单快捷方式

$ErrorActionPreference = 'Stop'

$AppName   = 'DeepSeek-Harness-1.0.0-portable.exe'
$Shortcut  = 'DeepSeek Harness'
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source    = Join-Path $ScriptDir $AppName

if (-not (Test-Path $Source)) {
    Write-Host "[错误] 找不到 $AppName`n请把本脚本和 exe 放在同一个文件夹里。" -ForegroundColor Red
    Read-Host '按回车退出'
    exit 1
}

# 定位桌面（支持 OneDrive 重定向）
$Desktop = [Environment]::GetFolderPath('Desktop')
if (-not (Test-Path $Desktop)) {
    $Desktop = Join-Path $env:USERPROFILE 'Desktop'
}
if (-not (Test-Path $Desktop)) {
    $Desktop = Join-Path $env:USERPROFILE 'OneDrive\Desktop'
}
New-Item -ItemType Directory -Force -Path $Desktop | Out-Null

Write-Host '[1/3] 复制到桌面 ...' -NoNewline
Copy-Item $Source (Join-Path $Desktop $AppName) -Force
Write-Host ' 完成' -ForegroundColor Green

$Wsh = New-Object -ComObject WScript.Shell

Write-Host '[2/3] 创建桌面快捷方式 ...' -NoNewline
$lnk1 = $Wsh.CreateShortcut((Join-Path $Desktop "$Shortcut.lnk"))
$lnk1.TargetPath       = Join-Path $Desktop $AppName
$lnk1.WorkingDirectory = $Desktop
$lnk1.Description      = 'DeepSeek Harness - Windows 桌面应用'
$lnk1.IconLocation     = Join-Path $Desktop $AppName
$lnk1.Save()
Write-Host ' 完成' -ForegroundColor Green

Write-Host '[3/3] 创建开始菜单快捷方式 ...' -NoNewline
$StartMenu = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'
if (Test-Path $StartMenu) {
    $lnk2 = $Wsh.CreateShortcut((Join-Path $StartMenu "$Shortcut.lnk"))
    $lnk2.TargetPath       = Join-Path $Desktop $AppName
    $lnk2.WorkingDirectory = $Desktop
    $lnk2.IconLocation     = Join-Path $Desktop $AppName
    $lnk2.Save()
}
Write-Host ' 完成' -ForegroundColor Green

Write-Host ''
Write-Host '============================================' -ForegroundColor Cyan
Write-Host '  安装完成！桌面已生成 "DeepSeek Harness" 快捷方式' -ForegroundColor Green
Write-Host '============================================' -ForegroundColor Cyan
Write-Host ''
Read-Host '按回车退出'
