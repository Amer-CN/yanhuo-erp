import { defineConfig } from 'vitest/config';

/**
 * 性能基准专用配置（`pnpm perf`）：只收 `tests/perf` 目录下的 `*.perf.ts`。
 * 与 `vitest.config.ts` 分开，避免每次 `pnpm test` 都跑 4 秒采样、
 * 也避免基准的时间数字混进功能回归日志。
 */
export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts']
  }
});