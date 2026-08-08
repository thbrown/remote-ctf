import { useEffect, useState } from 'react';

/** Re-renders every `intervalMs` so components displaying formatRelativeTime() stay live
 * (otherwise "3s ago" would freeze at whatever it was on the render that logged the event). */
export function useNowTick(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "3s ago" / "4m ago" style relative time, for event-log/ticker timestamps that need to
 * keep ticking as time passes rather than freeze at the moment they were logged. */
export function formatRelativeTime(atMs: number, nowMs: number = Date.now()): string {
  const deltaS = Math.max(0, Math.round((nowMs - atMs) / 1000));
  if (deltaS < 1) return 'just now';
  if (deltaS < 60) return `${deltaS}s ago`;
  const deltaM = Math.round(deltaS / 60);
  if (deltaM < 60) return `${deltaM}m ago`;
  const deltaH = Math.round(deltaM / 60);
  return `${deltaH}h ago`;
}

/** "mm:ss" countdown for the optional game clock — clamped at "0:00", never negative
 * (the Hub auto-ends the session around the same moment, but a client tick can land a
 * beat before that patch arrives). */
export function formatCountdown(startTimestamp: string, gameDurationMs: number, nowMs: number = Date.now()): string {
  const remainingMs = Math.max(0, Date.parse(startTimestamp) + gameDurationMs - nowMs);
  const totalSeconds = Math.floor(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}
