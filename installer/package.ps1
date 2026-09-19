<#
=============================================================================
 STRATA TUNE - RELEASE PACKAGER
 Produces release\Strata-Tune-Windows-x64.zip containing:
   Strata Tune.exe + Electron runtime         (@electron/packager, no node_modules)
   resources\collector\                       collector, worker and bench (published by scripts\build-collector.ps1)
   resources\presentmon\                      PresentMon 2.5.1 (vendored by scripts\setup-tools.ps1)
   resources\LICENSE, DISCLAIMER.md, THIRD-PARTY-NOTICES.md   (what About -> Legal renders)
   README.md, DISCLAIMER.md, LICENSE, THIRD-PARTY-NOTICES.md  at the zip root, VERSION.txt
 Usage (from the strata-tune folder):  powershell -ExecutionPolicy Bypass -File installer\package.ps1
   -SkipBuild     reuse dist/, dist-electron/ and dist-report/
   -NoZip         stop after assembling release\Strata-Tune-Windows-x64\
 The collector bundle is NOT rebuilt here: run scripts\build-collector.ps1 first (it needs the
 app closed, because the running collector is the published exe).
=============================================================================
#>
param(
    [switch]$SkipBuild,
    [switch]$NoZip
)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root
$Release = Join-Path $Root "release"
$PkgName = "Strata-Tune-Windows-x64"
$Stage   = Join-Path $Release $PkgName
$Zip     = Join-Path $Release "$PkgName.zip"
$version = (Get-Content (Join-Path $Root "package.json") | ConvertFrom-Json).version

function Step($m) { Write-Host ""; Write-Host "=== $m ===" -ForegroundColor Cyan }

Step "0. Preconditions"
$collectorSrc = Join-Path $Root "resources\collector"
foreach ($exe in @('strata-tune-collector.exe', 'strata-tune-worker.exe', 'strata-tune-bench.exe')) {
    if (-not (Test-Path (Join-Path $collectorSrc $exe))) { throw "$exe missing from resources\collector: run scripts\build-collector.ps1 first" }
}
$presentMonSrc = Join-Path $Root "tools\presentmon\PresentMon-2.5.1-x64.exe"
if (-not (Test-Path $presentMonSrc)) { throw "PresentMon missing: run scripts\setup-tools.ps1 first" }
foreach ($legal in @('LICENSE', 'DISCLAIMER.md', 'THIRD-PARTY-NOTICES.md')) {
    if (-not (Test-Path (Join-Path $Root $legal))) { throw "$legal missing at the repo root" }
}
Write-Host "app version: $version"

if (-not $SkipBuild) {
    Step "1. npm run build"
    & npm run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
}
foreach ($must in @('dist\index.html', 'dist-electron\main.js', 'dist-electron\preload.cjs', 'dist-report\report-template.html')) {
    if (-not (Test-Path (Join-Path $Root $must))) { throw "build output missing: $must" }
}

Step "2. Electron packager"
if (Test-Path $Stage) { Remove-Item -Recurse -Force $Stage }
New-Item -ItemType Directory -Path $Release -Force | Out-Null
$pkgOut = Join-Path $Release "pkg"
if (Test-Path $pkgOut) { Remove-Item -Recurse -Force $pkgOut }
# Ship only what the main process needs: package.json, dist/, dist-electron/, dist-report/,
# assets/ (the window icon is read from app.getAppPath()/assets) and support.json (read the
# same way). node_modules is excluded wholesale: main.js is fully bundled by Vite. The native
# exes and the legal files go under resources\ by hand in step 3, where the packaged app
# expects them (process.resourcesPath).
$ignore = @(
    '^/node_modules', '^/src', '^/electron', '^/collector', '^/tools', '^/tests', '^/docs', '^/scripts',
    '^/installer', '^/release', '^/resources', '^/public', '^/\.git', '^/\.claude', '^/\.vite',
    '^/index\.html$', '^/report\.html$', '^/[^/]+\.md$', '^/[^/]+\.ps1$', '^/[^/]+\.py$',
    '^/tsconfig[^/]*\.json$', '^/vite[^/]*\.config\.ts$', '^/vitest[^/]*\.config\.ts$', '^/tailwind\.config\.js$',
    '^/postcss\.config\.js$', '^/package-lock\.json$', '^/global\.json$', '^/\.gitignore$', '^/[^/]+\.log$', '^/LICENSE$'
)
$ignoreArgs = $ignore | ForEach-Object { "--ignore=$_" }
& npx @electron/packager . "Strata Tune" --platform=win32 --arch=x64 --out=$pkgOut --overwrite `
    --icon=assets/strata-tune-st.ico --app-version=$version --win32metadata.CompanyName="Kaustubh Jawanjal" `
    --win32metadata.ProductName="Strata Tune" --win32metadata.FileDescription="Strata Tune - PC tuning and diagnostics" `
    --prune=true --asar=false @ignoreArgs
if ($LASTEXITCODE -ne 0) { throw "electron packager failed" }
$packed = Get-ChildItem $pkgOut -Directory | Select-Object -First 1
if (-not $packed) { throw "packager produced no output" }
Move-Item $packed.FullName $Stage
Remove-Item -Recurse -Force $pkgOut
Write-Host "app packaged: $Stage"

Step "3. Collector, PresentMon, legal texts"
$col = Join-Path $Stage "resources\collector"
New-Item -ItemType Directory -Path $col -Force | Out-Null
# Exes and the native helper DLLs; never the .pdb symbol files.
Get-ChildItem $collectorSrc -File | Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object { Copy-Item $_.FullName (Join-Path $col $_.Name) -Force }
$pm = Join-Path $Stage "resources\presentmon"
New-Item -ItemType Directory -Path $pm -Force | Out-Null
Copy-Item $presentMonSrc (Join-Path $pm "PresentMon-2.5.1-x64.exe") -Force
foreach ($legal in @('LICENSE', 'DISCLAIMER.md', 'THIRD-PARTY-NOTICES.md')) {
    Copy-Item (Join-Path $Root $legal) (Join-Path $Stage "resources\$legal") -Force   # About -> Legal reads these
    Copy-Item (Join-Path $Root $legal) (Join-Path $Stage $legal) -Force               # and the zip root carries them (plan 27a)
}
Copy-Item (Join-Path $Root "installer\README.md") (Join-Path $Stage "README.md") -Force
# Electron's own licence texts: keep them, under clear names.
$lic = Join-Path $Stage "LICENSES"
New-Item -ItemType Directory -Path $lic -Force | Out-Null
Copy-Item (Join-Path $Stage "LICENSE") (Join-Path $lic "Electron-LICENSE.txt") -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $Stage "LICENSES.chromium.html") (Join-Path $lic "Chromium-LICENSES.html") -Force -ErrorAction SilentlyContinue
Remove-Item (Join-Path $Stage "LICENSES.chromium.html"), (Join-Path $Stage "version") -Force -ErrorAction SilentlyContinue
# The packager left Electron's LICENSE at the root; the app's own LICENSE (MIT) replaces it.
Copy-Item (Join-Path $Root "LICENSE") (Join-Path $Stage "LICENSE") -Force
Set-Content -Path (Join-Path $Stage "VERSION.txt") -Value "Strata Tune $version`nBuilt $(Get-Date -Format s)`nCommit $(git rev-parse --short HEAD 2>$null)" -Encoding UTF8

Step "4. Sanity"
foreach ($must in @("Strata Tune.exe", "resources\app\package.json", "resources\app\dist\index.html", "resources\app\dist-electron\main.js",
                    "resources\app\dist-electron\preload.cjs", "resources\app\dist-report\report-template.html", "resources\app\assets\strata-tune-st.ico",
                    "resources\app\support.json", "resources\collector\strata-tune-collector.exe", "resources\collector\strata-tune-worker.exe",
                    "resources\collector\strata-tune-bench.exe", "resources\presentmon\PresentMon-2.5.1-x64.exe",
                    "resources\LICENSE", "resources\DISCLAIMER.md", "resources\THIRD-PARTY-NOTICES.md",
                    "README.md", "DISCLAIMER.md", "LICENSE", "THIRD-PARTY-NOTICES.md", "VERSION.txt")) {
    if (-not (Test-Path (Join-Path $Stage $must))) { throw "missing from package: $must" }
}
if (Test-Path (Join-Path $Stage "resources\app\node_modules")) { throw "node_modules leaked into the package" }
if (Get-ChildItem (Join-Path $Stage "resources\collector") -Filter *.pdb) { throw "pdb files leaked into the package" }
$total = [math]::Round(((Get-ChildItem $Stage -Recurse -File | Measure-Object Length -Sum).Sum) / 1MB, 0)
Write-Host "package folder: $total MB, $((Get-ChildItem $Stage -Recurse -File).Count) files"

if ($NoZip) { Write-Host "Stopped before zip (-NoZip). Folder: $Stage"; exit 0 }

Step "5. Zip"
if (Test-Path $Zip) { Remove-Item $Zip -Force }
Push-Location $Release
try {
    # Windows' own bsdtar produces a standard zip that Explorer opens. Explicit path: Git for
    # Windows puts a GNU tar on PATH that reads "D:" as a remote host.
    $bsdtar = Join-Path $env:SystemRoot "System32\tar.exe"
    & $bsdtar -a -cf $Zip $PkgName
    if ($LASTEXITCODE -ne 0) { throw "tar failed" }
} finally { Pop-Location }
$zipMB = [math]::Round((Get-Item $Zip).Length / 1MB, 0)
$sha = (Get-FileHash $Zip -Algorithm SHA256).Hash
Set-Content -Path "$Zip.sha256" -Value "$sha  $PkgName.zip" -Encoding ASCII
Write-Host ""
Write-Host "RELEASE: $Zip" -ForegroundColor Green
Write-Host "size:    $zipMB MB $(if ($zipMB -gt 2000) { '(!! over the 2 GB GitHub release asset limit)' } else { '(under the 2 GB GitHub limit)' })" -ForegroundColor $(if ($zipMB -gt 2000) { 'Red' } else { 'Green' })
Write-Host "sha256:  $sha"
