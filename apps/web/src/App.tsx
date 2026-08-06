import { useState } from 'react';
import { PlayerApp } from './player/PlayerApp';
import { AdminApp } from './admin/AdminApp';

type Mode = 'chooser' | 'player' | 'admin';

/** doc01 HUB-150: first load presents a mode chooser. Spectator scoreboard is a separate
 * plain-HTTP page served directly by the Hub's spectatorApp (HUB-176) — not part of this
 * secure-context SPA — so the chooser just links out to it. */
export function App() {
  const [mode, setMode] = useState<Mode>('chooser');

  if (mode === 'player') return <PlayerApp />;
  if (mode === 'admin') return <AdminApp />;

  return (
    <div className="mode-chooser">
      <h1>Foundry CTF</h1>
      <button onClick={() => setMode('player')}>Join as player</button>
      <a
        className="button-link"
        href={`${location.protocol === 'https:' ? 'http:' : location.protocol}//${location.hostname}:8080/scoreboard`}
      >
        Join as spectator
      </a>
      <button onClick={() => setMode('admin')}>Admin</button>
    </div>
  );
}
