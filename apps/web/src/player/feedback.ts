/** Haptic/audio feedback for capture/tag events. See ../audioFeedback.ts for the shared
 * tone-synthesis/AudioContext plumbing this builds on. */
import { getAudioContext, tone, vibrate } from '../audioFeedback';

/** You tagged an opponent: short buzz + a quick rising two-note chirp. */
export function playTagInflictedFeedback(): void {
  vibrate(80);
  const ctx = getAudioContext();
  if (!ctx) return;
  tone(660, 0, 0.08, ctx);
  tone(880, 0.08, 0.1, ctx);
}

/** You completed a capture: short buzz + a brighter three-note ascending chime, distinct
 * from a tag so it reads as "bigger" (a captured point vs. a single tag). */
export function playCaptureFeedback(): void {
  vibrate(80);
  const ctx = getAudioContext();
  if (!ctx) return;
  tone(523.25, 0, 0.09, ctx);
  tone(659.25, 0.09, 0.09, ctx);
  tone(784, 0.18, 0.16, ctx, 0.25);
}

/** You got tagged: long 2.5s buzz + a low descending "uh-oh" tone, clearly distinct from
 * the (short, higher-pitched) tag-inflicted/capture sounds. */
export function playTaggedFeedback(): void {
  vibrate(2500);
  const ctx = getAudioContext();
  if (!ctx) return;
  tone(392, 0, 0.5, ctx, 0.25);
  tone(261.63, 0.45, 0.9, ctx, 0.25);
}
