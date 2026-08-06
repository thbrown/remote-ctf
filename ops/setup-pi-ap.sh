#!/usr/bin/env bash
#
# Idempotent Wi-Fi access point setup for the Foundry CTF Hub, targeting a
# Raspberry Pi 5 running Raspberry Pi OS (Bookworm, NetworkManager-based).
# Safe to re-run: every step checks current state before changing anything.
#
# Only AP_IFACE is touched (unmanaged, static-IP'd, handed to hostapd/dnsmasq).
# Every other network interface - notably the Pi 5's built-in Wi-Fi, if you're
# running the AP on a USB adapter instead - is left under normal NetworkManager
# control, so it can stay connected to a real network (home Wi-Fi, a hotspot)
# for internet access the whole time the AP is up. No toggling required: point
# AP_IFACE at your USB adapter (e.g. `wlan1`) and connect the other interface
# to the internet separately, e.g.:
#   sudo nmcli device wifi connect "HomeSSID" password "homepassword" ifname wlan0
#
# See ops/raspberry-pi-ap-setup.md for the manual walkthrough this automates.
#
# Usage:
#   sudo ./ops/setup-pi-ap.sh
#
# Override defaults via environment variables, e.g.:
#   sudo AP_IFACE=wlan1 SSID=MyEvent PSK=supersecret ./ops/setup-pi-ap.sh
#
set -euo pipefail

AP_IFACE="${AP_IFACE:-${IFACE:-wlan0}}"
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

if ! ip link show "${AP_IFACE}" >/dev/null 2>&1; then
  echo "Interface ${AP_IFACE} not found. Available wireless interfaces:" >&2
  iw dev 2>/dev/null | awk '$1=="Interface"{print "  " $2}' >&2 || true
  echo "Set AP_IFACE to the one you want to use for the AP." >&2
  exit 1
fi

if ip route show default 2>/dev/null | grep -q "dev ${AP_IFACE} "; then
  echo "REFUSING: ${AP_IFACE} currently has the default route (it's your internet connection)." >&2
  echo "  Turning it into the AP will cut off internet access, e.g. for git pulls." >&2
  echo "  If you really only have one interface and want to proceed anyway, pass FORCE=1:" >&2
  echo "    sudo FORCE=1 AP_IFACE=${AP_IFACE} ./ops/setup-pi-ap.sh" >&2
  echo "  Otherwise point AP_IFACE at your other adapter, e.g.:" >&2
  echo "    sudo AP_IFACE=wlan1 ./ops/setup-pi-ap.sh" >&2
  if [[ "${FORCE:-0}" != "1" ]]; then
    exit 1
  fi
  echo "FORCE=1 set - proceeding anyway. You'll need ops/recover-pi-ap.sh to get internet back." >&2
fi

if command -v iw >/dev/null 2>&1; then
  phy="$(iw dev "${AP_IFACE}" info 2>/dev/null | awk '/wiphy/{print $2}')"
  if [[ -n "${phy}" ]] && ! iw phy "phy${phy}" info 2>/dev/null | grep -A20 'Supported interface modes' | grep -q ' AP$'; then
    log "WARNING: ${AP_IFACE} (phy${phy}) doesn't advertise AP-mode support via iw."
    log "  hostapd may fail to start. This is common for some USB Wi-Fi chipsets"
    log "  without an out-of-tree driver. Continuing anyway - check 'iw list' and"
    log "  'journalctl -u hostapd -e' if hostapd doesn't come up."
  fi
fi

# --- 1. Packages -----------------------------------------------------------
log "Installing hostapd and dnsmasq (skipped if already present)..."
apt-get update -qq
apt-get install -y -qq hostapd dnsmasq

systemctl unmask hostapd >/dev/null 2>&1 || true
rfkill unblock wifi || true

# --- 2. Hand AP_IFACE off from NetworkManager --------------------------------
if command -v nmcli >/dev/null 2>&1; then
  log "Marking ${AP_IFACE} unmanaged in NetworkManager..."
  nm_conf="/etc/NetworkManager/conf.d/unmanaged-${AP_IFACE}.conf"
  cat >"${nm_conf}" <<EOF
[keyfile]
unmanaged-devices=interface-name:${AP_IFACE}
EOF
  nmcli device set "${AP_IFACE}" managed no >/dev/null 2>&1 || true
  if systemctl is-active --quiet NetworkManager; then
    systemctl reload NetworkManager 2>/dev/null || systemctl restart NetworkManager
  fi
else
  log "NetworkManager not present, skipping unmanaged-device config."
fi

# --- 3. Static IP on AP_IFACE via a small systemd oneshot --------------------
log "Installing static IP unit for ${AP_IFACE} (${AP_IP}/${AP_CIDR})..."
ip_unit=/etc/systemd/system/foundry-ctf-ap-ip.service
cat >"${ip_unit}" <<EOF
[Unit]
Description=Foundry CTF - static IP for ${AP_IFACE}
After=sys-subsystem-net-devices-${AP_IFACE}.device network-pre.target
Before=hostapd.service dnsmasq.service
BindsTo=sys-subsystem-net-devices-${AP_IFACE}.device

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/ip addr replace ${AP_IP}/${AP_CIDR} dev ${AP_IFACE}
ExecStart=/sbin/ip link set dev ${AP_IFACE} up
ExecStop=/sbin/ip addr del ${AP_IP}/${AP_CIDR} dev ${AP_IFACE}

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
interface=${AP_IFACE}
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
interface=${AP_IFACE}
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

# --- 6b. Redirect :80/:443 to the Hub's unprivileged ports -------------------
# Linux reserves ports <1024 for root. Rather than grant node itself the
# capability to bind them (setcap - tried this first, but it depends on the
# root filesystem correctly round-tripping the security.capability xattr,
# which fails with "effective file capabilities must either be empty or
# exactly match..." on some Pi OS setups, e.g. with the read-only overlay
# filesystem option enabled), redirect the well-known ports to the Hub's
# normal unprivileged ones (8080/8443, same as dev) at the netfilter level.
# This only needs root once, here, never for the Hub process itself - so
# ops/run-hub.sh runs entirely as a normal user. Installed as a systemd
# oneshot (like the static-IP unit above) so it's reapplied on every boot.
log "Installing port-redirect unit (:80->8080, :443->8443 on ${AP_IFACE})..."
redirect_unit=/etc/systemd/system/foundry-ctf-port-redirect.service
cat >"${redirect_unit}" <<EOF
[Unit]
Description=Foundry CTF - redirect :80/:443 to the Hub's unprivileged ports
After=sys-subsystem-net-devices-${AP_IFACE}.device network-pre.target
BindsTo=sys-subsystem-net-devices-${AP_IFACE}.device

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c '/sbin/iptables -t nat -C PREROUTING -i ${AP_IFACE} -p tcp --dport 80 -j REDIRECT --to-port 8080 || /sbin/iptables -t nat -A PREROUTING -i ${AP_IFACE} -p tcp --dport 80 -j REDIRECT --to-port 8080'
ExecStart=/bin/sh -c '/sbin/iptables -t nat -C PREROUTING -i ${AP_IFACE} -p tcp --dport 443 -j REDIRECT --to-port 8443 || /sbin/iptables -t nat -A PREROUTING -i ${AP_IFACE} -p tcp --dport 443 -j REDIRECT --to-port 8443'
ExecStop=/sbin/iptables -t nat -D PREROUTING -i ${AP_IFACE} -p tcp --dport 80 -j REDIRECT --to-port 8080
ExecStop=/sbin/iptables -t nat -D PREROUTING -i ${AP_IFACE} -p tcp --dport 443 -j REDIRECT --to-port 8443

[Install]
WantedBy=multi-user.target
EOF

if ! command -v iptables >/dev/null 2>&1; then
  log "  installing iptables..."
  apt-get install -y -qq iptables
fi

systemctl daemon-reload
systemctl enable foundry-ctf-port-redirect.service >/dev/null
systemctl restart foundry-ctf-port-redirect.service

# --- 7. Verify ----------------------------------------------------------------
log "Verifying..."
sleep 1
ok=1

if ip addr show "${AP_IFACE}" | grep -q "${AP_IP}/${AP_CIDR}"; then
  log "  [ok] ${AP_IFACE} has ${AP_IP}/${AP_CIDR}"
else
  log "  [FAIL] ${AP_IFACE} does not have ${AP_IP}/${AP_CIDR}"
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

if iptables -t nat -C PREROUTING -i "${AP_IFACE}" -p tcp --dport 80 -j REDIRECT --to-port 8080 2>/dev/null \
  && iptables -t nat -C PREROUTING -i "${AP_IFACE}" -p tcp --dport 443 -j REDIRECT --to-port 8443 2>/dev/null; then
  log "  [ok] :80/:443 redirect to 8080/8443 on ${AP_IFACE}"
else
  log "  [FAIL] port redirect rules missing - check: systemctl status foundry-ctf-port-redirect"
  ok=0
fi

if [[ "${ok}" -eq 1 ]]; then
  log "Done. AP '${SSID}' is up at ${AP_IP}. Start the Hub with ./ops/run-hub.sh"
else
  log "Completed with errors - see [FAIL] lines above."
  exit 1
fi
