/**
 * doc01 HUB-015 startup order: load config -> init store -> seed teams -> resolve prior
 * session (HUB-016) -> bind nodeApp -> bind spectatorApp+portalApp -> load/generate TLS ->
 * bind deviceApp. nodeApp binds before any TLS material exists or is even attempted
 * (HUB-011) so Control Point registration can never be broken by a cert problem.
 */
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server as SocketIoServer } from 'socket.io';
import { SEED_TEAMS } from '@foundry-ctf/shared';
import { loadConfig } from './config.js';
import { InMemoryStore } from './store/InMemoryStore.js';
import { FileSystemStore } from './store/FileSystemStore.js';
import type { GameStateStore } from './store/GameStateStore.js';
import { NodeRegistry } from './nodes/NodeRegistry.js';
import { NodeDispatcher } from './nodes/NodeDispatcher.js';
import { createNodeApp } from './http/nodeApp.js';
import { createSpectatorApp } from './http/spectatorApp.js';
import { createPortalApp } from './http/portalApp.js';
import { createDeviceApp } from './http/deviceApp.js';
import { loadOrCreateTlsMaterial } from './http/tls.js';
import { GameEngine } from './engine/GameEngine.js';
import { SystemClock } from './engine/Clock.js';
import { createSocketIoGameEvents } from './ws/gameEvents.js';
import { createWsGateway } from './ws/WsGateway.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const CAPTURE_TICK_MS = 200; // 5 Hz, HUB-103
const SCORING_TICK_MS = 1000; // 1 Hz, HUB-131

async function ensureStation(store: GameStateStore, config: Awaited<ReturnType<typeof loadConfig>>) {
  const existing = await store.stations.get(config.stationId);
  if (existing) return existing;
  return store.stations.create({
    stationId: config.stationId,
    currentSessionId: null,
    stationName: 'Foundry CTF',
    captureDurationMs: config.captureDurationMs,
    presenceGraceMs: config.presenceGraceMs,
    tagCooldownMs: config.tagCooldownMs,
    respawnImmunityMs: config.respawnImmunityMs,
    neutralHexColor: config.neutralHexColor,
  } as any);
}

async function main() {
  const config = await loadConfig();
  console.log(`[hub] starting — storeDriver=${config.storeDriver} stationId=${config.stationId}`);

  const store: GameStateStore = config.storeDriver === 'filesystem' ? new FileSystemStore(config.dataDir) : new InMemoryStore();
  await store.init();

  for (const team of SEED_TEAMS) {
    // HUB-044: idempotent upsert by teamId.
    const existing = await store.teams.get(team.teamId);
    if (!existing) {
      await store.teams.create({ ...team, score: 0, totalTagsInflicted: 0, totalTagsReceived: 0 });
    }
  }
  await ensureStation(store, config);

  const registry = new NodeRegistry(config.heartbeatIntervalMs);
  const dispatcher = new NodeDispatcher(registry);

  // nodeApp binds first, independent of TLS (HUB-011).
  const nodeApp = createNodeApp(store, registry, config);
  await new Promise<void>((resolve) => nodeApp.listen(config.nodeHttpPort, resolve));
  console.log(`[hub] nodeApp listening on :${config.nodeHttpPort}`);

  const spectatorApp = createSpectatorApp(config);
  const spectatorServer = createHttpServer(spectatorApp);
  await new Promise<void>((resolve) => spectatorServer.listen(config.spectatorHttpPort, resolve));
  console.log(`[hub] spectatorApp listening on :${config.spectatorHttpPort}`);

  if (config.portalHttpPort !== null) {
    const portalApp = createPortalApp(config);
    const portalServer = createHttpServer(portalApp);
    await new Promise<void>((resolve) => portalServer.listen(config.portalHttpPort!, resolve));
    console.log(`[hub] portalApp listening on :${config.portalHttpPort}`);
  }

  const tls = await loadOrCreateTlsMaterial(config);
  const webDistDir = join(__dirname, '../../web/dist');
  const deviceApp = createDeviceApp(config, tls, webDistDir);
  const httpsServer = createHttpsServer({ cert: tls.cert, key: tls.key }, deviceApp);

  const io = new SocketIoServer();
  io.attach(httpsServer); // HUB-013
  io.attach(spectatorServer);

  const engine = new GameEngine({
    store,
    clock: new SystemClock(),
    wallClockIso: () => new Date().toISOString(),
    dispatchColor: (mac, hexColor, pattern) => {
      const record = registry.get(mac);
      if (record) dispatcher.pushSetColor(mac, record.ip, hexColor, pattern);
    },
    isNodeOnline: (mac) => {
      const record = registry.get(mac);
      return record ? registry.isOnline(record) : false;
    },
    events: createSocketIoGameEvents(io),
  });
  engine.start();
  await engine.handleHubRestart(); // HUB-016

  createWsGateway({ io, store, engine, config, stationId: config.stationId, dispatcher, registry });

  setInterval(() => void engine.tickCaptures(config.stationId), CAPTURE_TICK_MS);
  setInterval(() => void engine.tickScoring(config.stationId), SCORING_TICK_MS);

  await new Promise<void>((resolve) => httpsServer.listen(config.deviceHttpsPort, resolve));
  console.log(`[hub] deviceApp listening on :${config.deviceHttpsPort} (${config.publicOrigin})`);
  console.log('[hub] ready');

  // Scoreboard lives on spectatorApp's own plain-HTTP port, not behind publicOrigin/TLS -
  // reuse publicOrigin's hostname since that's already the right thing to hand to players
  // (LAN IP or the real domain, whichever's configured), just with a different port/scheme.
  const scoreboardUrl = `http://${new URL(config.publicOrigin).hostname}:${config.spectatorHttpPort}/scoreboard`;
  console.log(`[hub]   Main page:     ${config.publicOrigin}`);
  console.log(`[hub]   Join sheet:    ${config.publicOrigin}/join-sheet`);
  console.log(`[hub]   Test QR codes: ${config.publicOrigin}/test-qr`);
  console.log(`[hub]   Scoreboard:    ${scoreboardUrl}`);
}

main().catch((err) => {
  console.error('[hub] fatal startup error', err);
  process.exit(1);
});
