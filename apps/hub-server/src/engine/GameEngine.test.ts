import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/InMemoryStore.js';
import { GameEngine, type GameEngineEvents } from './GameEngine.js';
import { FakeClock } from './Clock.js';

const STATION_ID = 'station-1';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';
const CP_MAC = 'AA:BB:CC:DD:EE:01';

function makeEvents(): GameEngineEvents & { calls: Record<string, any[]> } {
  const calls: Record<string, any[]> = {};
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
  };
  return {
    calls,
    captureStarted: record('captureStarted'),
    captureProgress: record('captureProgress'),
    captureCompleted: record('captureCompleted'),
    captureCompletedForPlayer: record('captureCompletedForPlayer'),
    captureAbandoned: record('captureAbandoned'),
    tagInflicted: record('tagInflicted'),
    tagReceived: record('tagReceived'),
    respawnCompleted: record('respawnCompleted'),
    scanRejected: record('scanRejected'),
    sessionStarted: record('sessionStarted'),
    sessionEnded: record('sessionEnded'),
  } as any;
}

async function setup() {
  const store = new InMemoryStore();
  await store.init();
  const clock = new FakeClock();
  const events = makeEvents();
  const colorPushes: { mac: string; hexColor: string; pattern: string }[] = [];
  const onlineMacs = new Set([CP_MAC]);

  const engine = new GameEngine({
    store,
    clock,
    wallClockIso: () => new Date(0).toISOString(),
    dispatchColor: (mac, hexColor, pattern) => colorPushes.push({ mac, hexColor, pattern }),
    isNodeOnline: (mac) => onlineMacs.has(mac),
    events,
  });
  engine.start();

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

  const playerA = await store.players.create({
    playerId: 'p-a',
    playerName: 'Alice',
    stationId: STATION_ID,
    sessionId: null,
    playerSessionId: null,
    teamId: TEAM_A,
    qrCodeToken: 'token-alice-1234567890',
    playerStatus: 'active',
    profilePicture: null,
    locationLat: null,
    locationLong: null,
    playerSecret: 'secret-a',
  } as any);

  const playerB = await store.players.create({
    playerId: 'p-b',
    playerName: 'Bob',
    stationId: STATION_ID,
    sessionId: null,
    playerSessionId: null,
    teamId: TEAM_B,
    qrCodeToken: 'token-bob-1234567890ab',
    playerStatus: 'active',
    profilePicture: null,
    locationLat: null,
    locationLong: null,
    playerSecret: 'secret-b',
  } as any);

  return { store, clock, events, colorPushes, onlineMacs, engine, playerA, playerB };
}

describe('GameEngine — capture (HUB-100..108)', () => {
  it('rejects a capture attempt when no session is running', async () => {
    const { engine, events } = await setup();
    await engine.attemptCapture('p-a', `qrctf:1:cp:${CP_MAC}`, CP_MAC);
    expect(events.calls.scanRejected[0][2]).toBe('no_session');
  });

  it('happy path: start -> progress ticks -> complete, ownership transfers, flash pushed', async () => {
    const { engine, store, clock, events, colorPushes } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);

    await engine.attemptCapture('p-a', 'raw', CP_MAC);
    expect(events.calls.captureStarted).toHaveLength(1);
    expect(colorPushes.at(-1)).toEqual({ mac: CP_MAC, hexColor: '#FFFFFF', pattern: 'pulse' }); // neutral owner, pulsing

    await engine.tickCaptures(STATION_ID);
    expect(events.calls.captureProgress).toHaveLength(1);

    clock.advance(10000); // full captureDurationMs
    await engine.tickCaptures(STATION_ID);

    expect(events.calls.captureCompleted).toHaveLength(1);
    // Delivered to the capturing player specifically (for personal feedback like
    // haptics/sound), separate from captureCompleted's broadcast to everyone.
    expect(events.calls.captureCompletedForPlayer).toHaveLength(1);
    expect(events.calls.captureCompletedForPlayer[0][0]).toBe('p-a');
    const cp = await store.controlPoints.get('cp1');
    expect(cp?.currentOwnerTeamId).toBe(TEAM_A);
    expect(cp?.capturingPlayerId).toBeNull();
    expect(colorPushes.at(-1)).toEqual({ mac: CP_MAC, hexColor: '#111111', pattern: 'flash' });
  });

  it('rejects redundant capture of a point your own team already owns', async () => {
    const { engine, store, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await store.controlPoints.update('cp1', { currentOwnerTeamId: TEAM_A });

    await engine.attemptCapture('p-a', 'raw', CP_MAC);
    expect(events.calls.scanRejected[0][2]).toBe('already_owned_by_your_team');
  });

  it('abandons a capture after continuous presence loss exceeds presenceGraceMs (HUB-104)', async () => {
    const { engine, store, clock, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await engine.attemptCapture('p-a', 'raw', CP_MAC);

    await store.controlPoints.update('cp1', { isHumanDetected: false }); // presence lost, via store feed
    clock.advance(2500); // == presenceGraceMs, boundary satisfied by >=
    await engine.tickCaptures(STATION_ID);

    expect(events.calls.captureAbandoned).toHaveLength(1);
    expect((events.calls.captureAbandoned[0][0] as any).abandonReason).toBe('presence_lost');
  });

  it('does NOT abandon if presence returns before the grace window elapses', async () => {
    const { engine, store, clock, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await engine.attemptCapture('p-a', 'raw', CP_MAC);

    await store.controlPoints.update('cp1', { isHumanDetected: false });
    clock.advance(1000);
    await store.controlPoints.update('cp1', { isHumanDetected: true }); // recovered
    clock.advance(5000);
    await engine.tickCaptures(STATION_ID);

    expect(events.calls.captureAbandoned).toBeUndefined();
  });

  it('abandons a capture when the Node goes offline mid-attempt (HUB-108)', async () => {
    const { engine, onlineMacs, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await engine.attemptCapture('p-a', 'raw', CP_MAC);

    onlineMacs.delete(CP_MAC);
    await engine.tickCaptures(STATION_ID);

    expect(events.calls.captureAbandoned).toHaveLength(1);
    expect((events.calls.captureAbandoned[0][0] as any).abandonReason).toBe('node_offline');
  });

  it('player_cancelled via cancelCapture', async () => {
    const { engine, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await engine.attemptCapture('p-a', 'raw', CP_MAC);
    const captureId = (events.calls.captureStarted[0][0] as any).captureId;

    await engine.cancelCapture('p-a', captureId);
    expect(events.calls.captureAbandoned).toHaveLength(1);
    expect((events.calls.captureAbandoned[0][0] as any).abandonReason).toBe('player_cancelled');
  });

  it('rejects capture_in_progress and already_capturing', async () => {
    const { engine, store } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);

    await store.players.create({
      playerId: 'p-a2',
      playerName: 'Alice Two',
      stationId: STATION_ID,
      sessionId: null,
      playerSessionId: null,
      teamId: TEAM_A,
      qrCodeToken: 'token-alice-two-abcdef',
      playerStatus: 'active',
      profilePicture: null,
      locationLat: null,
      locationLong: null,
      playerSecret: 'secret-a2',
    } as any);
    // re-run session start so the new player gets a playerSession — simplest: just proceed,
    // attemptCapture only needs an active player + session, not a playerSession record.

    await engine.attemptCapture('p-a', 'raw', CP_MAC);
    const eventsSecond = makeEvents();
    (engine as any).events = eventsSecond;
    await engine.attemptCapture('p-a2', 'raw', CP_MAC);
    expect(eventsSecond.calls.scanRejected[0][2]).toBe('capture_in_progress');
  });
});

describe('GameEngine — tagging (HUB-110..113)', () => {
  it('happy path tag: target tagged_out, counters bumped, both sides notified', async () => {
    const { engine, store, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);

    await engine.attemptTag('p-a', 'raw', 'token-bob-1234567890ab');

    const bob = await store.players.get('p-b');
    expect(bob?.playerStatus).toBe('tagged_out');
    expect(events.calls.tagInflicted).toHaveLength(1);
    expect(events.calls.tagReceived).toHaveLength(1);

    const teamA = await store.teams.get(TEAM_A);
    const teamB = await store.teams.get(TEAM_B);
    expect(teamA?.totalTagsInflicted).toBe(1);
    expect(teamB?.totalTagsReceived).toBe(1);
  });

  it('rejects same-team tags', async () => {
    const { engine, store, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await store.players.update('p-b', { teamId: TEAM_A });

    await engine.attemptTag('p-a', 'raw', 'token-bob-1234567890ab');
    expect(events.calls.scanRejected[0][2]).toBe('same_team');
  });

  it('enforces tag cooldown between the same pair, independent of respawn immunity', async () => {
    const { engine, store, clock, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await store.respawnLocations.create({
      respawnLocationId: 'rp1',
      stationId: STATION_ID,
      locationLat: 0,
      locationLong: 0,
      allowedTeamIds: [],
    } as any);

    await engine.attemptTag('p-a', 'raw', 'token-bob-1234567890ab'); // t=0, lastTag=0
    clock.advance(1000); // t=1000
    await engine.attemptRespawn('p-b', 'raw', 'rp1'); // lastRespawn=1000
    clock.advance(5000); // t=6000: respawn immunity (5000ms) has just elapsed, cooldown (10000ms) has not

    await engine.attemptTag('p-a', 'raw', 'token-bob-1234567890ab');
    expect(events.calls.scanRejected.at(-1)?.[2]).toBe('tag_cooldown');
  });

  it("capturer cannot inflict tags mid-attempt (HUB-112), but CAN be tagged, aborting their capture", async () => {
    const { engine, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);

    // Bob starts capturing (needs presence true, already set). Bob is on TEAM_B; cp is neutral.
    await engine.attemptCapture('p-b', 'raw', CP_MAC);
    expect(events.calls.captureStarted).toHaveLength(1);

    // Alice tags Bob while he's capturing -> allowed (defenders tag freely), aborts his capture.
    await engine.attemptTag('p-a', 'raw', 'token-bob-1234567890ab');
    expect(events.calls.captureAbandoned).toHaveLength(1);
    expect((events.calls.captureAbandoned[0][0] as any).abandonReason).toBe('player_tagged');
  });
});

describe('GameEngine — respawn (HUB-120..124)', () => {
  it('happy path respawn restores active status', async () => {
    const { engine, store, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await store.respawnLocations.create({
      respawnLocationId: 'rp1',
      stationId: STATION_ID,
      locationLat: 0,
      locationLong: 0,
      allowedTeamIds: [],
    } as any);
    await store.players.update('p-b', { playerStatus: 'tagged_out' });

    await engine.attemptRespawn('p-b', 'raw', 'rp1');
    expect((await store.players.get('p-b'))?.playerStatus).toBe('active');
    expect(events.calls.respawnCompleted).toHaveLength(1);
  });

  it('rejects respawn for a player who is not tagged_out', async () => {
    const { engine, store, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await store.respawnLocations.create({
      respawnLocationId: 'rp1',
      stationId: STATION_ID,
      locationLat: 0,
      locationLong: 0,
      allowedTeamIds: [],
    } as any);

    await engine.attemptRespawn('p-b', 'raw', 'rp1'); // p-b is still active
    expect(events.calls.scanRejected[0][2]).toBe('not_tagged_out');
  });

  it('enforces allowedTeamIds restriction', async () => {
    const { engine, store, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await store.respawnLocations.create({
      respawnLocationId: 'rp1',
      stationId: STATION_ID,
      locationLat: 0,
      locationLong: 0,
      allowedTeamIds: [TEAM_B], // only team B may use it
    } as any);
    await store.players.update('p-a', { playerStatus: 'tagged_out' });

    await engine.attemptRespawn('p-a', 'raw', 'rp1');
    expect(events.calls.scanRejected[0][2]).toBe('respawn_not_allowed_for_team');
  });

  it('respawn immunity blocks an immediate re-tag', async () => {
    const { engine, store, events } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await store.respawnLocations.create({
      respawnLocationId: 'rp1',
      stationId: STATION_ID,
      locationLat: 0,
      locationLong: 0,
      allowedTeamIds: [],
    } as any);
    await store.players.update('p-b', { playerStatus: 'tagged_out' });
    await engine.attemptRespawn('p-b', 'raw', 'rp1');

    await engine.attemptTag('p-a', 'raw', 'token-bob-1234567890ab');
    expect(events.calls.scanRejected.at(-1)?.[2]).toBe('respawn_immunity');
  });
});

describe('GameEngine — scoring (HUB-130..133)', () => {
  it('splits score proportional to hold time across owned control points', async () => {
    const { engine, store } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await store.controlPoints.update('cp1', { currentOwnerTeamId: TEAM_A });

    await engine.tickScoring(STATION_ID);
    await engine.tickScoring(STATION_ID);

    const teamA = await store.teams.get(TEAM_A);
    const teamB = await store.teams.get(TEAM_B);
    expect(teamA?.score).toBe(1);
    expect(teamB?.score).toBe(0);
  });

  it('scores 0 for all teams before anything has been held', async () => {
    const { engine, store } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);

    await engine.tickScoring(STATION_ID);

    const teamA = await store.teams.get(TEAM_A);
    expect(teamA?.score).toBe(0);
  });
});

describe('GameEngine — session lifecycle', () => {
  it('startSession snapshots captureDurationMs and seeds series/rows', async () => {
    const { engine, store } = await setup();
    const session = await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    expect(session.captureDurationMs).toBe(10000);

    const station = await store.stations.get(STATION_ID);
    expect((station as any).currentSessionId).toBe(session.sessionId);

    const playerSessions = await store.playerSessions.list();
    expect(playerSessions).toHaveLength(2);
  });

  it('endSession sets winningTeamId to the highest scorer and clears currentSessionId', async () => {
    const { engine, store } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await store.controlPoints.update('cp1', { currentOwnerTeamId: TEAM_B });
    await engine.tickScoring(STATION_ID);

    await engine.endSession(STATION_ID);

    const station = await store.stations.get(STATION_ID);
    expect((station as any).currentSessionId).toBeNull();
    const sessions = await store.sessions.list();
    expect(sessions[0].winningTeamId).toBe(TEAM_B);
  });

  it('HUB-016: handleHubRestart abandons an in-progress session cleanly', async () => {
    const { engine, store } = await setup();
    await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);
    await engine.attemptCapture('p-a', 'raw', CP_MAC);

    await engine.handleHubRestart();

    const station = await store.stations.get(STATION_ID);
    expect((station as any).currentSessionId).toBeNull();
    const captures = await store.captures.list();
    expect(captures[0].captureStatus).toBe('abandoned');
    expect(captures[0].abandonReason).toBe('hub_restart');
    const cp = await store.controlPoints.get('cp1');
    expect(cp?.currentOwnerTeamId).toBeNull();
    expect(cp?.capturingPlayerId).toBeNull();
    const alice = await store.players.get('p-a');
    expect(alice?.playerStatus).toBe('active');
  });
});
