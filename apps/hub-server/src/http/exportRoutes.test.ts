/**
 * End-to-end over a real (in-memory) store driven by a real GameEngine: play a short match,
 * then read it back out through the export. This is the first code path that reads the time
 * series rather than only appending to them, so it's also the check that what the engine
 * writes is actually recoverable.
 */
import express from 'express';
import { describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/InMemoryStore.js';
import { GameEngine } from '../engine/GameEngine.js';
import { FakeClock } from '../engine/Clock.js';
import type { Config } from '../config.js';
import { buildSessionExport, registerExportRoutes, toGeoJson } from './exportRoutes.js';
import { REPLAY_HTML } from './replayPage.js';
import { buildCsvTables, CSV_TABLE_NAMES, renderCsv } from './csvExport.js';

const STATION_ID = 'station-1';
const TEAM_A = 'team-a';
const TEAM_B = 'team-b';
const CP_MAC = 'AA:BB:CC:DD:EE:01';

const noopEvents: any = new Proxy({}, { get: () => () => {} });

async function playAMatch() {
  const store = new InMemoryStore();
  await store.init();
  const clock = new FakeClock();

  const engine = new GameEngine({
    store,
    clock,
    wallClockIso: () => new Date().toISOString(),
    dispatchColor: () => {},
    isNodeOnline: () => true,
    events: noopEvents,
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
  await store.teams.create({ teamId: TEAM_A, teamName: 'Red', hexColor: '#ee3333', score: 0, totalTagsInflicted: 0, totalTagsReceived: 0 });
  await store.teams.create({ teamId: TEAM_B, teamName: 'Blue', hexColor: '#3399ff', score: 0, totalTagsInflicted: 0, totalTagsReceived: 0 });
  await store.controlPoints.create({
    controlPointId: 'cp1',
    controlPointName: 'North Gate',
    stationId: STATION_ID,
    currentOwnerTeamId: null,
    capturingPlayerId: null,
    captureProgress: 0,
    isHumanDetected: true,
    locationLat: 51.5009,
    locationLong: -0.12,
    macAddress: CP_MAC,
  } as any);
  await store.respawnLocations.create({
    respawnLocationId: 'rp1',
    stationId: STATION_ID,
    locationLat: 51.5,
    locationLong: -0.1214,
    allowedTeamIds: [],
  } as any);

  for (const [id, name, team, token] of [
    ['p-a', 'Alice', TEAM_A, 'token-alice-1234567890'],
    ['p-b', 'Bob', TEAM_B, 'token-bob-1234567890ab'],
  ] as const) {
    await store.players.create({
      playerId: id,
      playerName: name,
      stationId: STATION_ID,
      sessionId: null,
      playerSessionId: null,
      teamId: team,
      qrCodeToken: token,
      playerStatus: 'active',
      profilePicture: null,
      locationLat: null,
      locationLong: null,
      locationAccuracyM: null,
      playerSecret: 'secret-' + id,
    } as any);
  }

  const session = await engine.startSession(STATION_ID, 'Round 1', [TEAM_A, TEAM_B]);

  // Walk Alice north along a short track.
  for (let i = 0; i < 5; i++) {
    await engine.recordPlayerLocation('p-a', 51.5 + i * 0.0002, -0.12, 8);
  }
  // Bob moves once, then gets tagged.
  await engine.recordPlayerLocation('p-b', 51.5003, -0.1205, 12);
  await engine.attemptTag('p-a', 'raw', 'token-bob-1234567890ab');

  // Alice captures the control point.
  await engine.attemptCapture('p-a', 'raw', CP_MAC);
  clock.advance(10000);
  await engine.tickCaptures(STATION_ID);
  await engine.tickScoring(STATION_ID);
  await engine.endSession(STATION_ID);

  return { store, sessionId: session.sessionId };
}

/** Node's fetch keeps sockets alive, so a bare server.close() never fires its callback and
 * the test process hangs at teardown. Drop the keep-alive sockets first. */
async function closeServer(server: { closeAllConnections?: () => void; close: (cb: () => void) => void }) {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const config = { spectatorShowPositions: true } as unknown as Config;

describe('session export', () => {
  it('recovers player tracks, alive transitions and ownership history from the series', async () => {
    const { store, sessionId } = await playAMatch();
    const data = (await buildSessionExport(store, sessionId))!;
    expect(data).not.toBeNull();

    const alice = data.players.find((p) => p.playerId === 'p-a')!;
    expect(alice.playerName).toBe('Alice');
    expect(alice.track).toHaveLength(5);
    expect(alice.track[0].lat).toBeCloseTo(51.5);
    expect(alice.track[4].lat).toBeCloseTo(51.5008);
    // Every sample must be a coherent lat/long pair, not a lat paired with a stale long.
    for (const s of alice.track) expect(s.long).toBeCloseTo(-0.12);
    expect(alice.capturesCompleted.at(-1)?.v).toBe(1);
    expect(alice.tagsInflicted.at(-1)?.v).toBe(1);

    const bob = data.players.find((p) => p.playerId === 'p-b')!;
    expect(bob.isAlive.map((p) => p.v)).toEqual([true, false]);
    expect(bob.tagsReceived.at(-1)?.v).toBe(1);

    const cpHistory = data.controlPointHistory.find((h) => h.controlPointId === 'cp1')!;
    expect(cpHistory.ownerHistory.at(-1)?.v).toBe(TEAM_A);

    expect(data.teamScoreHistory.find((t) => t.teamId === TEAM_A)?.score.length).toBeGreaterThan(0);
    expect(data.tags).toHaveLength(1);
    expect(data.captures).toHaveLength(1);
    expect(data.teams.map((t) => t.teamName).sort()).toEqual(['Blue', 'Red']);
  });

  it('returns null for an unknown session', async () => {
    const { store } = await playAMatch();
    expect(await buildSessionExport(store, 'nope')).toBeNull();
  });

  it('emits valid GeoJSON with [long, lat] ordering', async () => {
    const { store, sessionId } = await playAMatch();
    const data = (await buildSessionExport(store, sessionId))!;
    const geo = toGeoJson(data) as any;

    expect(geo.type).toBe('FeatureCollection');
    const track = geo.features.find((f: any) => f.properties.kind === 'playerTrack');
    expect(track.geometry.type).toBe('LineString');
    expect(track.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    // GeoJSON is [long, lat] - longitude here is negative, latitude ~51.5. Getting these
    // the wrong way round puts every track in the Indian Ocean and still "works".
    const [long, lat] = track.geometry.coordinates[0];
    expect(long).toBeCloseTo(-0.12);
    expect(lat).toBeCloseTo(51.5);
    expect(track.properties.stroke).toBe('#ee3333');

    const cp = geo.features.find((f: any) => f.properties.kind === 'controlPoint');
    expect(cp.geometry.coordinates).toEqual([-0.12, 51.5009]);
    expect(geo.features.some((f: any) => f.properties.kind === 'respawnLocation')).toBe(true);

    // A single-sample track can't form a LineString and must be dropped, not emitted invalid.
    for (const f of geo.features) {
      if (f.geometry.type === 'LineString') expect(f.geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('serves json, geojson, the session index and the replay page', async () => {
    const { store, sessionId } = await playAMatch();
    const app = express();
    registerExportRoutes(app, store, config);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const index = await fetch(`${base}/export`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('Round 1');

      const json = await fetch(`${base}/export/${sessionId}.json`);
      expect(json.status).toBe(200);
      expect(((await json.json()) as { players: unknown[] }).players).toHaveLength(2);

      const geo = await fetch(`${base}/export/${sessionId}.geojson`);
      expect(geo.status).toBe(200);
      expect(geo.headers.get('content-type')).toContain('geo+json');

      expect((await fetch(`${base}/export/missing.json`)).status).toBe(404);
      expect((await fetch(`${base}/replay?session=${sessionId}`)).status).toBe(200);
    } finally {
      await closeServer(server);
    }
  });

  it('refuses to export positions when SPECTATOR_SHOW_POSITIONS is off', async () => {
    const { store, sessionId } = await playAMatch();
    const app = express();
    registerExportRoutes(app, store, { spectatorShowPositions: false } as unknown as Config);
    const server = app.listen(0);
    const port = (server.address() as any).port;

    try {
      expect((await fetch(`http://127.0.0.1:${port}/export/${sessionId}.json`)).status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${port}/export`)).status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${port}/replay`)).status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });

  it('the replay page has no syntax errors in its inline scripts', () => {
    const scripts = [...REPLAY_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBe(2); // shared map code + replay controller
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });
});

describe('CSV export (Foundry ingestion)', () => {
  it('emits one tidy row per position sample, with ISO and epoch timestamps', async () => {
    const { store, sessionId } = await playAMatch();
    const data = (await buildSessionExport(store, sessionId))!;
    const t = buildCsvTables(data).player_positions;

    expect(t.columns).toEqual([
      'sessionId', 'playerId', 'playerName', 'teamId', 'timestamp', 'epochMs', 'latitude', 'longitude',
    ]);
    // 5 samples for Alice + 1 for Bob.
    expect(t.rows).toHaveLength(6);

    const csv = renderCsv(t);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(7); // header + 6
    const first = lines[1].split(',');
    expect(first[0]).toBe(sessionId); // every row stands alone
    expect(first[4]).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/); // ISO 8601 UTC
    expect(Number(first[5])).toBeGreaterThan(0); // epoch ms
    expect(Date.parse(first[4])).toBe(Number(first[5])); // the two agree
  });

  it('quotes per RFC 4180 and uses CRLF', () => {
    const csv = renderCsv({
      columns: ['a', 'b', 'c'],
      rows: [['plain', 'has,comma', 'has "quotes"'], ['line\nbreak', null, undefined]],
    });
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe('a,b,c');
    expect(lines[1]).toBe('plain,"has,comma","has ""quotes"""');
    // A newline inside a field must stay quoted, not split the record.
    expect(csv).toContain('"line\nbreak"');
    // null/undefined become empty, never the literal string - otherwise numeric columns
    // ingest as text.
    expect(lines[2]).toBe('"line\nbreak",,');
    expect(csv).not.toContain('null');
    expect(csv.endsWith('\r\n')).toBe(true);
  });

  it('covers every declared table and keeps schemas rectangular', async () => {
    const { store, sessionId } = await playAMatch();
    const data = (await buildSessionExport(store, sessionId))!;
    const tables = buildCsvTables(data);

    for (const name of CSV_TABLE_NAMES) {
      const t = tables[name];
      expect(t, `table ${name} missing`).toBeDefined();
      expect(t.columns[0], `table ${name} must lead with sessionId`).toBe('sessionId');
      for (const row of t.rows) {
        expect(row.length, `table ${name} has a ragged row`).toBe(t.columns.length);
        expect(row[0]).toBe(sessionId);
      }
    }
    // Spot-check the tables that should have content after playAMatch().
    expect(tables.sessions.rows).toHaveLength(1);
    expect(tables.tags.rows).toHaveLength(1);
    expect(tables.captures.rows).toHaveLength(1);
    expect(tables.team_scores.rows.length).toBeGreaterThan(0);
    expect(tables.control_point_ownership.rows.length).toBeGreaterThan(0);
    expect(tables.player_metrics.rows.length).toBeGreaterThan(0);
  });

  it('serves each table over HTTP and a manifest describing them', async () => {
    const { store, sessionId } = await playAMatch();
    const app = express();
    registerExportRoutes(app, store, config);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const manifest = (await (await fetch(`${base}/export/${sessionId}/tables.json`)).json()) as any;
      expect(manifest.tables).toHaveLength(CSV_TABLE_NAMES.length);
      for (const entry of manifest.tables) {
        expect(entry.columns.length).toBeGreaterThan(0);
        const res = await fetch(`${base}${entry.url}`);
        expect(res.status, `${entry.name} did not serve`).toBe(200);
        expect(res.headers.get('content-type')).toContain('text/csv');
        expect(res.headers.get('content-disposition')).toContain(`${entry.name}_${sessionId}.csv`);
        const body = await res.text();
        // header + declared row count
        expect(body.trimEnd().split('\r\n')).toHaveLength(entry.rowCount + 1);
      }

      expect((await fetch(`${base}/export/${sessionId}/csv`)).status).toBe(200);
      expect((await fetch(`${base}/export/${sessionId}/not_a_table.csv`)).status).toBe(404);
      expect((await fetch(`${base}/export/missing/player_positions.csv`)).status).toBe(404);
    } finally {
      await closeServer(server);
    }
  });

  it('does not serve CSV when positions are disabled', async () => {
    const { store, sessionId } = await playAMatch();
    const app = express();
    registerExportRoutes(app, store, { spectatorShowPositions: false } as unknown as Config);
    const server = app.listen(0);
    const port = (server.address() as any).port;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/export/${sessionId}/player_positions.csv`)).status).toBe(403);
      expect((await fetch(`http://127.0.0.1:${port}/export/${sessionId}/tables.json`)).status).toBe(403);
    } finally {
      await closeServer(server);
    }
  });
});
