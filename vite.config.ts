import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { execFileSync } from 'node:child_process';
import { env } from 'node:process';
import { version } from './package.json';

function buildId(command: string): string {
  if (command === 'serve') return 'dev';
  if (env.VITE_BUILD_ID?.trim()) return env.VITE_BUILD_ID.trim();
  if (/^[0-9a-f]{7,40}$/i.test(env.GITHUB_SHA ?? '')) return env.GITHUB_SHA!.slice(0, 8);
  try {
    const git = (args: string[]) =>
      execFileSync('git', args, {
        encoding: 'utf8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore']
      }).trim();
    const sha = git(['rev-parse', '--short=8', 'HEAD']);
    const dirty = git(['status', '--porcelain', '--untracked-files=normal']) ? '-dirty' : '';
    return `${sha}${dirty}`;
  } catch {
    return `v${version}`;
  }
}

export default defineConfig(({ command }) => ({
  base: './',
  /*
   * Dexie 的官方入口 import-wrapper.mjs 固定转出 dist/dexie.js（ES5 UMD）；
   * 本应用只跑在现代浏览器 / PWA 环境，改指现代 ES 构建后 API 不变，
   * 打包产物少约 13KB（gzip -2.5KB），并省掉 ES5 降级代码的解析执行。
   * 见 .perf/ 的基线测量与 resolve-profile 归因（Dexie 是首屏最大单模块）。
   */
  resolve: {
    alias: [{ find: /^dexie$/, replacement: 'dexie/dist/modern/dexie.min.mjs' }]
  },
  define: { __APP_BUILD__: JSON.stringify(buildId(command)) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'prompt',
      includeAssets: ['icon-192.png', 'icon-512.png', 'apple-touch-icon.png'],
      manifest: {
        name: '烟花进销存',
        short_name: '烟花账',
        description: '摊位开单、库存、日结，断网可用',
        theme_color: '#070a10',
        background_color: '#070a10',
        lang: 'zh-CN',
        display: 'standalone',
        orientation: 'portrait',
        start_url: './',
        scope: './',
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,ico}']
      },
      devOptions: { enabled: false }
    })
  ],
  server: {
    // 默认只监听本机；真机联调需要局域网时临时 `pnpm dev --host` 覆盖，用完即关
    host: '127.0.0.1',
    port: 5173,
    watch: {
      ignored: ['**/*.tmpdir/**', '**/*.tmp', '**/.git/**', '**/dist/**']
    }
  }
}));
