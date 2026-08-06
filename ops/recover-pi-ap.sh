#!/usr/bin/env bash
#
# Undoes ops/setup-pi-ap.sh on a given interface and hands it back to
# NetworkManager. For when the AP got set up on the wrong interface (e.g. the
# Pi's internet-connected built-in wlan0 instead of a USB adapter) and you need
# your network access back.
#
# Usage (run at the Pi's console/keyboard if the AP interface was carrying your
# SSH session - it'll be gone once this runs):
#   sudo ./ops/recover-pi-ap.sh                     # defaults to wlan0
#   sudo AP_IFACE=wlan1 ./ops/recover-pi-ap.sh       # recover a different interface
#
# Optionally reconnect straight to a known Wi-Fi network afterwards:
#   sudo RECONNECT_SSID="HomeSSID" RECONNECT_PSK="homepassword" ./ops/recover-pi-ap.sh
#
set -euo pipefail

AP_IFACE="${AP_IFACE:-wlan0}"

log() { echo "[recover-pi-ap] $*"; }

if [[ "${EUID}" -ne 0 ]]; then
  echo "Must be run as root (sudo ./ops/recover-pi-ap.sh)" >&2
  exit 1
fi

log "Recovering ${AP_IFACE} from AP mode..."

log "Stopping hostapd, dnsmasq, and the static-IP/port-redirect units..."
systemctl stop hostapd dnsmasq foundry-ctf-ap-ip.service foundry-ctf-port-redirect.service 2>/dev/null || true
systemctl disable foundry-ctf-ap-ip.service foundry-ctf-port-redirect.service >/dev/null 2>&1 || true
rm -f /etc/systemd/system/foundry-ctf-ap-ip.service /etc/systemd/system/foundry-ctf-port-redirect.service
systemctl daemon-reload

nm_conf="/etc/NetworkManager/conf.d/unmanaged-${AP_IFACE}.conf"
if [[ -f "${nm_conf}" ]]; then
  log "Removing unmanaged-device override for ${AP_IFACE}..."
  rm -f "${nm_conf}"
fi

log "Flushing static IP off ${AP_IFACE}..."
ip addr flush dev "${AP_IFACE}" 2>/dev/null || true

if command -v nmcli >/dev/null 2>&1; then
  log "Handing ${AP_IFACE} back to NetworkManager..."
  nmcli device set "${AP_IFACE}" managed yes >/dev/null 2>&1 || true
  systemctl restart NetworkManager
  sleep 2
else
  log "NetworkManager not present, skipping."
fi

if [[ -n "${RECONNECT_SSID:-}" ]]; then
  log "Reconnecting ${AP_IFACE} to '${RECONNECT_SSID}'..."
  nmcli device wifi connect "${RECONNECT_SSID}" password "${RECONNECT_PSK:-}" ifname "${AP_IFACE}"
fi

log "Verifying..."
sleep 1
if nmcli -t -f DEVICE,STATE device status 2>/dev/null | grep -q "^${AP_IFACE}:connected"; then
  log "  [ok] ${AP_IFACE} is connected via NetworkManager"
else
  log "  [!] ${AP_IFACE} is not showing as connected yet - check 'nmcli device status'"
  log "      and reconnect manually if needed:"
  log "      sudo nmcli device wifi connect \"YourSSID\" password \"yourpassword\" ifname ${AP_IFACE}"
fi

log "Done. ${AP_IFACE} is back under normal NetworkManager control."
log "When you're ready to set up the AP again, target the correct interface, e.g.:"
log "  sudo AP_IFACE=wlan1 ./ops/setup-pi-ap.sh"
