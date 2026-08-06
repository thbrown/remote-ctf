/**
 * doc01 §5.1 (normative interfaces). All game state reads/writes MUST go through a single
 * GameStateStore (HUB-050) — no module outside a store implementation touches files,
 * memory maps, or Lohi directly.
 */
import type {
  OntologyTypeName,
  QrCtfCapture,
  QrCtfControlPoint,
  QrCtfControlPointSession,
  QrCtfPlayer,
  QrCtfPlayerSession,
  QrCtfRespawn,
  QrCtfRespawnLocation,
  QrCtfSession,
  QrCtfStation,
  QrCtfTag,
  QrCtfTeam,
  QrCtfTeamSession,
} from '@foundry-ctf/shared';
import type { SeriesId } from '@foundry-ctf/shared';
import type { AttachmentStore } from './AttachmentStore.js';
import type { SeriesPoint, TimeSeriesStore } from './TimeSeriesStore.js';

/**
 * HUB-051: every method returns a Promise, including the in-memory implementation. This
 * is deliberate and non-negotiable — it's the single biggest lever protecting the future
 * Lohi swap from becoming a whole-codebase refactor.
 *
 * HUB-052: `update` takes a partial patch — absent key = unchanged, `null` = clear.
 * HUB-053: series-valued properties are not patchable via `update`; they are append-only
 * via TimeSeriesStore (in this ontology, series are referenced by a `*SeriesId` field on
 * the parent record, which itself IS a regular, once-written field).
 */
export interface Repository<T, IdKey extends keyof T & string> {
  create(entity: T): Promise<T>;
  get(id: string): Promise<T | null>;
  list(filter?: Partial<T>): Promise<T[]>;
  update(id: string, patch: Partial<Omit<T, IdKey>>): Promise<T>;
  delete(id: string): Promise<void>;
}

export type ChangeEvent =
  | { kind: 'created'; type: OntologyTypeName; id: string; after: unknown }
  | { kind: 'updated'; type: OntologyTypeName; id: string; patch: unknown; after: unknown }
  | { kind: 'deleted'; type: OntologyTypeName; id: string }
  | { kind: 'appended'; type: 'series'; seriesId: SeriesId; point: SeriesPoint };

export interface GameStateStore {
  readonly stations: Repository<QrCtfStation, 'stationId'>;
  readonly teams: Repository<QrCtfTeam, 'teamId'>;
  readonly players: Repository<QrCtfPlayer, 'playerId'>;
  readonly controlPoints: Repository<QrCtfControlPoint, 'controlPointId'>;
  readonly respawnLocations: Repository<QrCtfRespawnLocation, 'respawnLocationId'>;
  readonly sessions: Repository<QrCtfSession, 'sessionId'>;
  readonly playerSessions: Repository<QrCtfPlayerSession, 'playerSessionId'>;
  readonly controlPointSessions: Repository<QrCtfControlPointSession, 'controlPointSessionId'>;
  readonly teamSessions: Repository<QrCtfTeamSession, 'teamSessionId'>;
  readonly tags: Repository<QrCtfTag, 'tagId'>;
  readonly captures: Repository<QrCtfCapture, 'captureId'>;
  readonly respawns: Repository<QrCtfRespawn, 'respawnId'>;

  readonly series: TimeSeriesStore;
  readonly attachments: AttachmentStore;

  subscribe(listener: (e: ChangeEvent) => void): () => void;

  /** Best-effort atomic batch. In-memory/FS: real. Lohi: a single edit batch. */
  batch<R>(fn: (tx: GameStateStore) => Promise<R>): Promise<R>;

  init(): Promise<void>;
  close(): Promise<void>;
}
