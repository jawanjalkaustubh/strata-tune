#!/usr/bin/env bash
# =============================================================================
#  Strata Tune - macOS SHORTCUTS (the twin of Install-Shortcuts.ps1)
#
#  Builds a small launcher app bundle and puts it where a Mac keeps shortcuts:
#    ~/Applications/Strata Tune.app   (Launchpad, Spotlight, drag to the Dock)
#    ~/Desktop/Strata Tune            (alias of the same app)
#  The bundle carries the app icon and runs run-strata-tune.command from this checkout,
#  so pulling new code needs no reinstall. Run again any time; it overwrites.
#
#  Usage: scripts/mac/install-shortcuts.sh [--no-desktop] [--remove]
# =============================================================================
set -euo pipefail
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
NAME="Strata Tune"
LAUNCHER="$REPO/run-strata-tune.command"
ICON_PNG="$REPO/assets/strata-tune-st.png"
BUNDLE_ID="com.kaustubhjawanjal.stratatune"
APPS="$HOME/Applications"
APP="$APPS/$NAME.app"
DESKTOP="$HOME/Desktop/$NAME"
DO_DESKTOP=1
for a in "$@"; do
  case "$a" in
    --no-desktop) DO_DESKTOP=0 ;;
    --remove) rm -rf "$APP" "$DESKTOP"; echo "Removed $APP and $DESKTOP"; exit 0 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
[ "$(uname -s)" = "Darwin" ] || { echo "macOS only (Windows: Install-Shortcuts.ps1)" >&2; exit 1; }
[ -x "$LAUNCHER" ] || chmod +x "$LAUNCHER"

mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# Icon: .icns from the PNG with the system tools.
if [ -f "$ICON_PNG" ] && command -v sips >/dev/null && command -v iconutil >/dev/null; then
  ICONSET="$(mktemp -d)/icon.iconset"; mkdir -p "$ICONSET"
  for s in 16 32 128 256 512; do
    sips -z $s $s "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null 2>&1 || true
    d=$((s*2)); [ $d -le 1024 ] && sips -z $d $d "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null 2>&1 || true
  done
  iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns" 2>/dev/null || echo "icon conversion failed; the app gets the generic icon"
  rm -rf "$(dirname "$ICONSET")"
fi

# The executable. Once set up (dependencies, build present) it runs the launcher directly, with
# no Terminal window, and keeps the launcher's output in ~/Library/Logs/StrataTune/launch.log. On a first
# run, or when something is missing, it opens the launcher in Terminal instead so the install/build
# output is visible, like the Windows launcher's console. LSUIElement keeps this stub itself out of
# the Dock; the real Electron window appears with its own icon.
cat > "$APP/Contents/MacOS/launch" <<SH
#!/usr/bin/env bash
REPO="$REPO"
if [ -d "\$REPO/node_modules/electron/dist/Electron.app" ] && [ -f "\$REPO/dist-electron/main.js" ]; then
  LOGDIR="\$HOME/Library/Logs/StrataTune"; mkdir -p "\$LOGDIR"
  exec "$LAUNCHER" >>"\$LOGDIR/launch.log" 2>&1
fi
exec open -a Terminal "$LAUNCHER"
SH
chmod +x "$APP/Contents/MacOS/launch"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>$BUNDLE_ID.launcher</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
</dict>
</plist>
PLIST

# Refresh Finder's icon cache for the bundle and register it with Launch Services.
touch "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
echo "Installed $APP"

# An alias the user moved into ~/Desktop/Strata (or any folder there) counts as present: no duplicate on the Desktop.
if [ "$DO_DESKTOP" = 1 ] && [ -e "$HOME/Desktop/Strata/$NAME" ]; then
  echo "Desktop shortcut already in ~/Desktop/Strata; not recreating it on the Desktop."
  DO_DESKTOP=0
fi
if [ "$DO_DESKTOP" = 1 ]; then
  # A Finder alias (not a symlink) so it survives moves and shows the app icon.
  rm -rf "$DESKTOP"
  osascript >/dev/null <<AS || ln -sfn "$APP" "$DESKTOP"
tell application "Finder"
  make new alias file at (path to desktop folder) to (POSIX file "$APP")
  set name of result to "$NAME"
end tell
AS
  echo "Desktop shortcut: $DESKTOP"
fi
echo "Drag $NAME from ~/Applications to the Dock to pin it."
