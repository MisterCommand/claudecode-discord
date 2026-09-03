@echo off
setlocal
chcp 65001 >nul 2>&1

set "SCRIPT_DIR=%~dp0"
cd /d "%SCRIPT_DIR%"

echo ===================================
echo  Claude Code Discord Bot Setup
echo ===================================
echo.

echo [1/5] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 (
    echo   Node.js 20+ is required. Install it from https://nodejs.org and run this script again.
    exit /b 1
)

for /f "tokens=1 delims=." %%a in ('node -p "process.versions.node"') do set "NODE_MAJOR=%%a"
if %NODE_MAJOR% LSS 20 (
    echo   Node.js 20+ is required.
    exit /b 1
)
for /f "tokens=*" %%v in ('node -v') do echo   Found Node.js %%v
echo.

echo [2/5] Checking Claude Code...
set "PATH=%PATH%;%APPDATA%\npm"
where claude >nul 2>&1
if errorlevel 1 (
    echo   Claude Code not found. Installing it with npm...
    call npm install -g @anthropic-ai/claude-code
)
where claude >nul 2>&1
if errorlevel 1 (
    echo   Claude Code installation did not add claude to PATH.
    exit /b 1
)
echo   Found Claude Code
echo   Run claude once before starting the bot if you have not authenticated yet.
echo.

echo [3/5] Installing project dependencies...
call npm install
if errorlevel 1 exit /b 1
echo.

echo [4/5] Checking environment file...
if not exist .env (
    copy /Y .env.example .env >nul
    echo   Created .env from .env.example. Edit it with your Discord and workspace settings.
) else (
    echo   .env already exists
)
echo.

echo [5/5] Building the bot...
call npm run build
if errorlevel 1 exit /b 1
echo.

echo Setup complete.
echo   1. Confirm .env is configured.
echo   2. Authenticate Claude Code with: claude
echo   3. Start the bot in the foreground with: npm start
exit /b 0
