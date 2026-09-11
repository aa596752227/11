@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "DOUBAO_CANVAS_DATA_DIR=%~dp0数据"
if not exist "%~dp0家兴豆包无限画布.exe" (
  echo 找不到 家兴豆包无限画布.exe
  pause
  exit /b 1
)
start "" "%~dp0家兴豆包无限画布.exe"
