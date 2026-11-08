# 烟花进销存（F:\AIXM\烟花爆竹）

自用烟花摊进销存 PWA：两个人、两台手机，摊位断网也能开单，联网自动同步。

## 线上

- 应用：<https://amer-cn.github.io/yanhuo-erp/>
- 仓库：<https://github.com/Amer-CN/yanhuo-erp>（push 到 main 自动测试 + 部署）
- 云同步：Supabase（publishable key + 内置同步码，默认开启，见 `docs/03-云同步设置.md`）

## 命令

```bash
pnpm install
pnpm dev      # http://localhost:5173
pnpm build    # tsc --noEmit && vite build
pnpm test     # 12 个核心计算单测
```

端到端（需要 Playwright + Chromium）：

```bash
python scripts/e2e-smoke.py       # 开单/进货/报表/库存
python scripts/e2e-sync.py        # 双设备自动云同步 + 断网补发（默认假 Supabase）
python scripts/e2e-merge.py       # 手动导出/导入合并（先 build + preview）
python scripts/e2e-offline.py     # 断网可用（先 build + preview）
python scripts/a11y-check.py      # 无障碍回归
python scripts/check-default-sync.py  # 零配置会发同步请求（拦截不写库）
```

## 技术栈

React 18 + TypeScript + Vite；Dexie（IndexedDB）；GlassKit 1.40 + lucide-react；vite-plugin-pwa；Supabase（PostgREST + RLS）。

## 目录

- `src/db/`：types / db / repo / calc / merge / outbox / sync / syncDefaults
- `src/ui/pages/`：7 个页面；`src/ui/kit.tsx` 组件；`src/tokens.css` 设计令牌；`src/styles.css` 应用层样式
- `supabase/schema.sql`：云端建表；`docs/`：需求、使用说明、云同步、设计系统
- `scripts/`：E2E 与诊断脚本

## 约定 / 红线

1. 本地优先：写入先落 IndexedDB + outbox，联网再同步；断网不得阻断开单。
2. 不复制金蝶反编译代码 / DLL（只借字段语义）。
3. 不在 `E:\测试` 干活；不删 `E:\测试\.work\rea-full` 的 `reports/`、`*.jsonl`、`tools/`。
4. 跨盘引用写绝对路径。
5. 测试脚本默认 `localStorage['yh-sync-disabled']='1'`，别让测试数据写真实账本。

## 当前状态

已上线，并通过真实 Supabase 双设备同步 / 断网补发验证；下一步：真机摊位试用（M6）。