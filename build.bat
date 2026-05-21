@echo off
chcp 65001 >nul
title Red Studio 打包

echo [1/3] 检查 PyInstaller...
python -m PyInstaller --version >nul 2>&1
if errorlevel 1 (
    echo 正在安装 PyInstaller...
    pip install pyinstaller
)

echo [2/3] 清理旧构建...
if exist build rmdir /s /q build
if exist dist  rmdir /s /q dist

echo [3/3] 开始打包...
python -m PyInstaller RedStudio.spec

if errorlevel 1 (
    echo.
    echo 打包失败，请检查错误信息。
    pause
    exit /b 1
)

echo.
echo 打包完成！输出目录：dist\RedStudio\
echo 可执行文件：dist\RedStudio\RedStudio.exe
pause
