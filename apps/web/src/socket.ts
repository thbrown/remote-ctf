import { io, type Socket } from 'socket.io-client';

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

let socketSingleton: Socket | null = null;

/** One socket per browser tab, shared across the player/admin/spectator views mounted in
 * this SPA (only one is ever "active" at a time per doc01 §8's mode chooser). */
export function getSocket(): Socket {
  if (!socketSingleton) {
    socketSingleton = io({ transports: ['websocket', 'polling'] });
  }
  return socketSingleton;
}
