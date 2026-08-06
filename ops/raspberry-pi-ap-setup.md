# Raspberry Pi Wi-Fi access point setup (hostapd + dnsmasq)

Turns one of the Pi's Wi-Fi radios into a standalone access point with no internet
uplink, so players can join with their phones and reach the Hub. This matches the Hub's
defaults: Pi at `10.0.0.1`, SSID `FoundryCTF`, password `capturetheflag` (override via
`WIFI_SSID`/`WIFI_PSK` on the Hub — those only control what's *displayed* on the join
sheet, so keep them in sync with whatever you set here).

Tested against Raspberry Pi OS Bookworm (current, uses NetworkManager). If your Pi is on
an older Raspberry Pi OS release using `dhcpcd` instead of NetworkManager, skip step 2
and instead follow the [classic dhcpcd-based guide](https://www.raspberrypi.com/documentation/computers/configuration.html#setting-up-a-routed-wireless-access-point)
for the static-IP part; steps 1, 3, 4, and 5 below still apply.

## Keeping internet access — run the AP on a second radio

Everything below only touches the *one interface* you tell it to (`AP_IFACE`, `wlan0` by
default). It never touches any other network interface. That means if the Pi 5 has a
second Wi-Fi radio — e.g. a USB adapter like a Panda PAU06 plugged in alongside the
built-in Wi-Fi — you can point the AP at the USB adapter and leave the built-in radio on
your home network/hotspot the whole time. No toggling between "game mode" and "internet
mode" is needed; both run simultaneously, and `git pull` just works over the built-in
radio while the AP stays up on the USB one.

```bash
# find interface names first
iw dev              # lists each interface + which physical radio (phyN) it's on

# run the AP on the USB adapter (commonly wlan1), leave wlan0 alone
sudo AP_IFACE=wlan1 ./ops/setup-pi-ap.sh

# connect the untouched built-in radio to your home network for internet
sudo nmcli device wifi connect "HomeSSID" password "homepassword" ifname wlan0
```

Not every USB Wi-Fi chipset supports AP mode — the script checks this for you (via
`iw phy ... info`) and warns before proceeding if `AP_IFACE` doesn't advertise it. Many
Ralink/MediaTek-based adapters (`rt2800usb`, in-kernel on Raspberry Pi OS, no extra driver
needed) do support it; some Realtek chipsets need an out-of-tree driver to get AP mode at
all. If the check warns and hostapd then fails to start, that's usually the cause — check
`journalctl -u hostapd -e` for specifics.

If you only have one radio, or the second one doesn't support AP mode, run the AP on
`wlan0` as before and disconnect/reconnect it from your home network manually before and
after you need internet (`nmcli device disconnect wlan0` / `nmcli device connect wlan0`,
or physically re-running with different config) — this repo doesn't script that toggle,
since a second radio is the simpler and more reliable path if you have the hardware for it.

## Automated (recommended)

[`ops/setup-pi-ap.sh`](setup-pi-ap.sh) does everything in steps 1–7 below and is
idempotent — safe to re-run any time (after a config change, a fresh flash, etc.).

```bash
sudo ./ops/setup-pi-ap.sh
```

Override the SSID/password/IP/channel/country via env vars if you don't want the
defaults (which match the Hub's own defaults):

```bash
sudo SSID=MyEvent PSK=supersecretpw COUNTRY=US ./ops/setup-pi-ap.sh
```

The rest of this doc explains what the script does, for when you want to do it by hand
or debug something it didn't get right.

## 1. Install packages

```bash
sudo apt update
sudo apt install -y hostapd dnsmasq
sudo systemctl unmask hostapd
```

## 2. Take the AP interface away from NetworkManager

Raspberry Pi OS Bookworm manages Wi-Fi via NetworkManager by default, which will fight
hostapd for control of the interface. Tell it to leave your chosen AP interface (`wlan0`
for the built-in radio, or e.g. `wlan1` for a USB adapter — see "Keeping internet access"
above) alone. The examples below use `wlan0`; substitute your interface name.

```bash
sudo nmcli device set wlan0 managed no
```

Make it permanent by adding to `/etc/NetworkManager/NetworkManager.conf`:

```ini
[keyfile]
unmanaged-devices=interface-name:wlan0
```

Any *other* Wi-Fi interface is left alone and stays under normal NetworkManager control
— that's what lets it keep a real internet connection.

## 3. Give the AP interface a static IP

Create `/etc/systemd/network/25-wlan0-ap.network` (or use `nmcli`/`dhcpcd.conf` if you're
on an older stack) so the Pi always answers at `10.0.0.1`:

```bash
sudo tee /etc/systemd/network/25-wlan0-ap.network >/dev/null <<'EOF'
[Match]
Name=wlan0

[Network]
Address=10.0.0.1/24
DHCPServer=no
EOF
sudo systemctl enable --now systemd-networkd
```

If `systemd-networkd` isn't already your network manager on this Pi, the simpler option
is a one-off static assignment that's reapplied on boot via `/etc/rc.local` or a small
systemd unit:

```bash
sudo ip addr add 10.0.0.1/24 dev wlan0
```

Verify: `ip addr show wlan0` should list `10.0.0.1/24`.

## 4. Configure dnsmasq (DHCP + DNS for the play network)

Copy the example config and point dnsmasq at it:

```bash
sudo mv /etc/dnsmasq.conf /etc/dnsmasq.conf.orig
sudo cp ops/dnsmasq.conf.example /etc/dnsmasq.conf
```

This hands out `10.0.0.2`–`10.0.0.200` by DHCP and resolves *every* DNS name to
`10.0.0.1`, which is what makes phones pop the "sign in to Wi-Fi" captive-portal prompt
straight to the join page (the Hub's `portalApp`, `PORTAL_HTTP_PORT`, handles that redirect
— see `docs/01-HUB.md`).

## 5. Configure hostapd

```bash
sudo cp ops/hostapd.conf.example /etc/hostapd/hostapd.conf
```

Edit `ssid` and `wpa_passphrase` in `/etc/hostapd/hostapd.conf` if you're not using the
defaults, and set them identically via `WIFI_SSID`/`WIFI_PSK` when you start the Hub so
the join sheet shows the right credentials.

Point the hostapd service at that file:

```bash
sudo sed -i 's/^#DAEMON_CONF=.*/DAEMON_CONF="\/etc\/hostapd\/hostapd.conf"/' /etc/default/hostapd
```

## 6. Enable IP forwarding? No.

This network is intentionally offline — don't enable `net.ipv4.ip_forward` or NAT to a
WAN interface. Phones on `10.0.0.0/24` should only be able to reach the Pi itself.

## 7. Start everything

```bash
sudo rfkill unblock wifi
sudo systemctl enable --now hostapd
sudo systemctl enable --now dnsmasq
sudo systemctl restart hostapd dnsmasq
```

## 8. Verify

- `sudo systemctl status hostapd dnsmasq` — both `active (running)`.
- The SSID (`FoundryCTF` by default) should be visible from a phone.
- Connect a phone to it, confirm it gets an address in `10.0.0.2`–`10.0.0.200`
  (`sudo dnsmasq --test` and `cat /var/lib/misc/dnsmasq.leases` on the Pi to check).
- With the Hub running (`PUBLIC_ORIGIN=https://10.0.0.1`), the phone should either get a
  captive-portal prompt to the join page automatically, or you can browse to
  `https://10.0.0.1:8443` (or `:443` in production) manually.

## Troubleshooting

- `hostapd` fails to start / "Could not configure driver mode": either another process
  (NetworkManager, `wpa_supplicant`) still has the interface — re-check step 2 and
  `sudo systemctl disable --now wpa_supplicant` if present — or the chipset doesn't
  support AP mode at all. Check with `iw phy phyN info` (find `N` via `iw dev`) and look
  for `AP` under "Supported interface modes"; if it's missing, that adapter can't run an
  AP with the in-kernel driver and needs a different one or a different piece of
  hardware.
- Phone connects but gets no IP: `sudo systemctl status dnsmasq`, check
  `sudo journalctl -u dnsmasq -e` for interface-binding errors, confirm `wlan0` has
  `10.0.0.1/24` (step 3) before dnsmasq starts.
- No captive-portal prompt: this is cosmetic — the join sheet/QR flow works regardless.
  iOS/Android captive-portal detection is finicky and not required for the game to
  function; players can always type the Hub's HTTPS address manually.
