<#
 STRATA TUNE - Desktop and Start Menu shortcuts.
 Lives inside the strata-tune folder; TargetDir defaults to this folder.
#>
param(
    [string]$TargetDir = $PSScriptRoot
)

if (-not $TargetDir) { $TargetDir = "D:\AntiGravity\strata-tune" }

$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath("Desktop")
$StartMenuPath = [Environment]::GetFolderPath("Programs")

$VbsLauncher = Join-Path $TargetDir "run-strata-tune.vbs"
$IconPath = Join-Path $TargetDir "assets\strata-tune-st.ico"

function New-StrataShortcut($Path) {
    $s = $WshShell.CreateShortcut($Path)
    $s.TargetPath = "wscript.exe"
    $s.Arguments = "`"$VbsLauncher`""
    $s.WorkingDirectory = $TargetDir
    $s.Description = "Strata Tune - PC tuning and diagnostics"
    if (Test-Path $IconPath) { $s.IconLocation = "$IconPath,0" }
    $s.Save()
    Write-Host "Created $Path" -ForegroundColor Green
}

New-StrataShortcut (Join-Path $DesktopPath "Strata Tune.lnk")

$StartMenuDir = Join-Path $StartMenuPath "Strata Tune"
if (-not (Test-Path $StartMenuDir)) { New-Item -ItemType Directory -Path $StartMenuDir -Force | Out-Null }
New-StrataShortcut (Join-Path $StartMenuDir "Strata Tune.lnk")
