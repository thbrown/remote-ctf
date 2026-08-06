import { useEffect, useState } from 'react';
import { encodePlQr, encodeRpQr } from '@foundry-ctf/shared';
import { useGame } from '../useGame';
import { QrThumbnail } from './QrThumbnail';

interface NodeRow {
  mac: string;
  ip: string;
  controlPointId: string | null;
  isOnline: boolean;
  desiredColor: string;
  reportedColor: string | null;
  rssi: number | null;
}

interface RespawnLocationRow {
  respawnLocationId: string;
  locationLat: number;
  locationLong: number;
  allowedTeamIds: string[];
}

interface PlayerRow {
  playerId: string;
  playerName: string;
  teamId: string | null;
  playerStatus: string;
  qrCodeToken: string;
  qrCodeClaimed: boolean;
  profilePicture: string | null;
  isConnected: boolean;
  tagsInflicted: number;
  tagsReceived: number;
  capturesCompleted: number;
}

function AdminLogin({
  pin,
  setPin,
  onSubmit,
  authError,
}: {
  pin: string;
  setPin: (v: string) => void;
  onSubmit: () => void;
  authError: string | null;
}) {
  return (
    <div className="admin-login">
      <h2>Admin PIN</h2>
      <input
        type="password"
        value={pin}
        onChange={(e) => setPin(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && onSubmit()}
      />
      {authError && <div className="form-error">Incorrect PIN — try again.</div>}
      <button onClick={onSubmit}>Enter</button>
    </div>
  );
}

export function AdminApp() {
  const [pin, setPin] = useState('');
  // Deliberately separate from `pin` (which tracks every keystroke): only updates when
  // "Enter" is clicked, so useGame's effect (keyed on this value) doesn't re-send
  // session:hello on every keystroke - only on an actual submit.
  const [submittedPin, setSubmittedPin] = useState<string | undefined>(undefined);
  const { socket, state } = useGame('admin', submittedPin);

  const [sessionName, setSessionName] = useState('Round 1');
  const [activeTeamIds, setActiveTeamIds] = useState<string[]>([]);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [claimMac, setClaimMac] = useState('');
  const [claimName, setClaimName] = useState('');
  const [respawnLocations, setRespawnLocations] = useState<RespawnLocationRow[]>([]);
  const [rpLat, setRpLat] = useState('');
  const [rpLong, setRpLong] = useState('');
  const [rpTeamIds, setRpTeamIds] = useState<string[]>([]);
  const [rpCustomId, setRpCustomId] = useState('');
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [qrEdits, setQrEdits] = useState<Record<string, string>>({});

  function refreshRespawnLocations() {
    socket.emit('admin:respawnLocation:list', {}, (res: any) => {
      if (res?.ok) setRespawnLocations(res.locations);
    });
  }

  useEffect(() => {
    if (state.status !== 'connected' || submittedPin === undefined) return;
    refreshRespawnLocations();
    function pollNodesAndPlayers() {
      socket.emit('admin:nodes:list', {}, (res: any) => {
        if (res?.ok) setNodes(res.nodes);
      });
      socket.emit('admin:players:list', {}, (res: any) => {
        if (res?.ok) setPlayers(res.players);
      });
    }
    pollNodesAndPlayers();
    const interval = setInterval(pollNodesAndPlayers, 3000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, state.status, submittedPin]);

  if (submittedPin === undefined || state.authError) {
    return <AdminLogin pin={pin} setPin={setPin} onSubmit={() => setSubmittedPin(pin)} authError={state.authError} />;
  }

  if (state.status !== 'connected') {
    return <div className="admin-login">Connecting…</div>;
  }

  function setPlayerQrCode(playerId: string) {
    const qrCodeToken = (qrEdits[playerId] ?? '').trim();
    if (!qrCodeToken) return;
    socket.emit('admin:player:setQrCode', { playerId, qrCodeToken }, (res: any) => {
      if (!res?.ok) {
        alert(`Failed to set QR code: ${res?.error ?? 'unknown error'}`);
        return;
      }
      setQrEdits((edits) => {
        const next = { ...edits };
        delete next[playerId];
        return next;
      });
    });
  }

  function toggleActiveTeam(teamId: string) {
    setActiveTeamIds((ids) => (ids.includes(teamId) ? ids.filter((id) => id !== teamId) : [...ids, teamId]));
  }

  function startSession() {
    socket.emit('admin:session:start', { sessionName, activeTeamIds }, (res: any) => {
      if (!res?.ok) alert(`Failed to start session: ${res?.error}`);
    });
  }

  function stopSession() {
    socket.emit('admin:session:stop', {}, () => {});
  }

  function claimNode() {
    socket.emit('admin:node:claim', { macAddress: claimMac, controlPointName: claimName || undefined }, (res: any) => {
      if (!res?.ok) alert(`Failed to claim: ${res?.error}`);
      else {
        setClaimMac('');
        setClaimName('');
      }
    });
  }

  function identifyNode(mac: string) {
    socket.emit('admin:node:identify', { macAddress: mac }, () => {});
  }

  function toggleRpTeam(teamId: string) {
    setRpTeamIds((ids) => (ids.includes(teamId) ? ids.filter((id) => id !== teamId) : [...ids, teamId]));
  }

  function createRespawnLocation() {
    const lat = Number(rpLat);
    const long = Number(rpLong);
    if (!Number.isFinite(lat) || !Number.isFinite(long)) {
      alert('lat/long must be numbers');
      return;
    }
    socket.emit(
      'admin:respawnLocation:create',
      { lat, long, allowedTeamIds: rpTeamIds, respawnLocationId: rpCustomId.trim() || undefined },
      (res: any) => {
        if (!res?.ok) alert(`Failed: ${res?.error}`);
        else {
          setRpLat('');
          setRpLong('');
          setRpTeamIds([]);
          setRpCustomId('');
          refreshRespawnLocations();
        }
      },
    );
  }

  function deleteRespawnLocation(respawnLocationId: string) {
    socket.emit('admin:respawnLocation:delete', { respawnLocationId }, () => refreshRespawnLocations());
  }

  return (
    <div className="admin-app">
      <h1>Admin</h1>
      <div className="status-line">
        Connection: {state.status} · Session: {state.session ? state.session.sessionName : 'none running'}
      </div>

      <div className="admin-group admin-group-session">
        <section>
          <h2>Session</h2>
          {state.session ? (
            <button onClick={stopSession}>Stop session</button>
          ) : (
            <>
              <input value={sessionName} onChange={(e) => setSessionName(e.target.value)} placeholder="Session name" />
              <div className="team-toggle-list">
                {state.teams.map((t) => (
                  <label key={t.teamId} className="team-toggle">
                    <input
                      type="checkbox"
                      checked={activeTeamIds.includes(t.teamId)}
                      onChange={() => toggleActiveTeam(t.teamId)}
                    />
                    <span className="swatch" style={{ background: t.hexColor }} />
                    {t.teamName}
                  </label>
                ))}
              </div>
              <button onClick={startSession} disabled={activeTeamIds.length < 2}>
                Start session
              </button>
            </>
          )}
        </section>
      </div>

      <div className="admin-group admin-group-game">
      <section>
        <h2>Players</h2>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Photo</th><th>Name</th><th>Team</th><th>Status</th><th>Connected</th>
                <th>Tags for</th><th>Tags against</th><th>K/D</th><th>Points captured</th>
                <th>QR code ID</th><th>Badge</th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => {
                const team = p.teamId ? state.teams.find((t) => t.teamId === p.teamId) : null;
                const kd = p.tagsReceived === 0 ? (p.tagsInflicted === 0 ? '—' : '∞') : (p.tagsInflicted / p.tagsReceived).toFixed(2);
                return (
                  <tr key={p.playerId} className={p.isConnected ? '' : 'player-row-disconnected'}>
                    <td>
                      {p.profilePicture ? (
                        <img className="avatar" src={p.profilePicture} alt="" />
                      ) : (
                        <span className="avatar" style={{ background: team?.hexColor ?? '#555' }} />
                      )}
                    </td>
                    <td>{p.playerName}</td>
                    <td>
                      {team ? (
                        <>
                          <span className="swatch" style={{ background: team.hexColor }} /> {team.teamName}
                        </>
                      ) : (
                        '— (not yet joined a team)'
                      )}
                    </td>
                    <td>{p.playerStatus}</td>
                    <td>{p.isConnected ? 'connected' : 'disconnected'}</td>
                    <td>{p.tagsInflicted}</td>
                    <td>{p.tagsReceived}</td>
                    <td>{kd}</td>
                    <td>{p.capturesCompleted}</td>
                    <td>
                      <div className="qr-edit">
                        <input
                          value={qrEdits[p.playerId] ?? (p.qrCodeClaimed ? p.qrCodeToken : '')}
                          onChange={(e) => setQrEdits((edits) => ({ ...edits, [p.playerId]: e.target.value }))}
                          placeholder="unclaimed"
                        />
                        <button onClick={() => setPlayerQrCode(p.playerId)}>Set</button>
                      </div>
                    </td>
                    <td>{p.qrCodeClaimed && <QrThumbnail value={encodePlQr(p.qrCodeToken)} size={64} />}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      <section>
        <h2>Control Points</h2>
        <table>
          <thead>
            <tr><th>Name</th><th>MAC</th><th>Owner</th><th>Presence</th></tr>
          </thead>
          <tbody>
            {state.controlPoints.map((cp) => {
              const owner = cp.currentOwnerTeamId ? state.teams.find((t) => t.teamId === cp.currentOwnerTeamId) : null;
              return (
                <tr key={cp.controlPointId}>
                  <td>{cp.controlPointName}</td>
                  <td>{cp.macAddress ?? '—'}</td>
                  <td>{owner ? owner.teamName : 'Neutral'}</td>
                  <td>{cp.isHumanDetected ? 'detected' : 'clear'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h3>Claim a node</h3>
        <div className="claim-form">
          <input value={claimMac} onChange={(e) => setClaimMac(e.target.value)} placeholder="MAC address (AA:BB:CC:DD:EE:FF)" />
          <input value={claimName} onChange={(e) => setClaimName(e.target.value)} placeholder="Control Point name" />
          <button onClick={claimNode}>Claim</button>
        </div>
        <table>
          <thead>
            <tr><th>MAC</th><th>IP</th><th>Online</th><th>Claimed</th><th>Desired</th><th>Reported</th><th>RSSI</th><th></th></tr>
          </thead>
          <tbody>
            {nodes.map((n) => (
              <tr key={n.mac}>
                <td>{n.mac}</td>
                <td>{n.ip}</td>
                <td>{n.isOnline ? 'online' : 'offline'}</td>
                <td>{n.controlPointId ? 'yes' : 'no'}</td>
                <td><span className="swatch" style={{ background: n.desiredColor }} /></td>
                <td>{n.reportedColor && <span className="swatch" style={{ background: n.reportedColor }} />}</td>
                <td>{n.rssi ?? '—'}</td>
                <td><button onClick={() => identifyNode(n.mac)}>Identify</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h2>Respawn Points</h2>
        <div className="claim-form">
          <input value={rpLat} onChange={(e) => setRpLat(e.target.value)} placeholder="Latitude" />
          <input value={rpLong} onChange={(e) => setRpLong(e.target.value)} placeholder="Longitude" />
          <input
            value={rpCustomId}
            onChange={(e) => setRpCustomId(e.target.value)}
            placeholder="Custom ID (optional, e.g. to match a pre-printed test QR)"
          />
        </div>
        <div className="team-toggle-list">
          <span>Allowed teams (none checked = any team):</span>
          {state.teams.map((t) => (
            <label key={t.teamId} className="team-toggle">
              <input type="checkbox" checked={rpTeamIds.includes(t.teamId)} onChange={() => toggleRpTeam(t.teamId)} />
              <span className="swatch" style={{ background: t.hexColor }} />
              {t.teamName}
            </label>
          ))}
        </div>
        <button onClick={createRespawnLocation}>Add respawn location</button>
        <table>
          <thead><tr><th>QR</th><th>Lat</th><th>Long</th><th>Allowed teams</th><th></th></tr></thead>
          <tbody>
            {respawnLocations.map((rp) => (
              <tr key={rp.respawnLocationId}>
                <td><QrThumbnail value={encodeRpQr(rp.respawnLocationId)} /></td>
                <td>{rp.locationLat}</td>
                <td>{rp.locationLong}</td>
                <td>{rp.allowedTeamIds.length === 0 ? 'any' : rp.allowedTeamIds.map((id) => state.teams.find((t) => t.teamId === id)?.teamName ?? id).join(', ')}</td>
                <td><button onClick={() => deleteRespawnLocation(rp.respawnLocationId)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      </div>

      <section>
        <a href="/join-sheet" target="_blank" rel="noreferrer">Print Join Sheet</a>
        {' · '}
        <a href="/test-qr" target="_blank" rel="noreferrer">Test QR Codes</a>
      </section>

      <div className="admin-group admin-group-log">
        <section>
          <h2>Event log</h2>
          <div className="event-log">
            {state.eventLog.map((line, i) => <div key={i}>{line}</div>)}
          </div>
        </section>
      </div>
    </div>
  );
}
