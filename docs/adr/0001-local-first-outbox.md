# ADR 0001：本地优先 + 发件箱

- Status: Accepted
- Date: 2026-11-08

## Context

摊位经常断网，但开单不能等网络。账本是唯一不可再生资产，云同步只能作为副本与合并通道，不能作为写入前置条件。

## Decision

所有业务写入先落 IndexedDB（`yanhuo-erp`），同一操作登记到 `outbox`（`kind:recordId`），再由 `useSync` 在联网/前台/写入后 0.7s/每 10s 尝试推送；断网期间只积累 outbox，恢复网络后补发。

## Consequences

- 正面：断网照常开单；E2E `e2e-offline` 验证了离线刷新与离线记单。
- 代价：云端不是实时强一致；发件箱按记录去重，只保留最后状态，中间编辑顺序不可追溯。
- 约束：新增业务写入必须同时入 outbox，否则该记录不会同步。