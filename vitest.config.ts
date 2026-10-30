import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // INDEX_TREES=0 runs the suites with the index trees dropped (test/setup.ts).
    setupFiles: ['test/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
    // Nodes in one test share timers and the event loop; keep files sequential.
    fileParallelism: false,
  },
});
