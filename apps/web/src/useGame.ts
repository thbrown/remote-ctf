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
  playerId: string;
  progress: number;
  isHumanDetected: boolean;
}

/** Mirrors TagEvent from @foundry-ctf/shared, with the added fields optional so a client
 * running against an older Hub degrades to "another player" rather than "undefined". */
interface TagEventPayload {
  tagId: string;
  otherPlayerId: string;
  otherPlayerName?: string;
  otherTeamId?: string | null;
}

export interface ScanRejection {
  raw: string;
  reason: string;
  atMs: number;
}

export interface EventLogEntry {
  id: number;
  atMs: number;
  text: string;
}

export interface GameState {
  status: ConnectionStatus;
  teams: QrCtfTeam[];
  controlPoints: QrCtfControlPoint[];
  session: QrCtfSession | null;
  ownPlayer: QrCtfPlayer | null;
  activeCapture: CaptureProgressState | null;
  lastRejection: ScanRejection | null;
  eventLog: EventLogEntry[];
  /** Set when session:hello's ack comes back ok:false (e.g. a bad admin PIN) - cleared at
   * the start of every fresh hello attempt. Admin/spectator only; players always succeed
   * (they get a fresh identity if their stored one doesn't match). */
  authError: string | null;
  /** Bumped on capture:completedOwn/tag:inflicted/tag:received - each is a distinct object
   * (even for repeats of the same kind) so a consuming useEffect keyed on this field always
   * re-fires, which is what drives sound/vibration feedback (see player/feedback.ts). Kept
   * out of eventLog's string-based approach since that's meant for display text, and these
   * player-room-targeted events (never broadcast to everyone) are specifically the ones
   * that should trigger personal feedback, unlike e.g. the broadcast capture:completed. */
  lastFeedbackEvent: {
    kind: 'captureCompleted' | 'tagInflicted' | 'tagReceived';
    atMs: number;
    /** Who the tag was with, for the on-screen banner. Null for captureCompleted. */
    otherPlayerName?: string | null;
  } | null;
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
    lastFeedbackEvent: null,
  }));
  const helloSentRef = useRef(false);
  const eventLogIdRef = useRef(0);
  /** Mirror of state.ownPlayer?.playerId, readable from event handlers that need our identity
   * outside a setState reducer (e.g. deciding whether a capture event is ours before logging). */
  const ownPlayerIdRef = useRef<string | null>(loadPlayerIdentity()?.playerId ?? null);
  /** Mirror of state.teams, for handlers that need to resolve a teamId to a name without
   * reaching into a setState reducer. */
  const teamsRef = useRef<QrCtfTeam[]>([]);

  useEffect(() => {
    // Reset on every effect run (role/adminPin change, e.g. a retry with a corrected PIN)
    // so a stale success/failure from a previous attempt can't block or misreport a new one.
    helloSentRef.current = false;
    setState((s) => (s.authError ? { ...s, authError: null } : s));

    function pushLog(text: string) {
      const entry = { id: eventLogIdRef.current++, atMs: Date.now(), text };
      setState((s) => ({ ...s, eventLog: [entry, ...s.eventLog].slice(0, 50) }));
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
      ownPlayerIdRef.current = snap.ownPlayer?.playerId ?? null;
      teamsRef.current = snap.teams;
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
        if (type === 'qrCtfTeam') {
          const teams = applyPatch(s.teams, 'teamId', id, patch);
          teamsRef.current = teams;
          return { ...s, teams };
        }
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

    // The server already scopes capture:started/capture:progress to the capturing player's
    // room, but we self-filter on playerId anyway: a bystander rendering someone else's
    // progress ring is the exact bug this guards, and one stale server build shouldn't be
    // able to bring it back.
    function onCaptureStarted(e: { captureId: string; controlPointId: string; playerId: string; durationMs: number }) {
      setState((s) => {
        if (e.playerId !== s.ownPlayer?.playerId) return s;
        return { ...s, activeCapture: { captureId: e.captureId, playerId: e.playerId, progress: 0, isHumanDetected: true } };
      });
      // Own-identity check lives in the reducer above (it needs `s.ownPlayer`), so gate the
      // log on the same ref rather than logging someone else's capture start.
      if (e.playerId === ownPlayerIdRef.current) pushLog('Capture started');
    }
    function onCaptureProgress(e: CaptureProgressState) {
      setState((s) =>
        s.activeCapture?.captureId === e.captureId && e.playerId === s.ownPlayer?.playerId ? { ...s, activeCapture: e } : s,
      );
    }
    // capture:completed and capture:abandoned are genuine broadcasts (control point ownership
    // is public), so they must only clear OUR ring - otherwise one player finishing a capture
    // wipes another player's in-progress ring.
    function onCaptureCompleted(e: { captureId: string }) {
      setState((s) => (s.activeCapture?.captureId === e.captureId ? { ...s, activeCapture: null } : s));
      pushLog('Capture completed!');
    }
    // Player-room-targeted (unlike capture:completed's broadcast to everyone) - this is
    // specifically "my own capture finished," which is what personal feedback should key
    // off of, not "anyone anywhere captured anything."
    function onCaptureCompletedOwn() {
      setState((s) => ({ ...s, lastFeedbackEvent: { kind: 'captureCompleted', atMs: Date.now() } }));
    }
    function onCaptureAbandoned(e: { captureId: string; playerId: string; abandonReason: string }) {
      setState((s) => (s.activeCapture?.captureId === e.captureId ? { ...s, activeCapture: null } : s));
      if (e.playerId === ownPlayerIdRef.current) pushLog(`Capture abandoned: ${e.abandonReason}`);
    }
    function onScanRejected(e: { raw: string; reason: string }) {
      setState((s) => ({ ...s, lastRejection: { raw: e.raw, reason: e.reason, atMs: Date.now() } }));
      pushLog(`Scan rejected: ${e.reason}`);
    }
    /** "Bob (Red Raiders)" when the team resolves, "Bob" when it doesn't. Reads teams from a
     * ref rather than state so this stays a pure lookup outside any reducer. */
    function describeOther(e: { otherPlayerName?: string; otherTeamId?: string | null }): string {
      const name = e.otherPlayerName?.trim() || 'another player';
      const team = e.otherTeamId ? teamsRef.current.find((t) => t.teamId === e.otherTeamId) : null;
      return team ? `${name} (${team.teamName})` : name;
    }
    function onTagInflicted(e: TagEventPayload) {
      pushLog(`You tagged ${describeOther(e)}!`);
      setState((s) => ({
        ...s,
        lastFeedbackEvent: { kind: 'tagInflicted', atMs: Date.now(), otherPlayerName: e.otherPlayerName ?? null },
      }));
    }
    function onTagReceived(e: TagEventPayload) {
      pushLog(`${describeOther(e)} tagged you!`);
      setState((s) => ({
        ...s,
        lastFeedbackEvent: { kind: 'tagReceived', atMs: Date.now(), otherPlayerName: e.otherPlayerName ?? null },
      }));
    }
    function onRespawnCompleted() {
      pushLog('Respawned');
    }
    function onSessionStarted() {
      pushLog('Session started');
    }
    function onSessionEnded() {
      pushLog('Session ended');
      // The store patch for the ended session carries endTimestamp/winningTeamId, not a
      // null - nothing else ever clears state.session back to null, which left Admin/
      // Player screens stuck showing session-in-progress UI until a refresh.
      setState((s) => ({ ...s, session: null }));
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
    socket.on('capture:completedOwn', onCaptureCompletedOwn);
    socket.on('capture:abandoned', onCaptureAbandoned);
    socket.on('scan:rejected', onScanRejected);
    socket.on('tag:inflicted', onTagInflicted);
    socket.on('tag:received', onTagReceived);
    socket.on('respawn:completed', onRespawnCompleted);
    socket.on('session:started', onSessionStarted);
    socket.on('session:ended', onSessionEnded);

    if (socket.connected) sendHello();
    // A server-initiated disconnect.disconnect(true) - e.g. a bad admin PIN - leaves the
    // reason as "io server disconnect", which by Socket.IO's own design does NOT
    // auto-reconnect (unlike a transport/network drop). Retrying (a new role/adminPin,
    // which re-runs this effect) needs an explicit connect() or the socket just sits
    // disconnected forever with nothing ever calling sendHello() again.
    else socket.connect();

    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('state:snapshot', onSnapshot);
      socket.off('state:patch', onPatch);
      socket.off('capture:started', onCaptureStarted);
      socket.off('capture:progress', onCaptureProgress);
      socket.off('capture:completed', onCaptureCompleted);
      socket.off('capture:completedOwn', onCaptureCompletedOwn);
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
