/**
 * HUB-176 — spectator scoreboard: large-format, read-only, auto-updating, plain HTTP (no
 * secure-context requirement, so no cert warning on a venue TV). Self-contained: uses the
 * socket.io client bundle the socket.io server itself serves at /socket.io/socket.io.js —
 * no CDN (HUB-152's "no CDN" spirit applies here too, even though that requirement is
 * written against the main Web App).
 */
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
  .bar-fill { height: 100%; }
  .score-pct { flex: 0 0 90px; text-align: right; font-variant-numeric: tabular-nums; }
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
</style>
</head>
<body>
  <h1>Foundry CTF</h1>
  <div id="timer">Waiting for a session…</div>
  <div id="teams"></div>
  <div id="cps"></div>
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
  <script>
    const socket = io({ transports: ['websocket', 'polling'] });
    let teams = [];
    let controlPoints = [];
    let session = null;
    let players = [];

    function teamById(id) { return teams.find((t) => t.teamId === id); }
    function playerById(id) { return players.find((p) => p.playerId === id); }
    function cpById(id) { return controlPoints.find((c) => c.controlPointId === id); }

    function render() {
      const teamsWithPlayers = teams.filter((t) => players.some((p) => p.teamId === t.teamId));

      const teamsEl = document.getElementById('teams');
      const sorted = [...teamsWithPlayers].sort((a, b) => b.score - a.score);
      teamsEl.innerHTML = sorted.map((t) => \`
        <div class="team-row">
          <div class="swatch" style="background:\${t.hexColor}"></div>
          <div class="team-name">\${t.teamName}</div>
          <div class="bar-track"><div class="bar-fill" style="width:\${Math.round(t.score * 100)}%;background:\${t.hexColor}"></div></div>
          <div class="score-pct">\${Math.round(t.score * 100)}%</div>
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

      document.getElementById('timer').textContent = session
        ? 'Session in progress: ' + session.sessionName
        : 'No session running';
    }

    // Players aren't part of state:snapshot/state:patch for spectators (HUB-094 - no
    // player PII pushed to the public no-auth socket stream), so poll a redacted roster
    // on an interval instead, same pattern the Admin app uses for its own rosters.
    function pollPlayers() {
      socket.emit('spectator:players:list', {}, (res) => {
        if (res && res.ok) {
          players = res.players;
          render();
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

    socket.on('connect', () => {
      socket.emit('session:hello', { role: 'spectator' }, () => {});
      pollPlayers();
    });
    setInterval(pollPlayers, 3000);

    socket.on('state:snapshot', (snap) => {
      teams = snap.teams;
      controlPoints = snap.controlPoints;
      session = snap.session;
      render();
    });

    socket.on('state:patch', ({ type, id, patch }) => {
      const applyTo = (list) => {
        const idx = list.findIndex((x) => Object.values(x).includes(id) || x[Object.keys(x)[0]] === id);
      };
      if (type === 'qrCtfTeam') {
        const idx = teams.findIndex((t) => t.teamId === id);
        if (patch === null) { if (idx >= 0) teams.splice(idx, 1); }
        else if (idx >= 0) teams[idx] = { ...teams[idx], ...patch };
        else teams.push(patch);
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
    socket.on('capture:started', (e) => {
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
