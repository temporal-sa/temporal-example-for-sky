import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Scenarios wait on real Activity retries (1s, 2s, 4s backoff), so allow for those.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
