# Strata Tune - Phase 0 toolchain setup.
#
# Fetches the pinned PresentMon build into tools/presentmon/ and verifies it
# byte-for-byte against docs/dependencies.md. The exe is gitignored; this script
# is how a fresh clone gets it. Idempotent: a verified copy is left alone, a bad
# one is deleted and fetched again.
#
# Then reports three things it cannot fix on its own, because each needs either
# an installer or an elevated one-off: whether the current user can open an ETW
# trace session without elevation (Performance Log Users), whether PawnIO is
# installed, and whether the pinned .NET SDK is present. Nothing here installs
# anything but PresentMon.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\setup-tools.ps1

param(
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'

# Pins from docs/dependencies.md. 2.5.0 was withdrawn upstream, and the 157 MB MSI
# is the service + GUI, not the standalone console exe the collector spawns.
$PresentMon = @{
  Version = '2.5.1'
  Url     = 'https://github.com/GameTechDev/PresentMon/releases/download/v2.5.1/PresentMon-2.5.1-x64.exe'
  Size    = 956768
  Sha256  = '9BEC3083069F58F911E6A512F4806DB51A27BD096103087BC1D05EF54C80A191'
}
$PresentMonDir = Join-Path $RepoRoot 'tools\presentmon'
$PresentMonExe = Join-Path $PresentMonDir "PresentMon-$($PresentMon.Version)-x64.exe"

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }

# Size first because it is free; the hash only runs on a plausibly complete file.
function Test-Pinned($path, $size, $sha256) {
  if (-not (Test-Path $path)) { return $false }
  if ((Get-Item $path).Length -ne $size) { return $false }
  return ((Get-FileHash $path -Algorithm SHA256).Hash -eq $sha256)
}

function Get-Pinned($url, $path, $size, $sha256) {
  # Land in a sibling temp file so a bad download never sits at the real path.
  $partial = "$path.partial"
  if (Test-Path $partial) { Remove-Item $partial -Force }

  # GitHub rejects the TLS 1.0 default of .NET Framework's WebClient.
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ProgressPreference = 'SilentlyContinue'
  Invoke-WebRequest -Uri $url -OutFile $partial -UseBasicParsing

  $actualSize = (Get-Item $partial).Length
  $actualSha  = (Get-FileHash $partial -Algorithm SHA256).Hash
  if ($actualSize -ne $size -or $actualSha -ne $sha256) {
    Remove-Item $partial -Force
    throw ("Download of $url does not match the pin and was deleted.`n" +
           "  size   expected $size, got $actualSize`n" +
           "  sha256 expected $sha256`n" +
           "         got      $actualSha`n" +
           "Either the release asset changed or the download was tampered with. Do not bypass this.")
  }
  Move-Item $partial $path -Force
}

# ------------------------------------------------------------- PresentMon ---
Step "PresentMon $($PresentMon.Version) -> $PresentMonExe"
New-Item -ItemType Directory -Force $PresentMonDir | Out-Null

if (Test-Pinned $PresentMonExe $PresentMon.Size $PresentMon.Sha256) {
  Write-Host "already present, size and SHA-256 verified"
} else {
  if (Test-Path $PresentMonExe) {
    Write-Host "existing file does not match the pin; deleting and fetching again" -ForegroundColor Yellow
    Remove-Item $PresentMonExe -Force
  }
  Get-Pinned $PresentMon.Url $PresentMonExe $PresentMon.Size $PresentMon.Sha256
  Write-Host "downloaded, size and SHA-256 verified"
}
Write-Host "  $($PresentMon.Size) bytes, SHA-256 $($PresentMon.Sha256)"

# ---------------------------------------------------- ETW without elevation ---
# PresentMon exits 6 when StartTraceW fails. Membership of Performance Log Users
# (well-known SID S-1-5-32-559, checked by SID so the display language does not
# matter) is what lets a non-admin start the session. Group membership is baked
# into the logon token, so a new member must sign out and back in.
Step "ETW trace session without elevation"
$groups = & whoami /groups
if ($groups -match 'S-1-5-32-559') {
  Write-Host "$env:USERDOMAIN\$env:USERNAME is in Performance Log Users; PresentMon can run non-elevated"
} else {
  Write-Host "$env:USERDOMAIN\$env:USERNAME is NOT in Performance Log Users." -ForegroundColor Yellow
  Write-Host "PresentMon will exit 6 unless it runs elevated. To fix it once, run this in an" -ForegroundColor Yellow
  Write-Host "elevated prompt (this script will not do it for you), then sign out and back in:" -ForegroundColor Yellow
  Write-Host ""
  Write-Host "  net localgroup `"Performance Log Users`" `"$env:USERDOMAIN\$env:USERNAME`" /add"
}

# ------------------------------------------------------------------ PawnIO ---
# LibreHardwareMonitor 0.9.6 reads CPU and super-IO registers through PawnIO and
# returns zeros rather than errors when it cannot open \\?\GLOBALROOT\Device\PawnIO.
# The installer is signed, separate and not ours to redistribute, so this step
# reports and links. The collector opens the device itself and exits 4 when it
# cannot, which is the check that actually protects a reading.
Step "PawnIO (LibreHardwareMonitor needs it for CPU and board sensors)"
$PawnIoKey = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO'
$PawnIoVersion = (Get-ItemProperty -Path $PawnIoKey -Name DisplayVersion -ErrorAction SilentlyContinue).DisplayVersion
$PawnIoService = Get-Service -Name PawnIO -ErrorAction SilentlyContinue

if ($PawnIoVersion) {
  Write-Host "installed, version $PawnIoVersion"
} else {
  Write-Host "NOT installed. CPU package power, Tctl, VRM and fan RPM will be unavailable" -ForegroundColor Yellow
  Write-Host "and the collector will exit 4 rather than report zeros. Install the signed" -ForegroundColor Yellow
  Write-Host "driver from https://pawnio.eu (this script will not do it for you)." -ForegroundColor Yellow
}

if ($PawnIoService) {
  Write-Host "  service PawnIO is $($PawnIoService.Status), start type $($PawnIoService.StartType)"
} else {
  Write-Host "  no PawnIO service is registered" -ForegroundColor Yellow
}

# ---------------------------------------------------------------- .NET SDK ---
# global.json pins the SDK, and `dotnet --version` run from the repo root
# resolves through that pin, so the command failing there is the check.
Step ".NET SDK (global.json)"
$Pinned = (Get-Content (Join-Path $RepoRoot 'global.json') -Raw | ConvertFrom-Json).sdk.version
$Dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
if (-not $Dotnet -and (Test-Path 'C:\Program Files\dotnet\dotnet.exe')) {
  $Dotnet = 'C:\Program Files\dotnet\dotnet.exe'
  Write-Host "dotnet is not on PATH; using $Dotnet" -ForegroundColor Yellow
}

if (-not $Dotnet) {
  Write-Host "dotnet was not found. global.json pins $Pinned; install it with" -ForegroundColor Yellow
  Write-Host "  winget install Microsoft.DotNet.SDK.10"
} else {
  Push-Location $RepoRoot
  try { $Sdk = & $Dotnet --version } finally { Pop-Location }

  if ($LASTEXITCODE -ne 0 -or -not $Sdk) {
    Write-Host "no installed SDK satisfies global.json ($Pinned, rollForward latestPatch). Install it with" -ForegroundColor Yellow
    Write-Host "  winget install Microsoft.DotNet.SDK.10"
  } elseif ($Sdk -eq $Pinned) {
    Write-Host "$Sdk, exactly the pin"
  } else {
    Write-Host "$Sdk resolved for the pin $Pinned (rollForward latestPatch)"
  }
}

Step "Done"
