# Doc 01 — Foundry CTF Hub Server & Web App

**Version:** 0.4
**Status:** Draft — buildable. Non-blocking open questions: Q-A, Q-D.
**Requirement prefix:** `HUB-`
**Audience:** The AI agent implementing the Hub. Human reviewers.
**Companion docs:** `00-WIRE-CONTRACT.md` (normative, Appendix A), `02-CONTROL-POINT.md` (firmware, FYI)

---

## HOW TO READ THIS DOCUMENT

- Requirements are numbered `HUB-nnn` and are normative. MUST / SHOULD / MAY per RFC 2119.
- Code blocks are **interface contracts**, not illustrations. Match the signatures.
- **Conflict rule:** where this document disagrees with `00-WIRE-CONTRACT.md`, the wire
  contract wins. Report the discrepancy; do not silently adapt.
- `TBD` means genuinely undecided. Do not invent a value — stub it in config and flag it.

### Changelog
- **0.4** — TLS fixed to self-signed; clock-sync requirement removed; attachments 128×128;
  `captureStatus` → `in_progress | complete | abandoned`; `abandonReason` added; 8 teams
  hardcoded; `captureDurationMs` on both Station (mutable) and Session (immutable
  snapshot); redundant captures rejected; Node endpoints redesigned; hub restart abandons
  the session; spectator scoreboard added.
- **0.3** — Doc split; wire contract extracted.
- **0.2** — Restructured from original brief.

---

## 1. Overview

A single Node.js process on a Raspberry Pi (a laptop during development) acting as:
Wi-Fi access point, authoritative game server, static host for the React Web App, and
coordinator for ESP-based Control Point Nodes. **No internet connectivity.**

One Hub = one `qrCtfStation` = one concurrent Session.

### 1.1 Goals

| ID | Goal |
|---|---|
| G-1 | Run the entire game offline on one device |
| G-2 | Zero-install for players: join Wi-Fi via QR, open the Web App via QR, play in a browser |
| G-3 | All game state behind one swappable interface (Palantir Lohi implementation later) |
| G-4 | Time-series history captured locally, independently syncable to Foundry via OSDK |
| G-5 | Control Point firmware stays trivially simple — plain HTTP, no TLS, no crypto |

### 1.2 Non-goals

- Internet connectivity, cloud auth, user accounts
- Live Foundry sync in v1 (in-memory / filesystem mode performs **no** syncing)
- Serious anti-cheat beyond server-side sanity checks (§7.5)
- Multi-Station / multi-Hub federation
- Native mobile apps — browser only

### 1.3 Deployment targets

| Env | Host | Notes |
|---|---|---|
| `dev` | Laptop on normal Wi-Fi | HTTPS on a high port, no AP, simulated Nodes |
| `prod` | Raspberry Pi 4/5, `hostapd` + `dnsmasq`, no WAN | HTTPS on 443, real hardware |

---

## 2. Architecture

```
┌────────────────────────── HUB (RPi / laptop) ─────────────────────────┐
│  hostapd + dnsmasq  →  SSID <TBD>, gateway <TBD>                      │
│                                                                       │
│  ┌──────────────── single Node.js process ────────────────────────┐   │
│  │  nodeApp       HTTP  :3000  → Control Point Node API (Doc 00)  │   │
│  │  deviceApp     HTTPS :443   → Web App + /api + WSS (players)   │   │
│  │  spectatorApp  HTTP  :8080  → read-only scoreboard + WS        │   │
│  │  portalApp     HTTP  :80    → captive-portal probes + 301      │   │
│  │                                                                │   │
│  │        ┌──────────────── GameEngine ─────────────────┐         │   │
│  │        │  capture FSM · tag rules · 1 Hz scoring tick │         │   │
│  │        └────────┬───────────────────────┬────────────┘         │   │
│  │                 │                       │                       │   │
│  │        GameStateStore            NodeDispatcher                 │   │
│  │         ├ InMemoryStore          (queued outbound HTTP)         │   │
│  │         ├ FileSystemStore → data/*.json + series/*.ndjson       │   │
│  │         └ LohiStore (stub)                                      │   │
│  └────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────┘
      ▲ HTTPS/WSS            ▲ HTTP                ▲ HTTP  ▼ HTTP
   ┌──┴──────┐          ┌────┴─────┐          ┌────┴──────────────┐
   │ Phones  │          │ Host TV  │          │ Control Point     │
   │ Web App │          │ /scoreboard│        │ Nodes (ESP)       │
   └─────────┘          └──────────┘          └───────────────────┘
```

**HUB-010** Four Express applications, one process. The Node API MUST NOT share an app
instance with the device API — plaintext must never expose admin or WebSocket surface.

**HUB-011** `nodeApp` MUST bind **first** and MUST NOT depend on TLS material being
present. A missing or expired certificate can never break Control Point registration.

**HUB-012** Production binds ports 80/443 via
`setcap 'cap_net_bind_service=+ep' $(readlink -f $(which node))`. **Never run as root.**
Dev defaults to 8443, which needs no privilege.

**HUB-013** One `socket.io` instance, attached to **both** the HTTPS server and the
spectator HTTP server: `io.attach(httpsServer); io.attach(spectatorServer);`. Spectator
connections are read-only (HUB-094).

**HUB-014** `nodeApp` MUST expose no game-mutating endpoint beyond those in Doc 00, and
MUST NOT serve static assets, the Web App, or any admin surface.

**HUB-015** Startup order:
1. Load config
2. Init store
3. Seed the 8 teams (HUB-044)
4. Resolve any prior session (HUB-016)
5. Bind `nodeApp`
6. Bind `spectatorApp` and `portalApp`
7. Load/generate TLS material
8. Bind `deviceApp`

**HUB-016 — Restart policy.** On boot, if `station.currentSessionId` is set, the Hub MUST
**abandon** that session. No resume logic. Specifically, in one `batch()`:
- `session.endTimestamp = now`
- every `in_progress` capture → `captureStatus: 'abandoned'`, `abandonReason: 'hub_restart'`, `completeTimestamp = now`
- every player → `playerStatus: 'active'`
- every control point → `currentOwnerTeamId = null`, `capturingPlayerId = null`, `captureProgress = 0`
- `station.currentSessionId = null`
- push `neutralHexColor` to all Nodes

---

## 3. TLS, captive portal, onboarding

**HUB-020** The Web App requires `getUserMedia` (camera) and `geolocation`, both of which
require a **secure context**. The Web App MUST therefore be served over HTTPS.

**HUB-021** Two modes, selected by `TLS_MODE`:

| Mode | Behavior | Status |
|---|---|---|
| `selfsigned` | Generate on first boot into `DATA_DIR/tls/`, reuse thereafter | **v1 default** |
| `provided` | Load `TLS_CERT_PATH` / `TLS_KEY_PATH` | Drop-in upgrade path |

> **Upgrade note (not required for v1).** A real, warning-free cert *is* obtainable for an
> offline LAN: use an ACME **DNS-01** challenge (Let's Encrypt via `lego` / `acme.sh` /
> `certbot`) from any online machine, copy `fullchain.pem` + `privkey.pem` to the Hub, set
> `TLS_MODE=provided`, and point `dnsmasq` at the Hub with
> `address=/ctf.example.com/<HUB_IP>`. DNS-01 proves domain control via a TXT record and
> never contacts the Hub. Cost: a domain with an API-capable DNS provider, and 90-day
> manual renewal. Roughly 30 minutes of work.

**HUB-022** The generated self-signed cert MUST include SANs for **both** the DNS name and
the **IP address** (`IP:<HUB_IP>`), so `https://<gateway-ip>/` works with no DNS at all.
Validity 825 days. Key RSA-2048 (broadest mobile compatibility).

**HUB-023** A user-bypassed self-signed cert **is still a secure context** — camera and GPS
work after click-through. The known costs MUST be documented in the runbook:
- The bypass repeats per device and per browser
- Service workers will not register (no PWA / offline install)
- iOS requires *Show Details → visit this website*
- Chrome on Android: *Advanced → Proceed*

**HUB-024** The Hub MUST serve `GET /cert` returning the certificate in PEM and DER for
optional manual trust installation, and the Join Sheet MUST include click-through
instructions for iOS and Android.

### 3.1 Captive-portal survival

Mobile OSes probe for internet on join. Failing the probe causes "no internet" banners and,
on iOS, **silent fallback to cellular** — which takes players off the LAN mid-game.

**HUB-025** `dnsmasq` MUST wildcard-resolve all names to the Hub IP.

**HUB-026** `portalApp` MUST answer OS connectivity probes as success:

| Path | Response |
|---|---|
| `/hotspot-detect.html`, `/library/test/success.html` | `<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>` |
| `/generate_204`, `/gen_204` | `204 No Content` |
| `/connecttest.txt` | `Microsoft Connect Test` |
| `/ncsi.txt` | `Microsoft NCSI` |

**HUB-027** All other `portalApp` requests → `301` redirect to `PUBLIC_ORIGIN`.

### 3.2 Join Sheet

**HUB-030** `GET /join-sheet` on `deviceApp` renders a printable page containing:
1. Wi-Fi QR — `WIFI:T:WPA;S:<ssid>;P:<psk>;H:false;;`
2. App QR — `PUBLIC_ORIGIN`
3. The spectator scoreboard URL (plain HTTP, no warning)
4. Certificate click-through instructions for iOS and Android

---

## 4. Data model

### 4.1 Object types

Mirrors the Foundry ontology. **[+]** = new property, **[Δ]** = changed.

| API name | PK | Properties |
|---|---|---|
| `qrCtfTeam` | `teamId` | `teamName`, `hexColor`, `score` (double 0–1), `totalTagsInflicted` (int), `totalTagsReceived` (int) |
| `qrCtfStation` | `stationId` | `currentSessionId`, **[+]** `stationName`, **[+]** `captureDurationMs`, **[+]** `presenceGraceMs`, **[+]** `tagCooldownMs`, **[+]** `respawnImmunityMs`, **[+]** `neutralHexColor` |
| `qrCtfControlPoint` | `controlPointId` | `controlPointName`, `stationId`, `currentOwnerTeamId`, `capturingPlayerId`, `captureProgress` (0–1), `isHumanDetected` (bool), `locationLat`, `locationLong`, **[+]** `macAddress` |
| `qrCtfPlayer` | `playerId` | `playerName`, `stationId`, `sessionId`, `playerSessionId`, `teamId`, `qrCodeToken`, `playerStatus`, `profilePicture` (attachment), `locationLat`, `locationLong` |
| `qrCtfRespawnLocation` | `respawnLocationId` | `stationId`, `locationLat`, `locationLong`, `allowedTeamIds` (string[]) |
| `qrCtfSession` | `sessionId` | `sessionName`, `stationId`, `winningTeamId`, `startTimestamp`, `endTimestamp`, **[+]** `captureDurationMs` |
| `qrCtfPlayerSession` | `playerSessionId` | `sessionId`, `playerId`, `teamId`, `locationLatSeriesId`, `locationLongSeriesId`, `isAliveSeriesId`, `tagsInflictedSeriesId`, `tagsReceivedSeriesId`, `capturesCompletedSeriesId` |
| `qrCtfControlPointSession` | `controlPointSessionId` | `sessionId`, `controlPointId`, `ownerHistorySeriesId`, `isHumanDetectedHistorySeriesId` |
| `qrCtfTeamSession` | `teamSessionId` | `sessionId`, `teamId`, `scoreSeriesId`, `finalScore` (double), `totalTagsInflicted`, `totalTagsReceived` |
| `qrCtfTag` | `tagId` | `sessionId`, `sourcePlayerId`, `targetPlayerId`, `sourceTeamId`, `targetTeamId`, `locationLat`, `locationLong`, `tagTimestamp` |
| `qrCtfCapture` | `captureId` | `sessionId`, `playerId`, `capturingTeamId`, `controlPointId`, `startTimestamp`, `completeTimestamp`, `captureStatus`, **[+]** `abandonReason` |
| `qrCtfRespawn` | `respawnId` | `sessionId`, `playerId`, `respawnLocationId`, `respawnTimestamp` |

**Enums**

```ts
export type PlayerStatus   = 'active' | 'tagged_out' | 'respawning';
export type CaptureStatus  = 'in_progress' | 'complete' | 'abandoned';   // [Δ]

export type AbandonReason =                                              // [+]
  | 'presence_lost'      // isHumanDetected false for > presenceGraceMs
  | 'player_tagged'      // capturer was tagged mid-attempt (HUB-107)
  | 'player_cancelled'   // capture:cancel from the client
  | 'session_ended'      // admin stopped the session
  | 'node_offline'       // Node missed 3 heartbeats mid-capture
  | 'hub_restart';       // HUB-016
```

**HUB-040** Local TypeScript types MUST mirror these field-for-field so that swapping in
Lohi-generated types is an alias + codec change, not a refactor.

**HUB-041 — Denormalization contract.** `qrCtfTag.sourceTeamId` / `targetTeamId` and
`qrCtfCapture.capturingTeamId` record team membership **as of the event**. They MUST be
written from the player's team at event time and MUST NEVER be back-filled or corrected
when a player later switches teams.

**HUB-042 — Link contract.** Collections (`station.controlPoints`, `session.tags`, …) are
the reverse side of a one-to-many derived from the child's foreign key. Implementations
MUST derive collections by filtering on the FK, and MUST NOT maintain redundant arrays on
parents.

### 4.2 Ontology change list — apply these in Foundry

| # | Type | Change | Why |
|---|---|---|---|
| 1 | `qrCtfCapture` | `captureStatus` enum → `in_progress \| complete \| abandoned` | Aborted attempts must be representable |
| 2 | `qrCtfCapture` | **+** `abandonReason` (string, nullable) | Distinguishes "sensor dropped" from "got tagged" in analytics |
| 3 | `qrCtfStation` | **+** `captureDurationMs` (int) | Mutable admin setting |
| 4 | `qrCtfStation` | **+** `presenceGraceMs`, `tagCooldownMs`, `respawnImmunityMs` (int) | Field-tunable knobs |
| 5 | `qrCtfStation` | **+** `neutralHexColor` (string), `stationName` (string) | Unowned-point LED color; human label |
| 6 | `qrCtfSession` | **+** `captureDurationMs` (int) | Immutable per-round snapshot |
| 7 | `qrCtfControlPoint` | **+** `macAddress` (string) | Stable hardware identity; what the `cp` QR encodes |

**Deliberately NOT in the ontology** — Hub-local, non-synced sidecar. This is ephemeral
network plumbing that would be noise in Foundry:

`ipAddress`, `isOnline`, `lastSeenTimestamp`, `firmwareVersion`, `rssi`,
`desiredHexColor` / `reportedHexColor`, `playerSecret`, `ADMIN_PIN`.

**HUB-043** The Node registry is a Hub-local table keyed by MAC:

```ts
interface ControlPointNodeRecord {
  mac: string;
  ip: string;
  controlPointId: string | null;
  lastSeenMs: number;
  isOnline: boolean;
  fw: string;
  desiredColor: string;
  desiredPattern: 'solid' | 'pulse' | 'flash';
  reportedColor: string | null;
  rssi: number | null;
}
```

### 4.3 Capture duration — two fields, two roles

| Field | Role | Mutability |
|---|---|---|
| `qrCtfStation.captureDurationMs` | The admin's **current setting** | Mutable at any time, including mid-session |
| `qrCtfSession.captureDurationMs` | **Immutable snapshot** taken at session start | Written once, never patched |

**HUB-047** `station.captureDurationMs` is the mutable admin setting. Default `10000`.

**HUB-048** `session.captureDurationMs` MUST be written exactly once, at session creation,
by copying the station value (see HUB-165). It MUST NEVER be patched afterward.

**HUB-049** The `GameEngine` MUST read the capture duration from
**`session.captureDurationMs` only**. It MUST NOT read `station.captureDurationMs` during
play. Only the Admin UI and the session-creation path touch the station value. Editing
capture time mid-session therefore has no effect on the running session, and the Admin UI
MUST display *"Applies to the next session."*

> **Deliberate asymmetry.** `presenceGraceMs`, `tagCooldownMs`, and `respawnImmunityMs` live
> on the Station **only** and are read live. Rationale: `captureDurationMs` is a game rule
> affecting fairness and historical comparability, so it is frozen per round. The other
> three are field-tuning knobs — if the presence sensor misbehaves 10 minutes into a game,
> the admin must be able to raise `presenceGraceMs` without stopping the session.

### 4.4 Seed teams (hardcoded)

**HUB-044** On `store.init()`, idempotently upsert these eight teams by `teamId`.
`score` and `totalTags*` reset to 0 at **session start**, not at seed time.

```ts
export const SEED_TEAMS = [
  { teamId: 'e9b2b516-6c79-4e30-8177-32de66a37f29', teamName: 'Blue Bandits',  hexColor: '#3A48EA' },
  { teamId: '38c7ae2e-259d-42df-a13d-496dd7375dc8', teamName: 'Red Raiders',   hexColor: '#EE2D2D' },
  { teamId: 'cfa98610-1b23-4979-a733-18ba106a6f41', teamName: 'Green Goblins', hexColor: '#00E301' },
  { teamId: '718a369c-cfce-4814-9bf5-e934125d90a8', teamName: 'Yellow Yaks',   hexColor: '#FFFF00' },
  { teamId: '4f0cb7d5-5b11-4175-8a9c-4853f5fe2d2b', teamName: 'Cyan Cyclones', hexColor: '#00EAEA' },
  { teamId: '860d1e6b-57c1-4e7b-b234-1744c071e962', teamName: 'Pink Panthers', hexColor: '#EA76DD' },
  { teamId: '1949c46d-8759-4b66-9976-04ae17d9ee34', teamName: 'Grey Ghosts',   hexColor: '#7D7D7D' },
  { teamId: 'a2e4f279-ad40-4424-9ab9-f7be0247bbbf', teamName: 'Orange Orcs',   hexColor: '#F07D19' },
] as const;
```

**HUB-045** Teams are **fixed**. There is no team CRUD in the Admin UI. The admin MAY
choose which subset is *active* for a session; players pick only from active teams.

**HUB-046** `#FFFF00` (Yellow Yaks) and `#00E301` (Green Goblins) are near-identical on a
cheap WS2812 at low brightness, as are `#3A48EA` and `#00EAEA` in bright sun. The Admin UI
SHOULD warn when enabling both members of a confusable pair. See Doc 02 FW-052.

---

## 5. State layer

**HUB-050** All game state reads and writes go through a single `GameStateStore`. No module
outside a store implementation may touch files, memory maps, or Lohi.

**HUB-051** **Every store method returns a Promise, including in the in-memory
implementation.** This is the single most important forward-compatibility decision in the
project — a synchronous in-memory store turns the eventual Lohi swap into a whole-codebase
refactor. Free now, expensive later.

**HUB-052** `update` takes a **partial patch**: absent key = unchanged, `null` = clear.
Callers MUST NOT be required to pass unchanged fields.

**HUB-053** Series-valued properties are **not patchable** via `update`. They are
append-only via `TimeSeriesStore`.

**HUB-054** The store emits a change feed. All WebSocket broadcasts MUST derive from it and
MUST NOT be emitted ad hoc by callers, so no mutation can escape unbroadcast.

### 5.1 Interfaces (normative)

```ts
export type EpochMs  = number;   // internal monotonic-anchored clock
export type Iso8601  = string;   // Foundry timestamps
export type SeriesId = string;

export interface Repository<T, IdKey extends keyof T & string> {
  create(entity: T): Promise<T>;
  get(id: string): Promise<T | null>;
  list(filter?: Partial<T>): Promise<T[]>;
  /** Patch contains ONLY changed fields. PK and series-id fields are not patchable. */
  update(id: string, patch: Partial<Omit<T, IdKey>>): Promise<T>;
  delete(id: string): Promise<void>;
}

export type ChangeEvent =
  | { kind: 'created'; type: OntologyTypeName; id: string; after: unknown }
  | { kind: 'updated'; type: OntologyTypeName; id: string; patch: unknown; after: unknown }
  | { kind: 'deleted'; type: OntologyTypeName; id: string }
  | { kind: 'appended'; type: 'series'; seriesId: SeriesId; point: SeriesPoint };

export interface GameStateStore {
  readonly stations:             Repository<QrCtfStation, 'stationId'>;
  readonly teams:                Repository<QrCtfTeam, 'teamId'>;
  readonly players:              Repository<QrCtfPlayer, 'playerId'>;
  readonly controlPoints:        Repository<QrCtfControlPoint, 'controlPointId'>;
  readonly respawnLocations:     Repository<QrCtfRespawnLocation, 'respawnLocationId'>;
  readonly sessions:             Repository<QrCtfSession, 'sessionId'>;
  readonly playerSessions:       Repository<QrCtfPlayerSession, 'playerSessionId'>;
  readonly controlPointSessions: Repository<QrCtfControlPointSession, 'controlPointSessionId'>;
  readonly teamSessions:         Repository<QrCtfTeamSession, 'teamSessionId'>;
  readonly tags:                 Repository<QrCtfTag, 'tagId'>;
  readonly captures:             Repository<QrCtfCapture, 'captureId'>;
  readonly respawns:             Repository<QrCtfRespawn, 'respawnId'>;

  readonly series: TimeSeriesStore;
  readonly attachments: AttachmentStore;

  subscribe(listener: (e: ChangeEvent) => void): () => void;

  /** Best-effort atomic batch. In-memory/FS: real. Lohi: a single edit batch. */
  batch<R>(fn: (tx: GameStateStore) => Promise<R>): Promise<R>;

  init(): Promise<void>;
  close(): Promise<void>;
}
```

### 5.2 TimeSeriesStore

**Rationale.** Palantir Lohi embedded does **not** sync time series. Series must therefore
persist separately from object state, and the same component must be reusable by a future
OSDK sync job — hence the cursor bookkeeping, not just append/read.

```ts
export type SeriesValue = number | boolean | string;
export interface SeriesPoint<V extends SeriesValue = SeriesValue> { t: EpochMs; v: V }

export interface SeriesMeta {
  seriesId: SeriesId;
  ownerType: OntologyTypeName;   // 'qrCtfPlayerSession'
  ownerId: string;
  property: string;              // 'locationLat'
  valueType: 'double' | 'boolean' | 'string' | 'int';
  unit?: string;
  createdAt: EpochMs;
}

export interface TimeSeriesStore {
  createSeries(meta: Omit<SeriesMeta, 'seriesId' | 'createdAt'>): Promise<SeriesId>;
  getMeta(seriesId: SeriesId): Promise<SeriesMeta | null>;
  listSeries(f?: Partial<Pick<SeriesMeta, 'ownerType' | 'ownerId' | 'property'>>): Promise<SeriesMeta[]>;

  /** Append-only. MUST reject t older than the last point. */
  append<V extends SeriesValue>(id: SeriesId, p: SeriesPoint<V>): Promise<void>;
  appendMany<V extends SeriesValue>(id: SeriesId, ps: SeriesPoint<V>[]): Promise<void>;

  latest<V extends SeriesValue>(id: SeriesId): Promise<SeriesPoint<V> | null>;
  range<V extends SeriesValue>(id: SeriesId, fromMs: EpochMs, toMs: EpochMs): Promise<SeriesPoint<V>[]>;

  // --- Foundry / OSDK sync support: unused in v1, required by design ---
  readUnsynced(id: SeriesId, chunkSize?: number): AsyncIterable<SeriesPoint[]>;
  getSyncCursor(id: SeriesId): Promise<EpochMs | null>;
  setSyncCursor(id: SeriesId, throughMs: EpochMs): Promise<void>;
}
```

**HUB-060** The filesystem implementation MUST store each series as append-only NDJSON at
`data/series/<seriesId>.ndjson` — crash-safe, O(1) append, trivially streamable to OSDK.
Metadata in `data/series/index.json`, cursors in `data/series/cursors.json`.

**HUB-061** `append` MUST enforce non-decreasing `t` and reject out-of-order points.

**HUB-062 — Clock.** There is no in-app clock synchronization. The operator sets the system
clock manually before starting the service (`sudo date -s "..."`; see the runbook). The Hub
MUST log wall-clock time at startup and emit a **loud warning if it looks implausible**
(year < 2024). Regardless, all **durations** — capture timers, scoring ticks, heartbeat
timeouts — MUST be computed from monotonic time (`process.hrtime.bigint()` or
`performance.now()`), never from wall clock. Wall clock is used only for recorded
timestamps.

### 5.3 Attachments

**HUB-065** `profilePicture` is accessed only via `AttachmentStore`
(`put(bytes, mime) → AttachmentRef`, `getUrl(ref) → string`), because filesystem mode
stores a path while Foundry stores an attachment RID.

**HUB-066** Files land in `data/attachments/<ref>.jpg`, referenced by an opaque
`AttachmentRef`. **Never** base64-inlined into `state.json`.

**HUB-067** The server MUST reject uploads larger than **64 KB** or with dimensions greater
than **128×128** — belt and braces behind the client-side downscaling in HUB-171.

### 5.4 Lohi swap strategy

**HUB-070** Ontology types live in exactly one module: `packages/shared/src/ontology.ts`.
Game logic imports only from there, never from a store implementation.

**HUB-071** When Lohi ships, its generated types MUST be adapted at the store boundary via
explicit `toLohi` / `fromLohi` codecs inside `LohiStore`. **Lohi types MUST NOT appear in
`GameEngine` or in the Web App.**

---

## 6. WebSocket protocol

**HUB-090** The Hub is the sole authority. Clients report scans and render pushed state;
they never compute outcomes.

**HUB-091** `socket.io` over `wss://` on `deviceApp` and `ws://` on `spectatorApp`. The
client is bundled by Vite — **no CDN**.

**HUB-092** On connect the Hub sends one `state:snapshot`, then incremental `state:patch`
messages derived from the store change feed (HUB-054).

**HUB-093** Rooms: `session:<sessionId>`, `player:<playerId>`, `admins`, `spectators`.

### 6.1 Client → Server

| Event | Payload | Notes |
|---|---|---|
| `session:hello` | `{ playerId?, playerSecret?, role: 'player' \| 'admin' \| 'spectator' }` | Resume or create identity |
| `scan` | `{ raw, lat?, long?, accuracyM?, clientTs }` | **One unified event.** The server parses the QR payload and decides capture / tag / respawn. Clients MUST NOT classify scans. |
| `location` | `{ lat, long, accuracyM, clientTs }` | Throttled to ≥3 s |
| `capture:cancel` | `{ captureId }` | Player voluntarily abandons |
| `player:update` | `{ playerName?, teamId?, profilePicture? }` | Partial patch |
| `admin:*` | see §8.2 | Requires `ADMIN_PIN` |

### 6.2 Server → Client

| Event | Payload |
|---|---|
| `state:snapshot` | Full view: teams, control points, own player, scores, session |
| `state:patch` | `{ type, id, patch }` |
| `capture:started` | `{ captureId, controlPointId, durationMs, startedAtMs }` |
| `capture:progress` | `{ captureId, progress: 0..1, isHumanDetected }` — 5 Hz |
| `capture:completed` | `{ captureId, controlPointId, teamId }` |
| `capture:abandoned` | `{ captureId, abandonReason }` |
| `tag:inflicted` / `tag:received` | `{ tagId, otherPlayerId, … }` |
| `respawn:completed` | `{ respawnId }` |
| `scan:rejected` | `{ raw, reason }` — MUST always be sent for invalid or illegal scans so the UI can explain why nothing happened |
| `session:started` / `session:ended` | `{ sessionId, winningTeamId? }` |

**HUB-094** Spectator sockets receive only `state:snapshot` / `state:patch`, filtered to
teams, scores, and control points. **No player PII, no admin events.** Any client→server
event originating from a spectator socket MUST be dropped.

---

## 7. Game rules

### 7.1 Capture

**HUB-100** A Capture Attempt begins when an `active` player scans a claimed Control Point
during a running Session.

**HUB-101 — Preconditions.** All MUST hold, otherwise emit `scan:rejected` with the given
reason:

| Condition | Rejection reason |
|---|---|
| A Session is running | `no_session` |
| `player.playerStatus === 'active'` | `player_tagged_out` |
| The Control Point is claimed and `isOnline` | `node_offline` |
| `controlPoint.isHumanDetected === true` at scan time | `no_presence_detected` |
| No other Capture Attempt `in_progress` on this Control Point | `capture_in_progress` |
| The player has no other Capture Attempt `in_progress` | `already_capturing` |
| `controlPoint.currentOwnerTeamId !== player.teamId` | `already_owned_by_your_team` |

The last row means **redundant captures are rejected** — there is no "refresh" of a point
your team already holds.

**HUB-102** On start: create `qrCtfCapture { captureStatus: 'in_progress', startTimestamp }`,
set `controlPoint.capturingPlayerId`, start a **monotonic** timer of
**`session.captureDurationMs`** (per HUB-049), and push `pattern: 'pulse'` to the Node.

**HUB-103** Tick `controlPoint.captureProgress` from 0 → 1 and broadcast `capture:progress`
at **5 Hz**.

**HUB-104 — Presence grace.** The Hub MUST abandon on presence loss only after
`isHumanDetected === false` **continuously for `station.presenceGraceMs`** (default
2500 ms). A zero-tolerance rule makes the game unplayable with a motion sensor — see
risk R-3 and Doc 02 FW-002.

**HUB-105** On abandon: `captureStatus: 'abandoned'`, set `abandonReason` and
`completeTimestamp`, clear `capturingPlayerId` and `captureProgress`, restore
`pattern: 'solid'` with the owner's color, broadcast `capture:abandoned`.

**HUB-106** On success: `captureStatus: 'complete'`, set `completeTimestamp`; set
`controlPoint.currentOwnerTeamId = capture.capturingTeamId`; clear `capturingPlayerId` and
`captureProgress`; append to `controlPointSession.ownerHistorySeriesId`; increment the
player's `capturesCompletedSeriesId`; push the new team `hexColor` with `pattern: 'flash'`
then `solid`; broadcast `capture:completed`.

**HUB-107** If the capturing player is tagged mid-attempt, the attempt MUST abandon with
`abandonReason: 'player_tagged'`.

**HUB-108** Session end → abandon all `in_progress` captures with `session_ended`. A Node
going offline mid-capture → abandon with `node_offline`.

### 7.2 Tagging

**HUB-110** A Tag occurs when player A scans player B's `qrCodeToken`.

**HUB-111 — Preconditions.** Session running; A is `active`; B is `active`;
`A.teamId !== B.teamId`; A has no `in_progress` capture; A has not tagged B within
`station.tagCooldownMs` (default 10000 ms); B is not within `station.respawnImmunityMs` of
respawning.

**HUB-112** "Tagging is disabled during a capture" is scoped to **the capturing player
only** — they cannot *inflict* tags while their capture runs. Everyone else tags freely,
and the capturer **can be tagged**, which aborts their capture per HUB-107. This is
deliberate: it gives defenders something to do.

**HUB-113** On a valid Tag: create `qrCtfTag` with denormalized team IDs (HUB-041) and the
**tagger's** GPS; set `B.playerStatus = 'tagged_out'`; append to both players' tag series;
increment team counters; broadcast.

### 7.3 Respawn

**HUB-120** A `tagged_out` player scans a Respawn Location QR. The Hub MUST validate that
`respawnLocation.allowedTeamIds` contains the player's `teamId`. **An empty array means any
team.**

**HUB-121** On success: create `qrCtfRespawn`, set `playerStatus = 'active'`, append `true`
to `isAliveSeriesId`, broadcast `respawn:completed`.

**HUB-122** A `tagged_out` player MUST NOT inflict tags, be tagged, or start captures.

**HUB-123** A respawned player is immune from being tagged for `station.respawnImmunityMs`
(default 5000 ms), to prevent spawn-camping.

**HUB-124** `playerStatus: 'respawning'` is **never written by the engine in v1**. It
remains in the type for schema parity and for a future timed respawn penalty.

### 7.4 Scoring

**HUB-130** Score is the **normalized share of cumulative control-point hold time**:

```
holdSeconds(team) = Σ over control points of seconds that team held it this session
score(team)       = holdSeconds(team) / Σ over all teams holdSeconds(team)
```

**HUB-131** Evaluated on a **1 Hz tick**. Values always sum to 1.0 across teams. Before any
point has been held, all scores are 0.

**HUB-132** Each tick appends to every `teamSession.scoreSeriesId` and updates
`qrCtfTeam.score`.

**HUB-133** On session end: set `endTimestamp`; `winningTeamId` = the team with the highest
score; write `teamSession.finalScore`, `totalTagsInflicted`, `totalTagsReceived`.

### 7.5 Anti-cheat posture

**HUB-140** Player QR codes are printed on shirts and are therefore photographable;
screenshot-based fake tags are possible. **Accepted risk for a hackweek.** Required
mitigations: `tagCooldownMs`, status preconditions, `respawnImmunityMs`, and a server-side
audit log of every rejected scan.

**HUB-141** Admin actions are gated by a shared `ADMIN_PIN` set at Hub startup and passed
on `session:hello`. This is deterrence, not security.

---

## 8. Web App

**HUB-150** On first load, present a mode chooser: **Player** or **Admin**. Admin requires
the PIN.

**HUB-151** Identity persists in `localStorage` (`playerId` + `playerSecret`) so a refresh
or a backgrounded browser resumes the same player.

**HUB-152** The app MUST be fully functional with no internet: no CDN fonts, no external
analytics, no map tiles. Everything bundled by Vite.

### 8.1 Node claiming flow

1. Node boots → `POST /api/cp/register` → appears in the Admin UI as **unclaimed**, keyed by MAC
2. Admin scans the Node's printed `qrctf:1:cp:<MAC>` sticker
3. Web App sends `{ macAddress, lat, long, controlPointName }` → Hub creates
   `qrCtfControlPoint` and binds `controlPointId ↔ macAddress`
4. Hub pushes `neutralHexColor`

**HUB-160** A Control Point MUST NOT participate in gameplay until it is claimed and holds
coordinates.

**HUB-161** Scanning a `cp` sticker whose MAC has never registered MUST still create the
Control Point (pre-staging), displayed as "awaiting hardware".

### 8.2 Admin mode

| Screen | Capability |
|---|---|
| **Nodes** | List MAC, IP, online status, claimed status, desired vs reported color, RSSI. Claim via QR + current GPS. Rename. Delete. `POST /identify` test-blink. |
| **Respawn Locations** | Create via QR + GPS; set `allowedTeamIds`; rename; delete; print placards |
| **Teams** | **Read-only** list of the 8 seed teams; toggle which are active for this session |
| **Session** | Start / Stop; `sessionName`; `captureDurationMs` ("Capture Time (ms)", labelled *Applies to the next session*); live tuning of `presenceGraceMs` / `tagCooldownMs` / `respawnImmunityMs`; live scoreboard; event log |
| **Players** | Roster; regenerate `qrCodeToken`; print shirt-QR sheet; force-respawn |
| **Join Sheet** | Print Wi-Fi QR + App QR + cert instructions |

**HUB-165 — Session start.** Starting a Session MUST perform all of the following inside a
single `batch()`:
- create `qrCtfSession`, **snapshotting `captureDurationMs` from the station** (HUB-048)
- set `station.currentSessionId`
- create `qrCtfPlayerSession`, `qrCtfControlPointSession`, and `qrCtfTeamSession` rows with
  **every series provisioned** via `createSeries`
- reset all team counters and scores to 0
- set all players `active`
- clear all control point ownership
- push `neutralHexColor` to all Nodes

### 8.3 Player mode

**HUB-170** First run: profile creation — `playerName`, `teamId` (from the active team
list), optional photo from the camera.

**HUB-171** Photos MUST be downscaled client-side to **≤128×128 JPEG, quality ≈0.7**
(target < 8 KB) before upload. An RPi filesystem, and any future Foundry attachment upload,
will not tolerate raw phone photos.

**HUB-172** The play screen has exactly two regions:

- **Camera View** — `<video playsinline muted autoplay>` with continuous QR decoding. One
  scan handler; the server classifies the payload. The same payload scanned twice within
  2 s MUST be deduplicated client-side.
- **Stats** — own `playerName`, team color swatch, `tagsInflicted`, `tagsReceived`,
  `playerStatus` badge; team scoreboard sorted by score descending; an **Edit** button
  opening the profile dialog.

**HUB-173** During a Capture Attempt the Camera View MUST overlay a progress ring driven by
`capture:progress`, and MUST visibly indicate `isHumanDetected === false` during the grace
window ("Keep moving!").

**HUB-174** `playerStatus === 'tagged_out'` MUST be unmistakable: full-screen tint plus
"Return to your respawn point".

**HUB-175** GPS uses `watchPosition`, throttled to ≥3 s, is **optional**, and MUST NOT gate
any game outcome. Coordinates are recorded for Foundry analytics only.

**HUB-176 — Spectator scoreboard.** `spectatorApp` serves `GET /scoreboard`: a
large-format, read-only, auto-updating board over **plain HTTP**. It needs no camera and no
GPS, therefore no secure context, therefore **no certificate warning** on the host's laptop
or a venue TV. Contents: ordered team scores with color bars, a control-point ownership
grid, a recent-event ticker, and the session timer. Must be legible from 3 m.

**HUB-177** QR payload handling per Doc 00 §0.5. Unknown scheme or version → `scan:rejected`.

**HUB-178** `qrCodeToken` MUST be a random string of ≥16 characters, never the `playerId`,
and MUST be regenerable from the Admin UI if a shirt is compromised.

---

## 9. Stack, repo layout, configuration

**HUB-190** TypeScript everywhere · Vite + React 18 + `@blueprintjs/core` v5+ · Node 20 +
Express + `socket.io` · `pnpm` workspaces · **Zod validation on every inbound HTTP body and
WebSocket payload**.

```
foundry-ctf/
  docs/
    00-WIRE-CONTRACT.md
    01-HUB.md
    02-CONTROL-POINT.md
  packages/shared/          # ontology types, seed teams, QR codecs, WS contracts, zod schemas
  apps/hub-server/src/
    http/
      nodeApp.ts            # Control Point Node API  (:3000, HTTP)
      deviceApp.ts          # Web App + /api          (:443, HTTPS)
      spectatorApp.ts       # scoreboard              (:8080, HTTP)
      portalApp.ts          # captive portal          (:80,  HTTP)
    ws/                     # socket.io gateway, snapshot/patch
    engine/                 # capture FSM, tag rules, scoring tick
    nodes/                  # ControlPointNode registry + NodeDispatcher
    store/
      GameStateStore.ts     # interface (§5.1)
      InMemoryStore.ts
      FileSystemStore.ts
      TimeSeriesStore.ts    # + FileSystemTimeSeriesStore (NDJSON)
      AttachmentStore.ts
      LohiStore.ts          # stub
    config.ts
  apps/web/                 # Vite React SPA — player, admin, scoreboard routes
  tools/sim-control-point/  # N simulated Nodes   (Hub agent owns)
  tools/mock-hub/           # stub Hub            (firmware agent owns)
  ops/                      # hostapd.conf, dnsmasq.conf, systemd unit, gen-cert.sh
  data/                     # gitignored: state.json, series/*.ndjson, attachments/, tls/
```

**HUB-191** In dev, Vite runs its own HTTPS dev server (`@vitejs/plugin-basic-ssl`) and
proxies `/api` and `/socket.io` to the Hub Server. Camera access must be testable in dev,
so the dev server **cannot** be plain HTTP. In prod, the Hub serves `apps/web/dist`
statically.

### 9.1 NodeDispatcher

**HUB-195** Outbound dispatch MUST be non-blocking and queued **per Node**: at most one
in-flight request, 2 s timeout, latest-value-wins coalescing, exponential backoff with a
cap. `ESP8266WebServer` serves one connection at a time and will otherwise head-of-line
block the game loop.

**HUB-196** Track `desiredColor` vs `reportedColor` per Node and reconcile continuously via
retry plus the presence and heartbeat responses (Doc 00 CON-014 / CON-016). Push is never
load-bearing.

### 9.2 Configuration

| Var | Dev | Prod |
|---|---|---|
| `STORE_DRIVER` | `filesystem` | `filesystem` |
| `DATA_DIR` | `./data` | `/var/lib/foundry-ctf` |
| `NODE_HTTP_PORT` | 3000 | 3000 |
| `DEVICE_HTTPS_PORT` | 8443 | 443 |
| `SPECTATOR_HTTP_PORT` | 8080 | 8080 |
| `PORTAL_HTTP_PORT` | *disabled* | 80 |
| `TLS_MODE` | `selfsigned` | `selfsigned` |
| `TLS_CERT_PATH` / `TLS_KEY_PATH` | — | used when `TLS_MODE=provided` |
| `PUBLIC_ORIGIN` | `https://localhost:8443` | `https://<HUB_IP>` (**TBD**, Q-A) |
| `CAPTURE_DURATION_MS` | 10000 | 10000 |
| `PRESENCE_GRACE_MS` | 2500 | 2500 |
| `TAG_COOLDOWN_MS` | 10000 | 10000 |
| `RESPAWN_IMMUNITY_MS` | 5000 | 5000 |
| `HEARTBEAT_INTERVAL_MS` | 15000 | 15000 |
| `NEUTRAL_HEX_COLOR` | `#FFFFFF` | `#FFFFFF` |
| `UNCLAIMED_HEX_COLOR` | `#202020` | `#202020` |
| `ADMIN_PIN` | `1234` | required |
| `STATION_ID` | generated once, persisted | same |

Env vars seed the corresponding `qrCtfStation` properties on first boot only; thereafter the
Station record is authoritative and the Admin UI edits it.

---

## 10. Testing

**HUB-200** `tools/sim-control-point` MUST simulate N Nodes: register, heartbeat, expose
`/set-color`, `/status`, and `/identify`, and toggle presence on a schedule or by keypress.
**Full end-to-end play MUST be testable on a laptop with zero ESPs.**

**HUB-201** `GameEngine` MUST be unit-testable with an injected fake clock and
`InMemoryStore`, giving deterministic capture-timer tests.

**HUB-202** One **contract test suite** MUST run against *every* `GameStateStore`
implementation, so `LohiStore` can later be validated against identical expectations.

---

## 11. Milestones

| # | Exit criteria |
|---|---|
| **M0** | Four listeners up; Web App served over HTTPS; `sim-control-point` registers successfully |
| **M1** | `InMemoryStore` + `FileSystemStore` + `TimeSeriesStore` pass the contract suite; 8 teams seeded |
| **M2** | register → presence → heartbeat → `/set-color` round-trip against the simulator; reconciliation proven by deliberately dropping a push |
| **M3** | WS snapshot/patch; profile creation with a 128×128 photo; Stats renders live; scoreboard page works |
| **M4** | Capture (with grace window), Tag, Respawn, 1 Hz scoring, session start/stop |
| **M5** | Admin: claim by QR, respawn locations, join sheet, printable sheets |
| **M6** | One real ESP Node end-to-end |
| **M7** | RPi AP, systemd unit, 6+ real phones, one complete game |

---

## 12. Risk register

| ID | Risk | Sev | Mitigation |
|---|---|---|---|
| **R-1** | Self-signed TLS friction on player devices | 🟡 Med | Accepted. Reduced by IP SAN (HUB-022), `/cert` endpoint (HUB-024), documented click-through, and the plain-HTTP scoreboard for observers (HUB-176). **Validate on the actual demo iPhone and Android in week 1.** `TLS_MODE=provided` remains a ~30-minute upgrade via ACME DNS-01. |
| **R-3** | Presence sensor detects motion, not presence | 🔴 High | Owned by Doc 02 (FW-002). Hub-side mitigation is `presenceGraceMs` (HUB-104) plus "Keep moving!" UI (HUB-173). **This is the top project risk.** |
| **R-4** | Hub→Node push depends on a stable ESP IP | 🟢 Low | Neutralized by DHCP reservations, re-register on boot (CON-010), and response-carried authoritative color (CON-014/016). |
| **R-5** | Mobile OS drops the AP for lack of internet | 🟡 Med | Fully mitigated by HUB-026. **Implement early — it is a demo-killer.** |
| **R-6** | RPi onboard Wi-Fi client capacity (~8–15) | 🟡 Med | Players + Nodes share one 2.4 GHz radio. If >10 players, put a travel router in AP mode on the Pi's Ethernet and let the Pi be a pure server. |
| **R-7** | Wall-clock correctness with no RTC/NTP | 🟡 Med | Operator sets the clock manually (HUB-062); durations use monotonic time; startup warning on implausible dates. A DS3231 RTC module (~$3) removes this risk entirely. |
| **R-8** | Sync-vs-async store interface | 🟢 Low / high leverage | HUB-051. Free now, expensive later. |
| **R-10** | Blueprint on phones | 🟢 Low | Desktop-density library. Budget CSS time: ≥44 px hit targets, prefer `Dialog` / `Drawer` / `Toaster`, hand-roll the Camera View rather than fighting the grid. Blueprint v5+ requires React 18 and explicit CSS imports. |
| **R-12** | Battery drain (camera + GPS + WSS) | 🟢 Low | Decode at 5–10 fps, GPS ≥3 s, pause the camera when backgrounded, tell players to arrive charged. |
| **R-13** | QR screenshot cheating | 🟢 Low | Accepted; cooldowns, status preconditions, and an audit log. |

**QR decode library:** use `@zxing/browser` or `nimiq/qr-scanner`. **Do not** depend on the
native `BarcodeDetector` API — it is Chromium/Android-only and absent on iOS Safari.

---

## 13. Open questions

| ID | Question | Blocks | Default if unresolved |
|---|---|---|---|
| **Q-A** | Final SSID / PSK / gateway IP | Join Sheet (HUB-030), `PUBLIC_ORIGIN` | `FoundryCTF` / `capturetheflag` / `10.0.0.1`, DHCP `10.0.0.50–150` |
| **Q-D** | Peak player / Node / respawn-location counts | R-6 sizing, list virtualization | 12 players, 6 Nodes, 4 respawn locations |

Neither blocks writing code. Both are single constants — stub as `TBD` in config.

---

<!-- PASTE-APPENDIX-A -->
## Appendix A — Wire Contract

The full text of `docs/00-WIRE-CONTRACT.md` is normative and forms part of this document.
Read it before implementing anything in §2 (`nodeApp`) or §9.1 (`NodeDispatcher`).

Run the Appendix A build step to inline it here.
