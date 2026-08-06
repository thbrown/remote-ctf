import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import { FileSystemStore } from './FileSystemStore.js';
import { runGameStateStoreContractTests } from './contractTests.js';

const tmpDirs: string[] = [];

runGameStateStoreContractTests('FileSystemStore', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'foundry-ctf-fs-store-'));
  tmpDirs.push(dir);
  return new FileSystemStore(dir);
});

afterAll(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});
