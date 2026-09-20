#!/usr/bin/env bash
# Strata Tune - macOS launcher (shell only: the sensor collector is Windows-only, see docs/MACOS.md).
cd "$(dirname "$0")" || exit 1
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
# Node 24 first: Node 26 (Homebrew's plain `node`) breaks Electron's installer (see docs/MACOS.md).
[ -d /opt/homebrew/opt/node@24/bin ] && export PATH="/opt/homebrew/opt/node@24/bin:$PATH"
command -v node >/dev/null 2>&1 || { echo "Node is not installed: brew install node@24 && brew link --overwrite node@24" >&2; read -r -p "Press Return to close." _; exit 1; }
[ -d node_modules/electron/dist ] || { echo "[*] First run: installing dependencies..."; npm ci --no-audit --no-fund || { read -r -p "npm ci failed. Press Return." _; exit 1; }; }
[ -f dist-electron/main.js ] || { echo "[*] First run: building..."; npm run build || { read -r -p "npm run build failed. Press Return." _; exit 1; }; }
# The Swift worker (Metal bench, audit loads) and macmon (sensors): built and installed by scripts/mac/setup.sh; a missing worker is built here.
[ -x collector/mac/.build/release/strata-tune-mac-worker ] || { echo "[*] Building the macOS worker..."; scripts/mac/build-collector.sh || echo "[!] worker build failed; AI Models Measure and the audit loads are unavailable until it builds"; }
command -v macmon >/dev/null 2>&1 || echo "[!] macmon is not installed (brew install macmon): the Monitor shows only the battery and GPU memory"
# Name and icon. In development the app runs inside the stock Electron bundle, which macOS
# shows as "Electron" in the Dock, the menu bar and the app switcher. The bundle is only
# ad-hoc signed, so its Info.plist and icon can be replaced and the app re-signed ad hoc
# (what @electron/packager does at packaging time). Done once per Electron install.
brand_electron() {
  local app="node_modules/electron/dist/Electron.app" plist png="assets/strata-tune-st.png"
  plist="$app/Contents/Info.plist"
  [ -f "$plist" ] || return 0
  [ "$(/usr/libexec/PlistBuddy -c 'Print CFBundleDisplayName' "$plist" 2>/dev/null)" = "Strata Tune" ] && return 0
  echo "[*] Naming the Electron bundle Strata Tune..."
  /usr/libexec/PlistBuddy -c 'Set :CFBundleName Strata Tune' -c 'Set :CFBundleDisplayName Strata Tune' "$plist" || return 0
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
}
brand_electron

exec npm start
