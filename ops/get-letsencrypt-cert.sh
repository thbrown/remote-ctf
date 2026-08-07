#!/usr/bin/env bash
#
# Obtains (or renews) a real Let's Encrypt certificate for the Hub via ACME
# DNS-01, using Cloudflare as the DNS provider. See docs/01-HUB.md "Upgrade
# note" (HUB-021) - this automates that ~30-minute manual process.
#
# Run this on any machine with internet access - the Hub itself if it has
# connectivity at the time, or a laptop otherwise. DNS-01 only proves you
# control endlesswips.com's DNS (by creating a TXT record via the Cloudflare
# API); it never needs to reach the Hub, so it works even if the Hub is
# offline when you run this from elsewhere - just copy fullchain.pem and
# privkey.pem over afterwards.
#
# Prereqs:
#   - A DNS record for DOMAIN (A/AAAA, content doesn't matter - the game LAN's
#     dnsmasq resolves it locally for players, see ops/dnsmasq.conf.example).
#     A placeholder like 0.0.0.0 is fine.
#   - A Cloudflare API token scoped to Zone:DNS:Edit for endlesswips.com
#     (Cloudflare dashboard -> My Profile -> API Tokens -> Create Token ->
#     "Edit zone DNS" template, restricted to the endlesswips.com zone).
#   - certbot + the certbot-dns-cloudflare plugin (installed automatically
#     below via pip if missing).
#
# Usage:
#   CLOUDFLARE_API_TOKEN=xxxx ./ops/get-letsencrypt-cert.sh
#
# Override DOMAIN/OUT_DIR/EMAIL via env vars:
#   CLOUDFLARE_API_TOKEN=xxxx DOMAIN=ctf.endlesswips.com ./ops/get-letsencrypt-cert.sh
#
# Re-running (e.g. every ~80 days, before the 90-day expiry) renews in place -
# certbot no-ops if the existing cert still has >30 days of validity, unless
# you pass FORCE_RENEW=1.
#
set -euo pipefail

DOMAIN="${DOMAIN:-ctf.endlesswips.com}"
EMAIL="${EMAIL:-}"
OUT_DIR="${OUT_DIR:-./ops/certs}"
FORCE_RENEW="${FORCE_RENEW:-0}"

log() { echo "[get-letsencrypt-cert] $*"; }

if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "CLOUDFLARE_API_TOKEN is not set." >&2
  echo "  Create one at https://dash.cloudflare.com/profile/api-tokens" >&2
  echo "  (template: 'Edit zone DNS', restricted to the endlesswips.com zone), then:" >&2
  echo "    CLOUDFLARE_API_TOKEN=xxxx ./ops/get-letsencrypt-cert.sh" >&2
  exit 1
fi

if ! command -v certbot >/dev/null 2>&1 || ! certbot plugins 2>/dev/null | grep -q dns-cloudflare; then
  if command -v apt-get >/dev/null 2>&1; then
    # Debian/Raspberry Pi OS (Bookworm+) mark system pip "externally managed" (PEP 668)
    # and refuse a plain `pip install`, so prefer the apt packages here - they also
    # cover certbot's own dependencies without needing a venv.
    log "Installing certbot + certbot-dns-cloudflare via apt..."
    sudo apt-get update -qq
    sudo apt-get install -y certbot python3-certbot-dns-cloudflare
  else
    log "certbot not found - installing via pip..."
    python3 -m pip install --user --quiet --break-system-packages certbot certbot-dns-cloudflare \
      || python3 -m pip install --user --quiet certbot certbot-dns-cloudflare
    export PATH="${HOME}/.local/bin:${PATH}"
  fi
fi

CRED_DIR="$(mktemp -d)"
trap 'rm -rf "${CRED_DIR}"' EXIT
CRED_FILE="${CRED_DIR}/cloudflare.ini"
umask 077
printf 'dns_cloudflare_api_token = %s\n' "${CLOUDFLARE_API_TOKEN}" >"${CRED_FILE}"
chmod 600 "${CRED_FILE}"

CERTBOT_ARGS=(
  certonly
  --non-interactive
  --agree-tos
  --dns-cloudflare
  --dns-cloudflare-credentials "${CRED_FILE}"
  --dns-cloudflare-propagation-seconds 30
  -d "${DOMAIN}"
  --config-dir "${OUT_DIR}/config"
  --work-dir "${OUT_DIR}/work"
  --logs-dir "${OUT_DIR}/logs"
)

if [[ -n "${EMAIL}" ]]; then
  CERTBOT_ARGS+=(--email "${EMAIL}")
else
  CERTBOT_ARGS+=(--register-unsafely-without-email)
fi

if [[ "${FORCE_RENEW}" == "1" ]]; then
  CERTBOT_ARGS+=(--force-renewal)
fi

log "Requesting certificate for ${DOMAIN} via Cloudflare DNS-01..."
certbot "${CERTBOT_ARGS[@]}"

LIVE_DIR="${OUT_DIR}/config/live/${DOMAIN}"
if [[ ! -f "${LIVE_DIR}/fullchain.pem" ]]; then
  echo "certbot reported success but ${LIVE_DIR}/fullchain.pem is missing - something's off." >&2
  exit 1
fi

log "Certificate ready at ${LIVE_DIR}/fullchain.pem and ${LIVE_DIR}/privkey.pem"
log ""
log "Copy those two files to the Hub (USB stick, scp during a moment of connectivity,"
log "whatever's convenient for the offline box), then set on the Hub:"
log ""
log "  TLS_MODE=provided"
log "  TLS_CERT_PATH=<path to fullchain.pem on the Hub>"
log "  TLS_KEY_PATH=<path to privkey.pem on the Hub>"
log "  PUBLIC_ORIGIN=https://${DOMAIN}"
log ""
log "Restart the Hub to pick up the new cert (TLS material loads once at boot)."
log "Re-run this script again in ~80 days to renew before the 90-day expiry."
