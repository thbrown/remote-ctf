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
