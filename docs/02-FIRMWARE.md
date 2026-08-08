# Doc 02 — Foundry CTF Control Point Node (Firmware)

**Version:** 0.1
**Status:** Draft — **blocked on Q-C (hardware selection) before ordering**
**Requirement prefix:** `FW-`
**Audience:** The AI agent implementing the firmware. Whoever builds the hardware.
**Companion docs:** `00-WIRE-CONTRACT.md` (normative, Appendix A), `01-HUB.md` (server, FYI)

---

## HOW TO READ THIS DOCUMENT

- Requirements are numbered `FW-nnn` and are normative. MUST / SHOULD / MAY per RFC 2119.
- **Conflict rule:** where this document disagrees with `00-WIRE-CONTRACT.md`, the wire
  contract wins. Report the discrepancy; do not silently adapt.
- Two items (FW-001, FW-002) recommend **departing from the original hardware brief**. Both
  have ordering lead time. Read §2 first and escalate before buying anything.

---

## 1. What you are building

A battery- or USB-powered enclosure containing an ESP8266-class Wi-Fi module, a
human-presence sensor, and an RGB LED.

It does exactly three things:
1. Joins a known Wi-Fi AP
2. Reports whether a human is standing at it
3. Lights up in whatever color the Hub tells it to

**It contains no game logic** — no teams, no scores, no capture timers, no ownership, no
knowledge of other Nodes or of player phones. See wire contract CON-001.

**Build target:** N = 6 Nodes (default assumption, see Q-D).

---

## 2. Hardware — read before ordering

### FW-001 — Board choice ⚠️

The original brief specifies **ESP-01**. The ESP-01 is a **poor fit**. Use an **ESP-01S**,
or preferably an **ESP-12F / D1 Mini / ESP32 dev board**:

1. **Boot-strapping pins.** Plain ESP-01 breaks out only GPIO0 and GPIO2, and **both must
   be HIGH at boot** or the chip enters flash mode. A PIR output idles LOW — wire it to
   GPIO0 or GPIO2 and the module simply will not boot. That leaves GPIO3 (RX) as the only
   safe input.
2. **UART conflict.** The recommended presence sensor (FW-002) is UART. On ESP-01, UART is
   simultaneously your only debug channel and your only free input.
3. **Flash size.** ESP-01 variants with 512 KB/1 MB flash cannot do OTA updates.

Cost delta is roughly $2 per unit and the pin/boot headaches vanish entirely.
**Escalate before ordering if ESP-01 is a hard constraint.**

### FW-002 — Sensor choice ⚠️ (top project risk)

A PIR (HC-SR501 and similar) detects **motion**, not **presence**. A player standing still
on a Control Point for 10 seconds will very likely read as absent and abort their own
capture — which breaks the game's core mechanic.

Use an **mmWave presence radar: HLK-LD2410 / LD2410C.** It detects stationary humans and is
the correct sensor for "stand here for N seconds." It is UART, which reinforces FW-001.

**If PIR is unavoidable:** set the sensitivity and hold-time potentiometers to maximum,
rely on the Hub's `presenceGraceMs` window (recommend raising it to 4000 ms), and report the
limitation explicitly so the Hub agent can frame the UI as "keep moving."

### Reference BOM (per Node)

| Part | Suggested | Note |
|---|---|---|
| MCU | ESP-01S / ESP-12F / D1 Mini | FW-001 |
| Presence sensor | HLK-LD2410C | FW-002 |
| LED | WS2812B, or an 8-pixel ring | FW-003 |
| Power | USB power bank, ≥5000 mAh | Must survive a full game |
| Regulator | AMS1117-3.3 if not on-board | ESP peaks around 350 mA |
| Enclosure | Weather-resistant, translucent lid | Radar sees through plastic, **not** metal |

### FW-003 — LED

Use one **WS2812B / NeoPixel** — a single data pin, so you don't need three PWM channels you
don't have. Power it at 3.3 V, or level-shift the data line: 3.3 V data into a 5 V-powered
WS2812 is marginal and flaky. **Diffuse it** — a bare pixel is invisible outdoors.

### FW-004 — Pinout if constrained to ESP-01

Presence sensor → **GPIO3 (RX)**. WS2812 data → **GPIO2**. GPIO0 unused and pulled HIGH.
Verify the module boots with the sensor **physically attached**, not merely powered
separately.

### FW-005 — Mounting

The sensor must have a clear line of sight to where a player stands, roughly waist-to-chest
height. Do not point it at the ground or at moving foliage.

---

## 3. Behavior

### 3.1 State machine

```
BOOT → WIFI_CONNECTING → REGISTERING → RUNNING
             ↑                            │
             └────────(link lost)─────────┘
```

**FW-010 — BOOT.** Read own MAC, initialize the LED to dim white, initialize the sensor.

**FW-011 — WIFI_CONNECTING.** Join the hardcoded SSID/PSK. LED: slow blue pulse. On failure,
retry forever with backoff (1 s → 30 s cap). **Never reboot as a recovery strategy.**

**FW-012 — REGISTERING.** `POST /api/cp/register` (CON-010). Retry with backoff. LED: fast
white blink. Store `heartbeatIntervalMs` from the response.

**FW-013 — RUNNING.** Three concurrent duties, none of which may block the others:
- Poll the sensor, debounce ≥500 ms, `POST /api/cp/presence` on every transition (CON-013, CON-015)
- `POST /api/cp/heartbeat` every `heartbeatIntervalMs` (CON-016)
- Serve `POST /set-color`, `GET /status`, `POST /identify` on port 80 (CON-020)

**FW-014** Apply the `hexColor` and `pattern` from **every** Hub response — register,
presence, and heartbeat (CON-014). **This is the self-heal mechanism and is not optional.**

**FW-015** On Wi-Fi loss, return to `WIFI_CONNECTING` and then **re-register** — the IP may
have changed. The LED holds its last color while disconnected; a disconnected Node should
not visibly panic mid-game.

**FW-016** The LED render loop MUST never be blocked by a network call. **No `delay()` in the
main loop** — use non-blocking timers. A Hub that is down must not freeze the LED.

### 3.2 Explicitly not your job

**FW-020** The Node MUST NOT: store team, owner, or score state; run capture timers; decide
whether a capture succeeded; communicate with any other Node; communicate with player
phones; or perform TLS.

### 3.3 Sensor semantics

**FW-021** `detected: true` means "a human appears to be present at this Control Point
**right now**." Publish transitions only, not a stream. Publishing the same value twice is
harmless (CON-013) but wasteful.

**FW-022** Tune debounce and sensitivity so that a person standing still reads `true`
**continuously for ≥15 s**. **This is the single most important acceptance test in this
document.** If it fails, the game does not work.

---

## 4. Configuration

**FW-030** All deployment constants live in exactly one header, `config.h`, so reflashing
for a new venue is a one-file edit:

```c
#define CTF_WIFI_SSID        "TBD"          // Q-A
#define CTF_WIFI_PSK         "TBD"          // Q-A
#define CTF_HUB_IP           "10.0.0.1"     // Q-A — hardcoded IP, never DNS (CON-003)
#define CTF_HUB_PORT         3000
#define CTF_FW_VERSION       "1.0.0"
#define CTF_HEARTBEAT_MS     5000           // overridden by the register response
#define CTF_DEBOUNCE_MS      500
#define CTF_HTTP_TIMEOUT_MS  2000
#define CTF_NODE_HTTP_PORT   80
```

**FW-031** The Hub must be reachable at a **fixed IP**. Do not implement DNS or mDNS
discovery. Coordinate the final SSID / PSK / IP with the Hub owner — currently unresolved
(**Q-A**). Use `TBD` until it is; do not invent a value.

**FW-032** `CTF_WIFI_PSK` MUST NOT be committed to git. Ship `config.h.example` and
gitignore `config.h`.

---

## 5. Physical deliverables

**FW-040** Each Node ships with a printed, weather-resistant QR sticker on the enclosure
encoding `qrctf:1:cp:<ITS OWN MAC>` (CON-030, CON-031), plus the MAC in human-readable text
underneath for manual entry.

**FW-041** Provide a build/flash script that prints the MAC to serial after flashing, so
stickers can be generated per unit without guesswork.

**FW-042** Provide a CSV manifest of all built Nodes — `mac,label,fw_version` — to the Hub
owner, so Control Points can be pre-staged in the Admin UI before hardware arrives on site
(HUB-161).

---

## 6. Testing

**FW-050** Build `tools/mock-hub` — a ~50-line Express stub, owned by this side and shared
with the Hub agent — implementing the three Node→Hub endpoints with canned responses, so
firmware is testable with no Hub and no game.

**FW-051 — Acceptance tests.** All are required before hardware is handed over.

| # | Test | Pass criteria |
|---|---|---|
| 1 | Boot with sensor attached | Boots reliably 10/10 times; never enters flash mode |
| 2 | **Stationary human** | A person standing still reads `detected: true` continuously for ≥15 s, 10/10 trials |
| 3 | Register idempotency | Power-cycle 5×; the Hub sees 5 registrations, each with the current IP |
| 4 | Hub down at boot | Node retries forever, LED shows the disconnected pattern, never bricks, recovers when the Hub returns |
| 5 | Hub down mid-game | LED holds its last color; auto-recovers within one heartbeat |
| 6 | Missed push | Block `/set-color`; the Node still corrects its color within one heartbeat (CON-016) |
| 7 | Color fidelity | All 8 team colors distinguishable from 5 m in daylight, through the enclosure |
| 8 | Battery | ≥4 h continuous operation |
| 9 | Wi-Fi drop | Kill and restore the AP; the Node reconnects and re-registers unattended |

**FW-052** Test 7 MUST specifically include Yellow `#FFFF00` vs Green `#00E301`, and Blue
`#3A48EA` vs Cyan `#00EAEA`. These pairs are hard to distinguish on a cheap WS2812. Report
if they are not separable, so the Hub owner can restrict the active team palette (HUB-046).

### Team color reference

> **Changed 2026-08-08 (Hub side) — informational for firmware, no firmware action required.**
> The Hub is the sole authority on these values and pushes them via `/set-color`; firmware
> never hardcodes them, so this table is a reference, not a contract. Two teams were retired
> and the rest re-saturated after the originals read washed out on real LEDs — the minimum RGB
> channel is emitted as white light, so a screen-picked tint loses its hue. See doc01 §4.4.
>
> Previous values, for anyone reconciling old logs: Blue `#3A48EA`, Red `#EE2D2D`, Green
> `#00E301`, Cyan `#00EAEA`, Orange `#F07D19`, plus retired Pink Panthers `#EA76DD` and Grey
> Ghosts `#7D7D7D`.

| Team | Hex |
|---|---|
| Blue Bandits | `#0014FF` |
| Red Raiders | `#FF0000` |
| Green Goblins | `#00FF01` |
| Yellow Yaks | `#FFFF00` |
| Cyan Cyclones | `#00FFFF` |
| Orange Orcs | `#FF5000` |
| *neutral (unowned)* | `#FFFFFF` |
| *unclaimed hardware* | `#202020` |

---

## 7. Risks to report upward

| ID | Risk | Sev | Action |
|---|---|---|---|
| **FR-1** | PIR cannot detect a stationary human | 🔴 High | Switch to LD2410 (FW-002). **Long-lead item — order in week 1.** |
| **FR-2** | ESP-01 GPIO0/GPIO2 boot constraint | 🔴 High | Switch to ESP-01S / ESP-12F (FW-001) |
| **FR-3** | WS2812 data at 3.3 V is marginal | 🟡 Med | Level-shift, or use a 3.3 V-tolerant pixel |
| **FR-4** | `ESP8266WebServer` is single-connection | 🟡 Med | Keep handlers under 50 ms; **never** call out to the Hub from inside a handler |
| **FR-5** | ESP-01 512 KB flash → no OTA | 🟢 Low | Accept manual flashing, or use a 4 MB board |
| **FR-6** | 6 Nodes + 12 phones on one 2.4 GHz radio | 🟡 Med | Report RSSI in `/status`; escalate if below −75 dBm at deployment sites |

---

## 8. Open questions

| ID | Question | Blocks | Default if unresolved |
|---|---|---|---|
| **Q-C** | Board and sensor: ESP-01 + PIR, or ESP-01S/ESP-12F + LD2410? | **Ordering — lead time** | Assume ESP-01S + LD2410. If parts are already purchased, say so and this doc will be rewritten around PIR with `presenceGraceMs: 4000`. |
| **Q-A** | SSID / PSK / gateway IP | `config.h` (FW-030) | `FoundryCTF` / `capturetheflag` / `10.0.0.1` |
| **Q-D** | Node count and deployment venue | Battery sizing, FR-6 | 6 Nodes |

---

<!-- PASTE-APPENDIX-A -->
## Appendix A — Wire Contract

The full text of `docs/00-WIRE-CONTRACT.md` is normative and forms part of this document.
Read it before implementing anything in §3.

Run the Appendix A build step to inline it here.
