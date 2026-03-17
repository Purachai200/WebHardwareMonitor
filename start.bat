@echo off
title PC MONITOR HUB - CONTROL PANEL (GUI VERSION)
mode con: cols=80 lines=30
setlocal enabledelayedexpansion

:: บังคับให้อยู่ในโฟลเดอร์ปัจจุบัน
cd /d "%~dp0"

:menu
cls
color 0d
echo =========================================================
echo             PC MONITOR CONTROL PANEL v2.0 (GUI)
echo =========================================================
echo.
echo     [1] START MONITOR (Launch Windows App + Server)
echo     [2] INSTALL LIBRARIES (Required first-time)
echo     [3] OPEN LIBRE HARDWARE MONITOR (Launch LHM)
echo     [4] EXIT
echo.
echo =========================================================
set /p opt="  ENTER OPTION (1-4): "

if "%opt%"=="1" goto run
if "%opt%"=="2" goto install
if "%opt%"=="3" goto lhm
if "%opt%"=="4" exit
goto menu

:run
cls
echo Checking for Node.js...
node -v >nul 2>&1 || goto node_missing
echo Starting Electron GUI...
:: ใช้ npm start เพื่อรันตามที่ตั้งค่าไว้ใน package.json
call npm start
if %errorlevel% neq 0 (
    color 0c
    echo.
    echo [ERROR] Could not start Electron. 
    echo Did you run Option [2] yet?
)
pause
goto menu

:install
cls
echo Checking for NPM...
npm -v >nul 2>&1 || goto node_missing
echo ---------------------------------------------------------
echo Installing Dependencies (Including Electron)...
echo (This might take a minute, please wait...)
echo ---------------------------------------------------------
:: ติดตั้ง Library ทั้งหมดรวมถึง Electron สำหรับทำ GUI
call npm install
if %errorlevel% neq 0 (
    color 0c
    echo.
    echo [ERROR] Installation failed! 
    echo Please check your internet connection.
) else (
    color 0a
    echo.
    echo [SUCCESS] Setup finished successfully!
    echo Now you can press [1] to start the program.
)
pause
goto menu

:lhm
cls
if exist .env (
    for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
        set "%%A=%%B"
    )
)
if not defined LHM_PATH (
    color 0e
    echo ERROR: LHM_PATH is not defined in .env file!
    echo Please check your .env configuration.
    pause
    goto menu
)
start "" "%LHM_PATH%"
goto menu

:node_missing
cls
color 0c
echo ERROR: Node.js or NPM is NOT installed!
echo Please download from: https://nodejs.org/
pause
goto menu