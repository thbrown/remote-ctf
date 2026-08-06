#!/usr/bin/env bash
#
# Idempotent Wi-Fi access point setup for the Foundry CTF Hub, targeting a
# Raspberry Pi 5 running Raspberry Pi OS (Bookworm, NetworkManager-based).
# Safe to re-run: every step checks current state before changing anything.
#
# See ops/raspberry-pi-ap-setup.md for the manual walkthrough this automates.
#
# Usage:
#   sudo ./ops/setup-pi-ap.sh
#
# Override defaults via environment variables, e.g.:
#   sudo SSID=MyEvent PSK=supersecret ./ops/setup-pi-ap.sh
#
set -euo pipefail

IFACE="${IFACE:-wlan0}"
AP_IP="${AP_IP:-10.0.0.1}"
AP_CIDR="${AP_CIDR:-24}"
SSID="${SSID:-FoundryCTF}"
PSK="${PSK:-capturetheflag}"
COUNTRY="${COUNTRY:-US}"
CHANNEL="${CHANNEL:-6}"
DHCP_START="${DHCP_START:-10.0.0.2}"
DHCP_END="${DHCP_END:-10.0.0.200}"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"

log() { echo "[setup-pi-ap] $*"; }

if [[ "${EUID}" -ne 0 ]]; then
  echo "Must be run as root (sudo ./ops/setup-pi-ap.sh)" >&2
  exit 1
fi

if [[ ${#PSK} -lt 8 ]]; then
  echo "PSK must be at least 8 characters (WPA2 requirement), got ${#PSK}." >&2
  exit 1
fi

# --- 1. Packages -----------------------------------------------------------
log "Installing hostapd and dnsmasq (skipped if already present)..."
apt-get update -qq
apt-get install -y -qq hostapd dnsmasq

systemctl unmask hostapd >/dev/null 2>&1 || true
rfkill unblock wifi || true

# --- 2. Hand wlan0 off from NetworkManager ----------------------------------
if command -v nmcli >/dev/null 2>&1; then
  log "Marking ${IFACE} unmanaged in NetworkManager..."
  nm_conf="/etc/NetworkManager/conf.d/unmanaged-${IFACE}.conf"
  cat >"${nm_conf}" <<EOF
[keyfile]
unmanaged-devices=interface-name:${IFACE}
EOF
  nmcli device set "${IFACE}" managed no >/dev/null 2>&1 || true
  if systemctl is-active --quiet NetworkManager; then
    systemctl reload NetworkManager 2>/dev/null || systemctl restart NetworkManager
  fi
else
  log "NetworkManager not present, skipping unmanaged-device config."
fi

# --- 3. Static IP on wlan0 via a small systemd oneshot ----------------------
log "Installing static IP unit for ${IFACE} (${AP_IP}/${AP_CIDR})..."
ip_unit=/etc/systemd/system/foundry-ctf-ap-ip.service
cat >"${ip_unit}" <<EOF
[Unit]
Description=Foundry CTF - static IP for ${IFACE}
After=sys-subsystem-net-devices-${IFACE}.device network-pre.target
Before=hostapd.service dnsmasq.service
BindsTo=sys-subsystem-net-devices-${IFACE}.device

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/ip addr replace ${AP_IP}/${AP_CIDR} dev ${IFACE}
ExecStart=/sbin/ip link set dev ${IFACE} up
ExecStop=/sbin/ip addr del ${AP_IP}/${AP_CIDR} dev ${IFACE}

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable foundry-ctf-ap-ip.service >/dev/null
systemctl restart foundry-ctf-ap-ip.service

# --- 4. dnsmasq --------------------------------------------------------------
log "Writing dnsmasq config (drop-in, doesn't touch other dnsmasq.conf entries)..."

# Debian's dnsmasq.conf ships a commented-out conf-dir include; make sure it's
# active so our drop-in in /etc/dnsmasq.d/ actually gets loaded.
if [[ -f /etc/dnsmasq.conf ]] && ! grep -q '^conf-dir=/etc/dnsmasq.d' /etc/dnsmasq.conf; then
  if grep -q '^#conf-dir=/etc/dnsmasq.d/,\*\.conf' /etc/dnsmasq.conf; then
    sed -i 's|^#conf-dir=/etc/dnsmasq.d/,\*\.conf|conf-dir=/etc/dnsmasq.d/,*.conf|' /etc/dnsmasq.conf
  else
    echo 'conf-dir=/etc/dnsmasq.d/,*.conf' >>/etc/dnsmasq.conf
  fi
fi

mkdir -p /etc/dnsmasq.d
cat >/etc/dnsmasq.d/foundry-ctf.conf <<EOF
# Managed by ops/setup-pi-ap.sh - safe to hand-edit, will be overwritten on re-run.
interface=${IFACE}
bind-interfaces
dhcp-range=${DHCP_START},${DHCP_END},255.255.255.0,24h
dhcp-option=6,${AP_IP}
address=/#/${AP_IP}
EOF

# --- 5. hostapd --------------------------------------------------------------
log "Writing hostapd config for SSID '${SSID}'..."
mkdir -p /etc/hostapd
cat >/etc/hostapd/hostapd.conf <<EOF
# Managed by ops/setup-pi-ap.sh - safe to hand-edit, will be overwritten on re-run.
interface=${IFACE}
driver=nl80211

ssid=${SSID}
hw_mode=g
channel=${CHANNEL}
country_code=${COUNTRY}
ieee80211d=1
ieee80211n=1
wmm_enabled=1

auth_algs=1
wpa=2
wpa_passphrase=${PSK}
wpa_key_mgmt=WPA-PSK
rsn_pairwise=CCMP
EOF

if [[ -f /etc/default/hostapd ]] && grep -q '^#\?DAEMON_CONF=' /etc/default/hostapd; then
  sed -i 's|^#\?DAEMON_CONF=.*|DAEMON_CONF="/etc/hostapd/hostapd.conf"|' /etc/default/hostapd
else
  echo 'DAEMON_CONF="/etc/hostapd/hostapd.conf"' >>/etc/default/hostapd
fi

# --- 6. Enable and (re)start everything --------------------------------------
log "Enabling and restarting hostapd + dnsmasq..."
systemctl unmask hostapd dnsmasq >/dev/null 2>&1 || true
systemctl enable hostapd dnsmasq >/dev/null
systemctl restart dnsmasq
systemctl restart hostapd

# --- 7. Verify ----------------------------------------------------------------
log "Verifying..."
sleep 1
ok=1

if ip addr show "${IFACE}" | grep -q "${AP_IP}/${AP_CIDR}"; then
  log "  [ok] ${IFACE} has ${AP_IP}/${AP_CIDR}"
else
  log "  [FAIL] ${IFACE} does not have ${AP_IP}/${AP_CIDR}"
  ok=0
fi

if systemctl is-active --quiet hostapd; then
  log "  [ok] hostapd is running (SSID: ${SSID})"
else
  log "  [FAIL] hostapd is not running - check: journalctl -u hostapd -e"
  ok=0
fi

if systemctl is-active --quiet dnsmasq; then
  log "  [ok] dnsmasq is running"
else
  log "  [FAIL] dnsmasq is not running - check: journalctl -u dnsmasq -e"
  ok=0
fi

if [[ "${ok}" -eq 1 ]]; then
  log "Done. AP '${SSID}' is up at ${AP_IP}. Start the Hub with PUBLIC_ORIGIN=https://${AP_IP}"
else
  log "Completed with errors - see [FAIL] lines above."
  exit 1
fi
