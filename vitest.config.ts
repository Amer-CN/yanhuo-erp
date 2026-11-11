import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 通配 .tsx：将来新增组件测试不会被「找不到文件即视为通过」静默跳过。
    // 需要 DOM 的文件自己在首行加 `// @vitest-environment jsdom`，不必全局切环境。
    include: ['tests/**/*.test.{ts,tsx}'],
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
        branches: 50,
        // 同步/一致性是最危险的区域，全局阈值对它的保护等于没有（2026-11-10 实测 68%）。
        // 补齐入站回归锁后实测 78.4%，取 75 留 3.4pt 缓冲：
        // 任何把删除级联 / 冲突落库 / pending 跳过 / 推送失败保留 打回未覆盖的改动都会在这里变红。
        'src/db/sync.ts': {
          lines: 75
        }
      }
    }
  }
});