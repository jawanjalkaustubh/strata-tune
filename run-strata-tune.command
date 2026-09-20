#!/usr/bin/env bash
# Strata Tune - macOS launcher (shell only: the sensor collector is Windows-only, see docs/MACOS.md).
cd "$(dirname "$0")" || exit 1
if [ -x /opt/homebrew/bin/brew ]; then eval "$(/opt/homebrew/bin/brew shellenv)"; fi
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
command -v node >/dev/null 2>&1 || { echo "Node is not installed: brew install node" >&2; read -r -p "Press Return to close." _; exit 1; }
[ -d node_modules/electron/dist ] || { echo "[*] First run: installing dependencies..."; npm ci --no-audit --no-fund || { read -r -p "npm ci failed. Press Return." _; exit 1; }; }
[ -f dist-electron/main.js ] || { echo "[*] First run: building..."; npm run build || { read -r -p "npm run build failed. Press Return." _; exit 1; }; }
exec npm start
