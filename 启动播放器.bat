@echo off
title Aurora 极光音乐播放器
cd /d "%~dp0"

echo.
echo   ==========================================
echo      AURORA  极光音乐播放器
echo   ==========================================
echo.

where node >nul 2>nul
if errorlevel 1 (
    echo   [错误] 没有检测到 Node.js
    echo.
    echo   请先安装 Node.js 建议 18 以上版本, 下载地址 https://nodejs.org
    echo   安装时勾选 "Add to PATH", 装完后重新双击本文件。
    echo.
    pause
    exit /b 1
)

if not exist "node_modules\three\build\three.module.js" (
    echo   首次运行, 正在安装依赖, 可能需要几分钟...
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   [错误] 依赖安装失败, 请检查网络后重试。
        echo   如果下载很慢, 可以先执行:
        echo     npm config set registry https://registry.npmmirror.com
        echo   再执行:
        echo     set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
        echo.
        pause
        exit /b 1
    )
    echo   依赖安装完成。
    echo.
)

if not exist "node_modules\electron\dist\electron.exe" (
    echo   正在下载桌面组件, 请稍候...
    set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
    pushd node_modules\electron
    node install.js
    popd
    if not exist "node_modules\electron\dist\electron.exe" (
        echo   [提示] 桌面组件下载失败, 改用浏览器模式启动。
        echo.
        goto browser
    )
)

echo   正在启动桌面窗口...
echo   关闭那个窗口即可退出播放器, 本窗口会随之关闭。
echo.

set "ELECTRON_RUN_AS_NODE="
if not exist "logs" mkdir "logs"
echo [%date% %time%] ---- launcher start ---- >> "logs\launcher.log"
"node_modules\electron\dist\electron.exe" . >> "logs\launcher.log" 2>&1
exit /b 0

:browser
chcp 65001 >nul
node server\index.js
echo.
echo   Player stopped.
pause
