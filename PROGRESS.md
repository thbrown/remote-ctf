# Foundry CTF — Progress / Resume Doc

**Read this file first in any new session.** It is the single source of truth for where
this build stands. Update it whenever you complete or start a unit of work — don't let it
drift stale. The two normative specs are in `docs/00-WIRE-CONTRACT.md` (firmware wire
contract, joint-owned) and `docs/01-HUB.md` (Hub server + web app, this is what we're
building). Requirement IDs (`CON-nnn`, `HUB-nnn`) below refer to those docs.

## What this project is

Offline LAN capture-the-flag game. One Raspberry Pi (laptop in dev) runs: a Wi-Fi AP, a
Node.js game server (sole authority for game state), a static host for a React web app
(players scan QR codes with their phone camera), and a coordinator talking plain HTTP to
ESP-based "Control Point" hardware nodes (RGB LED + presence sensor). We (the Hub agent)
only own the Hub side — `apps/hub-server`, `apps/web`, `packages/shared`,
`tools/sim-control-point`. Firmware (`02-CONTROL-POINT.md`, ESP side) was **not** provided
to this agent — only doc00 (wire contract) and doc01 (Hub) exist in `docs/`. If doc02 shows
up later, read it before touching anything MAC/firmware-adjacent.

No human is watching this build in real time — it is running unattended overnight. Bias
towards making forward progress and leaving clear notes over stopping to ask.

## Milestones (from doc01 §11) — track status here

- [ ] **M0** — Four listeners up (nodeApp :3000, deviceApp HTTPS, spectatorApp :8080,
      portalApp :80/disabled-in-dev); Web App served over HTTPS; `sim-control-point`
      registers successfully.
- [ ] **M1** — `InMemoryStore` + `FileSystemStore` + `TimeSeriesStore` pass one shared
      contract test suite; 8 teams seeded.
- [ ] **M2** — register → presence → heartbeat → `/set-color` round-trip against the
      simulator; reconciliation proven by deliberately dropping a push.
- [ ] **M3** — WS snapshot/patch; profile creation with a 128×128 photo; Stats renders
      live; scoreboard page works.
- [ ] **M4** — Capture (with grace window), Tag, Respawn, 1 Hz scoring, session
      start/stop.
- [ ] **M5** — Admin: claim by QR, respawn locations, join sheet, printable sheets.
- [ ] **M6** — One real ESP Node end-to-end. **Cannot be done without hardware — skip.**
- [ ] **M7** — RPi AP, systemd unit, 6+ real phones, one complete game. **Cannot be done
      without hardware/venue — skip.**

M6/M7 need physical hardware and are out of scope for unattended agent work. Realistic
ceiling for this session is M0–M5.

## Current status

See the "Log" section at the bottom for the detailed run of work. Update the line below
every time you resume:

**Last known state:** `packages/shared` complete and committed (ontology.ts, qr.ts, wire.ts,
ws.ts, index.ts + qr.test.ts, all passing typecheck+vitest). Workspace scaffolding
(pnpm-workspace.yaml, root package.json, tsconfig.base.json, per-package package.json/tsconfig
for shared/hub-server/web/sim-control-point) is in place and `pnpm install` succeeds at root.
Next in progress: hub-server store layer (Task #4 — Repository/GameStateStore interfaces,
InMemoryStore, FileSystemStore, TimeSeriesStore, contract test suite).

## Key architectural decisions already locked in by the spec (don't relitigate)

- Every `GameStateStore` method returns a Promise, even in-memory (HUB-051) — non-negotiable,
  it's the Lohi-swap seam.
- Ontology types live in exactly one place: `packages/shared/src/ontology.ts` (HUB-070).
  Game logic imports only from there.
- Durations (capture timers, scoring, heartbeat timeouts) computed from monotonic time only,
  never wall clock (HUB-062). Use an injectable clock so `GameEngine` is unit-testable
  (HUB-201).
- `session.captureDurationMs` is an immutable snapshot taken once at session start
  (HUB-048); `station.captureDurationMs` is the live-editable admin setting; engine reads
  session's copy only (HUB-049).
- Zod validation on every inbound HTTP body and WS payload (HUB-190).
- Four separate Express apps in one process, nodeApp bound first and independent of TLS
  (HUB-011).
- Conflict rule: if code disagrees with docs/00 or docs/01, the doc wins — stop and note the
  discrepancy in this file rather than silently improvising.

## Dependency policy (user request, 2026-08-05)

User explicitly asked to avoid supply-chain risk: **pin exact versions (no `^`/`~`) in every
`package.json`, and prefer a slightly older, well-established release over the newest patch**
(recent npm incidents have shipped compromised versions within hours of publish). When adding
any new dependency: pin exact, pick a version that's been out a while, and don't run
`npm audit fix` / `pnpm update` blindly. If unsure, ask rather than grabbing latest.

## Open questions from the docs (stub as TBD/defaults, do not invent)

- **Q-A** (both docs): SSID/PSK/gateway IP — using proposed defaults `FoundryCTF` /
  `capturetheflag` / `10.0.0.1`, DHCP pool `10.0.0.50–150`.
- **Q-D** (doc01 §13): peak counts — using defaults 12 players / 6 Nodes / 4 respawn
  locations for any sizing decisions (e.g. list virtualization thresholds).

## How to resume / verify current state

```
cd /Users/thomasbrown/Desktop/gitRepos/remote-ctf
git log --oneline -20        # see what's actually landed
cat PROGRESS.md              # this file
pnpm install                 # if node_modules missing
pnpm -r build                # or per-package build, see below
```

Then check the Log section below for the most recent entry and the "Next up" note at the
very end.

## Log

### 2026-08-05 — session start
- Read docs/00-WIRE-CONTRACT.md and docs/01-HUB.md in full.
- Initialized empty git repo at remote-ctf root (was previously a bare empty dir).
- Copied doc00 → `docs/00-WIRE-CONTRACT.md`, doc01 → `docs/01-HUB.md`.
- Scaffolded directory layout per HUB-190.
- Wrote this progress doc.
- Next: pnpm workspace + tsconfig scaffolding, then `packages/shared` (ontology types,
  seed teams, QR codec, WS contract types, zod schemas) since everything else imports from
  it.
