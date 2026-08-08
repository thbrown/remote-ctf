/**
 * doc01 §6 — socket.io connection handling: identity (session:hello), the four
 * game-input events, admin actions, and the store-change-feed-driven state:patch
 * broadcast (HUB-054/092). HUB-094: spectator sockets are read-only for gameplay - every
 * game-input/admin handler below checks `role` first and silently drops anything from a
 * spectator. The one deliberate exception is `spectator:players:list`, a narrow read-only
 * roster query returning only name/team/status (never qrCodeToken or playerSecret) for the
 * public scoreboard.
 *
 * Admin surface implemented in this pass: session start/stop, Node claim, Node identify,
 * Node list, Respawn Location create/list/delete, Players list (read-only roster).
 * Player roster mutations (rename/regenerate token/force-respawn) and Node rename/delete
 * are NOT yet implemented — see PROGRESS.md gap list. The Web App should only wire
 * buttons for what exists here until that's filled in.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import {
  AdminSetPlayerQrSchema,
  CaptureCancelSchema,
  ClaimQrSchema,
  isQrParseError,
  LocationSchema,
  normalizeMac,
  parseQr,
  PlayerUpdateSchema,
  ScanSchema,
  SessionHelloSchema,
  type ClientRole,
} from '@foundry-ctf/shared';
import type { GameStateStore } from '../store/GameStateStore.js';
import type { GameEngine } from '../engine/GameEngine.js';
import type { Config } from '../config.js';
import type { NodeDispatcher } from '../nodes/NodeDispatcher.js';
import type { NodeRegistry } from '../nodes/NodeRegistry.js';
import { buildSnapshot } from './snapshot.js';

export interface WsGatewayDeps {
  io: Server;
  store: GameStateStore;
  engine: GameEngine;
  config: Config;
  stationId: string;
  dispatcher: NodeDispatcher;
  registry: NodeRegistry;
}

function randomToken(): string {
  return randomBytes(16).toString('hex'); // 32 chars, well over the >=16 floor (HUB-178)
}

interface SocketState {
  role: ClientRole | null;
  playerId: string | null;
}

export function createWsGateway(deps: WsGatewayDeps): () => void {
  const { io, store, engine, config, stationId, dispatcher, registry } = deps;

  // Live connection tracking for players, keyed by playerId -> the set of socket ids
  // currently connected as that player. A Set (not a boolean) because a reconnect or a
  // second tab can briefly/deliberately hold two sockets for the same playerId - the
  // player only counts as disconnected once every socket for them has gone. Unlike
  // NodeRegistry's heartbeat-timeout approach (nodes have no persistent connection to
  // hook into), players already have a live socket.io connection, so connect/disconnect
  // events are the natural signal here.
  const connectedSocketIdsByPlayerId = new Map<string, Set<string>>();

  async function getPlayerStats(
    playerId: string,
    sessionId: string | null,
  ): Promise<{ tagsInflicted: number; tagsReceived: number; capturesCompleted: number }> {
    if (!sessionId) return { tagsInflicted: 0, tagsReceived: 0, capturesCompleted: 0 };
    const ps = (await store.playerSessions.list({ sessionId, playerId } as any))[0] as any;
    if (!ps) return { tagsInflicted: 0, tagsReceived: 0, capturesCompleted: 0 };
    const [tagsInflictedPoint, tagsReceivedPoint, capturesPoint] = await Promise.all([
      store.series.latest(ps.tagsInflictedSeriesId),
      store.series.latest(ps.tagsReceivedSeriesId),
      store.series.latest(ps.capturesCompletedSeriesId),
    ]);
    return {
      tagsInflicted: (tagsInflictedPoint as any)?.v ?? 0,
      tagsReceived: (tagsReceivedPoint as any)?.v ?? 0,
      capturesCompleted: (capturesPoint as any)?.v ?? 0,
    };
  }

  io.on('connection', (socket: Socket) => {
    const state: SocketState = { role: null, playerId: null };

    socket.on('disconnect', () => {
      if (!state.playerId) return;
      const set = connectedSocketIdsByPlayerId.get(state.playerId);
      if (!set) return;
      set.delete(socket.id);
      if (set.size === 0) connectedSocketIdsByPlayerId.delete(state.playerId);
    });

    socket.on('session:hello', async (raw: unknown, ack?: (res: unknown) => void) => {
      const parsed = SessionHelloSchema.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_hello' });
        socket.disconnect(true);
        return;
      }
      const hello = parsed.data;

      if (hello.role === 'admin') {
        if (hello.adminPin !== config.adminPin) {
          ack?.({ ok: false, error: 'bad_pin' });
          socket.disconnect(true);
          return;
        }
        state.role = 'admin';
        void socket.join('admins');
      } else if (hello.role === 'spectator') {
        state.role = 'spectator';
        void socket.join('spectators');
      } else {
        state.role = 'player';
        if (hello.playerId && hello.playerSecret) {
          const existing = await store.players.get(hello.playerId);
          if (existing && (existing as any).playerSecret === hello.playerSecret) {
            state.playerId = existing.playerId;
          }
        }
        if (!state.playerId) {
          const created = await store.players.create({
            playerId: randomUUID(),
            playerName: 'Player',
            stationId,
            sessionId: null,
            playerSessionId: null,
            teamId: null,
            qrCodeToken: randomToken(),
            qrCodeClaimed: false,
            playerStatus: 'active',
            profilePicture: null,
            locationLat: null,
            locationLong: null,
            locationAccuracyM: null,
            playerSecret: randomToken(),
          } as any);
          state.playerId = created.playerId;
        }
        void socket.join(`player:${state.playerId}`);
        const set = connectedSocketIdsByPlayerId.get(state.playerId!) ?? new Set<string>();
        set.add(socket.id);
        connectedSocketIdsByPlayerId.set(state.playerId!, set);
        const player = await store.players.get(state.playerId!);
        ack?.({ ok: true, playerId: state.playerId, playerSecret: (player as any).playerSecret });
      }

      if (state.role === 'admin' || state.role === 'spectator') ack?.({ ok: true });

      const snapshot = await buildSnapshot(store, stationId, {
        forPlayerId: state.role === 'player' ? state.playerId ?? undefined : undefined,
        spectator: state.role === 'spectator',
      });
      socket.emit('state:snapshot', snapshot);
    });

    socket.on('scan', async (raw: unknown) => {
      if (state.role !== 'player' || !state.playerId) return; // HUB-094
      const parsed = ScanSchema.safeParse(raw);
      if (!parsed.success) return;
      if (parsed.data.lat !== undefined && parsed.data.long !== undefined) {
        await engine.recordPlayerLocation(state.playerId, parsed.data.lat, parsed.data.long, parsed.data.accuracyM ?? null);
      }
      await engine.handleScan(state.playerId, parsed.data.raw);
    });

    socket.on('location', async (raw: unknown) => {
      if (state.role !== 'player' || !state.playerId) return;
      const parsed = LocationSchema.safeParse(raw);
      if (!parsed.success) return;
      await engine.recordPlayerLocation(state.playerId, parsed.data.lat, parsed.data.long, parsed.data.accuracyM);
    });

    socket.on('capture:cancel', async (raw: unknown) => {
      if (state.role !== 'player' || !state.playerId) return;
      const parsed = CaptureCancelSchema.safeParse(raw);
      if (!parsed.success) return;
      await engine.cancelCapture(state.playerId, parsed.data.captureId);
    });

    socket.on('player:update', async (raw: unknown) => {
      if (state.role !== 'player' || !state.playerId) return;
      const parsed = PlayerUpdateSchema.safeParse(raw);
      if (!parsed.success) return;
      const patch: Record<string, unknown> = {};
      if (parsed.data.playerName !== undefined) patch.playerName = parsed.data.playerName;
      if (parsed.data.teamId !== undefined) patch.teamId = parsed.data.teamId;
      if (parsed.data.profilePicture !== undefined) {
        const bytes = Buffer.from(parsed.data.profilePicture, 'base64');
        const ref = await store.attachments.put(bytes, 'image/jpeg'); // HUB-067 size check inside
        patch.profilePicture = await store.attachments.getUrl(ref); // put() returns a bare ref, not a servable URL
      }
      if (Object.keys(patch).length > 0) await store.players.update(state.playerId, patch as any);
    });

    // Onboarding: player scans a pre-printed physical badge (a `pl` QR minted independently
    // of any player record) and its token becomes their qrCodeToken - the same value others
    // scan on that badge to tag them. Not part of doc00's Node/Respawn "claim" flows, but
    // the same idea: whoever scans first gets it.
    socket.on('player:claimQr', async (raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'player' || !state.playerId) return;
      const parsed = ClaimQrSchema.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const qr = parseQr(parsed.data.raw);
      if (isQrParseError(qr)) {
        ack?.({ ok: false, error: 'unknown_qr' });
        return;
      }
      if (qr.kind !== 'pl') {
        ack?.({ ok: false, error: 'wrong_qr_kind' });
        return;
      }
      const claimants = await store.players.list({ qrCodeToken: qr.qrCodeToken } as any);
      const heldByOther = claimants.some((p: any) => p.playerId !== state.playerId);
      if (heldByOther) {
        ack?.({ ok: false, error: 'already_claimed' });
        return;
      }
      await store.players.update(state.playerId, { qrCodeToken: qr.qrCodeToken, qrCodeClaimed: true } as any);
      ack?.({ ok: true });
    });

    socket.on('admin:session:start', async (raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const body = (raw ?? {}) as { sessionName?: string; gameDurationMs?: number };
      // activeTeamIds is derived, not admin-picked: any team with >=1 player is active.
      // A team with zero players can't meaningfully play, so there's nothing for a
      // checkbox to opt in/out of.
      const players = await store.players.list({ stationId } as any);
      const activeTeamIds = [...new Set(players.map((p: any) => p.teamId).filter((id): id is string => !!id))];
      if (activeTeamIds.length < 2) {
        ack?.({ ok: false, error: 'need_at_least_two_teams_with_players' });
        return;
      }
      const gameDurationMs =
        typeof body.gameDurationMs === 'number' && Number.isFinite(body.gameDurationMs) && body.gameDurationMs > 0
          ? body.gameDurationMs
          : null;
      try {
        const session = await engine.startSession(stationId, body.sessionName ?? 'Session', activeTeamIds, gameDurationMs);
        ack?.({ ok: true, sessionId: session.sessionId });
      } catch (err) {
        ack?.({ ok: false, error: (err as Error).message });
      }
    });

    socket.on('admin:session:stop', async (_raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      await engine.endSession(stationId);
      ack?.({ ok: true });
    });

    socket.on('admin:node:claim', async (raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const body = (raw ?? {}) as { macAddress?: string; lat?: number; long?: number; controlPointName?: string };
      if (!body.macAddress) {
        ack?.({ ok: false, error: 'macAddress required' });
        return;
      }
      const mac = normalizeMac(body.macAddress);
      const existing = await store.controlPoints.list({ macAddress: mac } as any);

      const cp = existing[0]
        ? await store.controlPoints.update(existing[0].controlPointId, {
            locationLat: body.lat ?? existing[0].locationLat,
            locationLong: body.long ?? existing[0].locationLong,
            controlPointName: body.controlPointName ?? existing[0].controlPointName,
          } as any)
        : await store.controlPoints.create({
            controlPointId: randomUUID(),
            controlPointName: body.controlPointName ?? 'Control Point',
            stationId,
            currentOwnerTeamId: null,
            capturingPlayerId: null,
            captureProgress: 0,
            isHumanDetected: false,
            locationLat: body.lat ?? null,
            locationLong: body.long ?? null,
            macAddress: mac,
          } as any);

      registry.setControlPointId(mac, cp.controlPointId); // HUB-160/161
      const station = await store.stations.get(stationId);
      const record = registry.get(mac);
      if (record) dispatcher.pushSetColor(mac, record.ip, (station as any)?.neutralHexColor ?? '#FFFFFF', 'solid');
      ack?.({ ok: true, controlPointId: cp.controlPointId });
    });

    // Deletes a claimed Control Point from the station roster - mirrors
    // admin:respawnLocation:delete/admin:player:remove: unconditional, not a permanent
    // historical record. Any capture in progress on it is aborted first so the capturing
    // player's client doesn't end up with a dangling progress ring, and the underlying
    // Node (if any) is released back to unclaimed so it can be re-claimed later.
    socket.on('admin:controlPoint:remove', async (raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const body = (raw ?? {}) as { controlPointId?: string };
      if (!body.controlPointId) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const cp = await store.controlPoints.get(body.controlPointId);
      if (!cp) {
        ack?.({ ok: false, error: 'not_found' });
        return;
      }
      await engine.abandonCaptureForControlPoint(cp.controlPointId);
      await store.controlPoints.delete(cp.controlPointId);
      if (cp.macAddress) {
        registry.setControlPointId(cp.macAddress, null);
        const record = registry.get(cp.macAddress);
        if (record) dispatcher.pushSetColor(cp.macAddress, record.ip, config.unclaimedHexColor, 'solid');
      }
      ack?.({ ok: true });
    });

    socket.on('admin:respawnLocation:create', async (raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const body = (raw ?? {}) as { lat?: number; long?: number; allowedTeamIds?: string[]; respawnLocationId?: string };
      if (typeof body.lat !== 'number' || typeof body.long !== 'number') {
        ack?.({ ok: false, error: 'lat/long required' });
        return;
      }
      // Custom IDs are opt-in and only meaningful within this Hub (never sent to
      // firmware) - lets a pre-printed test QR (qrctf:1:rp:<id>) resolve once the
      // matching location is created here, without needing to reprint anything.
      const customId = typeof body.respawnLocationId === 'string' ? body.respawnLocationId.trim() : '';
      if (customId && customId.length > 100) {
        ack?.({ ok: false, error: 'respawnLocationId too long' });
        return;
      }
      const location = await store.respawnLocations.create({
        respawnLocationId: customId || randomUUID(),
        stationId,
        locationLat: body.lat,
        locationLong: body.long,
        allowedTeamIds: body.allowedTeamIds ?? [], // empty = any team, HUB-120
      } as any);
      ack?.({ ok: true, respawnLocationId: location.respawnLocationId });
    });

    socket.on('admin:respawnLocation:list', async (_raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const locations = await store.respawnLocations.list({ stationId } as any);
      ack?.({ ok: true, locations });
    });

    socket.on('admin:respawnLocation:delete', async (raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const body = (raw ?? {}) as { respawnLocationId?: string };
      if (body.respawnLocationId) await store.respawnLocations.delete(body.respawnLocationId);
      ack?.({ ok: true });
    });

    socket.on('admin:nodes:list', (_raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const nodes = registry.list().map((r) => ({ ...r, isOnline: registry.isOnline(r) }));
      ack?.({ ok: true, nodes });
    });

    socket.on('admin:players:list', async (_raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const players = await store.players.list({ stationId } as any);
      const station = await store.stations.get(stationId);
      const sessionId = (station as any)?.currentSessionId ?? null;
      // playerSecret is a login credential, never send it over the wire to anyone but the
      // owning player themselves (already done via ownPlayer in state:snapshot).
      const roster = await Promise.all(
        players.map(async (p: any) => ({
          playerId: p.playerId,
          playerName: p.playerName,
          teamId: p.teamId,
          playerStatus: p.playerStatus,
          qrCodeToken: p.qrCodeToken,
          qrCodeClaimed: p.qrCodeClaimed,
          profilePicture: p.profilePicture,
          isConnected: (connectedSocketIdsByPlayerId.get(p.playerId)?.size ?? 0) > 0,
          ...(await getPlayerStats(p.playerId, sessionId)),
        })),
      );
      ack?.({ ok: true, players: roster });
    });

    // Admin override of a player's badge - independent of an active session, since a
    // badge should be assignable/fixable at any time (e.g. correcting a mis-scan, or
    // pre-assigning ahead of a game), unlike the player-driven player:claimQr flow.
    socket.on('admin:player:setQrCode', async (raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const parsed = AdminSetPlayerQrSchema.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const claimants = await store.players.list({ qrCodeToken: parsed.data.qrCodeToken } as any);
      const heldByOther = claimants.some((p: any) => p.playerId !== parsed.data.playerId);
      if (heldByOther) {
        ack?.({ ok: false, error: 'already_claimed' });
        return;
      }
      await store.players.update(parsed.data.playerId, {
        qrCodeToken: parsed.data.qrCodeToken,
        qrCodeClaimed: true,
      } as any);
      ack?.({ ok: true });
    });

    // Removes a player from the station roster - same idea as
    // admin:respawnLocation:delete for respawn points, or claiming/unclaiming a Control
    // Point: the players list is just "who's currently added to this station," not a
    // permanent historical record, so removal is unconditional even if they've already
    // played a session. That session's own snapshotted stats (QrCtfPlayerSession,
    // TeamSession totals, etc.) are keyed by playerId as plain data, not a live
    // foreign-key relationship, so they're untouched by deleting the player record itself.
    socket.on('admin:player:remove', async (raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const body = (raw ?? {}) as { playerId?: string };
      if (!body.playerId) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      await store.players.delete(body.playerId);
      ack?.({ ok: true });
    });

    // HUB-094-style redaction: the public no-auth scoreboard gets name/team/status/stats/
    // photo - never qrCodeToken (would let anyone forge a tag) or playerSecret (identity
    // theft). profilePicture is already public/no-auth via /attachments (deviceApp.ts), so
    // no new exposure - just the URL, which is otherwise unguessable.
    //
    // Location is the one deliberate exception, and only when config.spectatorShowPositions
    // is on - it powers the live map. See that flag's doc comment for the fairness caveat:
    // this scoreboard is unauthenticated, so players can read opponents' positions from it.
    socket.on('spectator:players:list', async (_raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'spectator') return;
      const players = await store.players.list({ stationId } as any);
      const station = await store.stations.get(stationId);
      const sessionId = (station as any)?.currentSessionId ?? null;
      const roster = await Promise.all(
        players.map(async (p: any) => ({
          playerId: p.playerId,
          playerName: p.playerName,
          teamId: p.teamId,
          playerStatus: p.playerStatus,
          profilePicture: p.profilePicture,
          isConnected: (connectedSocketIdsByPlayerId.get(p.playerId)?.size ?? 0) > 0,
          ...(config.spectatorShowPositions
            ? { locationLat: p.locationLat, locationLong: p.locationLong, locationAccuracyM: p.locationAccuracyM ?? null }
            : {}),
          ...(await getPlayerStats(p.playerId, sessionId)),
        })),
      );
      ack?.({ ok: true, players: roster, showPositions: config.spectatorShowPositions });
    });

    // Coordinates only - allowedTeamIds is a gameplay detail the public board has no reason
    // to expose. Respawn points aren't part of state:snapshot, but the map needs them as
    // fixed reference geometry alongside the control points.
    socket.on('spectator:respawnLocations:list', async (_raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'spectator') return;
      const locations = await store.respawnLocations.list({ stationId } as any);
      ack?.({
        ok: true,
        respawnLocations: (locations as any[]).map((l) => ({
          respawnLocationId: l.respawnLocationId,
          locationLat: l.locationLat,
          locationLong: l.locationLong,
        })),
      });
    });

    socket.on('admin:node:identify', async (raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const body = (raw ?? {}) as { macAddress?: string };
      const mac = body.macAddress ? normalizeMac(body.macAddress) : '';
      const record = registry.get(mac);
      const ok = record ? await dispatcher.identify(mac, record.ip) : false;
      ack?.({ ok });
    });
  });

  // HUB-054/092: every mutation reaches clients via the store's change feed, never ad hoc.
  const SPECTATOR_VISIBLE_TYPES = new Set(['qrCtfTeam', 'qrCtfControlPoint', 'qrCtfSession']);
  const unsubscribe = store.subscribe((e) => {
    if (e.kind === 'appended') return; // series points aren't part of the object patch stream
    const body = e.kind === 'deleted' ? null : e.kind === 'created' ? e.after : (e as any).patch;
    const patch = { type: e.type, id: e.id, patch: body };

    // HUB-094: a qrCtfPlayer row carries playerSecret (resume-by-secret identity takeover)
    // and qrCodeToken (lets anyone forge a tag against that player). Broadcasting the raw
    // change feed to every socket put both on the wire for every other player to read, so
    // player patches go only to that player's own room plus admins. Everything else
    // (teams, control points, session) is public game state and still broadcasts.
    if (e.type === 'qrCtfPlayer') {
      io.to(`player:${e.id}`).emit('state:patch', patch);
      io.to('admins').emit('state:patch', patch);
      return;
    }

    if (SPECTATOR_VISIBLE_TYPES.has(e.type)) {
      // Same redaction buildSnapshot applies for spectators (snapshot.ts) - the patch stream
      // was leaking capturingPlayerId that the snapshot deliberately strips.
      const spectatorPatch =
        e.type === 'qrCtfControlPoint' && body && typeof body === 'object' && 'capturingPlayerId' in body
          ? { ...patch, patch: { ...(body as object), capturingPlayerId: null } }
          : patch;
      io.to('spectators').emit('state:patch', spectatorPatch);
    }
    io.except('spectators').emit('state:patch', patch);
  });

  return unsubscribe;
}
