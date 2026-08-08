import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { FileSystemStore } from './FileSystemStore.js';
import { runGameStateStoreContractTests } from './contractTests.js';

const tmpDirs: string[] = [];

runGameStateStoreContractTests('FileSystemStore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-ctf-fs-store-'));
  tmpDirs.push(dir);
  return new FileSystemStore(dir);
});

// The contract suite only ever exercises a live store instance, so nothing covered the
// NDJSON actually surviving a process restart - which is the whole point of persisting it,
// and what the post-game export reads back.
describe('FileSystemTimeSeriesStore persistence', () => {
  it('reloads series metadata, points and the lastPoint cache from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'foundry-ctf-fs-series-'));
    tmpDirs.push(dir);

    const first = new FileSystemStore(dir);
    await first.init();
    const seriesId = await first.series.createSeries({
      ownerType: 'qrCtfPlayerSession',
      ownerId: 'p-1',
      property: 'locationLat',
      valueType: 'double',
    });
    await first.series.append(seriesId, { t: 1000, v: 51.5 });
    await first.series.append(seriesId, { t: 2000, v: 51.6 });
    await first.close();

    const second = new FileSystemStore(dir);
    await second.init();

    expect((await second.series.getMeta(seriesId))?.property).toBe('locationLat');
    expect(await second.series.range(seriesId, 0, 5000)).toEqual([
      { t: 1000, v: 51.5 },
      { t: 2000, v: 51.6 },
    ]);
    // lastPoint must be rehydrated, or out-of-order protection silently lapses after a restart.
    expect(await second.series.latest(seriesId)).toEqual({ t: 2000, v: 51.6 });
    await expect(second.series.append(seriesId, { t: 500, v: 0 })).rejects.toThrow();
    await second.close();
  });
});

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});
