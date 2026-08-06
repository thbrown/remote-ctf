#!/usr/bin/env bash
#
# Convenience wrapper for starting the Hub in production mode with a pinned
# PUBLIC_ORIGIN instead of relying on auto-detection (see apps/hub-server/src/config.ts).
# Matches the AP_IP used by ops/setup-pi-ap.sh (10.0.0.1 by default).
#
# Usage:
#   sudo ./ops/setup-pi-ap.sh          # once, to bring up the AP
#   ./ops/run-hub.sh                    # every time you start the game
#
# Override AP_IP/ADMIN_PIN via env vars, same as setup-pi-ap.sh:
#   AP_IP=10.0.0.1 ADMIN_PIN=1234 ./ops/run-hub.sh
#
set -euo pipefail

AP_IP="${AP_IP:-10.0.0.1}"

export NODE_ENV=production
export PUBLIC_ORIGIN="${PUBLIC_ORIGIN:-https://${AP_IP}}"
export ADMIN_PIN="${ADMIN_PIN:-1234}"

# Bind the same unprivileged ports as dev (8080/8443) instead of production's
# default :80/:443 - ops/setup-pi-ap.sh installs an iptables redirect from
# :80/:443 to these, so players still just navigate to https://<AP_IP> with
# no port in the URL, but the Hub process itself never needs root or any
# special capability to start.
export PORTAL_HTTP_PORT="${PORTAL_HTTP_PORT:-8080}"
export DEVICE_HTTPS_PORT="${DEVICE_HTTPS_PORT:-8443}"

if [[ "${ADMIN_PIN}" == "1234" ]]; then
  echo "[run-hub] WARNING: using default ADMIN_PIN=1234 - fine for testing, change it for a real game." >&2
fi

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
cd "${SCRIPT_DIR}/.."

# `pnpm start` runs the prebuilt apps/hub-server/dist/, which does NOT rebuild itself -
# after a `git pull` that's stale code silently, with no error. Always rebuild every
# workspace here (pnpm -r respects the dependency graph, so packages/shared - a real
# runtime dependency of hub-server's compiled dist/, not just a type-only one - always
# builds before anything that imports it) so this script never runs anything but what's
# actually checked out.
echo "[run-hub] Building all workspaces..."
pnpm -r build

echo "[run-hub] PUBLIC_ORIGIN=${PUBLIC_ORIGIN}"
exec pnpm --filter @foundry-ctf/hub-server start
