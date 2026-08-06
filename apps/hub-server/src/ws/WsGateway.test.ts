import type { AddressInfo } from 'node:net';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server as SocketIoServer } from 'socket.io';
import { io as ioClient, type Socket as ClientSocket } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/InMemoryStore.js';
import { NodeRegistry } from '../nodes/NodeRegistry.js';
import { NodeDispatcher } from '../nodes/NodeDispatcher.js';
import { GameEngine } from '../engine/GameEngine.js';
import { SystemClock } from '../engine/Clock.js';
import { createSocketIoGameEvents } from './gameEvents.js';
import { createWsGateway } from './WsGateway.js';
import type { Config } from '../config.js';

const STATION_ID = 'station-1';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';
const CP_MAC = 'AA:BB:CC:DD:EE:01';

const config: Config = {
  storeDriver: 'inmemory',
  dataDir: './data',
  nodeHttpPort: 0,
  deviceHttpsPort: 8443,
  spectatorHttpPort: 8080,
  portalHttpPort: null,
  wifiSsid: 'FoundryCTF',
  wifiPsk: 'capturetheflag',
  tlsMode: 'selfsigned',
  tlsCertPath: null,
  tlsKeyPath: null,
  publicOrigin: 'https://localhost:8443',
  captureDurationMs: 10000,
  presenceGraceMs: 2500,
  tagCooldownMs: 10000,
  respawnImmunityMs: 5000,
  heartbeatIntervalMs: 15000,
  neutralHexColor: '#FFFFFF',
  unclaimedHexColor: '#202020',
  adminPin: '1234',
  stationId: STATION_ID,
};

function waitFor<T = unknown>(socket: ClientSocket, event: string): Promise<T> {
  return new Promise((resolve) => socket.once(event, resolve));
}

describe('WsGateway', () => {
  let httpServer: HttpServer;
  let io: SocketIoServer;
  let store: InMemoryStore;
  let baseUrl: string;
  let unsubscribe: () => void;
  const clients: ClientSocket[] = [];

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.init();

    await store.stations.create({
      stationId: STATION_ID,
      currentSessionId: null,
      stationName: 'Test Station',
      captureDurationMs: 10000,
      presenceGraceMs: 2500,
      tagCooldownMs: 10000,
      respawnImmunityMs: 5000,
      neutralHexColor: '#FFFFFF',
    } as any);
    await store.teams.create({ teamId: TEAM_A, teamName: 'A', hexColor: '#111111', score: 0, totalTagsInflicted: 0, totalTagsReceived: 0 });
    await store.teams.create({ teamId: TEAM_B, teamName: 'B', hexColor: '#222222', score: 0, totalTagsInflicted: 0, totalTagsReceived: 0 });
    await store.controlPoints.create({
      controlPointId: 'cp1',
      controlPointName: 'CP One',
      stationId: STATION_ID,
      currentOwnerTeamId: null,
      capturingPlayerId: null,
      captureProgress: 0,
      isHumanDetected: true,
      locationLat: 0,
      locationLong: 0,
      macAddress: CP_MAC,
    } as any);

    httpServer = createServer();
    io = new SocketIoServer(httpServer);
    const registry = new NodeRegistry(config.heartbeatIntervalMs);
    const dispatcher = new NodeDispatcher(registry);
    const engine = new GameEngine({
      store,
      clock: new SystemClock(),
      wallClockIso: () => new Date().toISOString(),
      dispatchColor: () => {},
      isNodeOnline: () => true,
      events: createSocketIoGameEvents(io),
    });
    engine.start();

    unsubscribe = createWsGateway({ io, store, engine, config, stationId: STATION_ID, dispatcher, registry });

    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    const { port } = httpServer.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    unsubscribe();
    for (const c of clients) c.disconnect();
    clients.length = 0;
    io.close();
    await new Promise((r) => httpServer.close(r));
  });

  function connect(): ClientSocket {
    const c = ioClient(baseUrl, { transports: ['websocket'], forceNew: true });
    clients.push(c);
    return c;
  }

  it('player hello gets an ack with identity and a snapshot', async () => {
    const client = connect();

    // The ack packet and the state:snapshot event packet can arrive in the same read
    // burst; the ack's promise continuation is a microtask that runs AFTER all packets in
    // that burst are synchronously dispatched. Registering the snapshot listener only
    // after awaiting the ack would miss an event that already fired. Register first.
    const snapshotPromise = waitFor<any>(client, 'state:snapshot');
    const ack = await new Promise<any>((resolve) => client.emit('session:hello', { role: 'player' }, resolve));
    expect(ack.ok).toBe(true);
    expect(typeof ack.playerId).toBe('string');

    const snapshot = await snapshotPromise;
    expect(snapshot.teams).toHaveLength(2);
    expect(snapshot.ownPlayer.playerId).toBe(ack.playerId);
  });

  it('player identity resumes across a reconnect via playerId+playerSecret (HUB-151)', async () => {
    const first = connect();
    const ack1 = await new Promise<any>((resolve) => first.emit('session:hello', { role: 'player' }, resolve));
    first.disconnect();

    const second = connect();
    const ack2 = await new Promise<any>((resolve) =>
      second.emit('session:hello', { role: 'player', playerId: ack1.playerId, playerSecret: ack1.playerSecret }, resolve),
    );
    expect(ack2.playerId).toBe(ack1.playerId);
  });

  it('admin hello with wrong PIN is disconnected', async () => {
    const client = connect();
    const ack = await new Promise<any>((resolve) => client.emit('session:hello', { role: 'admin', adminPin: 'wrong' }, resolve));
    expect(ack.ok).toBe(false);
  });

  it('spectator snapshot has no ownPlayer and redacts capturingPlayerId', async () => {
    await store.controlPoints.update('cp1', { capturingPlayerId: 'someone' } as any);
    const client = connect();
    const snapshotPromise = waitFor<any>(client, 'state:snapshot');
    await new Promise<any>((resolve) => client.emit('session:hello', { role: 'spectator' }, resolve));
    const snapshot = await snapshotPromise;
    expect(snapshot.ownPlayer).toBeUndefined();
    expect(snapshot.controlPoints[0].capturingPlayerId).toBeNull();
  });

  it("spectator scan events are dropped (HUB-094) — no capture starts", async () => {
    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));
    await new Promise<any>((resolve) =>
      admin.emit('admin:session:start', { sessionName: 'R1', activeTeamIds: [TEAM_A, TEAM_B] }, resolve),
    );

    const spectator = connect();
    await new Promise<any>((resolve) => spectator.emit('session:hello', { role: 'spectator' }, resolve));

    let sawCaptureStarted = false;
    spectator.on('capture:started', () => (sawCaptureStarted = true));
    spectator.emit('scan', { raw: `qrctf:1:cp:${CP_MAC}`, clientTs: Date.now() });

    await new Promise((r) => setTimeout(r, 150));
    expect(sawCaptureStarted).toBe(false);
    expect((await store.controlPoints.get('cp1'))?.capturingPlayerId).toBeNull();
  });

  it('admin session:start then a player scan starts a capture, broadcast to everyone', async () => {
    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));
    const startAck = await new Promise<any>((resolve) =>
      admin.emit('admin:session:start', { sessionName: 'R1', activeTeamIds: [TEAM_A, TEAM_B] }, resolve),
    );
    expect(startAck.ok).toBe(true);

    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(helloAck.playerId, { teamId: TEAM_A });

    const capturePromise = waitFor<any>(player, 'capture:started');
    player.emit('scan', { raw: `qrctf:1:cp:${CP_MAC}`, clientTs: Date.now() });

    const captureStarted = await capturePromise;
    expect(captureStarted.controlPointId).toBe('cp1');
  });

  it('admin:node:claim creates a Control Point bound to the MAC', async () => {
    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));

    const ack = await new Promise<any>((resolve) =>
      admin.emit(
        'admin:node:claim',
        { macAddress: 'aa:bb:cc:dd:ee:99', lat: 1, long: 2, controlPointName: 'North Gate' },
        resolve,
      ),
    );
    expect(ack.ok).toBe(true);
    const cps = await store.controlPoints.list({ macAddress: 'AA:BB:CC:DD:EE:99' } as any);
    expect(cps[0].controlPointName).toBe('North Gate');
  });

  it('admin respawn location create/list/delete round trip', async () => {
    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));

    const createAck = await new Promise<any>((resolve) =>
      admin.emit('admin:respawnLocation:create', { lat: 10, long: 20, allowedTeamIds: [TEAM_A] }, resolve),
    );
    expect(createAck.ok).toBe(true);

    const listAck = await new Promise<any>((resolve) => admin.emit('admin:respawnLocation:list', {}, resolve));
    expect(listAck.locations).toHaveLength(1);
    expect(listAck.locations[0].allowedTeamIds).toEqual([TEAM_A]);

    const deleteAck = await new Promise<any>((resolve) =>
      admin.emit('admin:respawnLocation:delete', { respawnLocationId: createAck.respawnLocationId }, resolve),
    );
    expect(deleteAck.ok).toBe(true);
    const afterDelete = await store.respawnLocations.list();
    expect(afterDelete).toHaveLength(0);
  });

  it('player:claimQr sets qrCodeToken from a scanned pl badge', async () => {
    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));

    const claimAck = await new Promise<any>((resolve) =>
      player.emit('player:claimQr', { raw: 'qrctf:1:pl:BADGE-TOKEN-0000000001' }, resolve),
    );
    expect(claimAck.ok).toBe(true);

    const record = await store.players.get(helloAck.playerId);
    expect((record as any)?.qrCodeToken).toBe('BADGE-TOKEN-0000000001');
  });

  it('player:claimQr rejects a badge already claimed by a different player', async () => {
    const first = connect();
    const firstAck = await new Promise<any>((resolve) => first.emit('session:hello', { role: 'player' }, resolve));
    await new Promise<any>((resolve) =>
      first.emit('player:claimQr', { raw: 'qrctf:1:pl:SHARED-BADGE-000000001' }, resolve),
    );

    const second = connect();
    await new Promise<any>((resolve) => second.emit('session:hello', { role: 'player' }, resolve));
    const secondClaimAck = await new Promise<any>((resolve) =>
      second.emit('player:claimQr', { raw: 'qrctf:1:pl:SHARED-BADGE-000000001' }, resolve),
    );
    expect(secondClaimAck.ok).toBe(false);
    expect(secondClaimAck.error).toBe('already_claimed');

    const firstRecord = await store.players.get(firstAck.playerId);
    expect((firstRecord as any)?.qrCodeToken).toBe('SHARED-BADGE-000000001');
  });

  it('player:claimQr rejects a non-pl QR (e.g. a Control Point code)', async () => {
    const player = connect();
    await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));

    const ack = await new Promise<any>((resolve) =>
      player.emit('player:claimQr', { raw: `qrctf:1:cp:${CP_MAC}` }, resolve),
    );
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('wrong_qr_kind');
  });

  it('admin:players:list returns the roster including qrCodeToken', async () => {
    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(helloAck.playerId, { playerName: 'Ada', teamId: TEAM_A } as any);
    await new Promise<any>((resolve) =>
      player.emit('player:claimQr', { raw: 'qrctf:1:pl:ROSTER-TEST-BADGE-001' }, resolve),
    );

    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));
    const listAck = await new Promise<any>((resolve) => admin.emit('admin:players:list', {}, resolve));

    expect(listAck.ok).toBe(true);
    const row = listAck.players.find((p: any) => p.playerId === helloAck.playerId);
    expect(row).toMatchObject({
      playerName: 'Ada',
      teamId: TEAM_A,
      qrCodeToken: 'ROSTER-TEST-BADGE-001',
      qrCodeClaimed: true,
    });
    expect(row.playerSecret).toBeUndefined();
  });

  it('spectator:players:list redacts qrCodeToken and playerSecret', async () => {
    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(helloAck.playerId, { playerName: 'Grace', teamId: TEAM_B } as any);

    const spectator = connect();
    await new Promise<any>((resolve) => spectator.emit('session:hello', { role: 'spectator' }, resolve));
    const listAck = await new Promise<any>((resolve) => spectator.emit('spectator:players:list', {}, resolve));

    expect(listAck.ok).toBe(true);
    const row = listAck.players.find((p: any) => p.playerId === helloAck.playerId);
    expect(row).toMatchObject({ playerName: 'Grace', teamId: TEAM_B, playerStatus: 'active' });
    expect(row.qrCodeToken).toBeUndefined();
    expect(row.playerSecret).toBeUndefined();
  });

  it('spectator:players:list includes profilePicture', async () => {
    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(helloAck.playerId, { profilePicture: '/attachments/abc123.jpg' } as any);

    const spectator = connect();
    await new Promise<any>((resolve) => spectator.emit('session:hello', { role: 'spectator' }, resolve));
    const listAck = await new Promise<any>((resolve) => spectator.emit('spectator:players:list', {}, resolve));

    const row = listAck.players.find((p: any) => p.playerId === helloAck.playerId);
    expect(row.profilePicture).toBe('/attachments/abc123.jpg');
  });

  it('admin:players:list reports isConnected, flipping to false after disconnect', async () => {
    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));

    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));

    const before = await new Promise<any>((resolve) => admin.emit('admin:players:list', {}, resolve));
    expect(before.players.find((p: any) => p.playerId === helloAck.playerId).isConnected).toBe(true);

    player.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    const after = await new Promise<any>((resolve) => admin.emit('admin:players:list', {}, resolve));
    expect(after.players.find((p: any) => p.playerId === helloAck.playerId).isConnected).toBe(false);
  });

  it('admin/spectator players:list report per-player tag/capture stats for the current session', async () => {
    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(helloAck.playerId, { teamId: TEAM_A } as any);

    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));
    const startAck = await new Promise<any>((resolve) =>
      admin.emit('admin:session:start', { sessionName: 'R1', activeTeamIds: [TEAM_A, TEAM_B] }, resolve),
    );
    expect(startAck.ok).toBe(true);

    const [playerSession] = await store.playerSessions.list({ sessionId: startAck.sessionId, playerId: helloAck.playerId } as any);
    expect(playerSession).toBeTruthy();
    await store.series.append((playerSession as any).tagsInflictedSeriesId, { t: Date.now(), v: 3 });
    await store.series.append((playerSession as any).tagsReceivedSeriesId, { t: Date.now(), v: 1 });
    await store.series.append((playerSession as any).capturesCompletedSeriesId, { t: Date.now(), v: 2 });

    const adminRoster = await new Promise<any>((resolve) => admin.emit('admin:players:list', {}, resolve));
    expect(adminRoster.players.find((p: any) => p.playerId === helloAck.playerId)).toMatchObject({
      tagsInflicted: 3,
      tagsReceived: 1,
      capturesCompleted: 2,
    });

    const spectator = connect();
    await new Promise<any>((resolve) => spectator.emit('session:hello', { role: 'spectator' }, resolve));
    const spectatorRoster = await new Promise<any>((resolve) => spectator.emit('spectator:players:list', {}, resolve));
    const spectatorRow = spectatorRoster.players.find((p: any) => p.playerId === helloAck.playerId);
    expect(spectatorRow).toMatchObject({ tagsInflicted: 3, tagsReceived: 1, capturesCompleted: 2 });
    expect(spectatorRow.qrCodeToken).toBeUndefined();
  });
});
