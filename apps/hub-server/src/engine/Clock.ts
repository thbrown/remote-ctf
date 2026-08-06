/**
 * HUB-062: durations (capture timers, scoring ticks, heartbeat timeouts, tag cooldowns,
 * respawn immunity) MUST be computed from monotonic time, never wall clock. Injectable so
 * GameEngine is unit-testable with a fake clock (HUB-201).
 */
export interface Clock {
  now(): number; // monotonic milliseconds; only meaningful as a difference between calls
}

export class SystemClock implements Clock {
  now(): number {
    return performance.now();
  }
}

export class FakeClock implements Clock {
  private t = 0;
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
  set(ms: number): void {
    this.t = ms;
  }
}
