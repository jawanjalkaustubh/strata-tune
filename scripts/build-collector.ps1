# Strata Tune - shipping build of the collector and the worker.
#
# Publishes both as self-contained single-file win-x64 executables (the pins and the
# reasons are in docs/dependencies.md) into resources/collector/, which is gitignored and
# is the folder the packaged app carries as process.resourcesPath/collector. Native
# libraries the .NET host cannot embed (Mono.Posix's helper, pulled in by
# LibreHardwareMonitorLib) land beside the exe rather than being extracted to %TEMP% at
# every start: an elevated process must never load from a user-writable folder
# (collector/README.md, install-location rule).
#
# The dev loop stays `dotnet build collector\StrataTune.sln -c Release`; this script is the
# release path only. Runtime packs are fetched from nuget.org the first time.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\build-collector.ps1

param(
  [string]$RepoRoot = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'

$Dotnet = (Get-Command dotnet -ErrorAction SilentlyContinue).Source
if (-not $Dotnet -and (Test-Path 'C:\Program Files\dotnet\dotnet.exe')) {
  $Dotnet = 'C:\Program Files\dotnet\dotnet.exe'
}
if (-not $Dotnet) {
  throw "dotnet was not found; global.json pins the SDK, install it with: winget install Microsoft.DotNet.SDK.10"
}

$Out = Join-Path $RepoRoot 'resources\collector'
New-Item -ItemType Directory -Force $Out | Out-Null
# publish adds files but never removes them; a renamed or dropped file must not linger in the shipping folder
Get-ChildItem $Out | Remove-Item -Recurse -Force

$Projects = @(
  @{ Name = 'collector'; Path = 'collector\StrataTune.Collector\StrataTune.Collector.csproj'; Exe = 'strata-tune-collector.exe' },
  @{ Name = 'worker';    Path = 'collector\StrataTune.Worker\StrataTune.Worker.csproj';       Exe = 'strata-tune-worker.exe' }
)

Push-Location $RepoRoot
try {
  foreach ($p in $Projects) {
    Write-Host "`n==> publish $($p.Name)" -ForegroundColor Cyan
    & $Dotnet publish $p.Path -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o $Out --nologo
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed for $($p.Path) (exit $LASTEXITCODE)" }
  }
} finally {
  Pop-Location
}

Write-Host "`n==> published" -ForegroundColor Cyan
foreach ($p in $Projects) {
  $exe = Join-Path $Out $p.Exe
  if (-not (Test-Path $exe)) { throw "expected $exe after publish" }
  Write-Host ("  {0}  ({1:N1} MB)" -f $exe, ((Get-Item $exe).Length / 1MB))
}
