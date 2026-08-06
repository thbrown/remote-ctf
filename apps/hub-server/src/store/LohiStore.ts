/**
 * Stub only (doc01 §5.4, HUB-071). When Lohi ships, implement this against generated
 * Lohi types adapted via toLohi/fromLohi codecs at this boundary. Lohi types must never
 * leak into GameEngine or the Web App.
 */
import type { GameStateStore } from './GameStateStore.js';

export class LohiStore implements GameStateStore {
  get stations(): never {
    throw new Error('LohiStore not implemented');
  }
  get teams(): never {
    throw new Error('LohiStore not implemented');
  }
  get players(): never {
    throw new Error('LohiStore not implemented');
  }
  get controlPoints(): never {
    throw new Error('LohiStore not implemented');
  }
  get respawnLocations(): never {
    throw new Error('LohiStore not implemented');
  }
  get sessions(): never {
    throw new Error('LohiStore not implemented');
  }
  get playerSessions(): never {
    throw new Error('LohiStore not implemented');
  }
  get controlPointSessions(): never {
    throw new Error('LohiStore not implemented');
  }
  get teamSessions(): never {
    throw new Error('LohiStore not implemented');
  }
  get tags(): never {
    throw new Error('LohiStore not implemented');
  }
  get captures(): never {
    throw new Error('LohiStore not implemented');
  }
  get respawns(): never {
    throw new Error('LohiStore not implemented');
  }
  get series(): never {
    throw new Error('LohiStore not implemented');
  }
  get attachments(): never {
    throw new Error('LohiStore not implemented');
  }
  subscribe(): () => void {
    throw new Error('LohiStore not implemented');
  }
  async batch<R>(): Promise<R> {
    throw new Error('LohiStore not implemented');
  }
  async init(): Promise<void> {
    throw new Error('LohiStore not implemented');
  }
  async close(): Promise<void> {
    throw new Error('LohiStore not implemented');
  }
}
