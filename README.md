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

```bash
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
4. Build the web app: `pnpm --filter @foundry-ctf/web build`.
5. Build the server: `pnpm --filter @foundry-ctf/hub-server build`.
6. Set `NODE_ENV=production` and `ADMIN_PIN`, then start it:
   ```bash
   NODE_ENV=production ADMIN_PIN=<pin> pnpm --filter @foundry-ctf/hub-server start
   ```
   `PUBLIC_ORIGIN` is auto-detected from the Pi's LAN IP and logged on boot — pass it
   explicitly (`PUBLIC_ORIGIN=https://10.0.0.1`) if the Pi has more than one network
   interface (e.g. the AP running on a USB Wi-Fi adapter per
   [`ops/raspberry-pi-ap-setup.md`](ops/raspberry-pi-ap-setup.md)), since auto-detection
   can't tell which interface is the game network.
7. Confirm all four listeners come up (`nodeApp`, `deviceApp`, `spectatorApp`, and
   `portalApp` if enabled) and that `tools/sim-control-point` (or real Control Point
   hardware, once built per `docs/02-FIRMWARE.md`) can register against it.

## Tests

```bash
pnpm test        # all workspaces
pnpm typecheck    # all workspaces
```
