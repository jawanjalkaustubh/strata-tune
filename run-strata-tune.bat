@echo off
title Strata Tune
cd /d "%~dp0"

:: First run after a clone: install dependencies, then build. Each step is checked
:: because the .vbs launcher runs this window hidden and a silent failure looks like
:: the app just did not open. The steps themselves run in a NEW, visible console
:: (start /wait opens one even when this window is hidden): a first-run npm ci can
:: take minutes and has no timeout, so the user must be able to see it working
:: rather than wonder whether the app hung (lifecycle audit 2026-09-15, item 34).
:: start /wait hands the child's exit code back as errorlevel.
set "STRATA_STEP="
if not exist "node_modules\electron\dist\electron.exe" (
    set "STRATA_STEP=npm ci"
    start "Strata Tune - first run: installing dependencies" /wait cmd /c "npm ci --no-audit --no-fund"
    if errorlevel 1 goto :fail
)
if not exist "dist-electron\main.js" (
    set "STRATA_STEP=npm run build"
    start "Strata Tune - first run: building" /wait cmd /c "npm run build"
    if errorlevel 1 goto :fail
)

:: The collector (elevated, .NET) is started by the app itself from Phase 1 on.
start "" "node_modules\electron\dist\electron.exe" .
exit /b 0

:fail
:: msg.exe does not exist on Windows Home, so the message box comes from PowerShell
:: through the WScript.Shell COM object, which every edition has. 4096 (system
:: modal) keeps the box top-most: this console is hidden when the .vbs launched it,
:: so nothing else would bring the message forward; 16 is the error icon and 0
:: waits for the user. The folder and the failed step travel as environment
:: variables so a quote in the path cannot break the command.
set "STRATA_DIR=%~dp0"
powershell -NoProfile -Command "[void](New-Object -ComObject WScript.Shell).Popup(('Strata Tune could not start: ' + $env:STRATA_STEP + ' failed.' + [Environment]::NewLine + [Environment]::NewLine + 'Open a terminal in ' + $env:STRATA_DIR + ' and run:' + [Environment]::NewLine + '  npm ci' + [Environment]::NewLine + '  npm run build'), 0, 'Strata Tune', 4096 + 16)"
exit /b 1
