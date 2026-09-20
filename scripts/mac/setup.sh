#!/usr/bin/env bash
# =============================================================================
#  STRATA TUNE - macOS (Apple Silicon) SETUP
#    1. Homebrew, node@24, macmon (the sudo-less sensor source), Ollama
#    2. npm ci + npm run build
#    3. the Swift worker (collector/mac) for the Metal bench and the audit loads
#    4. Strata Tune.app in ~/Applications + a Desktop alias
#  Re-running is safe. Usage: scripts/mac/setup.sh [--yes] [--no-build] [--no-shortcuts]
# =============================================================================
set -euo pipefail
YES=0; NO_BUILD=0; NO_SHORTCUTS=0
for a in "$@"; do
  case "$a" in
    --yes|-y) YES=1 ;;
    --no-build) NO_BUILD=1 ;;
    --no-shortcuts) NO_SHORTCUTS=1 ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done
REPO="$(cd "$(dirname "$0")/../.." && pwd)"
LOG="$REPO/setup-mac.log"
log()  { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*" | tee -a "$LOG"; }
step() { echo; log "=== $* ==="; }
fail() { log "ERROR: $*"; echo "Setup did not complete. See $LOG." >&2; exit 1; }
run_live() { local rc=0; "$@" || rc=$?; log "$(printf '%q ' "$@")-> exit $rc"; return $rc; }
confirm() { [ "$YES" = 1 ] && return 0; read -r -p "$1 [y/N] " a; [[ "$a" =~ ^[Yy] ]]; }

step "1/4 Homebrew, Node 24, macmon, Ollama"
[ "$(uname -s)" = "Darwin" ] || fail "This script is for macOS."
command -v brew >/dev/null 2>&1 || { [ -x /opt/homebrew/bin/brew ] && eval "$(/opt/homebrew/bin/brew shellenv)"; } || true
if ! command -v brew >/dev/null 2>&1; then
  confirm "Homebrew is not installed. Install it now (official installer, asks for your password)?" || fail "Homebrew is required: https://brew.sh"
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  eval "$(/opt/homebrew/bin/brew shellenv)"
fi
for pkg in node@24 macmon ollama; do
  if brew list --versions "$pkg" >/dev/null 2>&1; then log "$pkg already installed ($(brew list --versions "$pkg"))"
  else log "brew install $pkg"; run_live brew install "$pkg"; fi
done
# Node 24 (LTS), not Homebrew's plain `node` (26 today): Electron's unpacker (extract-zip) exits silently
# after the first zip entry on 26. node@24 is keg-only, so it goes first on PATH here and gets linked.
NODE24="$(brew --prefix node@24)/bin"
[ -x "$NODE24/node" ] || fail "node@24 not found at $NODE24"
export PATH="$NODE24:$PATH"
if [ "$("$(brew --prefix)/bin/node" --version 2>/dev/null | cut -d. -f1)" != "v24" ]; then
  brew list --versions node >/dev/null 2>&1 && brew unlink node >/dev/null 2>&1 || true
  brew link --overwrite node@24 >/dev/null 2>&1 || log "WARNING: could not link node@24; scripts use $NODE24 directly"
fi
command -v swift >/dev/null 2>&1 || fail "swift not found: run  xcode-select --install  (the command-line tools), then re-run."
log "node $(node --version), macmon $(macmon --version 2>/dev/null | head -1), $(swift --version 2>&1 | head -1)"

step "2/4 App dependencies + build"
if [ "$NO_BUILD" = 1 ]; then log "Skipped."
else
  cd "$REPO"
  log "npm ci"; run_live npm ci --no-audit --no-fund
  log "npm run build"; run_live npm run build
fi

step "3/4 macOS worker (Metal bench + audit loads)"
run_live "$REPO/scripts/mac/build-collector.sh"

step "4/4 Shortcuts (~/Applications + Desktop)"
if [ "$NO_SHORTCUTS" = 1 ]; then log "Skipped."; else "$REPO/scripts/mac/install-shortcuts.sh" 2>&1 | tee -a "$LOG"; fi

echo
log "Done. Launch Strata Tune from Launchpad / the Desktop shortcut, or:  open \"$REPO/run-strata-tune.command\""
