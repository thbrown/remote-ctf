/** Shared tone-synthesis plumbing for haptic/audio feedback. No audio files are bundled -
 * tones are synthesized with Web Audio so this stays self-contained. A single AudioContext
 * is reused (rather than one per sound) since browsers cap how many can exist and creating
 * one requires a prior user gesture anyway - by the time any consumer's sounds fire, the
 * user has already interacted with the page, so resume() is safe here. */
let audioCtx: AudioContext | null = null;

export function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as any).webkitAudioContext;
  if (!Ctor) return null;
  if (!audioCtx) audioCtx = new Ctor();
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  return audioCtx;
}

export function tone(freqHz: number, startOffsetS: number, durationS: number, ctx: AudioContext, peakGain = 0.2): void {
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
export function vibrate(pattern: number | number[]): void {
  try {
    if ('vibrate' in navigator) navigator.vibrate(pattern);
  } catch {
    // ignore
  }
}
