import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/InMemoryStore.js';
import { NodeRegistry } from '../nodes/NodeRegistry.js';
import { createNodeApp } from './nodeApp.js';
import type { Config } from '../config.js';

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
  stationId: 'station-test',
};

describe('nodeApp', () => {
  let baseUrl: string;
  let close: () => Promise<void>;
  let store: InMemoryStore;

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.init();
    const registry = new NodeRegistry(config.heartbeatIntervalMs);
    const app = createNodeApp(store, registry, config);
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${port}`;
    close = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterEach(async () => {
    await close();
  });

  it('register: unknown MAC auto-registers unclaimed, never 404 (CON-011/012)', async () => {
    const res = await fetch(`${baseUrl}/api/cp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.0.51', fw: '1.0.0' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      claimed: false,
      controlPointId: null,
      hexColor: '#202020',
      pattern: 'solid',
      heartbeatIntervalMs: 15000,
    });
  });

  it('register: claimed MAC reports controlPointId and current desired color', async () => {
    await store.controlPoints.create({
      controlPointId: 'cp1',
      controlPointName: 'CP One',
      stationId: 'station-test',
      currentOwnerTeamId: null,
      capturingPlayerId: null,
      captureProgress: 0,
      isHumanDetected: false,
      locationLat: 1,
      locationLong: 2,
      macAddress: 'AA:BB:CC:DD:EE:FF',
    });

    const res = await fetch(`${baseUrl}/api/cp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: 'AA:BB:CC:DD:EE:FF', ip: '10.0.0.51', fw: '1.0.0' }),
    });
    const body = (await res.json()) as { claimed: boolean; controlPointId: string | null };
    expect(body.claimed).toBe(true);
    expect(body.controlPointId).toBe('cp1');
  });

  it('register: malformed body -> 400', async () => {
    const res = await fetch(`${baseUrl}/api/cp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: 'not-a-mac', ip: '10.0.0.51', fw: '1.0.0' }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('presence: updates controlPoint.isHumanDetected and echoes authoritative color (CON-013/014)', async () => {
    await store.controlPoints.create({
      controlPointId: 'cp1',
      controlPointName: 'CP One',
      stationId: 'station-test',
      currentOwnerTeamId: null,
      capturingPlayerId: null,
      captureProgress: 0,
      isHumanDetected: false,
      locationLat: 1,
      locationLong: 2,
      macAddress: 'AA:BB:CC:DD:EE:FF',
    });

    const res = await fetch(`${baseUrl}/api/cp/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: 'AA:BB:CC:DD:EE:FF', detected: true }),
    });
    expect(res.status).toBe(200);

    const cp = await store.controlPoints.get('cp1');
    expect(cp?.isHumanDetected).toBe(true);
  });

  it('heartbeat: always overwrites stored ip (CON-010) and reports desired vs current', async () => {
    await fetch(`${baseUrl}/api/cp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.0.51', fw: '1.0.0' }),
    });

    const res = await fetch(`${baseUrl}/api/cp/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: 'aa:bb:cc:dd:ee:ff', ip: '10.0.0.99', detected: false, hexColor: '#202020' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { claimed: boolean; hexColor: string };
    expect(body.claimed).toBe(false);
    expect(body.hexColor).toBe('#202020');
  });
});
