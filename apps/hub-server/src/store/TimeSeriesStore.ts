/**
 * doc01 §5.2. Palantir Lohi embedded does not sync time series, so series persist
 * separately from object state via this interface — reusable later by an OSDK sync job,
 * hence the cursor bookkeeping rather than plain append/read.
 */
import type { EpochMs, SeriesId } from '@foundry-ctf/shared';
import type { OntologyTypeName } from '@foundry-ctf/shared';

export type SeriesValue = number | boolean | string;
export interface SeriesPoint<V extends SeriesValue = SeriesValue> {
  t: EpochMs;
  v: V;
}

export interface SeriesMeta {
  seriesId: SeriesId;
  ownerType: OntologyTypeName;
  ownerId: string;
  property: string;
  valueType: 'double' | 'boolean' | 'string' | 'int';
  unit?: string;
  createdAt: EpochMs;
}

export interface TimeSeriesStore {
  createSeries(meta: Omit<SeriesMeta, 'seriesId' | 'createdAt'>): Promise<SeriesId>;
  getMeta(seriesId: SeriesId): Promise<SeriesMeta | null>;
  listSeries(f?: Partial<Pick<SeriesMeta, 'ownerType' | 'ownerId' | 'property'>>): Promise<SeriesMeta[]>;

  /** Append-only. MUST reject t older than the last point (HUB-061). */
  append<V extends SeriesValue>(id: SeriesId, p: SeriesPoint<V>): Promise<void>;
  appendMany<V extends SeriesValue>(id: SeriesId, ps: SeriesPoint<V>[]): Promise<void>;

  latest<V extends SeriesValue>(id: SeriesId): Promise<SeriesPoint<V> | null>;
  range<V extends SeriesValue>(id: SeriesId, fromMs: EpochMs, toMs: EpochMs): Promise<SeriesPoint<V>[]>;

  // --- Foundry / OSDK sync support: unused in v1, required by design ---
  readUnsynced(id: SeriesId, chunkSize?: number): AsyncIterable<SeriesPoint[]>;
  getSyncCursor(id: SeriesId): Promise<EpochMs | null>;
  setSyncCursor(id: SeriesId, throughMs: EpochMs): Promise<void>;
}

export class OutOfOrderAppendError extends Error {
  constructor(seriesId: SeriesId, attempted: EpochMs, lastT: EpochMs) {
    super(`append to series ${seriesId} rejected: t=${attempted} < lastT=${lastT}`);
    this.name = 'OutOfOrderAppendError';
  }
}
