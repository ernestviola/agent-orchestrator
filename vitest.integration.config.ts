import { defineConfig } from 'vitest/config';

// Integration tests drive real Docker (build the sandbox image first:
// `npm run sandbox:build`). Run with `npm run test:integration`.
// Kept separate from the default config so `npm test` never touches Docker.
export default defineConfig({
  test: {
    include: ['tests/**/*.integration.test.ts'],
    // Real containers start/stop/pull — give each test room.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
