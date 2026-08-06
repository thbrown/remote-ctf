import { useEffect, useState } from 'react';
import { useGame } from '../useGame';

interface NodeRow {
  mac: string;
  ip: string;
  controlPointId: string | null;
  isOnline: boolean;
  desiredColor: string;
  reportedColor: string | null;
  rssi: number | null;
}

export function AdminApp() {
  const [pin, setPin] = useState('');
  const [pinSubmitted, setPinSubmitted] = useState(false);
  const { socket, state } = useGame('admin', pinSubmitted ? pin : undefined);

  const [sessionName, setSessionName] = useState('Round 1');
  const [activeTeamIds, setActiveTeamIds] = useState<string[]>([]);
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [claimMac, setClaimMac] = useState('');
  const [claimName, setClaimName] = useState('');

  useEffect(() => {
    if (state.status !== 'connected' || !pinSubmitted) return;
    const interval = setInterval(() => {
      socket.emit('admin:nodes:list', {}, (res: any) => {
        if (res?.ok) setNodes(res.nodes);
      });
    }, 3000);
    return () => clearInterval(interval);
  }, [socket, state.status, pinSubmitted]);

  if (!pinSubmitted) {
    return (
      <div className="admin-login">
        <h2>Admin PIN</h2>
        <input type="password" value={pin} onChange={(e) => setPin(e.target.value)} />
        <button onClick={() => setPinSubmitted(true)}>Enter</button>
      </div>
    );
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

  return (
    <div className="admin-app">
      <h1>Admin</h1>
      <div className="status-line">
        Connection: {state.status} · Session: {state.session ? state.session.sessionName : 'none running'}
      </div>

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

      <section>
        <h2>Teams</h2>
        <table>
          <thead>
            <tr><th>Team</th><th>Score</th><th>Tags inflicted</th><th>Tags received</th></tr>
          </thead>
          <tbody>
            {state.teams.map((t) => (
              <tr key={t.teamId}>
                <td><span className="swatch" style={{ background: t.hexColor }} /> {t.teamName}</td>
                <td>{Math.round(t.score * 100)}%</td>
                <td>{t.totalTagsInflicted}</td>
                <td>{t.totalTagsReceived}</td>
              </tr>
            ))}
          </tbody>
        </table>
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
      </section>

      <section>
        <h2>Nodes</h2>
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
        <h2>Event log</h2>
        <div className="event-log">
          {state.eventLog.map((line, i) => <div key={i}>{line}</div>)}
        </div>
      </section>
    </div>
  );
}
