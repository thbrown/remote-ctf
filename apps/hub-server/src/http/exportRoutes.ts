/**
 * Post-game export and replay.
 *
 * This is the first thing in the codebase that reads the time series back out. Everything
 * up to now only ever appended (and `latest()`-ed for live stats), so a completed match's
 * NDJSON was write-only — the data existed on disk and nothing could reach it.
 *
 * Three surfaces:
 *   GET /export                      — session index (nothing else exposes session IDs)
 *   GET /export/:sessionId.json      — everything about one session
 *   GET /export/:sessionId.geojson   — player tracks as LineStrings, geometry as Points,
 *                                      openable directly in geojson.io or any GIS tool
 *   GET /replay?session=<id>         — scrubbable playback of the above
 *
 * Mounted on the spectator app, which is plain HTTP with no auth. Export contains player
 * names and positions, so it carries the same caveat as the live map (see
 * Config.spectatorShowPositions) — it is gated on that same flag.
 */
import express from 'express';
import type { Config } from '../config.js';
import type { GameStateStore } from '../store/GameStateStore.js';
import type { SeriesPoint } from '../store/TimeSeriesStore.js';
import { REPLAY_HTML } from './replayPage.js';
import { buildCsvTables, CSV_TABLE_NAMES, isCsvTableName, renderCsv } from './csvExport.js';

export interface SessionExport {
  session: unknown;
  teams: { teamId: string; teamName: string; hexColor: string; finalScore: number | null }[];
  controlPoints: { controlPointId: string; controlPointName: string; locationLat: number | null; locationLong: number | null }[];
  respawnLocations: { respawnLocationId: string; locationLat: number; locationLong: number }[];
  players: {
    playerId: string;
    playerName: string;
    teamId: string | null;
    track: { t: number; lat: number; long: number }[];
    isAlive: SeriesPoint[];
    tagsInflicted: SeriesPoint[];
    tagsReceived: SeriesPoint[];
    capturesCompleted: SeriesPoint[];
  }[];
  controlPointHistory: { controlPointId: string; ownerHistory: SeriesPoint[]; presenceHistory: SeriesPoint[] }[];
  teamScoreHistory: { teamId: string; score: SeriesPoint[] }[];
  tags: unknown[];
  captures: unknown[];
  respawns: unknown[];
}

const FULL_RANGE: [number, number] = [0, Number.MAX_SAFE_INTEGER];

async function readSeries(store: GameStateStore, seriesId: string | null | undefined): Promise<SeriesPoint[]> {
  if (!seriesId) return [];
  try {
    return await store.series.range(seriesId, FULL_RANGE[0], FULL_RANGE[1]);
  } catch {
    return []; // a series referenced by a row but missing on disk shouldn't fail the export
  }
}

/**
 * Latitude and longitude are two independent series sampled from one GPS fix, so they are
 * written back-to-back with near-identical timestamps but are not guaranteed to be equal.
 * Zip them by index rather than by timestamp — they're appended strictly in pairs, so index
 * alignment is exact, whereas timestamp matching would drop points whenever the two appends
 * straddle a millisecond boundary.
 */
function zipTrack(lats: SeriesPoint[], longs: SeriesPoint[]): { t: number; lat: number; long: number }[] {
  const n = Math.min(lats.length, longs.length);
  const out: { t: number; lat: number; long: number }[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ t: lats[i].t, lat: Number(lats[i].v), long: Number(longs[i].v) });
  }
  return out;
}

export async function buildSessionExport(store: GameStateStore, sessionId: string): Promise<SessionExport | null> {
  const session = await store.sessions.get(sessionId);
  if (!session) return null;

  const [playerSessions, teamSessions, cpSessions, allTeams, allPlayers, allControlPoints, allRespawns] = await Promise.all([
    store.playerSessions.list({ sessionId } as any),
    store.teamSessions.list({ sessionId } as any),
    store.controlPointSessions.list({ sessionId } as any),
    store.teams.list(),
    store.players.list(),
    store.controlPoints.list(),
    store.respawnLocations.list(),
  ]);

  const playerById = new Map((allPlayers as any[]).map((p) => [p.playerId, p]));

  const players = await Promise.all(
    (playerSessions as any[]).map(async (ps) => {
      const [lats, longs, isAlive, tagsInflicted, tagsReceived, capturesCompleted] = await Promise.all([
        readSeries(store, ps.locationLatSeriesId),
        readSeries(store, ps.locationLongSeriesId),
        readSeries(store, ps.isAliveSeriesId),
        readSeries(store, ps.tagsInflictedSeriesId),
        readSeries(store, ps.tagsReceivedSeriesId),
        readSeries(store, ps.capturesCompletedSeriesId),
      ]);
      const player = playerById.get(ps.playerId);
      return {
        playerId: ps.playerId,
        // A player deleted from the roster after the match still has a playerSession; keep
        // the row rather than dropping their history.
        playerName: player?.playerName ?? '(removed player)',
        teamId: ps.teamId ?? player?.teamId ?? null,
        track: zipTrack(lats, longs),
        isAlive,
        tagsInflicted,
        tagsReceived,
        capturesCompleted,
      };
    }),
  );

  const controlPointHistory = await Promise.all(
    (cpSessions as any[]).map(async (cs) => ({
      controlPointId: cs.controlPointId,
      ownerHistory: await readSeries(store, cs.ownerHistorySeriesId),
      presenceHistory: await readSeries(store, cs.isHumanDetectedHistorySeriesId),
    })),
  );

  const teamScoreHistory = await Promise.all(
    (teamSessions as any[]).map(async (ts) => ({ teamId: ts.teamId, score: await readSeries(store, ts.scoreSeriesId) })),
  );

  const finalScoreByTeamId = new Map((teamSessions as any[]).map((ts) => [ts.teamId, ts.finalScore]));
  const activeTeamIds = new Set((teamSessions as any[]).map((ts) => ts.teamId));

  const [tags, captures, respawns] = await Promise.all([
    store.tags.list({ sessionId } as any),
    store.captures.list({ sessionId } as any),
    store.respawns.list({ sessionId } as any),
  ]);

  return {
    session,
    teams: (allTeams as any[])
      .filter((t) => activeTeamIds.has(t.teamId))
      .map((t) => ({
        teamId: t.teamId,
        teamName: t.teamName,
        hexColor: t.hexColor,
        finalScore: finalScoreByTeamId.get(t.teamId) ?? null,
      })),
    controlPoints: (allControlPoints as any[]).map((c) => ({
      controlPointId: c.controlPointId,
      controlPointName: c.controlPointName,
      locationLat: c.locationLat,
      locationLong: c.locationLong,
    })),
    respawnLocations: (allRespawns as any[]).map((r) => ({
      respawnLocationId: r.respawnLocationId,
      locationLat: r.locationLat,
      locationLong: r.locationLong,
    })),
    players,
    controlPointHistory,
    teamScoreHistory,
    tags,
    captures,
    respawns,
  };
}

/** GeoJSON needs [long, lat] order — the reverse of how every other part of this codebase
 * writes a coordinate, and the single easiest thing to get wrong here. */
export function toGeoJson(data: SessionExport): unknown {
  const features: unknown[] = [];

  for (const p of data.players) {
    if (p.track.length < 2) continue; // a LineString needs two positions to be valid
    const team = data.teams.find((t) => t.teamId === p.teamId);
    features.push({
      type: 'Feature',
      properties: {
        kind: 'playerTrack',
        playerId: p.playerId,
        playerName: p.playerName,
        teamId: p.teamId,
        teamName: team?.teamName ?? null,
        stroke: team?.hexColor ?? '#888888', // simplestyle-spec: geojson.io colours by this
        startedAtMs: p.track[0].t,
        endedAtMs: p.track[p.track.length - 1].t,
      },
      geometry: { type: 'LineString', coordinates: p.track.map((s) => [s.long, s.lat]) },
    });
  }

  for (const c of data.controlPoints) {
    if (typeof c.locationLat !== 'number' || typeof c.locationLong !== 'number') continue;
    features.push({
      type: 'Feature',
      properties: { kind: 'controlPoint', controlPointId: c.controlPointId, name: c.controlPointName, 'marker-symbol': 'circle' },
      geometry: { type: 'Point', coordinates: [c.locationLong, c.locationLat] },
    });
  }

  for (const r of data.respawnLocations) {
    features.push({
      type: 'Feature',
      properties: { kind: 'respawnLocation', respawnLocationId: r.respawnLocationId, 'marker-symbol': 'star' },
      geometry: { type: 'Point', coordinates: [r.locationLong, r.locationLat] },
    });
  }

  return { type: 'FeatureCollection', features };
}

export function registerExportRoutes(app: express.Express, store: GameStateStore, config: Config): void {
  /**
   * Same gate as the live map: if positions aren't public, neither is the track archive.
   * Mounted as middleware over the whole prefix rather than checked per handler, so a route
   * added later can't leak positions by forgetting the check.
   */
  app.use(['/export', '/replay'], (_req, res, next) => {
    if (config.spectatorShowPositions) return next();
    res.status(403).type('text').send('Position export is disabled (SPECTATOR_SHOW_POSITIONS=false).');
  });

  /**
   * Loads the session export or answers 404, so every handler below can just take the data.
   * The 404 body follows the route's own content type — a client asking for CSV shouldn't
   * have to parse JSON to learn the session is gone.
   */
  function withExport(
    notFound: 'json' | 'text',
    handler: (data: SessionExport, req: express.Request, res: express.Response) => void | Promise<void>,
  ): express.RequestHandler {
    return async (req, res) => {
      const data = await buildSessionExport(store, req.params.sessionId);
      if (!data) {
        if (notFound === 'json') res.status(404).json({ error: 'session_not_found' });
        else res.status(404).type('text').send('session_not_found');
        return;
      }
      await handler(data, req, res);
    };
  }

  app.get('/export', async (_req, res) => {
    const sessions = (await store.sessions.list()) as any[];
    const rows = [...sessions].sort((a, b) => String(b.startTimestamp).localeCompare(String(a.startTimestamp)));
    res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>Foundry CTF — Sessions</title>
<style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;background:#0b0d12;color:#f2f2f2;padding:24px}
a{color:#8ab4ff}table{border-collapse:collapse}td,th{padding:8px 14px;border-bottom:1px solid #262a33;text-align:left}</style>
</head><body><h1>Sessions</h1>${
          rows.length === 0
            ? '<p>No sessions recorded yet.</p>'
            : `<table><thead><tr><th>Name</th><th>Started</th><th>Ended</th><th>Export</th></tr></thead><tbody>${rows
                .map(
                  (s) =>
                    `<tr><td>${escapeHtml(s.sessionName)}</td><td>${escapeHtml(s.startTimestamp)}</td><td>${escapeHtml(
                      s.endTimestamp ?? 'running',
                    )}</td><td><a href="/replay?session=${encodeURIComponent(s.sessionId)}">replay</a> · <a href="/export/${encodeURIComponent(
                      s.sessionId,
                    )}.json">json</a> · <a href="/export/${encodeURIComponent(s.sessionId)}.geojson">geojson</a>` +
                    ` · <a href="/export/${encodeURIComponent(s.sessionId)}/csv">csv</a></td></tr>`,
                )
                .join('')}</tbody></table>`
        }</body></html>`,
      );
  });

  /** Human-facing CSV index: one link per table, with row counts so it's obvious which
   * tables actually have data before downloading fourteen files. */
  app.get(
    '/export/:sessionId/csv',
    withExport('text', (data, req, res) => {
      const tables = buildCsvTables(data);
      const sid = encodeURIComponent(req.params.sessionId);
      res
        .status(200)
        .type('html')
        .send(
        `<!doctype html><html><head><meta charset="utf-8"><title>CSV export</title>
<style>body{font-family:-apple-system,Helvetica,Arial,sans-serif;background:#0b0d12;color:#f2f2f2;padding:24px;line-height:1.5}
a{color:#8ab4ff}table{border-collapse:collapse;margin-top:16px}td,th{padding:7px 14px;border-bottom:1px solid #262a33;text-align:left}
th{font-size:.8rem;text-transform:uppercase;letter-spacing:.06em;opacity:.7}
td.n{text-align:right;font-variant-numeric:tabular-nums}code{background:#171a22;border:1px solid #262a33;border-radius:4px;padding:1px 5px}
.muted{opacity:.65;max-width:70ch}</style></head><body>
<h1>CSV export</h1>
<p class="muted">${escapeHtml((data.session as any).sessionName)} — one table per observation type, every row
carrying <code>sessionId</code> so successive matches concatenate into one dataset. Timestamps are ISO 8601 UTC
alongside epoch milliseconds.</p>
<p class="muted">For a programmatic upload, <a href="/export/${sid}/tables.json">tables.json</a> lists every table
with its columns, row count and URL.</p>
<table><thead><tr><th>Table</th><th>Rows</th><th>Columns</th></tr></thead><tbody>${CSV_TABLE_NAMES.map(
          (name) =>
            `<tr><td><a href="/export/${sid}/${name}.csv">${name}.csv</a></td>` +
            `<td class="n">${tables[name].rows.length}</td>` +
            `<td class="muted">${tables[name].columns.join(', ')}</td></tr>`,
        ).join('')}</tbody></table>
<p style="margin-top:24px"><a href="/export">&larr; All sessions</a></p></body></html>`,
      );
    }),
  );

  app.get(
    '/export/:sessionId.json',
    withExport('json', (data, _req, res) => {
      res.status(200).json(data);
    }),
  );

  app.get(
    '/export/:sessionId.geojson',
    withExport('json', (data, _req, res) => {
      res.status(200).type('application/geo+json').send(JSON.stringify(toGeoJson(data)));
    }),
  );

  /**
   * Manifest for a programmatic client (the eventual Foundry upload job): one request tells
   * it which tables exist, their columns, row counts and URLs, so it can iterate without
   * hardcoding this route list.
   */
  app.get(
    '/export/:sessionId/tables.json',
    withExport('json', (data, req, res) => {
      const tables = buildCsvTables(data);
      res.status(200).json({
        sessionId: req.params.sessionId,
        tables: CSV_TABLE_NAMES.map((name) => ({
          name,
          url: `/export/${encodeURIComponent(req.params.sessionId)}/${name}.csv`,
          columns: tables[name].columns,
          rowCount: tables[name].rows.length,
        })),
      });
    }),
  );

  app.get('/export/:sessionId/:table.csv', (req, res, next) => {
    const table = req.params.table;
    if (!isCsvTableName(table)) {
      res.status(404).type('text').send(`Unknown table "${table}". Available: ${CSV_TABLE_NAMES.join(', ')}`);
      return;
    }
    withExport('text', (data, _req, res2) => {
      res2
        .status(200)
        .type('text/csv; charset=utf-8')
        // Named by session so a directory of downloads stays unambiguous once there's more
        // than one match in it.
        .set('content-disposition', `attachment; filename="${table}_${req.params.sessionId}.csv"`)
        .send(renderCsv(buildCsvTables(data)[table]));
    })(req, res, next);
  });

  app.get('/replay', (_req, res) => {
    res.status(200).type('html').send(REPLAY_HTML);
  });
}

function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
