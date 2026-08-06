/**
 * HUB-195/196: outbound dispatch to Control Point Nodes MUST be non-blocking and queued
 * per Node — at most one in-flight request, 2 s timeout, latest-value-wins coalescing,
 * exponential backoff with a cap. ESP8266WebServer serves one connection at a time and
 * would otherwise head-of-line block the game loop. Push is always best-effort (CON-022) —
 * correctness comes from CON-014/016 (presence + heartbeat reconciliation), never from
 * push alone.
 */
import type { LedPattern } from '@foundry-ctf/shared';
import type { NodeRegistry } from './NodeRegistry.js';

const REQUEST_TIMEOUT_MS = 2000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;

interface PendingColorState {
  ip: string;
  hexColor: string;
  pattern: LedPattern;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** doc00 §0.4 Base URL is always `http://<node.ip>:80` in prod/firmware. In dev,
 * tools/sim-control-point runs several simulated Nodes in one process and cannot each
 * bind privileged port 80, so it reports `ip` as `host:port` — recognized here as a
 * dev-only deviation. Plain IPs (no colon) always get the contractual `:80`. */
function nodeBaseUrl(ip: string): string {
  return ip.includes(':') ? `http://${ip}` : `http://${ip}:80`;
}

export class NodeDispatcher {
  private readonly inFlight = new Set<string>();
  private readonly pending = new Map<string, PendingColorState>();
  private readonly backoffMs = new Map<string, number>();

  constructor(private readonly registry: NodeRegistry) {}

  /** Queue a /set-color push. Never blocks the caller. */
  pushSetColor(mac: string, ip: string, hexColor: string, pattern: LedPattern): void {
    this.registry.setDesired(mac, hexColor, pattern);
    this.pending.set(mac, { ip, hexColor, pattern });
    if (!this.inFlight.has(mac)) void this.drain(mac);
  }

  /** Best-effort, fire-and-forget admin "find this Node" — no retry (HUB admin action, not
   * a game-correctness path). */
  async identify(mac: string, ip: string): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(`${nodeBaseUrl(ip)}/identify`, { method: 'POST' }, REQUEST_TIMEOUT_MS);
      return res.status === 204 || res.ok;
    } catch {
      return false;
    }
  }

  private async drain(mac: string): Promise<void> {
    this.inFlight.add(mac);
    try {
      for (;;) {
        const state = this.pending.get(mac);
        if (!state) break;
        this.pending.delete(mac); // consume the latest value; a newer push during send supersedes it

        const ok = await this.send(mac, state);
        if (ok) {
          this.backoffMs.delete(mac);
          continue;
        }

        const nextBackoff = Math.min((this.backoffMs.get(mac) ?? INITIAL_BACKOFF_MS / 2) * 2, MAX_BACKOFF_MS);
        this.backoffMs.set(mac, nextBackoff);
        if (!this.pending.has(mac)) {
          await sleep(nextBackoff);
          // retry the same state only if nothing newer arrived while we slept
          if (!this.pending.has(mac)) this.pending.set(mac, state);
        }
      }
    } finally {
      this.inFlight.delete(mac);
    }
  }

  private async send(mac: string, state: PendingColorState): Promise<boolean> {
    try {
      const res = await fetchWithTimeout(
        `${nodeBaseUrl(state.ip)}/set-color`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ hexColor: state.hexColor, pattern: state.pattern }),
        },
        REQUEST_TIMEOUT_MS,
      );
      if (res.status === 204 || res.ok) {
        this.registry.setReported(mac, state.hexColor);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }
}
