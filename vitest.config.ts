import { defineConfig } from 'vitest/config';

// Own config, so tests don't pick up the interface's Vite root and API server.
export default defineConfig({
  test: { include: ['tests/**/*.test.ts'] },
});
