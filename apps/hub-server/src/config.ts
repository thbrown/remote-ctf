/**
 * doc01 §9.2. Env vars seed the corresponding qrCtfStation properties on first boot only;
 * thereafter the Station record in the store is authoritative and the Admin UI edits it.
 * This module only supplies process-level config (ports, paths, TLS, seed defaults) —
 * never re-read as the live source of truth for tunable game knobs once a Station exists.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';

export type StoreDriver = 'inmemory' | 'filesystem';
export type TlsMode = 'selfsigned' | 'provided';

export interface Config {
  storeDriver: StoreDriver;
  dataDir: string;
  nodeHttpPort: number;
  deviceHttpsPort: number;
  spectatorHttpPort: number;
  /** doc01 §9.2: "disabled" in dev. null means the portal app does not bind. */
  portalHttpPort: number | null;
  /** doc00 Q-A / doc00 §0.2 — TBD until the venue is finalized; using the doc's own
   * proposed defaults (PROGRESS.md documents this choice). */
  wifiSsid: string;
  wifiPsk: string;
  tlsMode: TlsMode;
  tlsCertPath: string | null;
  tlsKeyPath: string | null;
  publicOrigin: string;
  captureDurationMs: number;
  presenceGraceMs: number;
  tagCooldownMs: number;
  respawnImmunityMs: number;
  heartbeatIntervalMs: number;
  neutralHexColor: string;
  unclaimedHexColor: string;
  adminPin: string;
  stationId: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function envStr(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? fallback : raw;
}

/** Best-effort LAN address for the join sheet/QR/`publicOrigin` default, used only when
 * PUBLIC_ORIGIN isn't set explicitly. `localhost` is meaningless to a player's phone, so
 * this picks the first non-internal IPv4 address instead. On a box with more than one
 * Wi-Fi radio (e.g. a Pi running the game AP on a USB adapter while the built-in radio
 * stays on the internet, see ops/raspberry-pi-ap-setup.md) this can guess the wrong
 * interface — set PUBLIC_ORIGIN explicitly in that case. */
function detectLanIPv4(): { address: string; iface: string } | null {
  const nets = networkInterfaces();
  for (const [iface, addrs] of Object.entries(nets)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) return { address: addr.address, iface };
    }
  }
  return null;
}

/** STATION_ID: use env if given, else generate once and persist under DATA_DIR so it's
 * stable across reboots without requiring an env var (doc01 §9.2 table: "generated once,
 * persisted"). */
async function resolveStationId(dataDir: string): Promise<string> {
  const fromEnv = process.env.STATION_ID;
  if (fromEnv) return fromEnv;

  const path = join(dataDir, 'station-id.txt');
  try {
    const existing = await readFile(path, 'utf8');
    const trimmed = existing.trim();
    if (trimmed) return trimmed;
  } catch (err: any) {
    if (err?.code !== 'ENOENT') throw err;
  }

  const id = randomUUID();
  await mkdir(dataDir, { recursive: true });
  await writeFile(path, id, 'utf8');
  return id;
}

export async function loadConfig(): Promise<Config> {
  const isDev = envStr('NODE_ENV', 'development') !== 'production';
  const dataDir = envStr('DATA_DIR', './data');

  const portalHttpPortRaw = process.env.PORTAL_HTTP_PORT;
  const portalHttpPort = isDev && portalHttpPortRaw === undefined ? null : envInt('PORTAL_HTTP_PORT', 80);

  const deviceHttpsPort = envInt('DEVICE_HTTPS_PORT', isDev ? 8443 : 443);

  let publicOrigin = process.env.PUBLIC_ORIGIN;
  if (!publicOrigin) {
    const lan = detectLanIPv4();
    const host = lan?.address ?? 'localhost';
    const portSuffix = deviceHttpsPort === 443 ? '' : `:${deviceHttpsPort}`;
    publicOrigin = `https://${host}${portSuffix}`;
    if (lan) {
      console.log(
        `[config] PUBLIC_ORIGIN not set - auto-detected ${publicOrigin} (interface ${lan.iface}). ` +
          'Set PUBLIC_ORIGIN explicitly if this is wrong, e.g. when running the AP on a second Wi-Fi radio.',
      );
    } else {
      console.warn(`[config] PUBLIC_ORIGIN not set and no LAN interface found - falling back to ${publicOrigin}.`);
    }
  }

  return {
    storeDriver: (envStr('STORE_DRIVER', 'filesystem') as StoreDriver) ?? 'filesystem',
    dataDir,
    nodeHttpPort: envInt('NODE_HTTP_PORT', 3000),
    deviceHttpsPort,
    spectatorHttpPort: envInt('SPECTATOR_HTTP_PORT', 8080),
    portalHttpPort,
    wifiSsid: envStr('WIFI_SSID', 'FoundryCTF'),
    wifiPsk: envStr('WIFI_PSK', 'capturetheflag'),
    tlsMode: (envStr('TLS_MODE', 'selfsigned') as TlsMode) ?? 'selfsigned',
    tlsCertPath: process.env.TLS_CERT_PATH ?? null,
    tlsKeyPath: process.env.TLS_KEY_PATH ?? null,
    publicOrigin, // Q-A default: auto-detected LAN IP unless PUBLIC_ORIGIN is set
    captureDurationMs: envInt('CAPTURE_DURATION_MS', 10000),
    presenceGraceMs: envInt('PRESENCE_GRACE_MS', 2500),
    tagCooldownMs: envInt('TAG_COOLDOWN_MS', 10000),
    respawnImmunityMs: envInt('RESPAWN_IMMUNITY_MS', 5000),
    heartbeatIntervalMs: envInt('HEARTBEAT_INTERVAL_MS', 15000),
    neutralHexColor: envStr('NEUTRAL_HEX_COLOR', '#FFFFFF'),
    unclaimedHexColor: envStr('UNCLAIMED_HEX_COLOR', '#202020'),
    adminPin: envStr('ADMIN_PIN', '1234'),
    stationId: await resolveStationId(dataDir),
  };
}
