/** Audio feedback for Node/player connectivity changes in Admin mode, so an admin doesn't
 * have to keep eyes on the tables to notice a drop mid-game. Node and player sounds share
 * the same happy-rising/sad-falling shape but sit in different pitch ranges (player an
 * octave above Node) so the two are distinguishable by ear alone. No vibration - Admin
 * mode runs on a laptop/tablet at a desk, not a phone in a player's hand. */
import { getAudioContext, tone } from '../audioFeedback';

export function playNodeConnectedFeedback(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  tone(440, 0, 0.08, ctx);
  tone(587.33, 0.08, 0.12, ctx);
}

export function playNodeDisconnectedFeedback(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  tone(440, 0, 0.12, ctx, 0.25);
  tone(293.66, 0.1, 0.22, ctx, 0.25);
}

export function playPlayerConnectedFeedback(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  tone(880, 0, 0.08, ctx);
  tone(1174.66, 0.08, 0.12, ctx);
}

export function playPlayerDisconnectedFeedback(): void {
  const ctx = getAudioContext();
  if (!ctx) return;
  tone(880, 0, 0.12, ctx, 0.25);
  tone(587.33, 0.1, 0.22, ctx, 0.25);
}
