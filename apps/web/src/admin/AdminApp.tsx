import { useEffect, useRef, useState, type ReactNode } from 'react';
import { encodePlQr, encodeRpQr, isQrParseError, parseQr } from '@foundry-ctf/shared';
import { formatRelativeTime, useNowTick } from '../relativeTime';
import { useGame } from '../useGame';
import { AdminQrScanner } from './AdminQrScanner';
import {
  playNodeConnectedFeedback,
  playNodeDisconnectedFeedback,
  playPlayerConnectedFeedback,
  playPlayerDisconnectedFeedback,
} from './feedback';
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

type SectionTone = 'session' | 'players' | 'nodes' | 'respawn' | 'resources' | 'log';

function AdminSection({ title, tone, children }: { title: string; tone: SectionTone; children: ReactNode }) {
  return (
    <section className={`admin-section admin-section-${tone}`}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function AdminApp() {
  const now = useNowTick();
  const [pin, setPin] = useState('');
  // Deliberately separate from `pin` (which tracks every keystroke): only updates when
  // "Enter" is clicked, so useGame's effect (keyed on this value) doesn't re-send
  // session:hello on every keystroke - only on an actual submit.
  const [submittedPin, setSubmittedPin] = useState<string | undefined>(undefined);
  const { socket, state } = useGame('admin', submittedPin);

  const [sessionName, setSessionName] = useState('Round 1');
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [claimMac, setClaimMac] = useState('');
  const [claimName, setClaimName] = useState('');
  const [claimLat, setClaimLat] = useState('');
  const [claimLong, setClaimLong] = useState('');
  const [respawnLocations, setRespawnLocations] = useState<RespawnLocationRow[]>([]);
  const [rpLat, setRpLat] = useState('');
  const [rpLong, setRpLong] = useState('');
  const [rpTeamIds, setRpTeamIds] = useState<string[]>([]);
  const [rpCustomId, setRpCustomId] = useState('');
  const [players, setPlayers] = useState<PlayerRow[]>([]);
  const [qrEdits, setQrEdits] = useState<Record<string, string>>({});
  const [scanning, setScanning] = useState<'cp' | 'rp' | null>(null);

  function refreshRespawnLocations() {
    socket.emit('admin:respawnLocation:list', {}, (res: any) => {
      if (res?.ok) setRespawnLocations(res.locations);
    });
  }

  // Previous poll's connectivity, keyed by mac/playerId - compared against each new poll to
  // detect connect/disconnect transitions and fire the matching sound. null until the first
  // poll lands, so that initial roster load doesn't fire a burst of connect sounds.
  const prevNodeOnlineRef = useRef<Map<string, boolean> | null>(null);
  const prevPlayerConnectedRef = useRef<Map<string, boolean> | null>(null);

  useEffect(() => {
    if (state.status !== 'connected' || submittedPin === undefined) return;
    refreshRespawnLocations();
    function pollNodesAndPlayers() {
      socket.emit('admin:nodes:list', {}, (res: any) => {
        if (!res?.ok) return;
        const nodeRows: NodeRow[] = res.nodes;
        setNodes(nodeRows);
        const prev = prevNodeOnlineRef.current;
        const next = new Map(nodeRows.map((n) => [n.mac, n.isOnline]));
        if (prev) {
          for (const n of nodeRows) {
            const was = prev.get(n.mac);
            if (was === undefined) continue;
            if (was && !n.isOnline) playNodeDisconnectedFeedback();
            else if (!was && n.isOnline) playNodeConnectedFeedback();
          }
        }
        prevNodeOnlineRef.current = next;
      });
      socket.emit('admin:players:list', {}, (res: any) => {
        if (!res?.ok) return;
        const playerRows: PlayerRow[] = res.players;
        setPlayers(playerRows);
        const prev = prevPlayerConnectedRef.current;
        const next = new Map(playerRows.map((p) => [p.playerId, p.isConnected]));
        if (prev) {
          for (const p of playerRows) {
            const was = prev.get(p.playerId);
            if (was === undefined) continue;
            if (was && !p.isConnected) playPlayerDisconnectedFeedback();
            else if (!was && p.isConnected) playPlayerConnectedFeedback();
          }
        }
        prevPlayerConnectedRef.current = next;
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

  function handleScan(raw: string) {
    const kind = scanning;
    setScanning(null);
    const qr = parseQr(raw);
    if (isQrParseError(qr)) {
      alert('Could not read that QR code — try again.');
      return;
    }
    if (kind === 'cp') {
      if (qr.kind !== 'cp') {
        alert("That's not a Control Point QR code.");
        return;
      }
      setClaimMac(qr.macAddress);
      // Best-effort: fill lat/long from wherever the admin is standing when they scan it,
      // same as the Respawn Point flow below - not fatal if denied/unavailable.
      if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setClaimLat(String(pos.coords.latitude));
            setClaimLong(String(pos.coords.longitude));
          },
          () => {},
          { timeout: 5000 },
        );
      }
    } else if (kind === 'rp') {
      if (qr.kind !== 'rp') {
        alert("That's not a Respawn Point QR code.");
        return;
      }
      setRpCustomId(qr.respawnLocationId);
      // Best-effort: fill lat/long from wherever the admin is standing when they scan it -
      // the QR itself only carries an ID, not a location. Not fatal if denied/unavailable;
      // the admin can still type coordinates by hand.
      if ('geolocation' in navigator) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            setRpLat(String(pos.coords.latitude));
            setRpLong(String(pos.coords.longitude));
          },
          () => {},
          { timeout: 5000 },
        );
      }
    }
  }

  if (scanning) {
    return (
      <AdminQrScanner
        title={scanning === 'cp' ? 'Scan the Control Point QR code' : 'Scan the Respawn Point QR code'}
        onScan={handleScan}
        onCancel={() => setScanning(null)}
      />
    );
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

  // activeTeamIds isn't admin-picked anymore - the server derives it from whichever teams
  // currently have >=1 player, since a team with no players can't play. This is just a
  // preview of that for the admin's benefit before hitting start.
  const teamIdsWithPlayers = [...new Set(players.map((p) => p.teamId).filter((id): id is string => !!id))];
  const teamsWithPlayers = state.teams.filter((t) => teamIdsWithPlayers.includes(t.teamId));

  function startSession() {
    socket.emit('admin:session:start', { sessionName }, (res: any) => {
      if (!res?.ok) {
        const message =
          res?.error === 'need_at_least_two_teams_with_players'
            ? 'Need at least 2 teams with players joined before starting.'
            : res?.error;
        alert(`Failed to start session: ${message}`);
      }
    });
  }

  function stopSession() {
    socket.emit('admin:session:stop', {}, () => {});
  }

  function removePlayer(playerId: string, playerName: string) {
    if (!confirm(`Remove ${playerName} from this station?`)) return;
    socket.emit('admin:player:remove', { playerId }, (res: any) => {
      if (!res?.ok) {
        alert(`Failed to remove player: ${res?.error}`);
        return;
      }
      setPlayers((ps) => ps.filter((p) => p.playerId !== playerId));
    });
  }

  function claimNode() {
    const lat = claimLat.trim() ? Number(claimLat) : undefined;
    const long = claimLong.trim() ? Number(claimLong) : undefined;
    if ((lat !== undefined && !Number.isFinite(lat)) || (long !== undefined && !Number.isFinite(long))) {
      alert('lat/long must be numbers');
      return;
    }
    socket.emit(
      'admin:node:claim',
      { macAddress: claimMac, controlPointName: claimName || undefined, lat, long },
      (res: any) => {
        if (!res?.ok) alert(`Failed to claim: ${res?.error}`);
        else {
          setClaimMac('');
          setClaimName('');
          setClaimLat('');
          setClaimLong('');
        }
      },
    );
  }

  function identifyNode(mac: string) {
    socket.emit('admin:node:identify', { macAddress: mac }, (res: any) => {
      if (res?.ok) alert('Identify sent — the node should blink white for ~3s.');
      else alert('Could not reach that node — it may be offline.');
    });
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
        <span className="status-pill">Connection: {state.status}</span>
        <span className="status-pill">Session: {state.session ? state.session.sessionName : 'none running'}</span>
      </div>

      <AdminSection title="Session" tone="session">
        {state.session ? (
          <button className="btn-danger" onClick={stopSession}>Stop session</button>
        ) : (
          <>
            <input value={sessionName} onChange={(e) => setSessionName(e.target.value)} placeholder="Session name" />
            <div className="team-toggle-list">
              <span>Teams with players joined (these will be active):</span>
              {teamsWithPlayers.length === 0 && <span>— none yet</span>}
              {teamsWithPlayers.map((t) => (
                <span key={t.teamId} className="team-toggle">
                  <span className="swatch" style={{ background: t.hexColor }} />
                  {t.teamName}
                </span>
              ))}
            </div>
            <button onClick={startSession} disabled={teamsWithPlayers.length < 2}>
              Start session
            </button>
          </>
        )}
      </AdminSection>

      <AdminSection title="Players" tone="players">
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Photo</th><th>Name</th><th>Team</th><th>Status</th><th>Connected</th>
                <th>Tags for</th><th>Tags against</th><th>K/D</th><th>Points captured</th>
                <th>QR code ID</th><th>Badge</th><th></th>
              </tr>
            </thead>
            <tbody>
              {players.map((p) => {
                const team = p.teamId ? state.teams.find((t) => t.teamId === p.teamId) : null;
                const kd = p.tagsReceived === 0 ? (p.tagsInflicted === 0 ? '—' : '∞') : (p.tagsInflicted / p.tagsReceived).toFixed(2);
                return (
                  <tr key={p.playerId} className={p.isConnected ? '' : 'row-disconnected'}>
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
                    <td><button className="btn-danger" onClick={() => removePlayer(p.playerId, p.playerName)}>Remove</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </AdminSection>

      <AdminSection title="Control Points" tone="nodes">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>MAC</th><th>Owner</th><th>Presence</th><th>Connected</th>
              <th title="Hub wants (desired) / Node confirms (reported) - Node may lag Hub by a few seconds">LED</th>
              <th>Lat/Long</th><th>RSSI</th><th></th>
            </tr>
          </thead>
          <tbody>
            {state.controlPoints.map((cp) => {
              const owner = cp.currentOwnerTeamId ? state.teams.find((t) => t.teamId === cp.currentOwnerTeamId) : null;
              const node = cp.macAddress ? nodes.find((n) => n.mac === cp.macAddress) : undefined;
              const connected = node?.isOnline ?? false;
              return (
                <tr key={cp.controlPointId} className={connected ? '' : 'row-disconnected'}>
                  <td>{cp.controlPointName}</td>
                  <td>{cp.macAddress ?? '—'}</td>
                  <td>{owner ? owner.teamName : 'Neutral'}</td>
                  <td>{cp.isHumanDetected ? 'detected' : 'clear'}</td>
                  <td>{node ? (connected ? 'connected' : 'disconnected') : '—'}</td>
                  <td>
                    {node ? (
                      <span className="led-pair">
                        <span className="led-swatch" title="Hub wants the LED set to this">
                          <span className="swatch" style={{ background: node.desiredColor }} /> Hub
                        </span>
                        <span className="led-swatch" title="Node last confirmed this back - may lag Hub by a few seconds">
                          {node.reportedColor && <span className="swatch" style={{ background: node.reportedColor }} />} Node
                        </span>
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td>{cp.locationLat != null && cp.locationLong != null ? `${cp.locationLat.toFixed(5)}, ${cp.locationLong.toFixed(5)}` : '—'}</td>
                  <td>{node?.rssi ?? '—'}</td>
                  <td>{node && <button className="btn-ghost" onClick={() => identifyNode(node.mac)}>Identify</button>}</td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <h3>Claim a node</h3>
        <div className="claim-form">
          <input value={claimMac} onChange={(e) => setClaimMac(e.target.value)} placeholder="MAC address (AA:BB:CC:DD:EE:FF)" />
          <input value={claimName} onChange={(e) => setClaimName(e.target.value)} placeholder="Control Point name" />
          <input value={claimLat} onChange={(e) => setClaimLat(e.target.value)} placeholder="Latitude" />
          <input value={claimLong} onChange={(e) => setClaimLong(e.target.value)} placeholder="Longitude" />
          <button className="btn-ghost" onClick={() => setScanning('cp')}>Scan QR</button>
          <button onClick={claimNode}>Claim</button>
        </div>

        {nodes.some((n) => !n.controlPointId) && (
          <>
            <h3>Unclaimed nodes seen on the network</h3>
            <table>
              <thead>
                <tr><th>MAC</th><th>IP</th><th>Connected</th><th>RSSI</th><th></th></tr>
              </thead>
              <tbody>
                {nodes.filter((n) => !n.controlPointId).map((n) => (
                  <tr key={n.mac} className={n.isOnline ? '' : 'row-disconnected'}>
                    <td>{n.mac}</td>
                    <td>{n.ip}</td>
                    <td>{n.isOnline ? 'connected' : 'disconnected'}</td>
                    <td>{n.rssi ?? '—'}</td>
                    <td><button className="btn-ghost" onClick={() => setClaimMac(n.mac)}>Use for claim</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </AdminSection>

      <AdminSection title="Respawn Points" tone="respawn">
        <h3>Add a respawn location</h3>
        <div className="claim-form">
          <input value={rpLat} onChange={(e) => setRpLat(e.target.value)} placeholder="Latitude" />
          <input value={rpLong} onChange={(e) => setRpLong(e.target.value)} placeholder="Longitude" />
          <input
            value={rpCustomId}
            onChange={(e) => setRpCustomId(e.target.value)}
            placeholder="Custom ID (optional, e.g. to match a pre-printed test QR)"
          />
          <button className="btn-ghost" onClick={() => setScanning('rp')}>Scan QR</button>
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
                <td><button className="btn-danger" onClick={() => deleteRespawnLocation(rp.respawnLocationId)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </AdminSection>

      <AdminSection title="Resources" tone="resources">
        <a href="/join-sheet" target="_blank" rel="noreferrer">Print Join Sheet</a>
        {' · '}
        <a href="/test-qr" target="_blank" rel="noreferrer">Test QR Codes</a>
      </AdminSection>

      <AdminSection title="Event log" tone="log">
        <div className="event-log">
          {state.eventLog.map((entry) => (
            <div key={entry.id}>
              <span className="event-log-time">{formatRelativeTime(entry.atMs, now)}</span> — {entry.text}
            </div>
          ))}
        </div>
      </AdminSection>
    </div>
  );
}
