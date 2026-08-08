import { useEffect, useRef, useState } from 'react';
import QrScanner from 'qr-scanner';
// @ts-expect-error -- vite ?url import, no types
import QrScannerWorkerPath from 'qr-scanner/qr-scanner-worker.min.js?url';
import type { Socket } from 'socket.io-client';
import type { GameState } from '../useGame';
import { formatCountdown, formatRelativeTime, useNowTick } from '../relativeTime';
import { ClaimBadgeScreen } from './ClaimBadgeScreen';
import { playCaptureFeedback, playTagInflictedFeedback, playTaggedFeedback } from './feedback';
import { downscalePhoto } from './photo';
import {
  describeGeoError,
  formatGeoStatus,
  LOCATION_THROTTLE_MS,
  WATCH_GEO_OPTIONS,
  type GeoStatus,
} from '../geolocation';

QrScanner.WORKER_PATH = QrScannerWorkerPath;

const DEDUP_WINDOW_MS = 2000; // HUB-172

/** Mounted only once a player has registered (name/team/photo via RegistrationScreen) -
 * that's the point at which camera and geolocation permissions actually matter, so this
 * is where we ask for them instead of on first page load. */
export function GameplayScreen({ socket, state }: { socket: Socket; state: GameState }) {
  const now = useNowTick();
  const videoRef = useRef<HTMLVideoElement>(null);
  const scannerRef = useRef<QrScanner | null>(null);
  const lastScanRef = useRef<{ raw: string; atMs: number } | null>(null);
  const [editingProfile, setEditingProfile] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [teamInput, setTeamInput] = useState<string | null>(null);
  const [photoBase64, setPhotoBase64] = useState<string | null>(null);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [rescanningBadge, setRescanningBadge] = useState(false);
  const [geoStatus, setGeoStatus] = useState<GeoStatus>({ kind: 'searching' });
  /** Accuracy of the last fix we actually emitted, so the throttle can let a materially
   * better one through early. Infinity until the first send. */
  const lastSentAccuracyRef = useRef(Infinity);

  // Paused while rescanningBadge is open (ClaimBadgeScreen needs the camera itself, and
  // two QrScanner instances can't share one device at once) and restarted once it closes.
  useEffect(() => {
    if (!videoRef.current || rescanningBadge) return;
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
  }, [socket, rescanningBadge]);

  // Fires once per distinct feedback event (see useGame's lastFeedbackEvent doc comment) -
  // atMs makes every event a new object reference even for repeats of the same kind, so
  // this always re-runs rather than only on the first occurrence.
  useEffect(() => {
    const e = state.lastFeedbackEvent;
    if (!e) return;
    if (e.kind === 'captureCompleted') playCaptureFeedback();
    else if (e.kind === 'tagInflicted') playTagInflictedFeedback();
    else if (e.kind === 'tagReceived') playTaggedFeedback();
  }, [state.lastFeedbackEvent]);

  // HUB-175: GPS optional, throttled to >=3s, never gates any outcome. See geolocation.ts
  // for why enableHighAccuracy and a long timeout are load-bearing on an offline AP.
  useEffect(() => {
    if (!('geolocation' in navigator)) {
      setGeoStatus({ kind: 'unsupported' });
      return;
    }
    setGeoStatus({ kind: 'searching' });
    let lastSentAtMs = 0;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        const nowMs = Date.now();
        const accuracyM = pos.coords.accuracy;
        setGeoStatus({ kind: 'ok', accuracyM, atMs: nowMs });
        // Throttle, but never drop a fix that is materially more precise than the last one
        // we sent - the first good lock after a cold start is exactly the sample worth having.
        const muchBetter = accuracyM < lastSentAccuracyRef.current / 2;
        if (!muchBetter && nowMs - lastSentAtMs < LOCATION_THROTTLE_MS) return;
        lastSentAtMs = nowMs;
        lastSentAccuracyRef.current = accuracyM;
        socket.emit('location', {
          lat: pos.coords.latitude,
          long: pos.coords.longitude,
          accuracyM,
          clientTs: nowMs,
        });
      },
      (err) => {
        // Previously swallowed entirely, which is why a broken GPS looked identical to a
        // working one that simply had nothing to say.
        setGeoStatus({ kind: 'error', message: describeGeoError(err) });
      },
      WATCH_GEO_OPTIONS,
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

  if (rescanningBadge) {
    return (
      <div className="player-app">
        <ClaimBadgeScreen
          socket={socket}
          title="Scan your new badge"
          description="Scan the QR code on the new badge/wristband you want to use instead — it replaces your old one immediately."
          onClaimed={() => setRescanningBadge(false)}
        />
        <button onClick={() => setRescanningBadge(false)}>Cancel</button>
      </div>
    );
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
            {/* Only name the tagger if the last feedback event was actually the tag that put
                us here - a stale name from an earlier round would be worse than none. */}
            {state.lastFeedbackEvent?.kind === 'tagReceived' && state.lastFeedbackEvent.otherPlayerName && (
              <div className="tagged-out-by">by {state.lastFeedbackEvent.otherPlayerName}</div>
            )}
            <div>Return to your respawn point</div>
          </div>
        )}
        {!taggedOut && !state.session && (
          <div className="waiting-overlay">
            <div>YOU'RE IN!</div>
            <div>Waiting for the admin to start the game…</div>
          </div>
        )}
      </div>

      <div className="stats-panel">
        <div className="own-status">
          <span className="swatch" style={{ background: team?.hexColor }} />
          <strong>{ownPlayer?.playerName}</strong>
          <span className={`badge badge-${ownPlayer?.playerStatus}`}>{ownPlayer?.playerStatus}</span>
          {state.session?.gameDurationMs != null && (
            <span className="game-clock">{formatCountdown(state.session.startTimestamp, state.session.gameDurationMs, now)}</span>
          )}
          {/* Purely informational (HUB-175 forbids GPS gating any outcome), but without it
              there's no way to tell a denied permission from a cold fix from a broken cert. */}
          <span className={`badge gps-${geoStatus.kind}`}>{formatGeoStatus(geoStatus)}</span>
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

            <div className="field">
              QR code / badge
              <button onClick={() => setRescanningBadge(true)}>Scan a different badge…</button>
            </div>

            <div className="profile-dialog-actions">
              <button onClick={saveProfile}>Save</button>
              <button onClick={() => setEditingProfile(false)}>Close</button>
            </div>
          </div>
        )}

        {state.lastRejection && (
          <div className="rejection-toast">{state.lastRejection.reason.replace(/_/g, ' ')}</div>
        )}

        <div className="event-log">
          {state.eventLog.map((entry) => (
            <div key={entry.id}>
              <span className="event-log-time">{formatRelativeTime(entry.atMs, now)}</span> — {entry.text}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
