/**
 * M2 exit criteria (doc01 §11): register -> presence -> heartbeat -> /set-color
 * round-trip against a simulated Node; reconciliation proven by deliberately dropping a
 * push. This exercises nodeApp + NodeRegistry + NodeDispatcher together against a real
 * (if tiny) HTTP server standing in for an ESP Node, rather than mocking fetch.
 */
import type { AddressInfo } from 'node:net';
import { createServer, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InMemoryStore } from '../store/InMemoryStore.js';
import { NodeRegistry } from '../nodes/NodeRegistry.js';
import { NodeDispatcher } from '../nodes/NodeDispatcher.js';
import { createNodeApp } from '../http/nodeApp.js';
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

const MAC = 'AA:BB:CC:DD:EE:01';

/** Stand-in for an ESP Node's tiny HTTP server: tracks the last /set-color it received and
 * can be toggled "down" to simulate a dropped push without tearing down the listener. */
function startFakeNode() {
  let up = true;
  let lastColor: { hexColor: string; pattern: string } | null = null;

  const server: Server = createServer((req, res) => {
    if (!up) {
      req.destroy(); // simulate an unreachable Node — no response at all
      return;
    }
    if (req.method === 'POST' && req.url === '/set-color') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        lastColor = JSON.parse(raw);
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end();
  });

  return {
    server,
    setUp: (v: boolean) => (up = v),
    getLastColor: () => lastColor,
  };
}

describe('Node round-trip integration (M2)', () => {
  let store: InMemoryStore;
  let registry: NodeRegistry;
  let dispatcher: NodeDispatcher;
  let nodeAppServer: ReturnType<ReturnType<typeof createNodeApp>['listen']>;
  let hubBaseUrl: string;
  let fakeNode: ReturnType<typeof startFakeNode>;
  let fakeNodeIp: string;

  beforeEach(async () => {
    store = new InMemoryStore();
    await store.init();
    registry = new NodeRegistry(config.heartbeatIntervalMs);
    dispatcher = new NodeDispatcher(registry);

    const app = createNodeApp(store, registry, config);
    nodeAppServer = app.listen(0);
    await new Promise((r) => nodeAppServer.once('listening', r));
    const { port } = nodeAppServer.address() as AddressInfo;
    hubBaseUrl = `http://127.0.0.1:${port}`;

    fakeNode = startFakeNode();
    await new Promise<void>((r) => fakeNode.server.listen(0, r));
    const nodePort = (fakeNode.server.address() as AddressInfo).port;
    fakeNodeIp = `127.0.0.1:${nodePort}`; // dev-only host:port form, see NodeDispatcher.nodeBaseUrl

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
      macAddress: MAC,
    });
  });

  afterEach(async () => {
    await new Promise((r) => nodeAppServer.close(r));
    await new Promise((r) => fakeNode.server.close(r));
  });

  it('register -> presence -> heartbeat -> set-color round trip', async () => {
    const registerRes = await fetch(`${hubBaseUrl}/api/cp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: MAC, ip: fakeNodeIp, fw: '1.0.0' }),
    });
    const registerBody = (await registerRes.json()) as { claimed: boolean; controlPointId: string };
    expect(registerBody.claimed).toBe(true);
    expect(registerBody.controlPointId).toBe('cp1');

    // Admin/GameEngine pushes an authoritative color to the Node.
    dispatcher.pushSetColor(MAC, fakeNodeIp, '#3A48EA', 'solid');
    await new Promise((r) => setTimeout(r, 100));
    expect(fakeNode.getLastColor()).toEqual({ hexColor: '#3A48EA', pattern: 'solid' });

    const presenceRes = await fetch(`${hubBaseUrl}/api/cp/presence`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: MAC, detected: true }),
    });
    expect(presenceRes.status).toBe(200);
    expect((await store.controlPoints.get('cp1'))?.isHumanDetected).toBe(true);

    const heartbeatRes = await fetch(`${hubBaseUrl}/api/cp/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: MAC, ip: fakeNodeIp, detected: true, hexColor: '#3A48EA' }),
    });
    const heartbeatBody = (await heartbeatRes.json()) as { hexColor: string };
    expect(heartbeatBody.hexColor).toBe('#3A48EA'); // reconciled: what it should show
  });

  it('reconciles after a dropped push via the next heartbeat (CON-014/016, HUB-196)', async () => {
    await fetch(`${hubBaseUrl}/api/cp/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: MAC, ip: fakeNodeIp, fw: '1.0.0' }),
    });

    fakeNode.setUp(false); // simulate the Node going unreachable
    dispatcher.pushSetColor(MAC, fakeNodeIp, '#EE2D2D', 'flash');
    await new Promise((r) => setTimeout(r, 100));
    expect(fakeNode.getLastColor()).toBeNull(); // push never landed

    fakeNode.setUp(true); // Node comes back before its next heartbeat

    // Node reports what it's CURRENTLY showing (stale, since the push was dropped); the
    // Hub's heartbeat response MUST still carry the authoritative desired color so the
    // Node can self-correct next tick.
    const heartbeatRes = await fetch(`${hubBaseUrl}/api/cp/heartbeat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mac: MAC, ip: fakeNodeIp, detected: false, hexColor: '#202020' }),
    });
    const heartbeatBody = (await heartbeatRes.json()) as { hexColor: string; pattern: string };
    expect(heartbeatBody.hexColor).toBe('#EE2D2D');
    expect(heartbeatBody.pattern).toBe('flash');
  });
});
