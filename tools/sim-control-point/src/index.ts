/**
 * HUB-200: simulate N Control Point Nodes for zero-hardware end-to-end testing.
 * Each simulated Node: registers, heartbeats, exposes /set-color, /status, /identify,
 * and toggles presence on a schedule (or via keypress for interactive demos).
 *
 * Dev-only deviation from doc00 §0.4 (see NodeDispatcher.nodeBaseUrl): each sim Node runs
 * its own tiny HTTP server on a non-privileged port and reports `ip` as `127.0.0.1:<port>`
 * instead of a bare IP, since N Nodes in one process can't each bind port 80.
 *
 * Usage: NODE_COUNT=6 HUB_URL=http://localhost:3000 pnpm start
 */
import express from 'express';
import type { Request, Response } from 'express';

const HUB_URL = process.env.HUB_URL ?? 'http://localhost:3000';
const NODE_COUNT = Number(process.env.NODE_COUNT ?? 4);
const BASE_PORT = Number(process.env.SIM_BASE_PORT ?? 9101);
const PRESENCE_TOGGLE_MS = Number(process.env.SIM_PRESENCE_TOGGLE_MS ?? 8000);

interface SimNode {
  index: number;
  mac: string;
  ip: string;
  port: number;
  hexColor: string;
  pattern: 'solid' | 'pulse' | 'flash';
  detected: boolean;
  bootMs: number;
  heartbeatIntervalMs: number;
}

function macForIndex(i: number): string {
  const tail = (i + 1).toString(16).padStart(2, '0').toUpperCase();
  return `AA:BB:CC:DD:EE:${tail}`;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return (await res.json()) as T;
}

function startNodeServer(node: SimNode): void {
  const app = express();
  app.use(express.json());

  app.post('/set-color', (req: Request, res: Response) => {
    const { hexColor, pattern } = req.body as { hexColor: string; pattern: 'solid' | 'pulse' | 'flash' };
    node.hexColor = hexColor;
    node.pattern = pattern;
    console.log(`[sim ${node.mac}] set-color -> ${hexColor} ${pattern}`);
    res.status(204).end();
  });

  app.get('/status', (_req: Request, res: Response) => {
    res.json({
      mac: node.mac,
      fw: '1.0.0-sim',
      hexColor: node.hexColor,
      pattern: node.pattern,
      detected: node.detected,
      uptimeMs: Date.now() - node.bootMs,
      rssi: -50 - Math.floor(Math.random() * 20),
    });
  });

  app.post('/identify', (_req: Request, res: Response) => {
    console.log(`[sim ${node.mac}] *** identify blink ***`);
    res.status(204).end();
  });

  app.listen(node.port, () => {
    console.log(`[sim ${node.mac}] node HTTP server on :${node.port} (reported ip=${node.ip})`);
  });
}

async function register(node: SimNode): Promise<void> {
  const res = await postJson<{
    claimed: boolean;
    controlPointId: string | null;
    hexColor: string;
    pattern: 'solid' | 'pulse' | 'flash';
    heartbeatIntervalMs: number;
  }>(`${HUB_URL}/api/cp/register`, { mac: node.mac, ip: node.ip, fw: '1.0.0-sim' });
  node.hexColor = res.hexColor;
  node.pattern = res.pattern;
  node.heartbeatIntervalMs = res.heartbeatIntervalMs;
  console.log(
    `[sim ${node.mac}] registered: claimed=${res.claimed} controlPointId=${res.controlPointId} heartbeatIntervalMs=${res.heartbeatIntervalMs}`,
  );
}

function startHeartbeatLoop(node: SimNode): void {
  const tick = async () => {
    try {
      const res = await postJson<{ hexColor: string; pattern: 'solid' | 'pulse' | 'flash' }>(
        `${HUB_URL}/api/cp/heartbeat`,
        { mac: node.mac, ip: node.ip, detected: node.detected, hexColor: node.hexColor },
      );
      node.hexColor = res.hexColor;
      node.pattern = res.pattern;
    } catch (err) {
      console.warn(`[sim ${node.mac}] heartbeat failed: ${(err as Error).message}`);
    } finally {
      setTimeout(tick, node.heartbeatIntervalMs);
    }
  };
  setTimeout(tick, node.heartbeatIntervalMs);
}

async function togglePresence(node: SimNode): Promise<void> {
  node.detected = !node.detected;
  console.log(`[sim ${node.mac}] presence -> ${node.detected}`);
  try {
    const res = await postJson<{ hexColor: string; pattern: 'solid' | 'pulse' | 'flash' }>(
      `${HUB_URL}/api/cp/presence`,
      { mac: node.mac, detected: node.detected },
    );
    node.hexColor = res.hexColor;
    node.pattern = res.pattern;
  } catch (err) {
    console.warn(`[sim ${node.mac}] presence post failed: ${(err as Error).message}`);
  }
}

function startPresenceScheduler(node: SimNode): void {
  // Stagger so not all Nodes flip in lockstep.
  const jitter = Math.floor(Math.random() * PRESENCE_TOGGLE_MS);
  setTimeout(() => {
    void togglePresence(node);
    setInterval(() => void togglePresence(node), PRESENCE_TOGGLE_MS);
  }, jitter);
}

function startKeypressInterface(nodes: SimNode[]): void {
  if (!process.stdin.isTTY) return;
  console.log(`\nPress 1-${Math.min(nodes.length, 9)} to toggle presence on that sim Node. Ctrl+C to quit.\n`);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (key: string) => {
    if (key === '') process.exit(0); // Ctrl+C
    const n = Number(key);
    if (Number.isInteger(n) && n >= 1 && n <= nodes.length) {
      void togglePresence(nodes[n - 1]);
    }
  });
}

async function main() {
  console.log(`Starting ${NODE_COUNT} simulated Control Point Nodes against ${HUB_URL}`);
  const nodes: SimNode[] = [];

  for (let i = 0; i < NODE_COUNT; i++) {
    const port = BASE_PORT + i;
    const node: SimNode = {
      index: i,
      mac: macForIndex(i),
      ip: `127.0.0.1:${port}`,
      port,
      hexColor: '#202020',
      pattern: 'solid',
      detected: false,
      bootMs: Date.now(),
      heartbeatIntervalMs: 15000,
    };
    nodes.push(node);
    startNodeServer(node);
  }

  // Give servers a beat to bind before registering.
  await new Promise((r) => setTimeout(r, 250));

  for (const node of nodes) {
    await register(node);
    startHeartbeatLoop(node);
    startPresenceScheduler(node);
  }

  startKeypressInterface(nodes);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
