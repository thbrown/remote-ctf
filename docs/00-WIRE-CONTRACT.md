# Doc 00 — Foundry CTF Wire Contract

**Version:** 1.0
**Status:** Normative, shared
**Requirement prefix:** `CON-`
**Owners:** Hub agent AND Firmware agent (joint)

---

## HOW TO USE THIS DOCUMENT

This file is the **single source of truth** for the protocol between the Hub and the
Control Point Nodes. It is reproduced as Appendix A in both `01-HUB.md` and
`02-CONTROL-POINT.md`.

**Conflict rule:** If any other document, comment, or implementation disagrees with this
file, **this file wins**. Do not silently adapt to a discrepancy — report it and stop.

**Edit rule:** Never edit this contract in only one place. Edit `00-WIRE-CONTRACT.md` and
re-run the Appendix A build step.

Requirements are numbered `CON-nnn` and are normative. MUST / SHOULD / MAY per RFC 2119.

---

## 0.1 Roles and terms

| Term | Meaning |
|---|---|
| **Hub** | Raspberry Pi (laptop in dev) running the Wi-Fi AP and the Node.js game server. Sole authority for all game state. |
| **Control Point Node** ("Node") | Physical ESP module + human-presence sensor + RGB LED. Identified by `macAddress`. Owns no game logic. |
| **Control Point** | The *logical* game objective, ontology record `qrCtfControlPoint`. Created when an admin claims a Node. |
| **claimed** | A Node has been bound to a Control Point and given GPS coordinates. Unclaimed Nodes are inert. |
| **presence** | A human appears to be physically at the Node *right now*. Not "motion was seen recently". |

**CON-001** A Node is a dumb sensor + actuator. It MUST NOT track ownership, capture
progress, teams, scores, or timers. It reports presence, and it renders the color the Hub
tells it to render.

---

## 0.2 Network parameters

| Parameter | Value | Notes |
|---|---|---|
| SSID | `TBD` | **Q-A** — blocks firmware `config.h` |
| PSK | `TBD` | **Q-A** |
| Security | **WPA2-PSK, 2.4 GHz only** | ESP8266 cannot join WPA3 or 5 GHz |
| Hub gateway IP | `TBD` (proposed `10.0.0.1`) | **Q-A** |
| Hub Node-API port | **`3000`**, plain HTTP | Never TLS |
| Node HTTP server port | **`80`**, plain HTTP | On the ESP |
| Node IP assignment | DHCP, reserved per-MAC in `dnsmasq` | Stable across reboots |

**CON-002** All Node↔Hub traffic is **plaintext HTTP/1.1**. The ESP MUST NOT be asked to
perform TLS. The Hub's HTTPS listener is for browsers only and is a separate Express app
on a separate port.

**CON-003** The Node MUST address the Hub by **hardcoded IP address**. No DNS, no mDNS,
no discovery protocol.

**CON-004** Content type is `application/json` in both directions. All request and
response bodies are **flat objects** — no nesting, no arrays. This keeps ESP-side JSON
handling trivial.

**CON-005** `mac` is the primary identifier in every Node→Hub request. Canonical format is
**uppercase, colon-separated**: `AA:BB:CC:DD:EE:FF`. The Node MUST send uppercase. The Hub
MUST normalize case defensively on receipt.

**CON-006** `hexColor` is always **`#RRGGBB`**, uppercase, including the leading `#`.

**CON-007** Every request MUST complete or time out within 2000 ms. Neither side may block
on the other.

---

## 0.3 Node → Hub

Base URL: `http://<HUB_IP>:3000`

### `POST /api/cp/register`

Called on every boot, and again after every Wi-Fi reconnect.

```jsonc
// request
{
  "mac": "AA:BB:CC:DD:EE:FF",
  "ip":  "10.0.0.51",
  "fw":  "1.0.0"
}

// 200 response
{
  "claimed": true,
  "controlPointId": "cp_7f3a",     // null when claimed = false
  "hexColor": "#3A48EA",
  "pattern": "solid",
  "heartbeatIntervalMs": 5000
}
```

**CON-010** Idempotent. Safe to call any number of times. The Hub MUST overwrite the
stored `ip` on every call.

**CON-011** An unknown MAC MUST be auto-registered as `claimed: false` and answered with
`200` — **never `404`**. A Node that boots before the Hub, or before an admin claims it,
must still function.

**CON-012** When `claimed: false`, `hexColor` MUST be the configured `unclaimedHexColor`
(default `#202020`, near-off) so unclaimed hardware is visually distinct from a neutral
in-play Control Point.

---

### `POST /api/cp/presence`

Called on every debounced sensor edge transition.

```jsonc
// request
{ "mac": "AA:BB:CC:DD:EE:FF", "detected": true }

// 200 response
{ "hexColor": "#3A48EA", "pattern": "pulse" }
```

**CON-013** This is a **state assertion, not an event**. Receiving `detected: true` twice
is not two detections. Duplicates and retries are therefore harmless, which is what makes
the ESP's retry logic safe to keep simple.

**CON-014** The response carries the authoritative color, and the Node MUST apply it. This
is the **fast self-heal path** — a Node that missed a `/set-color` push corrects itself on
the next presence transition.

**CON-015** The Node MUST debounce the sensor for **≥500 ms** before reporting a
transition.

---

### `POST /api/cp/heartbeat`

Called every `heartbeatIntervalMs` (default 5000 ms, taken from the register response).

```jsonc
// request
{
  "mac": "AA:BB:CC:DD:EE:FF",
  "ip": "10.0.0.51",
  "detected": false,
  "hexColor": "#3A48EA"          // what the Node is CURRENTLY showing
}

// 200 response
{
  "claimed": true,
  "controlPointId": "cp_7f3a",
  "hexColor": "#3A48EA",         // what the Node SHOULD be showing
  "pattern": "solid",
  "heartbeatIntervalMs": 5000
}
```

**CON-016** Heartbeat is the **slow reconciliation path**. The Node reports what it is
currently rendering; the Hub replies with what it should be rendering. Any divergence
self-corrects within one interval.

**CON-017** A Node silent for `3 × heartbeatIntervalMs` MUST be marked offline by the Hub
and surfaced in the Admin UI.

---

## 0.4 Hub → Node

Base URL: `http://<node.ip>:80`

### `POST /set-color`

```jsonc
// request
{ "hexColor": "#EE2D2D", "pattern": "solid" }

// 204 No Content
```

**CON-020** `pattern` ∈ `solid | pulse | flash`. Firmware MUST accept all three values.
Rendering `pulse` and `flash` as `solid` is acceptable in v1. Semantics:

| pattern | Meaning |
|---|---|
| `solid` | Idle / owned / neutral — steady color |
| `pulse` | A capture is in progress at this point |
| `flash` | A capture just completed. The Node MAY auto-return to `solid` after ~2 s. |

**CON-021** The Node MUST respond within 2000 ms. The Hub treats a timeout as failure and
retries with exponential backoff.

**CON-022** Push is **best-effort**. Correctness is guaranteed by CON-014 and CON-016, and
MUST NOT depend on push alone.

---

### `GET /status` — diagnostics

```jsonc
{
  "mac": "AA:BB:CC:DD:EE:FF",
  "fw": "1.0.0",
  "hexColor": "#EE2D2D",
  "pattern": "solid",
  "detected": false,
  "uptimeMs": 412000,
  "rssi": -61
}
```

### `POST /identify` — admin "find this Node"

Empty body → `204 No Content`. The Node blinks white for ~3 s, then restores its color.

---

## 0.5 QR payload format

**CON-030** Every QR code in the system uses the scheme
`qrctf:<version>:<kind>:<value>`.

| Kind | Payload | Printed by | Encodes |
|---|---|---|---|
| `cp` | `qrctf:1:cp:AA:BB:CC:DD:EE:FF` | **Firmware/hardware owner**, at assembly | Node MAC |
| `rp` | `qrctf:1:rp:<respawnLocationId>` | Hub Admin UI | Respawn Location ID |
| `pl` | `qrctf:1:pl:<qrCodeToken>` | Hub Admin UI | Player token (≥16 random chars) |
| join | `https://<host>/` (a plain URL) | Hub Admin UI | Web App URL |

**CON-031** The `cp` sticker is the **only** contract artifact the firmware side must
physically produce. It MUST be affixed to the enclosure and remain legible after outdoor
deployment.

**CON-032** MAC colons are retained inside the `cp` payload. Parsers MUST split on the
**first three colons only**; everything after the third colon is the value.

**CON-033** The join QR is a bare URL (not `qrctf:`) so that a phone's native camera app
can open it directly.

---

## 0.6 Error handling

| Situation | Hub returns | Node must |
|---|---|---|
| Malformed body / missing `mac` | `400 { "error": "..." }` | Log, retry with backoff |
| Unknown MAC | `200`, `claimed: false` | Operate as unclaimed |
| Hub unreachable | — | Retry 1s → 2s → 4s … cap 30s. Never block the LED loop. **Never reboot.** |
| Node unreachable | — | Hub retries with backoff; marks offline per CON-017 |
| Node returns non-2xx | — | Hub logs, retries, does not crash |

**CON-040** Neither side may enter a state that requires a power cycle to escape. All
failure modes MUST be self-recovering.

---

## 0.7 Open questions blocking this contract

| ID | Question | Blocks |
|---|---|---|
| **Q-A** | Final SSID, PSK, and Hub gateway IP. Proposed: `FoundryCTF` / `capturetheflag` / `10.0.0.1`, DHCP pool `10.0.0.50–150`, Nodes reserved from `.51`. | Firmware `config.h` (FW-030), Hub Join Sheet (HUB-030) |

Both sides MUST use the placeholder `TBD` until Q-A is resolved, and MUST NOT invent
divergent defaults.
