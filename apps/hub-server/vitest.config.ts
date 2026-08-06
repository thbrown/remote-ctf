import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // The default 'threads' pool has been observed to hang on real socket.io/WebSocket
    // round-trips in WsGateway.test.ts (reproduces reliably in-process, but the identical
    // client/server code runs fine as a plain Node script outside vitest's worker threads).
    // 'forks' gives each test file a real child process, matching plain-Node behavior.
    pool: 'forks',
  },
});
