/**
 * HUB-202: one contract test suite that must run against every GameStateStore
 * implementation, so LohiStore can later be validated against identical expectations.
 * Call `runGameStateStoreContractTests` from a per-implementation *.test.ts file.
 */
import { describe, expect, it } from 'vitest';
import type { ChangeEvent, GameStateStore } from './GameStateStore.js';
import { OutOfOrderAppendError } from './TimeSeriesStore.js';

export function runGameStateStoreContractTests(name: string, makeStore: () => Promise<GameStateStore>) {
  describe(`GameStateStore contract: ${name}`, () => {
    it('create/get/list/update/delete round-trip on a repository', async () => {
      const store = await makeStore();
      await store.init();

      const team = await store.teams.create({
        teamId: 't1',
        teamName: 'Test Team',
        hexColor: '#123456',
        score: 0,
        totalTagsInflicted: 0,
        totalTagsReceived: 0,
      });
      expect(team.teamName).toBe('Test Team');

      const fetched = await store.teams.get('t1');
      expect(fetched).toEqual(team);

      const listed = await store.teams.list();
      expect(listed).toHaveLength(1);

      const updated = await store.teams.update('t1', { score: 0.5 });
      expect(updated.score).toBe(0.5);
      // unrelated fields unchanged
      expect(updated.teamName).toBe('Test Team');

      await store.teams.delete('t1');
      expect(await store.teams.get('t1')).toBeNull();

      await store.close();
    });

    it('update patch: absent key unchanged, null clears (HUB-052)', async () => {
      const store = await makeStore();
      await store.init();

      await store.controlPoints.create({
        controlPointId: 'cp1',
        controlPointName: 'CP One',
        stationId: 's1',
        currentOwnerTeamId: 't1',
        capturingPlayerId: 'p1',
        captureProgress: 0.5,
        isHumanDetected: true,
        locationLat: 1,
        locationLong: 2,
        macAddress: 'AA:BB:CC:DD:EE:FF',
      });

      const patched = await store.controlPoints.update('cp1', { capturingPlayerId: null });
      expect(patched.capturingPlayerId).toBeNull();
      // absent keys stay put
      expect(patched.currentOwnerTeamId).toBe('t1');
      expect(patched.controlPointName).toBe('CP One');

      await store.close();
    });

    it('get/update/delete on a missing id behaves per contract', async () => {
      const store = await makeStore();
      await store.init();

      expect(await store.teams.get('nope')).toBeNull();
      await expect(store.teams.update('nope', { score: 1 })).rejects.toThrow();
      await expect(store.teams.delete('nope')).resolves.toBeUndefined(); // idempotent delete

      await store.close();
    });

    it('emits a change feed for create/update/delete (HUB-054)', async () => {
      const store = await makeStore();
      await store.init();

      const events: ChangeEvent[] = [];
      const unsubscribe = store.subscribe((e) => events.push(e));

      await store.teams.create({
        teamId: 't2',
        teamName: 'Feed Team',
        hexColor: '#000000',
        score: 0,
        totalTagsInflicted: 0,
        totalTagsReceived: 0,
      });
      await store.teams.update('t2', { score: 1 });
      await store.teams.delete('t2');

      expect(events.map((e) => e.kind)).toEqual(['created', 'updated', 'deleted']);

      unsubscribe();
      await store.teams.create({
        teamId: 't3',
        teamName: 'After unsub',
        hexColor: '#000000',
        score: 0,
        totalTagsInflicted: 0,
        totalTagsReceived: 0,
      });
      expect(events).toHaveLength(3); // no new events after unsubscribe

      await store.close();
    });

    it('series: append/latest/range and out-of-order rejection', async () => {
      const store = await makeStore();
      await store.init();

      const seriesId = await store.series.createSeries({
        ownerType: 'qrCtfTeamSession',
        ownerId: 'ts1',
        property: 'score',
        valueType: 'double',
      });

      await store.series.append(seriesId, { t: 100, v: 0.1 });
      await store.series.append(seriesId, { t: 200, v: 0.2 });

      expect(await store.series.latest(seriesId)).toEqual({ t: 200, v: 0.2 });
      expect(await store.series.range(seriesId, 0, 150)).toEqual([{ t: 100, v: 0.1 }]);

      await expect(store.series.append(seriesId, { t: 50, v: 0.05 })).rejects.toBeInstanceOf(
        OutOfOrderAppendError,
      );

      await store.close();
    });

    it('series: sync cursor bookkeeping', async () => {
      const store = await makeStore();
      await store.init();

      const seriesId = await store.series.createSeries({
        ownerType: 'qrCtfPlayerSession',
        ownerId: 'ps1',
        property: 'locationLat',
        valueType: 'double',
      });
      await store.series.append(seriesId, { t: 1, v: 10 });
      await store.series.append(seriesId, { t: 2, v: 20 });

      expect(await store.series.getSyncCursor(seriesId)).toBeNull();

      const chunks: unknown[][] = [];
      for await (const chunk of store.series.readUnsynced(seriesId, 1)) chunks.push(chunk);
      expect(chunks).toEqual([[{ t: 1, v: 10 }], [{ t: 2, v: 20 }]]);

      await store.series.setSyncCursor(seriesId, 1);
      expect(await store.series.getSyncCursor(seriesId)).toBe(1);

      const remaining: unknown[][] = [];
      for await (const chunk of store.series.readUnsynced(seriesId, 10)) remaining.push(chunk);
      expect(remaining).toEqual([[{ t: 2, v: 20 }]]);

      await store.close();
    });

    it('attachments: put + getUrl, rejects oversized blobs (HUB-067)', async () => {
      const store = await makeStore();
      await store.init();

      const small = new Uint8Array(1024);
      const ref = await store.attachments.put(small, 'image/jpeg');
      const url = await store.attachments.getUrl(ref);
      expect(typeof url).toBe('string');

      const big = new Uint8Array(64 * 1024 + 1);
      await expect(store.attachments.put(big, 'image/jpeg')).rejects.toThrow();

      await store.close();
    });

    it('batch runs the callback against a store handle', async () => {
      const store = await makeStore();
      await store.init();

      const result = await store.batch(async (tx) => {
        await tx.teams.create({
          teamId: 'tb1',
          teamName: 'Batch Team',
          hexColor: '#ABCDEF',
          score: 0,
          totalTagsInflicted: 0,
          totalTagsReceived: 0,
        });
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(await store.teams.get('tb1')).not.toBeNull();

      await store.close();
    });
  });
}
