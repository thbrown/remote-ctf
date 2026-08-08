/**
 * Post-game replay: scrubs a finished session's recorded position tracks through the same
 * renderer the live scoreboard uses (mapView.ts), so the playback and the live view can't
 * drift apart visually.
 *
 * Fetches /export/<id>.json once and does everything client-side — a match is a few thousand
 * points at most, so there is no reason to stream or paginate it.
 */
import { MAP_VIEW_CSS, MAP_VIEW_SCRIPT } from './mapView.js';

export const REPLAY_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Foundry CTF — Replay</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: #0b0d12; color: #f2f2f2; font-family: -apple-system, Helvetica, Arial, sans-serif; }
  h1 { font-size: 1.8rem; margin: 0 0 4px; }
  #meta { opacity: 0.7; margin-bottom: 16px; }
  #controls { display: flex; align-items: center; gap: 14px; margin: 14px 0 6px; flex-wrap: wrap; }
  #scrub { flex: 1; min-width: 240px; }
  button { background: #262a33; color: #f2f2f2; border: 0; border-radius: 6px; padding: 8px 16px; font-size: 1rem; cursor: pointer; }
  button:hover { background: #333844; }
  #clock { font-variant-numeric: tabular-nums; font-size: 1.1rem; min-width: 110px; }
  #legend { display: flex; gap: 16px; flex-wrap: wrap; margin-top: 10px; font-size: 0.9rem; opacity: 0.85; }
  .legend-item { display: flex; align-items: center; gap: 6px; }
  .legend-swatch { width: 14px; height: 14px; border-radius: 50%; }
  .error { padding: 40px; text-align: center; opacity: 0.7; }
${MAP_VIEW_CSS}
</style>
</head>
<body>
  <h1>Replay</h1>
  <div id="meta">Loading…</div>
  <div id="map-wrap"></div>
  <div id="controls" hidden>
    <button id="play">▶ Play</button>
    <input id="scrub" type="range" min="0" max="1000" value="0" />
    <span id="clock">0:00</span>
    <label><input id="trails" type="checkbox" checked /> Trails</label>
  </div>
  <div id="legend"></div>

  <script>${MAP_VIEW_SCRIPT}</script>
  <script>
    const params = new URLSearchParams(location.search);
    const sessionId = params.get('session');
    let data = null;
    let startMs = 0;
    let endMs = 0;
    let cursorMs = 0;
    let playing = false;
    // Replay runs at 10x wall clock: a 20-minute match is about two minutes of watching,
    // which is roughly the point where a scrubber beats sitting through it in real time.
    const SPEED = 10;

    function teamById(id) {
      return (data.teams || []).find((t) => t.teamId === id) || null;
    }

    /** Last recorded sample at or before tMs. Tracks are strictly time-ordered (the series
     * store rejects out-of-order appends), so a plain scan back from the end is correct. */
    function sampleAt(track, tMs) {
      let found = null;
      for (const s of track) {
        if (s.t > tMs) break;
        found = s;
      }
      return found;
    }

    function playersAt(tMs) {
      return (data.players || [])
        .map((p) => {
          const s = sampleAt(p.track, tMs);
          if (!s) return null;
          const alive = sampleAt(p.isAlive, tMs);
          return {
            playerId: p.playerId,
            playerName: p.playerName,
            teamId: p.teamId,
            // isAlive false is what the live map shows as tagged_out - reuse that styling
            // rather than inventing a second dimmed state.
            playerStatus: alive && alive.v === false ? 'tagged_out' : 'active',
            locationLat: s.lat,
            locationLong: s.long,
            atMs: s.t,
          };
        })
        .filter(Boolean);
    }

    /** Control point ownership as of tMs, replayed from the owner-history series. */
    function controlPointsAt(tMs) {
      return (data.controlPoints || []).map((c) => {
        const hist = (data.controlPointHistory || []).find((h) => h.controlPointId === c.controlPointId);
        const owner = hist ? sampleAt(hist.ownerHistory, tMs) : null;
        return { ...c, currentOwnerTeamId: owner ? owner.v : null };
      });
    }

    function fmtClock(ms) {
      const total = Math.max(0, Math.floor(ms / 1000));
      return Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
    }

    function render() {
      const players = playersAt(cursorMs);
      const projection = renderMapSvg(
        document.getElementById('map-wrap'),
        {
          controlPoints: controlPointsAt(cursorMs),
          respawnLocations: data.respawnLocations || [],
          players,
          teamById,
        },
        // nowMs is the replay cursor, not real time - otherwise every historical fix would
        // be older than the staleness threshold and the whole map would render as stale.
        { height: 460, nowMs: cursorMs }
      );
      if (projection && document.getElementById('trails').checked) drawTrails(projection);
      document.getElementById('clock').textContent = fmtClock(cursorMs - startMs);
      document.getElementById('scrub').value = String(
        endMs > startMs ? ((cursorMs - startMs) / (endMs - startMs)) * 1000 : 0
      );
    }

    /** Path travelled so far, drawn under the current-position dots. Injected into the SVG
     * the shared renderer produced, using the projection it hands back, so trails can't
     * drift off the marks. */
    function drawTrails(projection) {
      const svg = document.querySelector('#map-wrap svg');
      if (!svg) return;
      const ns = 'http://www.w3.org/2000/svg';
      for (const p of data.players || []) {
        const upTo = p.track.filter((s) => s.t <= cursorMs);
        if (upTo.length < 2) continue;
        const team = teamById(p.teamId);
        const pts = upTo.map((s) => projection.project({ lat: s.lat, long: s.long }));
        const path = document.createElementNS(ns, 'polyline');
        path.setAttribute('points', pts.map((q) => q.x.toFixed(1) + ',' + q.y.toFixed(1)).join(' '));
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', team ? team.hexColor : '#8a90a0');
        path.setAttribute('stroke-width', '2');
        path.setAttribute('stroke-opacity', '0.35');
        svg.insertBefore(path, svg.firstChild);
      }
    }

    function renderLegend() {
      document.getElementById('legend').innerHTML = (data.teams || [])
        .map(
          (t) =>
            '<div class="legend-item"><span class="legend-swatch" style="background:' + t.hexColor + '"></span>' +
            t.teamName + '</div>'
        )
        .join('');
    }

    let lastFrameMs = 0;
    function tick(nowPerf) {
      if (!playing) return;
      const dt = lastFrameMs ? nowPerf - lastFrameMs : 16;
      lastFrameMs = nowPerf;
      cursorMs = Math.min(endMs, cursorMs + dt * SPEED);
      render();
      if (cursorMs >= endMs) {
        playing = false;
        document.getElementById('play').textContent = '▶ Play';
        return;
      }
      requestAnimationFrame(tick);
    }

    document.getElementById('play').addEventListener('click', () => {
      playing = !playing;
      document.getElementById('play').textContent = playing ? '❚❚ Pause' : '▶ Play';
      lastFrameMs = 0;
      // Restarting from the end would otherwise instantly stop again.
      if (playing && cursorMs >= endMs) cursorMs = startMs;
      if (playing) requestAnimationFrame(tick);
    });
    document.getElementById('scrub').addEventListener('input', (e) => {
      cursorMs = startMs + ((endMs - startMs) * Number(e.target.value)) / 1000;
      render();
    });
    document.getElementById('trails').addEventListener('change', render);
    window.addEventListener('resize', render);

    async function load() {
      if (!sessionId) {
        document.getElementById('meta').innerHTML =
          '<div class="error">No session specified. <a href="/export">Pick one from the session list.</a></div>';
        return;
      }
      const res = await fetch('/export/' + encodeURIComponent(sessionId) + '.json');
      if (!res.ok) {
        document.getElementById('meta').innerHTML = '<div class="error">Could not load that session.</div>';
        return;
      }
      data = await res.json();

      const allTimes = (data.players || []).flatMap((p) => p.track.map((s) => s.t));
      if (allTimes.length === 0) {
        document.getElementById('meta').innerHTML =
          '<div class="error">This session has no recorded positions — players either had no GPS fix or never moved with the app open.</div>';
        return;
      }
      startMs = Math.min(...allTimes);
      endMs = Math.max(...allTimes);
      cursorMs = startMs;

      document.getElementById('meta').textContent =
        data.session.sessionName + ' — ' + new Date(startMs).toLocaleString() + ' · ' + fmtClock(endMs - startMs) + ' of tracked play';
      document.getElementById('controls').hidden = false;
      renderLegend();
      render();
    }

    load();
  </script>
</body>
</html>`;
