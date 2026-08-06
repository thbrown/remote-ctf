/**
 * HUB-060: each series is append-only NDJSON at data/series/<seriesId>.ndjson. Metadata in
 * data/series/index.json, cursors in data/series/cursors.json.
 */
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { SeriesMeta, SeriesPoint, SeriesValue, TimeSeriesStore } from './TimeSeriesStore.js';
import { OutOfOrderAppendError } from './TimeSeriesStore.js';
import { atomicWriteJson, readJsonOrDefault } from './fsUtil.js';
import type { ChangeEvent } from './GameStateStore.js';

type Emit = (e: ChangeEvent) => void;

export class FileSystemTimeSeriesStore implements TimeSeriesStore {
  private readonly seriesDir: string;
  private readonly indexPath: string;
  private readonly cursorsPath: string;

  private meta = new Map<string, SeriesMeta>();
  private cursors = new Map<string, number>();
  /** Cache of last-appended point per series, so `latest()` avoids a disk read on the hot
   * path (scoring tick is 1 Hz across every team, ownerHistory on every capture event). */
  private lastPoint = new Map<string, SeriesPoint>();

  constructor(dataDir: string, private readonly emit: Emit) {
    this.seriesDir = join(dataDir, 'series');
    this.indexPath = join(this.seriesDir, 'index.json');
    this.cursorsPath = join(this.seriesDir, 'cursors.json');
  }

  async load(): Promise<void> {
    await mkdir(this.seriesDir, { recursive: true });
    const metaList = await readJsonOrDefault<SeriesMeta[]>(this.indexPath, []);
    this.meta = new Map(metaList.map((m) => [m.seriesId, m]));
    const cursorEntries = await readJsonOrDefault<Record<string, number>>(this.cursorsPath, {});
    this.cursors = new Map(Object.entries(cursorEntries));

    for (const seriesId of this.meta.keys()) {
      const points = await this.readAll(seriesId);
      if (points.length > 0) this.lastPoint.set(seriesId, points[points.length - 1]);
    }
  }

  private ndjsonPath(seriesId: string): string {
    return join(this.seriesDir, `${seriesId}.ndjson`);
  }

  private async readAll(seriesId: string): Promise<SeriesPoint[]> {
    try {
      const raw = await readFile(this.ndjsonPath(seriesId), 'utf8');
      return raw
        .split('\n')
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as SeriesPoint);
    } catch (err: any) {
      if (err?.code === 'ENOENT') return [];
      throw err;
    }
  }

  private async persistIndex(): Promise<void> {
    await atomicWriteJson(this.indexPath, [...this.meta.values()]);
  }

  private async persistCursors(): Promise<void> {
    await atomicWriteJson(this.cursorsPath, Object.fromEntries(this.cursors.entries()));
  }

  async createSeries(m: Omit<SeriesMeta, 'seriesId' | 'createdAt'>): Promise<string> {
    const seriesId = randomUUID();
    this.meta.set(seriesId, { ...m, seriesId, createdAt: Date.now() });
    await mkdir(this.seriesDir, { recursive: true });
    await appendFile(this.ndjsonPath(seriesId), '', 'utf8'); // ensure file exists
    await this.persistIndex();
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
    if (!this.meta.has(id)) throw new Error(`series ${id} not found`);
    const last = this.lastPoint.get(id);
    if (last && p.t < last.t) throw new OutOfOrderAppendError(id, p.t, last.t);
    await appendFile(this.ndjsonPath(id), JSON.stringify(p) + '\n', 'utf8');
    this.lastPoint.set(id, p);
    this.emit({ kind: 'appended', type: 'series', seriesId: id, point: p });
  }

  async appendMany<V extends SeriesValue>(id: string, ps: SeriesPoint<V>[]): Promise<void> {
    for (const p of ps) await this.append(id, p);
  }

  async latest<V extends SeriesValue>(id: string): Promise<SeriesPoint<V> | null> {
    return (this.lastPoint.get(id) as SeriesPoint<V>) ?? null;
  }

  async range<V extends SeriesValue>(id: string, fromMs: number, toMs: number): Promise<SeriesPoint<V>[]> {
    const all = await this.readAll(id);
    return all.filter((p) => p.t >= fromMs && p.t <= toMs) as SeriesPoint<V>[];
  }

  async *readUnsynced(id: string, chunkSize = 100): AsyncIterable<SeriesPoint[]> {
    const cursor = this.cursors.get(id) ?? -Infinity;
    const all = (await this.readAll(id)).filter((p) => p.t > cursor);
    for (let i = 0; i < all.length; i += chunkSize) {
      yield all.slice(i, i + chunkSize);
    }
  }

  async getSyncCursor(id: string): Promise<number | null> {
    return this.cursors.get(id) ?? null;
  }

  async setSyncCursor(id: string, throughMs: number): Promise<void> {
    this.cursors.set(id, throughMs);
    await this.persistCursors();
  }
}
