/**
 * Shared browser-geolocation settings and error mapping for the player and admin apps.
 *
 * Why these options matter more than they look: the Hub is an offline Wi-Fi AP with no
 * route to the internet. Without `enableHighAccuracy`, browsers prefer network positioning,
 * which resolves by asking Apple/Google's location services — unreachable from the game
 * network, so it fails or returns nothing. High accuracy forces the device's own GNSS chip,
 * which is the only source that works here (and the only one precise enough to be worth
 * plotting).
 *
 * The timeout matters just as much: a cold GNSS fix routinely takes 15–60 s, so the old
 * 5 s timeout meant essentially every attempt failed with TIMEOUT before the chip had a
 * chance to lock. 30 s for a one-shot fix; the watch gets longer still, since it can keep
 * waiting without the user staring at a spinner.
 */

/** One-shot fixes (admin claiming a control point / respawn point). */
export const ONE_SHOT_GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 30_000,
  maximumAge: 0,
};

/** Continuous player tracking. maximumAge 0 so we never re-report a cached stale fix as if
 * it were current — throttling is done on our side instead (see LOCATION_THROTTLE_MS). */
export const WATCH_GEO_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  timeout: 60_000,
  maximumAge: 0,
};

/** HUB-175's ">=3 s" throttle, applied where it actually belongs. `maximumAge` was never a
 * rate limiter — watchPosition fires as fast as the device produces fixes regardless. */
export const LOCATION_THROTTLE_MS = 3000;

export type GeoStatus =
  | { kind: 'unsupported' }
  | { kind: 'searching' }
  | { kind: 'ok'; accuracyM: number; atMs: number }
  | { kind: 'error'; message: string };

/** GeolocationPositionError codes are numeric constants; map them to something a player
 * standing in a field can act on. */
export function describeGeoError(err: GeolocationPositionError): string {
  if (err.code === err.PERMISSION_DENIED) return 'denied';
  if (err.code === err.POSITION_UNAVAILABLE) return 'no signal';
  if (err.code === err.TIMEOUT) return 'searching…';
  return 'unavailable';
}

/** Short label for the status chip. */
export function formatGeoStatus(status: GeoStatus): string {
  switch (status.kind) {
    case 'unsupported':
      return 'GPS unsupported';
    case 'searching':
      return 'GPS searching…';
    case 'ok':
      return `GPS ±${Math.round(status.accuracyM)} m`;
    case 'error':
      return `GPS ${status.message}`;
  }
}
