import type { OntologyTypeName } from '@foundry-ctf/shared';
import { join } from 'node:path';
import type { ChangeEvent, GameStateStore, Repository } from './GameStateStore.js';
import { atomicWriteJson, readJsonOrDefault } from './fsUtil.js';
import { FileSystemAttachmentStore } from './FileSystemAttachmentStore.js';
import { FileSystemTimeSeriesStore } from './FileSystemTimeSeriesStore.js';

type Emit = (e: ChangeEvent) => void;

/**
 * One JSON file per ontology type, holding a map of id -> row, at data/<file>.json.
 * Whole-map atomic rewrite on every mutation (HUB-060 durability rationale extends here;
 * the object counts in this game — teams/players/control points/sessions — are small
 * enough that whole-file rewrite is O(1) in practice, unlike series which must be
 * append-only).
 */
class FileSystemRepository<T extends Record<string, unknown>, IdKey extends keyof T & string>
  implements Repository<T, IdKey>
{
  private rows = new Map<string, T>();
  private readonly path: string;

  constructor(
    dataDir: string,
    file: string,
    private readonly type: OntologyTypeName,
    private readonly idKey: IdKey,
    private readonly emit: Emit,
  ) {
    this.path = join(dataDir, `${file}.json`);
  }

  async load(): Promise<void> {
    const list = await readJsonOrDefault<T[]>(this.path, []);
    this.rows = new Map(list.map((r) => [r[this.idKey] as unknown as string, r]));
  }

  private async persist(): Promise<void> {
    await atomicWriteJson(this.path, [...this.rows.values()]);
  }

  async create(entity: T): Promise<T> {
    const id = entity[this.idKey] as unknown as string;
    if (this.rows.has(id)) throw new Error(`${this.type} with ${this.idKey}=${id} already exists`);
    const stored = { ...entity };
    this.rows.set(id, stored);
    await this.persist();
    this.emit({ kind: 'created', type: this.type, id, after: stored });
    return { ...stored };
  }

  async get(id: string): Promise<T | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async list(filter?: Partial<T>): Promise<T[]> {
    const all = [...this.rows.values()];
    if (!filter) return all.map((r) => ({ ...r }));
    return all
      .filter((row) => Object.entries(filter).every(([k, v]) => row[k as keyof T] === v))
      .map((r) => ({ ...r }));
  }

  async update(id: string, patch: Partial<Omit<T, IdKey>>): Promise<T> {
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`${this.type} with ${this.idKey}=${id} not found`);
    const after = { ...existing, ...patch } as T;
    this.rows.set(id, after);
    await this.persist();
    this.emit({ kind: 'updated', type: this.type, id, patch, after });
    return { ...after };
  }

  async delete(id: string): Promise<void> {
    if (!this.rows.has(id)) return;
    this.rows.delete(id);
    await this.persist();
    this.emit({ kind: 'deleted', type: this.type, id });
  }
}

export class FileSystemStore implements GameStateStore {
  private readonly listeners = new Set<(e: ChangeEvent) => void>();
  private readonly emit: Emit = (e) => {
    for (const l of this.listeners) l(e);
  };

  readonly stations: FileSystemRepository<any, 'stationId'>;
  readonly teams: FileSystemRepository<any, 'teamId'>;
  readonly players: FileSystemRepository<any, 'playerId'>;
  readonly controlPoints: FileSystemRepository<any, 'controlPointId'>;
  readonly respawnLocations: FileSystemRepository<any, 'respawnLocationId'>;
  readonly sessions: FileSystemRepository<any, 'sessionId'>;
  readonly playerSessions: FileSystemRepository<any, 'playerSessionId'>;
  readonly controlPointSessions: FileSystemRepository<any, 'controlPointSessionId'>;
  readonly teamSessions: FileSystemRepository<any, 'teamSessionId'>;
  readonly tags: FileSystemRepository<any, 'tagId'>;
  readonly captures: FileSystemRepository<any, 'captureId'>;
  readonly respawns: FileSystemRepository<any, 'respawnId'>;

  readonly series: FileSystemTimeSeriesStore;
  readonly attachments: FileSystemAttachmentStore;

  private readonly repos: FileSystemRepository<any, any>[];

  constructor(private readonly dataDir: string) {
    this.stations = new FileSystemRepository(dataDir, 'stations', 'qrCtfStation', 'stationId', this.emit);
    this.teams = new FileSystemRepository(dataDir, 'teams', 'qrCtfTeam', 'teamId', this.emit);
    this.players = new FileSystemRepository(dataDir, 'players', 'qrCtfPlayer', 'playerId', this.emit);
    this.controlPoints = new FileSystemRepository(
      dataDir,
      'controlPoints',
      'qrCtfControlPoint',
      'controlPointId',
      this.emit,
    );
    this.respawnLocations = new FileSystemRepository(
      dataDir,
      'respawnLocations',
      'qrCtfRespawnLocation',
      'respawnLocationId',
      this.emit,
    );
    this.sessions = new FileSystemRepository(dataDir, 'sessions', 'qrCtfSession', 'sessionId', this.emit);
    this.playerSessions = new FileSystemRepository(
      dataDir,
      'playerSessions',
      'qrCtfPlayerSession',
      'playerSessionId',
      this.emit,
    );
    this.controlPointSessions = new FileSystemRepository(
      dataDir,
      'controlPointSessions',
      'qrCtfControlPointSession',
      'controlPointSessionId',
      this.emit,
    );
    this.teamSessions = new FileSystemRepository(
      dataDir,
      'teamSessions',
      'qrCtfTeamSession',
      'teamSessionId',
      this.emit,
    );
    this.tags = new FileSystemRepository(dataDir, 'tags', 'qrCtfTag', 'tagId', this.emit);
    this.captures = new FileSystemRepository(dataDir, 'captures', 'qrCtfCapture', 'captureId', this.emit);
    this.respawns = new FileSystemRepository(dataDir, 'respawns', 'qrCtfRespawn', 'respawnId', this.emit);

    this.repos = [
      this.stations,
      this.teams,
      this.players,
      this.controlPoints,
      this.respawnLocations,
      this.sessions,
      this.playerSessions,
      this.controlPointSessions,
      this.teamSessions,
      this.tags,
      this.captures,
      this.respawns,
    ];

    this.series = new FileSystemTimeSeriesStore(dataDir, this.emit);
    this.attachments = new FileSystemAttachmentStore(dataDir);
  }

  subscribe(listener: (e: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async batch<R>(fn: (tx: GameStateStore) => Promise<R>): Promise<R> {
    // Best-effort atomic per doc01 §5.1 — the filesystem impl has no real transaction
    // manager. Individual repo mutations are each atomic (temp+rename); a multi-step
    // batch is not rolled back on partial failure in v1.
    return fn(this);
  }

  async init(): Promise<void> {
    for (const repo of this.repos) await repo.load();
    await this.series.load();
  }

  async close(): Promise<void> {
    // no persistent handles held open beyond individual file writes
  }
}
