import type { OntologyTypeName } from '@foundry-ctf/shared';
import type { ChangeEvent, GameStateStore, Repository } from './GameStateStore.js';
import type { AttachmentStore } from './AttachmentStore.js';
import { AttachmentTooLargeError, MAX_ATTACHMENT_BYTES } from './AttachmentStore.js';
import type { SeriesMeta, SeriesPoint, SeriesValue, TimeSeriesStore } from './TimeSeriesStore.js';
import { OutOfOrderAppendError } from './TimeSeriesStore.js';
import { randomUUID } from 'node:crypto';

type Emit = (e: ChangeEvent) => void;

class InMemoryRepository<T extends Record<string, unknown>, IdKey extends keyof T & string>
  implements Repository<T, IdKey>
{
  private readonly rows = new Map<string, T>();

  constructor(
    private readonly type: OntologyTypeName,
    private readonly idKey: IdKey,
    private readonly emit: Emit,
  ) {}

  async create(entity: T): Promise<T> {
    const id = entity[this.idKey] as unknown as string;
    if (this.rows.has(id)) {
      throw new Error(`${this.type} with ${this.idKey}=${id} already exists`);
    }
    const stored = { ...entity };
    this.rows.set(id, stored);
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
    this.emit({ kind: 'updated', type: this.type, id, patch, after });
    return { ...after };
  }

  async delete(id: string): Promise<void> {
    if (!this.rows.has(id)) return;
    this.rows.delete(id);
    this.emit({ kind: 'deleted', type: this.type, id });
  }
}

class InMemoryTimeSeriesStore implements TimeSeriesStore {
  private readonly meta = new Map<string, SeriesMeta>();
  private readonly points = new Map<string, SeriesPoint[]>();
  private readonly cursors = new Map<string, number>();

  constructor(private readonly emit: Emit) {}

  async createSeries(m: Omit<SeriesMeta, 'seriesId' | 'createdAt'>): Promise<string> {
    const seriesId = randomUUID();
    this.meta.set(seriesId, { ...m, seriesId, createdAt: Date.now() });
    this.points.set(seriesId, []);
    return seriesId;
  }

  async getMeta(seriesId: string): Promise<SeriesMeta | null> {
    return this.meta.get(seriesId) ?? null;
  }

  async listSeries(f?: Partial<Pick<SeriesMeta, 'ownerType' | 'ownerId' | 'property'>>): Promise<SeriesMeta[]> {
    const all = [...this.meta.values()];
    if (!f) return all;
    return all.filter((m) => Object.entries(f).every(([k, v]) => (m as any)[k] === v));
  }

  async append<V extends SeriesValue>(id: string, p: SeriesPoint<V>): Promise<void> {
    const arr = this.points.get(id);
    if (!arr) throw new Error(`series ${id} not found`);
    const last = arr[arr.length - 1];
    if (last && p.t < last.t) throw new OutOfOrderAppendError(id, p.t, last.t);
    arr.push(p);
    this.emit({ kind: 'appended', type: 'series', seriesId: id, point: p });
  }

  async appendMany<V extends SeriesValue>(id: string, ps: SeriesPoint<V>[]): Promise<void> {
    for (const p of ps) await this.append(id, p);
  }

  async latest<V extends SeriesValue>(id: string): Promise<SeriesPoint<V> | null> {
    const arr = this.points.get(id);
    if (!arr || arr.length === 0) return null;
    return arr[arr.length - 1] as SeriesPoint<V>;
  }

  async range<V extends SeriesValue>(id: string, fromMs: number, toMs: number): Promise<SeriesPoint<V>[]> {
    const arr = this.points.get(id) ?? [];
    return arr.filter((p) => p.t >= fromMs && p.t <= toMs) as SeriesPoint<V>[];
  }

  async *readUnsynced(id: string, chunkSize = 100): AsyncIterable<SeriesPoint[]> {
    const cursor = this.cursors.get(id) ?? -Infinity;
    const arr = (this.points.get(id) ?? []).filter((p) => p.t > cursor);
    for (let i = 0; i < arr.length; i += chunkSize) {
      yield arr.slice(i, i + chunkSize);
    }
  }

  async getSyncCursor(id: string): Promise<number | null> {
    return this.cursors.get(id) ?? null;
  }

  async setSyncCursor(id: string, throughMs: number): Promise<void> {
    this.cursors.set(id, throughMs);
  }
}

class InMemoryAttachmentStore implements AttachmentStore {
  private readonly blobs = new Map<string, { bytes: Uint8Array; mime: string }>();

  async put(bytes: Uint8Array, mime: string): Promise<string> {
    if (bytes.byteLength > MAX_ATTACHMENT_BYTES) throw new AttachmentTooLargeError(bytes.byteLength);
    const ref = randomUUID();
    this.blobs.set(ref, { bytes, mime });
    return ref;
  }

  async getUrl(ref: string): Promise<string> {
    if (!this.blobs.has(ref)) throw new Error(`attachment ${ref} not found`);
    return `mem://attachments/${ref}`;
  }
}

export class InMemoryStore implements GameStateStore {
  private readonly listeners = new Set<(e: ChangeEvent) => void>();
  private readonly emit: Emit = (e) => {
    for (const l of this.listeners) l(e);
  };

  readonly stations = new InMemoryRepository<any, 'stationId'>('qrCtfStation', 'stationId', this.emit);
  readonly teams = new InMemoryRepository<any, 'teamId'>('qrCtfTeam', 'teamId', this.emit);
  readonly players = new InMemoryRepository<any, 'playerId'>('qrCtfPlayer', 'playerId', this.emit);
  readonly controlPoints = new InMemoryRepository<any, 'controlPointId'>(
    'qrCtfControlPoint',
    'controlPointId',
    this.emit,
  );
  readonly respawnLocations = new InMemoryRepository<any, 'respawnLocationId'>(
    'qrCtfRespawnLocation',
    'respawnLocationId',
    this.emit,
  );
  readonly sessions = new InMemoryRepository<any, 'sessionId'>('qrCtfSession', 'sessionId', this.emit);
  readonly playerSessions = new InMemoryRepository<any, 'playerSessionId'>(
    'qrCtfPlayerSession',
    'playerSessionId',
    this.emit,
  );
  readonly controlPointSessions = new InMemoryRepository<any, 'controlPointSessionId'>(
    'qrCtfControlPointSession',
    'controlPointSessionId',
    this.emit,
  );
  readonly teamSessions = new InMemoryRepository<any, 'teamSessionId'>(
    'qrCtfTeamSession',
    'teamSessionId',
    this.emit,
  );
  readonly tags = new InMemoryRepository<any, 'tagId'>('qrCtfTag', 'tagId', this.emit);
  readonly captures = new InMemoryRepository<any, 'captureId'>('qrCtfCapture', 'captureId', this.emit);
  readonly respawns = new InMemoryRepository<any, 'respawnId'>('qrCtfRespawn', 'respawnId', this.emit);

  readonly series = new InMemoryTimeSeriesStore(this.emit);
  readonly attachments = new InMemoryAttachmentStore();

  subscribe(listener: (e: ChangeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async batch<R>(fn: (tx: GameStateStore) => Promise<R>): Promise<R> {
    // In-memory ops are synchronous-effect and single-threaded; running fn against `this`
    // is transactionally sufficient (no partial-commit visible across an await boundary
    // to any other caller in a single-process Node event loop model without true
    // concurrency). Not a real rollback — matches doc01's "best-effort atomic" wording.
    return fn(this);
  }

  async init(): Promise<void> {
    // no-op: nothing to load from disk
  }

  async close(): Promise<void> {
    // no-op
  }
}
