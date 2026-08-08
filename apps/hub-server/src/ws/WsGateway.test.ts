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
  spectatorShowPositions: true,
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
  /** Exposed so tests can drive tickCaptures() directly instead of waiting on the 5 Hz
   * interval that only exists in index.ts. */
  let engineRef: GameEngine;
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
    engineRef = engine;

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

  /** admin:session:start derives its active teams from who has already joined - tests that
   * need >=2 active teams just need a player sitting on each, not an admin-picked list. */
  async function createPlayerOnTeam(teamId: string): Promise<string> {
    const c = connect();
    const ack = await new Promise<any>((resolve) => c.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(ack.playerId, { teamId } as any);
    return ack.playerId;
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
    // admin:session:start now derives active teams from who has joined - it needs >=2
    // teams with a player already on them, not an admin-picked list.
    await createPlayerOnTeam(TEAM_A);
    await createPlayerOnTeam(TEAM_B);
    await new Promise<any>((resolve) => admin.emit('admin:session:start', { sessionName: 'R1' }, resolve));

    const spectator = connect();
    await new Promise<any>((resolve) => spectator.emit('session:hello', { role: 'spectator' }, resolve));

    let sawCaptureStarted = false;
    spectator.on('capture:started', () => (sawCaptureStarted = true));
    spectator.emit('scan', { raw: `qrctf:1:cp:${CP_MAC}`, clientTs: Date.now() });

    await new Promise((r) => setTimeout(r, 150));
    expect(sawCaptureStarted).toBe(false);
    expect((await store.controlPoints.get('cp1'))?.capturingPlayerId).toBeNull();
  });

  it('admin session:start then a player scan starts a capture for the scanning player', async () => {
    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));

    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(helloAck.playerId, { teamId: TEAM_A });
    await createPlayerOnTeam(TEAM_B);

    const startAck = await new Promise<any>((resolve) =>
      admin.emit('admin:session:start', { sessionName: 'R1' }, resolve),
    );
    expect(startAck.ok).toBe(true);

    const capturePromise = waitFor<any>(player, 'capture:started');
    player.emit('scan', { raw: `qrctf:1:cp:${CP_MAC}`, clientTs: Date.now() });

    const captureStarted = await capturePromise;
    expect(captureStarted.controlPointId).toBe('cp1');
  });

  // The bug this pins: capture:started/capture:progress used to be io.emit'd to everyone, so
  // every player's phone rendered a progress ring for somebody else's capture. The previous
  // test passes under both the broken and the fixed routing (it only checks the capturing
  // player receives it) - this is the one that actually catches a regression.
  it('a capture is visible ONLY to the capturing player, not to other players', async () => {
    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));

    const capturer = connect();
    const capturerAck = await new Promise<any>((resolve) => capturer.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(capturerAck.playerId, { teamId: TEAM_A });

    const bystander = connect();
    const bystanderAck = await new Promise<any>((resolve) => bystander.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(bystanderAck.playerId, { teamId: TEAM_B });

    await new Promise<any>((resolve) => admin.emit('admin:session:start', { sessionName: 'R1' }, resolve));

    let bystanderSawStarted = false;
    let bystanderSawProgress = false;
    bystander.on('capture:started', () => (bystanderSawStarted = true));
    bystander.on('capture:progress', () => (bystanderSawProgress = true));

    const capturePromise = waitFor<any>(capturer, 'capture:started');
    capturer.emit('scan', { raw: `qrctf:1:cp:${CP_MAC}`, clientTs: Date.now() });
    await capturePromise;

    // Drive a few progress ticks so there is actually a progress stream to leak.
    for (let i = 0; i < 3; i++) await engineRef.tickCaptures(STATION_ID);
    await new Promise((r) => setTimeout(r, 100));

    expect(bystanderSawStarted).toBe(false);
    expect(bystanderSawProgress).toBe(false);
  });

  it('spectators get capture:occurred (for the ticker) but never capture:started/progress', async () => {
    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));

    const player = connect();
    const playerAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(playerAck.playerId, { teamId: TEAM_A });
    await createPlayerOnTeam(TEAM_B);
    await new Promise<any>((resolve) => admin.emit('admin:session:start', { sessionName: 'R1' }, resolve));

    const spectator = connect();
    await new Promise<any>((resolve) => spectator.emit('session:hello', { role: 'spectator' }, resolve));

    let spectatorSawStarted = false;
    spectator.on('capture:started', () => (spectatorSawStarted = true));
    const occurredPromise = waitFor<any>(spectator, 'capture:occurred');

    player.emit('scan', { raw: `qrctf:1:cp:${CP_MAC}`, clientTs: Date.now() });

    const occurred = await occurredPromise;
    expect(occurred.controlPointId).toBe('cp1');
    expect(occurred.playerId).toBe(playerAck.playerId);
    expect(spectatorSawStarted).toBe(false);
  });

  // playerSecret is a resume-by-secret credential and qrCodeToken lets anyone forge a tag
  // against that player; the raw change feed used to put both on every player's socket.
  it('a player never receives another player\'s qrCtfPlayer patch', async () => {
    const watcher = connect();
    await new Promise<any>((resolve) => watcher.emit('session:hello', { role: 'player' }, resolve));

    const patches: any[] = [];
    watcher.on('state:patch', (p) => patches.push(p));

    const otherId = await createPlayerOnTeam(TEAM_B);
    await store.players.update(otherId, { playerName: 'Mallory' } as any);
    await new Promise((r) => setTimeout(r, 100));

    const foreign = patches.filter((p) => p.type === 'qrCtfPlayer' && p.id === otherId);
    expect(foreign).toHaveLength(0);
  });

  it('spectators never receive capturingPlayerId via the patch stream (HUB-094)', async () => {
    const spectator = connect();
    await new Promise<any>((resolve) => spectator.emit('session:hello', { role: 'spectator' }, resolve));

    const patches: any[] = [];
    spectator.on('state:patch', (p) => patches.push(p));

    await store.controlPoints.update('cp1', { capturingPlayerId: 'player-xyz' } as any);
    await new Promise((r) => setTimeout(r, 100));

    const cpPatches = patches.filter((p) => p.type === 'qrCtfControlPoint');
    expect(cpPatches.length).toBeGreaterThan(0);
    for (const p of cpPatches) expect(p.patch.capturingPlayerId).toBeNull();
  });

  it('a location event records the player position and appends to their location series', async () => {
    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));

    const player = connect();
    const ack = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(ack.playerId, { teamId: TEAM_A });
    await createPlayerOnTeam(TEAM_B);
    await new Promise<any>((resolve) => admin.emit('admin:session:start', { sessionName: 'R1' }, resolve));

    player.emit('location', { lat: 51.5, long: -0.12, accuracyM: 8, clientTs: Date.now() });
    await new Promise((r) => setTimeout(r, 100));

    const stored = await store.players.get(ack.playerId);
    expect(stored?.locationLat).toBeCloseTo(51.5);
    expect(stored?.locationLong).toBeCloseTo(-0.12);
    expect((stored as any)?.locationAccuracyM).toBe(8);

    const station = await store.stations.get(STATION_ID);
    const sessionId = (station as any).currentSessionId;
    const ps = (await store.playerSessions.list({ sessionId, playerId: ack.playerId } as any))[0] as any;
    expect((await store.series.latest(ps.locationLatSeriesId))?.v).toBeCloseTo(51.5);
    expect((await store.series.latest(ps.locationLongSeriesId))?.v).toBeCloseTo(-0.12);
  });

  // Players are created on first hello at any time, so someone joining after startSession
  // used to have no playerSession at all - every series append for them silently no-op'd.
  it('a player who joins mid-session still gets a playerSession and recorded stats', async () => {
    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));
    await createPlayerOnTeam(TEAM_A);
    await createPlayerOnTeam(TEAM_B);
    await new Promise<any>((resolve) => admin.emit('admin:session:start', { sessionName: 'R1' }, resolve));

    const latecomer = connect();
    const ack = await new Promise<any>((resolve) => latecomer.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(ack.playerId, { teamId: TEAM_A });

    const station = await store.stations.get(STATION_ID);
    const sessionId = (station as any).currentSessionId;
    expect(await store.playerSessions.list({ sessionId, playerId: ack.playerId } as any)).toHaveLength(0);

    latecomer.emit('location', { lat: 1, long: 2, accuracyM: 5, clientTs: Date.now() });
    await new Promise((r) => setTimeout(r, 100));

    const ps = await store.playerSessions.list({ sessionId, playerId: ack.playerId } as any);
    expect(ps).toHaveLength(1);
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

  it('player:update with a profilePicture stores a servable /attachments URL, not the bare attachment ref', async () => {
    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));

    const tinyJpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xd9]).toString('base64'); // minimal SOI+EOI
    player.emit('player:update', { profilePicture: tinyJpegBase64 });
    await new Promise((resolve) => setTimeout(resolve, 50));

    const record = await store.players.get(helloAck.playerId);
    const profilePicture = (record as any)?.profilePicture as string;
    // Must be whatever the store's getUrl() produces (a servable reference), never the
    // bare ref put() returns on its own - InMemoryStore's is a mem:// URL, FileSystemStore's
    // is /attachments/<ref>; either way it must not equal the untranslated raw ref.
    expect(profilePicture).not.toMatch(/^[0-9a-f-]+\.jpg$/);
    expect(profilePicture).toMatch(/attachments\//);
  });

  it('admin:player:setQrCode assigns a badge outside of any active session', async () => {
    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));

    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));
    const setAck = await new Promise<any>((resolve) =>
      admin.emit('admin:player:setQrCode', { playerId: helloAck.playerId, qrCodeToken: 'ADMIN-SET-TOKEN-001' }, resolve),
    );
    expect(setAck.ok).toBe(true);

    const record = await store.players.get(helloAck.playerId);
    expect((record as any)?.qrCodeToken).toBe('ADMIN-SET-TOKEN-001');
    expect((record as any)?.qrCodeClaimed).toBe(true);
  });

  it('admin:player:setQrCode rejects a token already claimed by another player', async () => {
    const first = connect();
    const firstAck = await new Promise<any>((resolve) => first.emit('session:hello', { role: 'player' }, resolve));
    await new Promise<any>((resolve) =>
      first.emit('player:claimQr', { raw: 'qrctf:1:pl:ADMIN-CONFLICT-TOKEN-01' }, resolve),
    );

    const second = connect();
    const secondAck = await new Promise<any>((resolve) => second.emit('session:hello', { role: 'player' }, resolve));

    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));
    const setAck = await new Promise<any>((resolve) =>
      admin.emit(
        'admin:player:setQrCode',
        { playerId: secondAck.playerId, qrCodeToken: 'ADMIN-CONFLICT-TOKEN-01' },
        resolve,
      ),
    );
    expect(setAck.ok).toBe(false);
    expect(setAck.error).toBe('already_claimed');
    void firstAck;
  });

  it('admin:session:start derives active teams from who has joined, not an admin-picked list', async () => {
    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));

    const onlyOneTeamAck = await new Promise<any>((resolve) =>
      admin.emit('admin:session:start', { sessionName: 'R1' }, resolve),
    );
    expect(onlyOneTeamAck.ok).toBe(false);
    expect(onlyOneTeamAck.error).toBe('need_at_least_two_teams_with_players');

    await createPlayerOnTeam(TEAM_A);
    await createPlayerOnTeam(TEAM_B);
    const startAck = await new Promise<any>((resolve) =>
      admin.emit('admin:session:start', { sessionName: 'R1' }, resolve),
    );
    expect(startAck.ok).toBe(true);
    const teamSessions = await store.teamSessions.list({ sessionId: startAck.sessionId } as any);
    expect(teamSessions.map((ts: any) => ts.teamId).sort()).toEqual([TEAM_A, TEAM_B].sort());
  });

  it('admin:player:remove deletes a player with no session history', async () => {
    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));

    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));
    const removeAck = await new Promise<any>((resolve) =>
      admin.emit('admin:player:remove', { playerId: helloAck.playerId }, resolve),
    );
    expect(removeAck.ok).toBe(true);
    expect(await store.players.get(helloAck.playerId)).toBeNull();
  });

  it('admin:player:remove deletes a player even after they have played a session (roster removal, not history erasure)', async () => {
    const player = connect();
    const helloAck = await new Promise<any>((resolve) => player.emit('session:hello', { role: 'player' }, resolve));
    await store.players.update(helloAck.playerId, { teamId: TEAM_A } as any);
    await createPlayerOnTeam(TEAM_B);

    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));
    const startAck = await new Promise<any>((resolve) => admin.emit('admin:session:start', { sessionName: 'R1' }, resolve));

    const removeAck = await new Promise<any>((resolve) =>
      admin.emit('admin:player:remove', { playerId: helloAck.playerId }, resolve),
    );
    expect(removeAck.ok).toBe(true);
    expect(await store.players.get(helloAck.playerId)).toBeNull();

    // The session's own snapshotted stats survive the player record's deletion - they're
    // keyed by playerId as plain data, not a live foreign-key relationship.
    const [playerSession] = await store.playerSessions.list({
      sessionId: startAck.sessionId,
      playerId: helloAck.playerId,
    } as any);
    expect(playerSession).toBeTruthy();
  });

  it('session:hello rejects a bad admin PIN with an ack and disconnects the socket', async () => {
    const admin = connect();
    const ack = await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: 'wrong' }, resolve));
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('bad_pin');
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
    await createPlayerOnTeam(TEAM_B);

    const admin = connect();
    await new Promise<any>((resolve) => admin.emit('session:hello', { role: 'admin', adminPin: '1234' }, resolve));
    const startAck = await new Promise<any>((resolve) =>
      admin.emit('admin:session:start', { sessionName: 'R1' }, resolve),
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
