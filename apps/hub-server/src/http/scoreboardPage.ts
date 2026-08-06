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
  #ticker { font-size: 1.1rem; opacity: 0.85; line-height: 1.6; max-height: 200px; overflow-y: auto; }
  #ticker div { border-left: 3px solid #444; padding-left: 10px; margin-bottom: 6px; }
</style>
</head>
<body>
  <h1>Foundry CTF</h1>
  <div id="timer">Waiting for a session…</div>
  <div id="teams"></div>
  <div id="cps"></div>
  <div id="ticker"></div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const socket = io({ transports: ['websocket', 'polling'] });
    let teams = [];
    let controlPoints = [];
    let session = null;

    function teamById(id) { return teams.find((t) => t.teamId === id); }

    function render() {
      const teamsEl = document.getElementById('teams');
      const sorted = [...teams].sort((a, b) => b.score - a.score);
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

      document.getElementById('timer').textContent = session
        ? 'Session in progress: ' + session.sessionName
        : 'No session running';
    }

    function ticker(text) {
      const el = document.getElementById('ticker');
      const line = document.createElement('div');
      line.textContent = new Date().toLocaleTimeString() + ' — ' + text;
      el.prepend(line);
      while (el.children.length > 30) el.removeChild(el.lastChild);
    }

    socket.on('connect', () => {
      socket.emit('session:hello', { role: 'spectator' }, () => {});
    });

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
    socket.on('session:ended', (e) => ticker('Session ended. Winner: ' + (teamById(e.winningTeamId)?.teamName ?? 'none')));
    socket.on('capture:completed', (e) => {
      const cp = controlPoints.find((c) => c.controlPointId === e.controlPointId);
      const team = teamById(e.teamId);
      ticker((cp?.controlPointName ?? 'A control point') + ' captured by ' + (team?.teamName ?? 'a team'));
    });
    socket.on('capture:abandoned', () => ticker('A capture attempt was abandoned'));
  </script>
</body>
</html>`;
