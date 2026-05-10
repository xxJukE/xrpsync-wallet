#!/usr/bin/env bash
# Labs Wallet — install + launch script for macOS / Linux.
# Use this until the GitHub Actions build is producing signed installers.
#
# Requirements:
#   - Node.js 20.x (https://nodejs.org or via your package manager)
#   - git (only if you cloned the project)
#
# Usage:
#   ./install.sh              # install dependencies and launch
#   ./install.sh --build      # install + build a local AppImage / .dmg
#   ./install.sh --install    # install only
#
# Exit codes:
#   0   ok
#   1   missing prereq (Node, npm)
#   2   npm install failed
#   3   start/build failed

set -euo pipefail

MODE="${1:-run}"

# Locate the script's own directory so `cd` works regardless of where the user invoked it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

bold() { printf "\033[1m%s\033[0m\n" "$*"; }
ok()   { printf "\033[1;32m✓\033[0m %s\n" "$*"; }
warn() { printf "\033[1;33m!\033[0m %s\n" "$*" >&2; }
die()  { printf "\033[1;31m✗\033[0m %s\n" "$*" >&2; exit "${2:-1}"; }

bold "Labs Wallet · install helper"

# ── Prereq check ────────────────────────────────────────────────────────────
command -v node >/dev/null 2>&1 || die "Node.js is required. Install Node 20 from https://nodejs.org and retry." 1
command -v npm  >/dev/null 2>&1 || die "npm is required (it ships with Node.js)." 1

NODE_MAJOR="$(node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null || echo 0)"
if [ "$NODE_MAJOR" -lt 20 ]; then
    warn "Node $NODE_MAJOR detected; Labs Wallet needs Node 20+. The build may fail."
fi

ok "Node $(node -v) · npm $(npm -v)"

# ── Install ─────────────────────────────────────────────────────────────────
if [ ! -d node_modules ] || [ "$MODE" = "--install" ] || [ "$MODE" = "--build" ]; then
    bold "Installing dependencies (this can take a minute)…"
    if [ -f package-lock.json ]; then
        npm ci || npm install || die "npm install failed" 2
    else
        npm install || die "npm install failed" 2
    fi
    ok "dependencies installed"
fi

# ── Action ──────────────────────────────────────────────────────────────────
case "$MODE" in
    --install)
        ok "install only — done"
        exit 0
        ;;
    --build)
        bold "Building a local installer for your platform…"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            npm run build:mac || die "build:mac failed" 3
            ok "DMG built — see ./dist/"
        else
            npm run build:linux || die "build:linux failed" 3
            ok "AppImage built — see ./dist/"
        fi
        exit 0
        ;;
    *)
        bold "Launching Labs Wallet (dev mode)…"
        npm start || die "npm start failed" 3
        ;;
esac
