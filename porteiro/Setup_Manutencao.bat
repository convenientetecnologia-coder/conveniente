@echo off
setlocal
cls
echo ========================================================
echo   SETUP MANUTENCAO v5.2.0-nomem
echo   (nao altera C:\conveniente)
echo ========================================================
echo.
echo   Vigia + reboot 04:00 + net guard. MemClean=OFF (RAM no Conveniente).
echo.

net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [ADMIN] Solicitando administrador...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

set "KIT=%~dp0kit"
if not exist "%KIT%\manutencao.ps1" (
    echo [ERRO] kit\manutencao.ps1 nao encontrado
    pause
    exit /b 1
)

echo [+] Instalando...
powershell -NoProfile -ExecutionPolicy Bypass -File "%KIT%\install.ps1"
echo.
pause
endlocal
