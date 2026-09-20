#!/usr/bin/env bash
# Builds the macOS worker (collector/mac: the Metal bench for AI Models and the audit's load
# kernels) with the Swift toolchain that comes with the Xcode command-line tools.
#   scripts/mac/build-collector.sh          -> collector/mac/.build/release/strata-tune-mac-worker
# The sensor source is macmon (brew install macmon); nothing to build for it.
set -euo pipefail
cd "$(dirname "$0")/../.."
if ! command -v swift >/dev/null 2>&1; then
  echo "swift not found. Install the command-line tools:  xcode-select --install" >&2
  exit 1
fi
swift build -c release --package-path collector/mac
ls -l collector/mac/.build/release/strata-tune-mac-worker
