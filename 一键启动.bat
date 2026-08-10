@echo off
chcp 65001 >nul
title A股红利研究终端 - 启动器
cd /d %~dp0

set PORT=8000
set URL=http://localhost:%PORT%/web/

echo ============================================
echo    A股红利研究终端 一键启动
echo ============================================
echo.

rem ── 端口检测：已有服务直接开浏览器（避免重复启动 WinError 10048）──
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 (
    echo [提示] 端口 %PORT% 已有服务在运行，直接打开浏览器...
    echo.
    start "" "%URL%"
    goto :end
)

echo [启动] 正在启动本地服务（端口 %PORT%，新窗口运行）...
echo        关闭服务窗口即停止服务；保持本窗口可看状态。
echo.
start "A股红利服务" cmd /k "cd /d %~dp0 && python serve.py"

rem ── 等待服务就绪（最多 15 秒）──
set /a tries=0
:wait
set /a tries+=1
netstat -ano | findstr ":%PORT% " | findstr "LISTENING" >nul 2>&1
if not errorlevel 1 goto :ok
if %tries% geq 15 goto :timeout
ping -n 2 127.0.0.1 >nul
goto :wait

:ok
echo.
echo [成功] 服务已就绪，正在打开浏览器...
start "" "%URL%"
goto :end

:timeout
echo.
echo [警告] 服务启动超时（15秒）。请检查：
echo        1. 服务窗口是否有报错（python 是否在 PATH）
echo        2. 防火墙是否拦截 8000 端口
echo        3. 手动运行：python serve.py

:end
echo.
pause
