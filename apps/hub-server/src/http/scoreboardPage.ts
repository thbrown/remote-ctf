/**
 * HUB-176 — spectator scoreboard: large-format, read-only, auto-updating, plain HTTP (no
 * secure-context requirement, so no cert warning on a venue TV). Self-contained: uses the
 * socket.io client bundle the socket.io server itself serves at /socket.io/socket.io.js —
 * no CDN (HUB-152's "no CDN" spirit applies here too, even though that requirement is
 * written against the main Web App).
 */
import { MAP_VIEW_CSS, MAP_VIEW_SCRIPT } from './mapView.js';

export const SCOREBOARD_HTML = `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Foundry CTF — Scoreboard</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px; background: #0b0d12; color: #f2f2f2;
    font-family: -apple-system, Helvetica, Arial, sans-serif;
  }
  h1 { font-size: 2.5rem; margin: 0 0 8px; }
  #timer { font-size: 1.5rem; opacity: 0.7; margin-bottom: 24px; }
  #teams { display: flex; flex-direction: column; gap: 10px; margin-bottom: 32px; }
  .team-row { display: flex; align-items: center; gap: 16px; font-size: 1.8rem; }
  .swatch { width: 28px; height: 28px; border-radius: 6px; flex: none; }
  .team-name { flex: 0 0 220px; font-weight: 600; }
  .bar-track { flex: 1; height: 28px; background: #1c1f26; border-radius: 6px; overflow: hidden; }
  .bar-fill { height: 100%; transition: width 0.3s linear; }
  .score-pct { flex: 0 0 90px; text-align: right; font-variant-numeric: tabular-nums; }
  .score-delta { flex: 0 0 84px; text-align: right; font-size: 1.1rem; font-variant-numeric: tabular-nums; }
  .score-delta-up { color: #3ddc73; }
  .score-delta-down { color: #ff6b6b; }
  .score-delta-flat { color: #5a6070; }
  #cps { display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr)); gap: 12px; margin-bottom: 32px; }
  .cp-card { background: #1c1f26; border-radius: 10px; padding: 16px; }
  .cp-name { font-size: 1.1rem; opacity: 0.8; margin-bottom: 8px; }
  .cp-owner { font-size: 1.4rem; font-weight: 700; }
  h2 { font-size: 1.3rem; opacity: 0.8; margin: 0 0 12px; }
  #players-wrap { overflow-x: auto; margin-bottom: 32px; }
  #players { width: 100%; border-collapse: collapse; font-size: 1.05rem; }
  #players th, #players td { text-align: left; padding: 8px 14px; border-bottom: 1px solid #262a33; white-space: nowrap; }
  #players th { font-size: 0.85rem; opacity: 0.7; font-weight: 600; text-transform: uppercase; }
  #players .player-name-cell { display: flex; align-items: center; gap: 10px; }
  .avatar { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex: none; background: #333; }
  .player-status.tagged_out { color: #ff8080; }
  .player-row-disconnected { opacity: 0.4; font-style: italic; }
  #ticker { font-size: 1.1rem; opacity: 0.85; line-height: 1.6; max-height: 200px; overflow-y: auto; }
  #ticker div { border-left: 3px solid #444; padding-left: 10px; margin-bottom: 6px; }
  .ticker-time { opacity: 0.6; font-variant-numeric: tabular-nums; }
${MAP_VIEW_CSS}
</style>
</head>
<body>
  <h1>Foundry CTF</h1>
  <div id="timer">Waiting for a session…</div>
  <div id="teams"></div>
  <div id="cps"></div>
  <div id="map-section" hidden>
    <h2>Live map</h2>
    <div id="map-wrap"></div>
    <div class="map-note">Positions are GPS fixes from each player's phone; the shaded ring is the reported accuracy.</div>
  </div>
  <h2>Players</h2>
  <div id="players-wrap">
    <table id="players">
      <thead>
        <tr>
          <th>Player</th><th>Team</th><th>Status</th>
          <th>Tags for</th><th>Tags against</th><th>K/D</th><th>Points captured</th>
        </tr>
      </thead>
      <tbody id="players-body"></tbody>
    </table>
  </div>
  <div id="ticker"></div>

  <script src="/socket.io/socket.io.js"></script>
  <script>${MAP_VIEW_SCRIPT}</script>
  <script>
    const socket = io({ transports: ['websocket', 'polling'] });
    let teams = [];
    let controlPoints = [];
    let session = null;
    let players = [];
    let respawnLocations = [];
    // Server-controlled (SPECTATOR_SHOW_POSITIONS): when off, the roster carries no
    // coordinates at all and the map section stays hidden rather than rendering empty.
    let showPositions = false;
    // Wall-clock time each player's position last CHANGED, so the map can mark a fix as
    // stale. The roster poll returns the same coordinates every 3 s for a stationary or
    // disconnected player alike, so poll time alone can't distinguish them.
    const positionChangedAtMs = {};
    // Percentage-point change since the previous score update, keyed by teamId - drives
    // the ▲/▼ delta indicator. Undefined until a team's score has been patched at least
    // once (there's nothing to compare the very first value against).
    let scoreDeltaByTeamId = {};

    function teamById(id) { return teams.find((t) => t.teamId === id); }
    function playerById(id) { return players.find((p) => p.playerId === id); }
    function cpById(id) { return controlPoints.find((c) => c.controlPointId === id); }

    function deltaHtml(teamId) {
      const d = scoreDeltaByTeamId[teamId];
      if (d === undefined || Math.abs(d) < 0.05) return '<span class="score-delta score-delta-flat">—</span>';
      const cls = d > 0 ? 'score-delta-up' : 'score-delta-down';
      const arrow = d > 0 ? '▲' : '▼';
      const sign = d > 0 ? '+' : '';
      return \`<span class="score-delta \${cls}">\${arrow} \${sign}\${d.toFixed(1)}%</span>\`;
    }

    function render() {
      const teamsWithPlayers = teams.filter((t) => players.some((p) => p.teamId === t.teamId));

      const teamsEl = document.getElementById('teams');
      const sorted = [...teamsWithPlayers].sort((a, b) => b.score - a.score);
      teamsEl.innerHTML = sorted.map((t) => \`
        <div class="team-row">
          <div class="swatch" style="background:\${t.hexColor}"></div>
          <div class="team-name">\${t.teamName}</div>
          <div class="bar-track"><div class="bar-fill" style="width:\${(t.score * 100).toFixed(1)}%;background:\${t.hexColor}"></div></div>
          <div class="score-pct">\${(t.score * 100).toFixed(1)}%</div>
          \${deltaHtml(t.teamId)}
        </div>\`).join('');

      const cpsEl = document.getElementById('cps');
      cpsEl.innerHTML = controlPoints.map((cp) => {
        const owner = cp.currentOwnerTeamId ? teamById(cp.currentOwnerTeamId) : null;
        return \`
        <div class="cp-card">
          <div class="cp-name">\${cp.controlPointName}</div>
          <div class="cp-owner" style="color:\${owner ? owner.hexColor : '#888'}">\${owner ? owner.teamName : 'Neutral'}</div>
        </div>\`;
      }).join('');

      const playersBodyEl = document.getElementById('players-body');
      const sortedPlayers = [...players].sort((a, b) => a.playerName.localeCompare(b.playerName));
      playersBodyEl.innerHTML = sortedPlayers.map((p) => {
        const team = p.teamId ? teamById(p.teamId) : null;
        const kd = p.tagsReceived === 0 ? (p.tagsInflicted === 0 ? '—' : '∞') : (p.tagsInflicted / p.tagsReceived).toFixed(2);
        const avatar = p.profilePicture
          ? \`<img class="avatar" src="\${p.profilePicture}" alt="" />\`
          : \`<div class="avatar" style="background:\${team ? team.hexColor : '#555'}"></div>\`;
        return \`
        <tr class="\${p.isConnected ? '' : 'player-row-disconnected'}">
          <td>
            <div class="player-name-cell">
              \${avatar}
              \${p.playerName}\${p.isConnected ? '' : ' (disconnected)'}
            </div>
          </td>
          <td>\${team ? team.teamName : '—'}</td>
          <td class="player-status \${p.playerStatus}">\${p.playerStatus.replace(/_/g, ' ')}</td>
          <td>\${p.tagsInflicted}</td>
          <td>\${p.tagsReceived}</td>
          <td>\${kd}</td>
          <td>\${p.capturesCompleted}</td>
        </tr>\`;
      }).join('');

      renderMap();
      document.getElementById('timer').textContent = timerText();
    }

    // render() runs on every state:patch - during a capture that's the 5 Hz progress feed
    // plus per-second scores - but the map's inputs only change on the 3 s roster poll or
    // an ownership flip. Rebuilding the whole SVG string and reparsing it through innerHTML
    // at that rate is pure waste on the venue TV, so redraw only when something it draws
    // actually moved. Width is in the key because the SVG is sized in pixels.
    let lastMapKey = '';
    function renderMap() {
      const section = document.getElementById('map-section');
      section.hidden = !showPositions;
      if (!showPositions) return;

      const mapPlayers = players.map((p) => ({ ...p, atMs: positionChangedAtMs[p.playerId] }));
      const wrap = document.getElementById('map-wrap');
      const key = JSON.stringify([
        wrap.clientWidth,
        controlPoints.map((c) => [c.controlPointId, c.locationLat, c.locationLong, c.currentOwnerTeamId]),
        respawnLocations.map((r) => [r.respawnLocationId, r.locationLat, r.locationLong]),
        // The stale flag has to be in the key too: a player who stops reporting changes
        // nothing else, but their dot still has to go hollow. Threshold mirrors the
        // renderer's STALE_MS.
        mapPlayers.map((p) => [
          p.playerId, p.locationLat, p.locationLong, p.teamId, p.playerStatus,
          p.atMs != null && Date.now() - p.atMs > 30000,
        ]),
        teams.map((t) => [t.teamId, t.hexColor]),
      ]);
      if (key === lastMapKey) return;
      lastMapKey = key;

      renderMapSvg(wrap, { controlPoints, respawnLocations, players: mapPlayers, teamById }, { height: 420 });
    }
    // The SVG is sized from the container's pixel width, so it has to be redrawn on resize
    // (and on the venue TV's orientation change) rather than scaling with CSS.
    window.addEventListener('resize', renderMap);

    function timerText() {
      if (!session) return 'No session running';
      if (session.gameDurationMs == null) return 'Session in progress: ' + session.sessionName;
      const remainingMs = Math.max(0, Date.parse(session.startTimestamp) + session.gameDurationMs - Date.now());
      const totalSeconds = Math.floor(remainingMs / 1000);
      const mm = Math.floor(totalSeconds / 60);
      const ss = String(totalSeconds % 60).padStart(2, '0');
      return session.sessionName + ' — ' + mm + ':' + ss + ' remaining';
    }

    // Players aren't part of state:snapshot/state:patch for spectators (HUB-094 - no
    // player PII pushed to the public no-auth socket stream), so poll a redacted roster
    // on an interval instead, same pattern the Admin app uses for its own rosters.
    function pollPlayers() {
      socket.emit('spectator:players:list', {}, (res) => {
        if (res && res.ok) {
          showPositions = res.showPositions === true;
          const nowMs = Date.now();
          for (const p of res.players) {
            const prev = players.find((x) => x.playerId === p.playerId);
            if (!prev || prev.locationLat !== p.locationLat || prev.locationLong !== p.locationLong) {
              if (typeof p.locationLat === 'number') positionChangedAtMs[p.playerId] = nowMs;
            }
          }
          players = res.players;
          render();
        }
      });
    }

    // Static geometry - polled far less often than players, and only to pick up an admin
    // adding a respawn point mid-game.
    function pollRespawnLocations() {
      socket.emit('spectator:respawnLocations:list', {}, (res) => {
        if (res && res.ok) {
          respawnLocations = res.respawnLocations;
          renderMap();
        }
      });
    }

    let tickerEntries = [];
    function formatRelativeTime(atMs) {
      const deltaS = Math.max(0, Math.round((Date.now() - atMs) / 1000));
      if (deltaS < 1) return 'just now';
      if (deltaS < 60) return deltaS + 's ago';
      const deltaM = Math.round(deltaS / 60);
      if (deltaM < 60) return deltaM + 'm ago';
      return Math.round(deltaM / 60) + 'h ago';
    }
    function renderTicker() {
      const el = document.getElementById('ticker');
      el.innerHTML = tickerEntries.map((e) => \`<div><span class="ticker-time">\${formatRelativeTime(e.atMs)}</span> — \${e.text}</div>\`).join('');
    }
    function ticker(text) {
      tickerEntries.unshift({ atMs: Date.now(), text });
      tickerEntries = tickerEntries.slice(0, 30);
      renderTicker();
    }
    setInterval(renderTicker, 1000);
    // Independent of render()'s patch-driven calls, so the countdown ticks down smoothly
    // once a second instead of jumping only when a qrCtfTeam/qrCtfControlPoint patch happens.
    setInterval(() => { document.getElementById('timer').textContent = timerText(); }, 1000);

    socket.on('connect', () => {
      socket.emit('session:hello', { role: 'spectator' }, () => {});
      pollPlayers();
      pollRespawnLocations();
    });
    setInterval(pollPlayers, 3000);
    setInterval(pollRespawnLocations, 30000);

    socket.on('state:snapshot', (snap) => {
      teams = snap.teams;
      controlPoints = snap.controlPoints;
      session = snap.session;
      render();
    });

    socket.on('state:patch', ({ type, id, patch }) => {
      if (type === 'qrCtfTeam') {
        const idx = teams.findIndex((t) => t.teamId === id);
        if (patch === null) { if (idx >= 0) teams.splice(idx, 1); delete scoreDeltaByTeamId[id]; }
        else if (idx >= 0) {
          if (typeof patch.score === 'number') scoreDeltaByTeamId[id] = (patch.score - teams[idx].score) * 100;
          teams[idx] = { ...teams[idx], ...patch };
        } else teams.push(patch);
      } else if (type === 'qrCtfControlPoint') {
        const idx = controlPoints.findIndex((c) => c.controlPointId === id);
        if (patch === null) { if (idx >= 0) controlPoints.splice(idx, 1); }
        else if (idx >= 0) controlPoints[idx] = { ...controlPoints[idx], ...patch };
        else controlPoints.push(patch);
      } else if (type === 'qrCtfSession') {
        session = patch === null ? null : { ...(session ?? {}), ...patch };
      }
      render();
    });

    socket.on('session:started', () => ticker('Session started'));
    socket.on('session:ended', (e) => {
      ticker('Session ended. Winner: ' + (teamById(e.winningTeamId)?.teamName ?? 'none'));
      session = null;
      render();
    });
    // capture:occurred, not capture:started - the latter is scoped to the capturing player's
    // room so only they see a progress ring (see gameEvents.ts).
    socket.on('capture:occurred', (e) => {
      const cp = cpById(e.controlPointId);
      const player = playerById(e.playerId);
      ticker((player?.playerName ?? 'A player') + ' started capturing ' + (cp?.controlPointName ?? 'a control point'));
    });
    socket.on('capture:completed', (e) => {
      const cp = controlPoints.find((c) => c.controlPointId === e.controlPointId);
      const team = teamById(e.teamId);
      ticker((cp?.controlPointName ?? 'A control point') + ' captured by ' + (team?.teamName ?? 'a team'));
    });
    socket.on('capture:abandoned', () => ticker('A capture attempt was abandoned'));
    socket.on('tag:occurred', (e) => {
      const source = playerById(e.sourcePlayerId);
      const target = playerById(e.targetPlayerId);
      ticker((source?.playerName ?? 'A player') + ' tagged ' + (target?.playerName ?? 'a player'));
    });
  </script>
</body>
</html>`;
