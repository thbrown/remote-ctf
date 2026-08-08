/**
 * CSV projection of a session export, shaped for ingestion into Palantir Foundry.
 *
 * Design rules, all of them driven by "this becomes a Foundry dataset":
 *
 * - **One table per observation type, not one CSV of everything.** A single wide file mixing
 *   positions with tags with scores would need a different schema per row. Each table here
 *   has one fixed schema and one meaning per row.
 * - **Every row carries `sessionId`.** Sessions are appended into the same dataset over time,
 *   so each file has to stand alone and concatenate cleanly with the next match's.
 * - **Timestamps twice: ISO 8601 UTC and epoch milliseconds.** Foundry's parsers take the ISO
 *   form; the epoch column survives any timezone handling disagreement and makes joins exact.
 * - **Long format for the per-player counters** (`metric`, `value` columns) rather than one
 *   column per metric. Adding a metric later then appends rows instead of altering a schema.
 * - **Empty for null, never the string "null"** — otherwise a numeric column ingests as text.
 *
 * RFC 4180 quoting throughout, CRLF line endings (what the spec says, and what Excel expects
 * if anyone opens one of these on the way to Foundry).
 */
import type { SessionExport } from './exportRoutes.js';

export interface CsvTable {
  columns: string[];
  rows: (string | number | boolean | null | undefined)[][];
}

/** RFC 4180: quote when the value contains a comma, quote, CR or LF; escape quotes by doubling. */
function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function renderCsv(table: CsvTable): string {
  const lines = [table.columns.map(csvCell).join(',')];
  for (const row of table.rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n') + '\r\n';
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Every table a session produces, keyed by file name (without extension).
 * Order here is the order they're listed in the UI.
 */
export function buildCsvTables(data: SessionExport): Record<CsvTableName, CsvTable> {
  const session = data.session as {
    sessionId: string;
    sessionName: string;
    stationId: string;
    startTimestamp: string;
    endTimestamp: string | null;
    winningTeamId?: string | null;
    captureDurationMs: number;
    gameDurationMs: number | null;
  };
  const sid = session.sessionId;

  const teamNameById = new Map(data.teams.map((t) => [t.teamId, t.teamName]));
  const cpNameById = new Map(data.controlPoints.map((c) => [c.controlPointId, c.controlPointName]));

  // Partial while it fills, so a mistyped table name is a compile error rather than a file
  // that quietly never appears in the manifest. That every declared name is actually
  // assigned is covered by the coverage test.
  const tables: Partial<Record<CsvTableName, CsvTable>> = {};

  tables.sessions = {
    columns: [
      'sessionId', 'sessionName', 'stationId', 'startTimestamp', 'endTimestamp',
      'winningTeamId', 'winningTeamName', 'captureDurationMs', 'gameDurationMs',
    ],
    rows: [[
      sid, session.sessionName, session.stationId, session.startTimestamp, session.endTimestamp,
      session.winningTeamId ?? null, session.winningTeamId ? teamNameById.get(session.winningTeamId) ?? null : null,
      session.captureDurationMs, session.gameDurationMs,
    ]],
  };

  tables.teams = {
    columns: ['sessionId', 'teamId', 'teamName', 'hexColor', 'finalScore'],
    rows: data.teams.map((t) => [sid, t.teamId, t.teamName, t.hexColor, t.finalScore]),
  };

  tables.players = {
    columns: ['sessionId', 'playerId', 'playerName', 'teamId', 'teamName', 'positionSampleCount'],
    rows: data.players.map((p) => [
      sid, p.playerId, p.playerName, p.teamId, p.teamId ? teamNameById.get(p.teamId) ?? null : null, p.track.length,
    ]),
  };

  // The one that matters most for analysis: a tidy position fact table.
  tables.player_positions = {
    columns: ['sessionId', 'playerId', 'playerName', 'teamId', 'timestamp', 'epochMs', 'latitude', 'longitude'],
    rows: data.players.flatMap((p) =>
      p.track.map((s) => [sid, p.playerId, p.playerName, p.teamId, iso(s.t), s.t, s.lat, s.long]),
    ),
  };

  tables.player_status = {
    columns: ['sessionId', 'playerId', 'playerName', 'timestamp', 'epochMs', 'isAlive'],
    rows: data.players.flatMap((p) =>
      p.isAlive.map((s) => [sid, p.playerId, p.playerName, iso(s.t), s.t, s.v === true]),
    ),
  };

  // Long format: adding a metric later appends rows rather than changing this schema.
  tables.player_metrics = {
    columns: ['sessionId', 'playerId', 'playerName', 'metric', 'timestamp', 'epochMs', 'value'],
    rows: data.players.flatMap((p) =>
      (
        [
          ['tagsInflicted', p.tagsInflicted],
          ['tagsReceived', p.tagsReceived],
          ['capturesCompleted', p.capturesCompleted],
        ] as const
      ).flatMap(([metric, series]) =>
        series.map((s) => [sid, p.playerId, p.playerName, metric, iso(s.t), s.t, Number(s.v)]),
      ),
    ),
  };

  tables.team_scores = {
    columns: ['sessionId', 'teamId', 'teamName', 'timestamp', 'epochMs', 'score'],
    rows: data.teamScoreHistory.flatMap((t) =>
      t.score.map((s) => [sid, t.teamId, teamNameById.get(t.teamId) ?? null, iso(s.t), s.t, Number(s.v)]),
    ),
  };

  tables.control_points = {
    columns: ['sessionId', 'controlPointId', 'controlPointName', 'latitude', 'longitude'],
    rows: data.controlPoints.map((c) => [sid, c.controlPointId, c.controlPointName, c.locationLat, c.locationLong]),
  };

  tables.control_point_ownership = {
    columns: ['sessionId', 'controlPointId', 'controlPointName', 'timestamp', 'epochMs', 'ownerTeamId', 'ownerTeamName'],
    rows: data.controlPointHistory.flatMap((h) =>
      h.ownerHistory.map((s) => [
        sid, h.controlPointId, cpNameById.get(h.controlPointId) ?? null, iso(s.t), s.t,
        String(s.v), teamNameById.get(String(s.v)) ?? null,
      ]),
    ),
  };

  tables.control_point_presence = {
    columns: ['sessionId', 'controlPointId', 'controlPointName', 'timestamp', 'epochMs', 'isHumanDetected'],
    rows: data.controlPointHistory.flatMap((h) =>
      h.presenceHistory.map((s) => [
        sid, h.controlPointId, cpNameById.get(h.controlPointId) ?? null, iso(s.t), s.t, s.v === true,
      ]),
    ),
  };

  tables.respawn_locations = {
    columns: ['sessionId', 'respawnLocationId', 'latitude', 'longitude'],
    rows: data.respawnLocations.map((r) => [sid, r.respawnLocationId, r.locationLat, r.locationLong]),
  };

  tables.tags = {
    columns: [
      'sessionId', 'tagId', 'tagTimestamp', 'sourcePlayerId', 'targetPlayerId',
      'sourceTeamId', 'targetTeamId', 'latitude', 'longitude',
    ],
    rows: (data.tags as any[]).map((t) => [
      sid, t.tagId, t.tagTimestamp, t.sourcePlayerId, t.targetPlayerId,
      t.sourceTeamId, t.targetTeamId, t.locationLat, t.locationLong,
    ]),
  };

  tables.captures = {
    columns: [
      'sessionId', 'captureId', 'playerId', 'capturingTeamId', 'controlPointId', 'controlPointName',
      'startTimestamp', 'completeTimestamp', 'captureStatus', 'abandonReason',
    ],
    rows: (data.captures as any[]).map((c) => [
      sid, c.captureId, c.playerId, c.capturingTeamId, c.controlPointId, cpNameById.get(c.controlPointId) ?? null,
      c.startTimestamp, c.completeTimestamp, c.captureStatus, c.abandonReason,
    ]),
  };

  tables.respawns = {
    columns: ['sessionId', 'respawnId', 'playerId', 'respawnLocationId', 'respawnTimestamp'],
    rows: (data.respawns as any[]).map((r) => [sid, r.respawnId, r.playerId, r.respawnLocationId, r.respawnTimestamp]),
  };

  return tables as Record<CsvTableName, CsvTable>;
}

export const CSV_TABLE_NAMES = [
  'sessions',
  'teams',
  'players',
  'player_positions',
  'player_status',
  'player_metrics',
  'team_scores',
  'control_points',
  'control_point_ownership',
  'control_point_presence',
  'respawn_locations',
  'tags',
  'captures',
  'respawns',
] as const;

export type CsvTableName = (typeof CSV_TABLE_NAMES)[number];

/** Narrows a path parameter to a real table, so callers can index buildCsvTables safely. */
export function isCsvTableName(name: string): name is CsvTableName {
  return (CSV_TABLE_NAMES as readonly string[]).includes(name);
}
