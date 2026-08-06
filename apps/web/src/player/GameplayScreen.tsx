import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';
// @ts-expect-error -- vite ?url import, no types
import QrScannerWorkerPath from 'qr-scanner/qr-scanner-worker.min.js?url';
import type { Socket } from 'socket.io-client';
import type { GameState } from '../useGame';
import { downscalePhoto } from './photo';

QrScanner.WORKER_PATH = QrScannerWorkerPath;

const DEDUP_WINDOW_MS = 2000; // HUB-172

/** Mounted only once a player has registered (name/team/photo via RegistrationScreen) -
 * that's the point at which camera and geolocation permissions actually matter, so this
 * is where we ask for them instead of on first page load. */
export function GameplayScreen({ socket, state }: { socket: Socket; state: GameState }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const lastScanRef = useRef<{ raw: string; atMs: number } | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [teamInput, setTeamInput] = useState<string | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  useEffect(() => {
    if (!videoRef.current) return;
    const scanner = new QrScanner(
      videoRef.current,
      (result) => {
        const raw = result.data;
        const now = Date.now();
        const last = lastScanRef.current;
        if (last && last.raw === raw && now - last.atMs < DEDUP_WINDOW_MS) return; // HUB-172 dedup
        lastScanRef.current = { raw, atMs: now };
        socket.emit('scan', { raw, clientTs: now });
      },
      { highlightScanRegion: true, maxScansPerSecond: 8 },
    );
    scannerRef.current = scanner;
    scanner.start().catch((err) => console.error('camera start failed', err));
    return () => {
      scanner.stop();
      scanner.destroy();
      scannerRef.current = null;
    };
  }, [socket]);

  // HUB-175: GPS optional, throttled to >=3s, never gates any outcome.
  useEffect(() => {
    if (!('geolocation' in navigator)) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        socket.emit('location', {
          lat: pos.coords.latitude,
          long: pos.coords.longitude,
          accuracyM: pos.coords.accuracy,
          clientTs: Date.now(),
        });
      },
      () => {},
      { maximumAge: 3000, timeout: 5000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [socket]);

  const ownPlayer = state.ownPlayer;
  const team = ownPlayer?.teamId ? state.teams.find((t) => t.teamId === ownPlayer.teamId) : null;
  const taggedOut = ownPlayer?.playerStatus === 'tagged_out';

  function openEditProfile() {
    setNameInput(ownPlayer?.playerName ?? '');
    setTeamInput(ownPlayer?.teamId ?? null);
    setPhotoBase64(null);
    setPhotoPreview(ownPlayer?.profilePicture ?? null);
    setPhotoError(null);
    setEditingProfile(true);
  }

  async function handlePhotoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhotoError(null);
    try {
      const base64 = await downscalePhoto(file);
      setPhotoBase64(base64);
      setPhotoPreview(`data:image/jpeg;base64,${base64}`);
    } catch (err) {
      console.error('photo processing failed', err);
      setPhotoError('Could not use that photo — try a different one.');
    }
  }

  function saveProfile() {
    socket.emit('player:update', {
      playerName: nameInput || undefined,
      ...(teamInput && teamInput !== ownPlayer?.teamId ? { teamId: teamInput } : {}),
      ...(photoBase64 ? { profilePicture: photoBase64 } : {}),
    });
    setEditingProfile(false);
  }

  function cancelCapture() {
    if (state.activeCapture) socket.emit('capture:cancel', { captureId: state.activeCapture.captureId });
  }

  return (
    <div className="player-app">
      <div className="camera-view">
        <video ref={videoRef} muted playsInline autoPlay />
        {state.activeCapture && (
          <div className="capture-overlay">
            <div
              className="progress-ring"
              style={{
                background: `conic-gradient(#3A48EA ${state.activeCapture.progress * 360}deg, rgba(255,255,255,0.2) 0deg)`,
              }}
            />
            <div className="capture-label">
              {Math.round(state.activeCapture.progress * 100)}%
              {!state.activeCapture.isHumanDetected && <div className="keep-moving">Keep moving!</div>}
            </div>
            <button onClick={cancelCapture}>Cancel</button>
          </div>
        )}
        {taggedOut && (
          <div className="tagged-out-overlay">
            <div>TAGGED OUT</div>
            <div>Return to your respawn point</div>
          </div>
        )}
      </div>

      <div className="stats-panel">
        <div className="own-status">
          <span className="swatch" style={{ background: team?.hexColor }} />
          <strong>{ownPlayer?.playerName}</strong>
          <span className={`badge badge-${ownPlayer?.playerStatus}`}>{ownPlayer?.playerStatus}</span>
          <button onClick={openEditProfile}>Edit</button>
        </div>

        {editingProfile && (
          <div className="profile-dialog">
            <label className="field">
              Name
              <input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Player name" />
            </label>

            <label className="field photo-field">
              Photo
              <input type="file" accept="image/*" capture="user" onChange={handlePhotoChange} />
            </label>
            {photoPreview && <img className="photo-preview" src={photoPreview} alt="Your photo" />}
            {photoError && <div className="form-error">{photoError}</div>}

            <div className="field">
              Team
              <div className="team-picker">
                {state.teams.map((t) => (
                  <button
                    key={t.teamId}
                    style={{ background: t.hexColor, outline: teamInput === t.teamId ? '3px solid white' : 'none' }}
                    onClick={() => setTeamInput(t.teamId)}
                  >
                    {t.teamName}
                    {teamInput === t.teamId ? ' ✓' : ''}
                  </button>
                ))}
              </div>
            </div>

            <div className="profile-dialog-actions">
              <button onClick={saveProfile}>Save</button>
              <button onClick={() => setEditingProfile(false)}>Close</button>
            </div>
          </div>
        )}

        <div className="scoreboard-mini">
          {[...state.teams]
            .sort((a, b) => b.score - a.score)
            .map((t) => (
              <div key={t.teamId} className="scoreboard-row">
                <span className="swatch" style={{ background: t.hexColor }} />
                <span>{t.teamName}</span>
                <span>{Math.round(t.score * 100)}%</span>
              </div>
            ))}
        </div>

        {state.lastRejection && (
          <div className="rejection-toast">{state.lastRejection.reason.replace(/_/g, ' ')}</div>
        )}

        <div className="event-log">
          {state.eventLog.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
