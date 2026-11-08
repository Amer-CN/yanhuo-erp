import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/db/**/*.ts'],
      exclude: ['src/db/types.ts', 'src/db/seed.ts'],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 50
      }
    }
  }
});