import { io, type Socket } from 'socket.io-client';
import type { QrCtfPlayer } from '@foundry-ctf/shared';

/** HUB-151: identity persists in localStorage so a refresh/backgrounded browser resumes
 * the same player without re-registering. */
const STORAGE_KEY = 'foundry-ctf:player-identity';

export interface PlayerIdentity {
  playerId: string;
  playerSecret: string;
}

export function loadPlayerIdentity(): PlayerIdentity | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PlayerIdentity) : null;
  } catch {
    return null;
  }
}

export function savePlayerIdentity(identity: PlayerIdentity): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(identity));
}

const OWN_PLAYER_CACHE_KEY = 'foundry-ctf:own-player-cache';

/** Caches the last-known ownPlayer record so a refresh/reconnect can render the right
 * screen (gameplay vs. registration) immediately instead of flashing back to
 * "choose your team" while waiting for the server's state:snapshot to arrive. The real
 * snapshot always overwrites this once it lands - this is just to avoid the flash. */
export function loadCachedOwnPlayer(): QrCtfPlayer | null {
  try {
    const raw = localStorage.getItem(OWN_PLAYER_CACHE_KEY);
    return raw ? (JSON.parse(raw) as QrCtfPlayer) : null;
  } catch {
    return null;
  }
}

export function saveCachedOwnPlayer(player: QrCtfPlayer | null): void {
  try {
    if (player) localStorage.setItem(OWN_PLAYER_CACHE_KEY, JSON.stringify(player));
    else localStorage.removeItem(OWN_PLAYER_CACHE_KEY);
  } catch {
    // ignore - worst case a refresh flashes the registration screen briefly
  }
}

let socketSingleton: Socket | null = null;

/** One socket per browser tab, shared across the player/admin/spectator views mounted in
 * this SPA (only one is ever "active" at a time per doc01 §8's mode chooser). */
export function getSocket(): Socket {
  if (!socketSingleton) {
    socketSingleton = io({ transports: ['websocket', 'polling'] });
  }
  return socketSingleton;
}
