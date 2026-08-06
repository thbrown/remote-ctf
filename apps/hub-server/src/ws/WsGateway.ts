/**
 * doc01 §6 — socket.io connection handling: identity (session:hello), the four
 * game-input events, admin actions, and the store-change-feed-driven state:patch
 * broadcast (HUB-054/092). HUB-094: spectator sockets are read-only — every
 * client->server handler below checks `role` first and silently drops anything from a
 * spectator (they're simply never given a role that passes those checks).
 *
 * Admin surface implemented in this pass: session start/stop, Node claim, Node identify,
 * Node list, Respawn Location create/list/delete. Player roster actions
 * (rename/regenerate token/force-respawn) and Node rename/delete are NOT yet implemented —
 * see PROGRESS.md gap list. The Web App should only wire buttons for what exists here
 * until that's filled in.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { Server, Socket } from 'socket.io';
import {
  CaptureCancelSchema,
  LocationSchema,
  normalizeMac,
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

  io.on('connection', (socket: Socket) => {
    const state: SocketState = { role: null, playerId: null };

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
            playerStatus: 'active',
            profilePicture: null,
            locationLat: null,
            locationLong: null,
            playerSecret: randomToken(),
          } as any);
          state.playerId = created.playerId;
        }
        void socket.join(`player:${state.playerId}`);
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
        await store.players.update(state.playerId, { locationLat: parsed.data.lat, locationLong: parsed.data.long });
      }
      await engine.handleScan(state.playerId, parsed.data.raw);
    });

    socket.on('location', async (raw: unknown) => {
      if (state.role !== 'player' || !state.playerId) return;
      const parsed = LocationSchema.safeParse(raw);
      if (!parsed.success) return;
      await store.players.update(state.playerId, { locationLat: parsed.data.lat, locationLong: parsed.data.long });
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
        patch.profilePicture = await store.attachments.put(bytes, 'image/jpeg'); // HUB-067 size check inside
      }
      if (Object.keys(patch).length > 0) await store.players.update(state.playerId, patch as any);
    });

    socket.on('admin:session:start', async (raw: unknown, ack?: (res: unknown) => void) => {
      if (state.role !== 'admin') return;
      const body = (raw ?? {}) as { sessionName?: string; activeTeamIds?: string[] };
      try {
        const session = await engine.startSession(stationId, body.sessionName ?? 'Session', body.activeTeamIds ?? []);
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
    const patch = {
      type: e.type,
      id: e.id,
      patch: e.kind === 'deleted' ? null : e.kind === 'created' ? e.after : (e as any).patch,
    };
    if (SPECTATOR_VISIBLE_TYPES.has(e.type)) {
      io.to('spectators').emit('state:patch', patch);
    }
    io.except('spectators').emit('state:patch', patch);
  });

  return unsubscribe;
}
