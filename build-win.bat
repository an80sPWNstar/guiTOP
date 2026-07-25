@echo off
cd /d "%~dp0"

:: Remove WSL node-gyp symlinks that break Windows electron-builder
if exist node_modules\ (
  for /f "delims=" %%d in ('dir /s /b node_modules\ ^| findstr /i "node_gyp_bins" 2^>nul') do (
    if exist "%%d" rmdir /s /q "%%d" 2>nul
  )
)

npm run build
if %ERRORLEVEL% NEQ 0 (
  echo.
  echo Build failed ^(exit code %ERRORLEVEL%^)
  pause
)
