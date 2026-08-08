/**
 * The map is an inline <script> string, so nothing typechecks it and a syntax error would
 * only show up as a blank page at the venue. These tests evaluate the real script text and
 * exercise the projection against known distances.
 */
import { describe, expect, it } from 'vitest';
import { MAP_VIEW_SCRIPT } from './mapView.js';
import { SCOREBOARD_HTML } from './scoreboardPage.js';

interface Projection {
  scale: number;
  project(p: { lat: number; long: number }): { x: number; y: number };
}
interface MapApi {
  renderMapSvg(el: { clientWidth: number; innerHTML: string }, entities: any, opts?: any): void;
  makeProjection(points: { lat: number; long: number }[], w: number, h: number, pad: number): Projection | null;
}

function loadMapApi(): MapApi {
  return new Function(`${MAP_VIEW_SCRIPT}\nreturn { renderMapSvg, makeProjection };`)() as MapApi;
}

const TEAMS: Record<string, { hexColor: string }> = {
  t1: { hexColor: '#ee3333' },
  t2: { hexColor: '#3399ff' },
};
const teamById = (id: string) => TEAMS[id] ?? null;

/** A ~100 m square field: 0.0009 deg latitude is almost exactly 100 m. */
const CONTROL_POINTS = [
  { controlPointId: 'a', controlPointName: 'North', locationLat: 51.5009, locationLong: -0.12, currentOwnerTeamId: 't1' },
  { controlPointId: 'b', controlPointName: 'South', locationLat: 51.5, locationLong: -0.12, currentOwnerTeamId: null },
];
const RESPAWNS = [{ respawnLocationId: 'r1', locationLat: 51.5004, locationLong: -0.1214 }];

function render(entities: Partial<Record<string, any>> = {}, opts?: any) {
  const api = loadMapApi();
  const el = { clientWidth: 800, innerHTML: '' };
  api.renderMapSvg(
    el,
    {
      controlPoints: CONTROL_POINTS,
      respawnLocations: RESPAWNS,
      players: [],
      teamById,
      ...entities,
    },
    { height: 420, ...opts },
  );
  return el.innerHTML;
}

describe('mapView script', () => {
  it('every inline script on the scoreboard page is syntactically valid', () => {
    const scripts = [...SCOREBOARD_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    expect(scripts.length).toBeGreaterThan(0);
    for (const s of scripts) expect(() => new Function(s)).not.toThrow();
  });

  it('renders control points, respawn points and players as distinct marks', () => {
    const svg = render({
      players: [
        {
          playerId: 'p1',
          playerName: 'Alice',
          teamId: 't1',
          playerStatus: 'active',
          locationLat: 51.5005,
          locationLong: -0.1205,
          locationAccuracyM: 10,
          atMs: Date.now(),
        },
      ],
    });
    expect(svg.startsWith('<svg')).toBe(true);
    expect((svg.match(/<rect/g) ?? []).length).toBe(2); // two control points
    expect((svg.match(/<polygon/g) ?? []).length).toBe(1); // one respawn point
    expect(svg).toContain('Alice');
    expect(svg).toContain('#ee3333'); // owning team colour
  });

  it('marks a stale fix distinctly from a fresh one', () => {
    const base = {
      playerId: 'p1',
      playerName: 'Bob',
      teamId: 't2',
      playerStatus: 'active',
      locationLat: 51.5005,
      locationLong: -0.1205,
      locationAccuracyM: 10,
    };
    const fresh = render({ players: [{ ...base, atMs: Date.now() }] });
    const stale = render({ players: [{ ...base, atMs: Date.now() - 120_000 }] });
    expect(fresh).not.toContain('stroke-dasharray');
    expect(stale).toContain('stroke-dasharray');
    expect(stale).toContain('(stale)');
  });

  it('never emits NaN coordinates, including for a single point', () => {
    expect(render({ controlPoints: [CONTROL_POINTS[0]], respawnLocations: [] })).not.toContain('NaN');
    expect(render()).not.toContain('NaN');
  });

  it('keeps all drawn geometry inside the viewport', () => {
    const svg = render({
      players: [
        { playerId: 'p1', playerName: 'A', teamId: 't1', playerStatus: 'active', locationLat: 51.5009, locationLong: -0.1214, atMs: Date.now() },
        { playerId: 'p2', playerName: 'B', teamId: 't2', playerStatus: 'active', locationLat: 51.5, locationLong: -0.1187, atMs: Date.now() },
      ],
    });
    const xs = [...svg.matchAll(/c?x="([-\d.]+)"/g)].map((m) => Number(m[1]));
    const ys = [...svg.matchAll(/c?y="([-\d.]+)"/g)].map((m) => Number(m[1]));
    expect(xs.length).toBeGreaterThan(0);
    for (const x of xs) expect(x).toBeGreaterThanOrEqual(0);
    for (const x of xs) expect(x).toBeLessThanOrEqual(800);
    for (const y of ys) expect(y).toBeGreaterThanOrEqual(0);
    for (const y of ys) expect(y).toBeLessThanOrEqual(420);
  });

  // The whole point of the cos(lat) correction: without it, at London's latitude a degree of
  // longitude would be drawn ~1.6x too wide and every distance read off the map would be wrong.
  it('projects equal ground distances to equal pixel distances in both axes', () => {
    const api = loadMapApi();
    const projection = api.makeProjection(
      [
        { lat: 51.5, long: -0.12 },
        { lat: 51.5009, long: -0.11856 },
      ],
      800,
      420,
      28,
    )!;
    expect(projection).not.toBeNull();

    const origin = projection.project({ lat: 51.5, long: -0.12 });
    const north100m = projection.project({ lat: 51.5009, long: -0.12 });
    const east100m = projection.project({ lat: 51.5, long: -0.11856 });

    const dNorth = Math.hypot(north100m.x - origin.x, north100m.y - origin.y);
    const dEast = Math.hypot(east100m.x - origin.x, east100m.y - origin.y);
    expect(dNorth / dEast).toBeCloseTo(1, 1);
  });

  it('projects north as up (SVG y decreasing)', () => {
    const api = loadMapApi();
    const projection = api.makeProjection(
      [
        { lat: 51.5, long: -0.12 },
        { lat: 51.5009, long: -0.119 },
      ],
      800,
      420,
      28,
    )!;
    const south = projection.project({ lat: 51.5, long: -0.12 });
    const north = projection.project({ lat: 51.5009, long: -0.12 });
    expect(north.y).toBeLessThan(south.y);
  });

  it('shows an explanatory message when there is nothing to plot', () => {
    const api = loadMapApi();
    const el = { clientWidth: 800, innerHTML: '' };
    api.renderMapSvg(el, { controlPoints: [], respawnLocations: [], players: [], teamById }, {});
    expect(el.innerHTML).toContain('No positions yet');
  });

  it('escapes player and control point names', () => {
    const svg = render({
      players: [
        {
          playerId: 'p1',
          playerName: '<script>alert(1)</script>',
          teamId: 't1',
          playerStatus: 'active',
          locationLat: 51.5005,
          locationLong: -0.1205,
          atMs: Date.now(),
        },
      ],
    });
    expect(svg).not.toContain('<script>alert(1)</script>');
    expect(svg).toContain('&lt;script&gt;');
  });
});
