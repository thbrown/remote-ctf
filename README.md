# Foundry CTF

Offline LAN capture-the-flag game. One host (a Raspberry Pi at the venue, a laptop in dev)
runs a Node.js game server (sole authority for game state), serves a React web app that
players load in their phone's browser (QR-code scanning, team play), and talks to
ESP-based "Control Point" hardware nodes (RGB LED + presence sensor) over the LAN. No
internet connectivity is required to play.

See `PROGRESS.md` for current build status and `docs/` for the normative specs:

- `docs/00-WIRE-CONTRACT.md` — wire contract between Hub and Control Point firmware
- `docs/01-HUB.md` — Hub server + web app spec (this repo)
- `docs/02-FIRMWARE.md` — Control Point firmware spec (embedded/ESP side, informational
  here — the Hub doesn't depend on it)

## Repo layout

- `apps/hub-server` — Node/Express/WebSocket game server (`@foundry-ctf/hub-server`)
- `apps/web` — React player/admin SPA, served by the Hub over HTTPS (`@foundry-ctf/web`)
- `packages/shared` — types/protocol shared between server and web app
- `tools/sim-control-point` — simulates a Control Point node for testing without hardware
- `tools/mock-hub` — mock Hub for firmware-side testing

## Prerequisites

- Node.js >= 20
- [pnpm](https://pnpm.io/) 9 (`corepack enable` will pick up the pinned version from
  `package.json`)

## Setup

```bash
git clone https://github.com/thbrown/remote-ctf.git
cd remote-ctf
pnpm install
```

## Running in development

`packages/shared` is a real runtime dependency of the Hub (not just types), so build it
once before running anything that imports it — `pnpm --filter @foundry-ctf/hub-server dev`
included. Re-run this whenever you change `packages/shared`; the dev server doesn't
watch/rebuild it for you.

```bash
pnpm --filter @foundry-ctf/shared build
pnpm --filter @foundry-ctf/hub-server dev
```

This starts the Hub with a self-signed TLS cert and the following default listeners:

| App | Default port | Purpose |
| --- | --- | --- |
| deviceApp | `:8443` (HTTPS) | Serves the web app to player/admin phones |
| nodeApp | `:3000` (HTTP) | Control Point registration/heartbeat/presence API |
| spectatorApp | `:8080` (HTTP) | Public scoreboard, no auth |
| portalApp | disabled in dev (`:80` in prod) | Captive-portal redirect to deviceApp |

Build and serve the web app so the Hub can host it (the dev server otherwise serves a
placeholder page):

```bash
pnpm --filter @foundry-ctf/web build
```

To exercise the Hub without real hardware, run the Control Point simulator in another
terminal:

```bash
pnpm --filter @foundry-ctf/sim-control-point start
```

Then open `https://localhost:8443` (accept the self-signed cert warning) — the join sheet
links to the player app, admin app, and scoreboard.

## Configuration

The Hub is configured entirely via environment variables (see `apps/hub-server/src/config.ts`
for the full list and defaults). The ones you're most likely to set for a real deployment:

| Var | Default | Notes |
| --- | --- | --- |
| `NODE_ENV` | `development` | Set to `production` for the Pi deploy (changes default ports/TLS behavior) |
| `DATA_DIR` | `./data` | Where session/store state and the persisted `STATION_ID` live |
| `STORE_DRIVER` | `filesystem` | `inmemory` or `filesystem` |
| `PUBLIC_ORIGIN` | auto-detected LAN IP | The address players' phones will reach the Hub at. Auto-detected from the first non-internal network interface if unset (logged on boot) — **set this explicitly if the Pi has more than one network interface** (e.g. AP on a USB Wi-Fi adapter, internet on the built-in radio), since auto-detection can guess the wrong one |
| `WIFI_SSID` / `WIFI_PSK` | `FoundryCTF` / `capturetheflag` | Shown on the join sheet |
| `ADMIN_PIN` | `1234` | **Change this before running a real game** |
| `TLS_MODE` | `selfsigned` | Set to `provided` with `TLS_CERT_PATH`/`TLS_KEY_PATH` to use a real cert |

## Running on the Raspberry Pi

1. Install Node.js >= 20 and pnpm on the Pi (`corepack enable` after Node is installed).
2. Configure the Pi as a Wi-Fi access point so player phones can join a LAN with no
   internet: `sudo ./ops/setup-pi-ap.sh` (idempotent, static IP `10.0.0.1` to match the
   Hub's default `PUBLIC_ORIGIN`). See [`ops/raspberry-pi-ap-setup.md`](ops/raspberry-pi-ap-setup.md)
   for what it does and how to override the SSID/password, or to do it by hand.
3. Clone this repo onto the Pi and run `pnpm install`.
4. Build every workspace: `pnpm -r build` (this includes `packages/shared` — a real
   runtime dependency of the compiled Hub, not just types, so it must be built too, in
   that order; `pnpm -r` handles the ordering for you). `./ops/run-hub.sh` below already
   does this for you every time, so you only need this step if starting manually instead.
5. Start it. `PUBLIC_ORIGIN` is auto-detected from the Pi's LAN IP and logged on boot, but
   with more than one network interface (e.g. the AP running on a USB Wi-Fi adapter per
   [`ops/raspberry-pi-ap-setup.md`](ops/raspberry-pi-ap-setup.md)) auto-detection can't
   tell which one is the game network, so pin it explicitly instead of guessing:
   ```bash
   ./ops/run-hub.sh   # NODE_ENV=production, PUBLIC_ORIGIN=https://<AP_IP> (10.0.0.1 by default)
   ```
   or build (step 4) and start manually with the same env vars:
   ```bash
   NODE_ENV=production ADMIN_PIN=<pin> PUBLIC_ORIGIN=https://10.0.0.1 \
     pnpm --filter @foundry-ctf/hub-server start
   ```
6. Confirm all four listeners come up (`nodeApp`, `deviceApp`, `spectatorApp`, and
   `portalApp` if enabled) and that `tools/sim-control-point` (or real Control Point
   hardware, once built per `docs/02-FIRMWARE.md`) can register against it. `/test-qr`
   (linked from the Admin app) has sample player/respawn QR codes for testing scans
   without needing real players or hardware — see the page itself for how to use it.

## Tests

```bash
pnpm test        # all workspaces
pnpm typecheck    # all workspaces
```
