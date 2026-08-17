@echo off
chcp 65001 >nul
title DeepSeek Harness 一键安装
echo ============================================
echo   DeepSeek Harness 一键安装
echo ============================================
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0一键安装.ps1"
