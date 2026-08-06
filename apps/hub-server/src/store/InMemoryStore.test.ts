import { InMemoryStore } from './InMemoryStore.js';
import { runGameStateStoreContractTests } from './contractTests.js';

runGameStateStoreContractTests('InMemoryStore', async () => new InMemoryStore());
