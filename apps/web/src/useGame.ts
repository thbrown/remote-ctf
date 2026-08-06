import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  QrCtfControlPoint,
  QrCtfPlayer,
  QrCtfSession,
  QrCtfTeam,
} from '@foundry-ctf/shared';
import { getSocket, loadPlayerIdentity, savePlayerIdentity, loadCachedOwnPlayer, saveCachedOwnPlayer } from './socket';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export interface CaptureProgressState {
  captureId: string;
  progress: number;
  isHumanDetected: boolean;
}

export interface ScanRejection {
  raw: string;
  reason: string;
  atMs: number;
}

export interface GameState {
  status: ConnectionStatus;
  teams: QrCtfTeam[];
  controlPoints: QrCtfControlPoint[];
  session: QrCtfSession | null;
  ownPlayer: QrCtfPlayer | null;
  activeCapture: CaptureProgressState | null;
  lastRejection: ScanRejection | null;
  eventLog: string[];
  /** Set when session:hello's ack comes back ok:false (e.g. a bad admin PIN) - cleared at
   * the start of every fresh hello attempt. Admin/spectator only; players always succeed
   * (they get a fresh identity if their stored one doesn't match). */
  authError: string | null;
}

function applyPatch<T extends Record<string, any>>(list: T[], idKey: string, id: string, patch: unknown): T[] {
  if (patch === null) return list.filter((x) => x[idKey] !== id);
  const idx = list.findIndex((x) => x[idKey] === id);
  if (idx === -1) return [...list, patch as T];
  const next = [...list];
  next[idx] = { ...next[idx], ...(patch as object) };
  return next;
}

/** Drives the socket lifecycle + snapshot/patch reducer for whichever role mounts it.
 * One instance per view (Player/Admin/Spectator) — doc01's mode chooser ensures only one
 * is ever active per tab. */
export function useGame(role: 'player' | 'admin' | 'spectator', adminPin?: string) {
  const socket = useMemo(() => getSocket(), []);
  const [state, setState] = useState<GameState>(() => ({
    status: 'connecting',
    teams: [],
    controlPoints: [],
    session: null,
    // Seeded from the last snapshot so a refresh doesn't flash back to the registration
    // screen while waiting for the server round-trip - state:snapshot always overwrites
    // this once it arrives.
    ownPlayer: role === 'player' ? loadCachedOwnPlayer() : null,
    activeCapture: null,
    lastRejection: null,
    eventLog: [],
    authError: null,
  }));
  const helloSentRef = useRef(false);

  useEffect(() => {
    // Reset on every effect run (role/adminPin change, e.g. a retry with a corrected PIN)
    // so a stale success/failure from a previous attempt can't block or misreport a new one.
    helloSentRef.current = false;
    setState((s) => (s.authError ? { ...s, authError: null } : s));

    function pushLog(line: string) {
      setState((s) => ({ ...s, eventLog: [line, ...s.eventLog].slice(0, 50) }));
    }

    function sendHello() {
      if (helloSentRef.current) return;
      helloSentRef.current = true;
      const identity = role === 'player' ? loadPlayerIdentity() : null;
      socket.emit(
        'session:hello',
        {
          role,
          ...(identity ? { playerId: identity.playerId, playerSecret: identity.playerSecret } : {}),
          ...(adminPin ? { adminPin } : {}),
        },
        (ack: any) => {
          if (role === 'player' && ack?.ok && ack.playerId && ack.playerSecret) {
            savePlayerIdentity({ playerId: ack.playerId, playerSecret: ack.playerSecret });
          }
          if (ack?.ok === false) {
            pushLog(`Login failed: ${ack.error ?? 'unknown error'}`);
            setState((s) => ({ ...s, authError: ack.error ?? 'unknown error' }));
          }
        },
      );
    }

    // The hello ack and the state:snapshot event can arrive in the same read burst, so
    // register the snapshot listener before sending hello (see hub-server WsGateway
    // tests for the same race, documented there in detail).
    function onSnapshot(snap: { teams: QrCtfTeam[]; controlPoints: QrCtfControlPoint[]; session: QrCtfSession | null; ownPlayer?: QrCtfPlayer }) {
      if (role === 'player') saveCachedOwnPlayer(snap.ownPlayer ?? null);
      setState((s) => ({
        ...s,
        teams: snap.teams,
        controlPoints: snap.controlPoints,
        session: snap.session,
        ownPlayer: snap.ownPlayer ?? null,
        status: 'connected',
      }));
    }

    function onPatch({ type, id, patch }: { type: string; id: string; patch: unknown }) {
      setState((s) => {
        if (type === 'qrCtfTeam') return { ...s, teams: applyPatch(s.teams, 'teamId', id, patch) };
        if (type === 'qrCtfControlPoint') return { ...s, controlPoints: applyPatch(s.controlPoints, 'controlPointId', id, patch) };
        if (type === 'qrCtfSession') return { ...s, session: patch === null ? null : { ...(s.session ?? ({} as QrCtfSession)), ...(patch as object) } };
        if (type === 'qrCtfPlayer' && s.ownPlayer?.playerId === id) {
          const nextOwnPlayer = patch === null ? null : { ...s.ownPlayer, ...(patch as object) };
          if (role === 'player') saveCachedOwnPlayer(nextOwnPlayer);
          return { ...s, ownPlayer: nextOwnPlayer };
        }
        return s;
      });
    }

    function onCaptureStarted(e: { captureId: string; controlPointId: string; durationMs: number }) {
      setState((s) => ({ ...s, activeCapture: { captureId: e.captureId, progress: 0, isHumanDetected: true } }));
      pushLog('Capture started');
    }
    function onCaptureProgress(e: CaptureProgressState) {
      setState((s) => (s.activeCapture?.captureId === e.captureId ? { ...s, activeCapture: e } : s));
    }
    function onCaptureCompleted() {
      setState((s) => ({ ...s, activeCapture: null }));
      pushLog('Capture completed!');
    }
    function onCaptureAbandoned(e: { abandonReason: string }) {
      setState((s) => ({ ...s, activeCapture: null }));
      pushLog(`Capture abandoned: ${e.abandonReason}`);
    }
    function onScanRejected(e: { raw: string; reason: string }) {
      setState((s) => ({ ...s, lastRejection: { raw: e.raw, reason: e.reason, atMs: Date.now() } }));
      pushLog(`Scan rejected: ${e.reason}`);
    }
    function onTagInflicted() {
      pushLog('You tagged someone!');
    }
    function onTagReceived() {
      pushLog('You were tagged!');
    }
    function onRespawnCompleted() {
      pushLog('Respawned');
    }
    function onSessionStarted() {
      pushLog('Session started');
    }
    function onSessionEnded() {
      pushLog('Session ended');
    }
    function onDisconnect() {
      setState((s) => ({ ...s, status: 'disconnected' }));
      helloSentRef.current = false;
    }
    function onConnect() {
      sendHello();
    }

    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('state:snapshot', onSnapshot);
    socket.on('state:patch', onPatch);
    socket.on('capture:started', onCaptureStarted);
    socket.on('capture:progress', onCaptureProgress);
    socket.on('capture:completed', onCaptureCompleted);
    socket.on('capture:abandoned', onCaptureAbandoned);
    socket.on('scan:rejected', onScanRejected);
    socket.on('tag:inflicted', onTagInflicted);
    socket.on('tag:received', onTagReceived);
    socket.on('respawn:completed', onRespawnCompleted);
    socket.on('session:started', onSessionStarted);
    socket.on('session:ended', onSessionEnded);

    if (socket.connected) sendHello();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('state:snapshot', onSnapshot);
      socket.off('state:patch', onPatch);
      socket.off('capture:started', onCaptureStarted);
      socket.off('capture:progress', onCaptureProgress);
      socket.off('capture:completed', onCaptureCompleted);
      socket.off('capture:abandoned', onCaptureAbandoned);
      socket.off('scan:rejected', onScanRejected);
      socket.off('tag:inflicted', onTagInflicted);
      socket.off('tag:received', onTagReceived);
      socket.off('respawn:completed', onRespawnCompleted);
      socket.off('session:started', onSessionStarted);
      socket.off('session:ended', onSessionEnded);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, adminPin]);

  return { socket, state };
}
