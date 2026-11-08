# ADR 0005：v1 收银死代码的保留与最终删除

- Status: Accepted（已执行）
- Date: 2026-11-08

## Context

v2 场次记账上线时，`SellPage` + `repo.checkout` 作为 v1 回滚保险被保留，标注 `@deprecated`。后来确认 `SellPage` 已不在任何路由/懒加载入口中，所谓回滚保险打不开，只剩死代码与两套写入实现。

## Decision

删除 `src/ui/pages/SellPage.tsx`、`repo.ts` 的 `checkout`/`CheckoutInput`/`CartLineInput`；保留 `saveRecord`（`RecordEditor` 唯一写入口）。需要回滚时用 git tag + 可回滚的 Pages 部署，而不是把旧页面藏在代码里。

## Consequences

- 正面：只剩一条写入路径；删除约 680 行死代码；认知负担下降。
- 代价：没有页面级回滚按钮；回滚依赖 git 历史与部署（见运维手册第 8 节）。
- 约束：不得删除 `saveRecord`；`checkout-dock` 是当前样式类，与旧 `checkout()` 无关。