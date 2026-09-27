#!/usr/bin/env bash
# Strata Tune - macOS launcher (shell only: the sensor collector is Windows-only, see docs/MACOS.md).
cd "$(dirname "$0")" || exit 1
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Node 24 first: Node 26 (Homebrew's plain `node`) breaks Electron's installer (see docs/MACOS.md).
[ -d /opt/homebrew/opt/node@24/bin ] && export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
command -v node >/dev/null 2>&1 || { echo "Node is not installed: brew install node@24 && brew link --overwrite node@24" >&2; read -r -p "Press Return to close." _; exit 1; }
# Opened from ~/Applications/Strata Tune.app (scripts/mac/install-shortcuts.sh) the output goes to a log
# with no terminal to show it, so a notification says what is taking the time or what went wrong.
LOG="$HOME/Library/Logs/StrataTune/launch.log"
notify() { [ -t 1 ] || osascript -e "display notification \"$1\" with title \"Strata Tune\"" >/dev/null 2>&1 || true; }
UPDATING=0
updating() { [ "$UPDATING" = 1 ] || notify "Updating after a code change (about a minute)"; UPDATING=1; }
# An instance of this checkout that is running keeps its files: vite empties dist/ under its live renderer,
# and this launch only focuses its window (the single-instance lock). Nothing is reinstalled or rebuilt then.
ELECTRON_BIN="$(pwd -P)/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
RUNNING=0
pgrep -f "$(printf '%s' "$ELECTRON_BIN" | sed 's/[][\.*^$()+?{}|]/\\&/g')" >/dev/null 2>&1 && RUNNING=1
[ "$RUNNING" = 1 ] && echo "[*] Strata Tune is already running from this checkout: focusing it (no reinstall or rebuild while it runs)"
[ -d node_modules/electron/dist ] || { echo "[*] First run: installing dependencies..."; npm ci --no-audit --no-fund || { read -r -p "npm ci failed. Press Return." _; exit 1; }; }
# A pull that changed the dependencies reinstalls them (npm ci stamps node_modules/.package-lock.json).
if [ "$RUNNING" = 0 ] && [ -f node_modules/.package-lock.json ] && [ -n "$(find package.json package-lock.json -newer node_modules/.package-lock.json 2>/dev/null | head -1)" ]; then
  echo "[*] The dependencies changed: reinstalling..."; updating
  npm ci --no-audit --no-fund || { notify "Reinstalling the dependencies failed; see $LOG"; read -r -p "npm ci failed. Press Return." _; exit 1; }
fi
# Build on the first run and whenever the sources are newer than the build (after a git pull). A failed
# rebuild starts the previous build rather than nothing; only with no build at all does it stop.
if [ "$RUNNING" = 0 ] && { [ ! -f dist-electron/main.js ] || [ -n "$(find electron src index.html package.json package-lock.json vite.config.ts -newer dist-electron/main.js 2>/dev/null | head -1)" ]; }; then
  echo "[*] Building..."; updating
  if ! npm run build; then
    if [ -f dist-electron/main.js ] && [ -f dist/index.html ]; then
      echo "[!] npm run build failed; starting the previous build"; notify "The update did not build; starting the previous version. See $LOG"
    else
      notify "The build failed; see $LOG"; read -r -p "npm run build failed. Press Return." _; exit 1
    fi
  fi
fi
# The Swift worker (Metal bench, audit loads) and macmon (sensors): built and installed by scripts/mac/setup.sh; a missing worker is built here.
W=collector/mac/.build/release/strata-tune-mac-worker
if [ "$RUNNING" = 0 ] && { [ ! -x "$W" ] || [ -n "$(find collector/mac/Sources collector/mac/Package.swift -newer "$W" 2>/dev/null | head -1)" ]; }; then
  echo "[*] Building the macOS worker..."; updating
  scripts/mac/build-collector.sh || { echo "[!] worker build failed; AI Models Measure and the audit loads are unavailable until it builds"; notify "The macOS worker did not build: Measure and the audit loads are unavailable. See $LOG"; }
fi
command -v macmon >/dev/null 2>&1 || echo "[!] macmon is not installed (brew install macmon): the Monitor shows only the battery and GPU memory"
# Name and icon. In development the app runs inside the stock Electron bundle, which macOS
# shows as "Electron" in the Dock, the menu bar and the app switcher. The bundle is only
# ad-hoc signed, so its Info.plist and icon can be replaced and the app re-signed ad hoc
# (what @electron/packager does at packaging time). Done once per Electron install.
brand_electron() {
  local app="node_modules/electron/dist/Electron.app" plist png="assets/strata-tune-st.png"
  plist="$app/Contents/Info.plist"
  [ -f "$plist" ] || return 0
  # One bundle id per app: LaunchServices caches the display name by identifier, and the three
  # Strata apps all shipped as com.github.Electron, so the Dock kept calling them "Electron".
  [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleDisplayName' "$plist" 2>/dev/null)" = "Strata Tune" ] && [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleIdentifier' "$plist" 2>/dev/null)" = "com.kaustubhjawanjal.stratatune" ] && return 0
  echo "[*] Naming the Electron bundle Strata Tune..."
  /usr/libexec/PlistBuddy -c 'Set :CFBundleName Strata Tune' -c 'Set :CFBundleDisplayName Strata Tune' -c 'Set :CFBundleIdentifier com.kaustubhjawanjal.stratatune' "$plist" || return 0
  if [ -f "$png" ] && command -v sips >/dev/null && command -v iconutil >/dev/null; then
    local set; set="$(mktemp -d)/icon.iconset"; mkdir -p "$set"
    for s in 16 32 128 256 512; do
      sips -z $s $s "$png" --out "$set/icon_${s}x${s}.png" >/dev/null 2>&1 || true
      d=$((s*2)); [ $d -le 1024 ] && sips -z $d $d "$png" --out "$set/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
    done
    iconutil -c icns "$set" -o "$app/Contents/Resources/electron.icns" 2>/dev/null || true
    rm -rf "$(dirname "$set")"
  fi
  codesign --force --sign - "$app" >/dev/null 2>&1 || echo "[!] could not re-sign the Electron bundle; the name may show as Electron"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$app" >/dev/null 2>&1 || true
}
# Not under a running instance: re-signing rewrites the executable it runs from.
[ "$RUNNING" = 1 ] || brand_electron

exec npm start
