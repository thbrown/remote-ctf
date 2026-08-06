/** Haptic/audio feedback for capture/tag events. No audio files are bundled - tones are
 * synthesized with Web Audio so this stays self-contained. A single AudioContext is
 * reused (rather than one per sound) since browsers cap how many can exist and creating
 * one requires a prior user gesture anyway - by the time any of these fire, the player has
 * already interacted with the page (registration, badge scan), so resume() is safe here. */
let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

function tone(freqHz: number, startOffsetS: number, durationS: number, ctx: AudioContext, peakGain = 0.2): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.value = freqHz;
  const startAt = ctx.currentTime + startOffsetS;
  const endAt = startAt + durationS;
  gain.gain.setValueAtTime(0, startAt);
  gain.gain.linearRampToValueAtTime(peakGain, startAt + 0.02);
  gain.gain.linearRampToValueAtTime(0, endAt);
  osc.connect(gain);
  gain.connect(ctx.destination);
  osc.start(startAt);
  osc.stop(endAt);
}

/** Vibration is a "nice to have," never a requirement - silently no-op wherever
 * unsupported (desktop browsers, iOS Safari) rather than throwing. */
function vibrate(pattern: number | number[]): void {
  try {
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  } catch {
    // ignore
  }
}

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
