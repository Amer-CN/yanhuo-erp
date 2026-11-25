# Cross-Module Ledger Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Eliminate cross-module ledger corruption risks around manual merge, recovery, sync undo, and real E2E cleanup while preserving offline writes and legacy backup readability.

**Architecture:** Keep React/Dexie/PostgREST. Introduce a pure merge planner shared by preview and commit, split sync lease generation from data generation, persist pre-merge snapshots and undo pointers, and make E2E cleanup state resumable without storing credentials.

**Tech Stack:** TypeScript, Dexie, Vitest + fake-indexeddb, Python unittest, urllib, Supabase PostgREST.

**Spec:** `docs/superpowers/specs/2026-11-26-cross-module-ledger-hardening-design.md`

## Global Constraints

- Local-first writes remain available while sync is paused; only maintenance or stale data generations reject a command.
- Business writes, outbox entries, merge metadata, conflict/pending cleanup, and summary updates remain in one Dexie transaction where specified.
- Same-ID order divergence defaults to local; only an explicit `incoming` choice may replace a complete group.
- Never guess completeness for a same-ID legacy backup without `lineIds`.
- Test defaults keep cloud sync disabled; real E2E must use run-scoped test ledgers and never the built-in ledger.
- Do not run production SQL, touch a real ledger, push, or deploy.

## Review Focus

- A remote pending line excluded by an imported complete manifest must never reappear after the next sync.
- A closed session changed by merge must show the same summary on the home screen and report page.
- An undo intent created before recovery must fail after recovery instead of restoring stale data.
- A malformed or empty modern order manifest must reject the whole import before any table changes.
- A lost E2E cleanup response must retry the same ledger and operationId, and cleanup failure must not replace the original test exception.

---

### Task 1: Plan and Validate Order Merges Explicitly

**Files:**
- Modify: `src/db/merge.ts`
- Test: `tests/merge.test.ts`

**Interfaces:**
- Export `OrderMergeChoice = 'local' | 'incoming'`.
- Export `OrderMergeChanges`, `OrderMergePlanOptions`, and `planOrderMerge(existingOrders, existingLines, incomingOrders, incomingLines, options?)`.
- `OrderMergePlanOptions` contains `choices?: Record<string, OrderMergeChoice>` and `validProductIds?: ReadonlySet<string>`.
- Keep `importMerge` behavior compatible until Task 2 supplies the transaction integration.

- [x] **Step 1: Add failing validation and explicit-choice tests**
  Assert empty manifest, negative quantity/amount, invalid timestamp, missing product reference, duplicate incoming line IDs, and same-ID orphan lines reject or conflict before mutation. Assert divergent complete same-ID orders default local and only `{ [id]: 'incoming' }` replaces the group.
- [x] **Step 2: Run merge tests and verify RED**
  Run: `pnpm exec vitest run tests/merge.test.ts`
  Expected: new contract tests fail on current timestamp auto-winner/validation gaps.
- [x] **Step 3: Implement pure planner and validation**
  Add `choices` handling, `changes` output, strict modern-manifest validation, and product-reference validation against existing plus incoming products. Preserve legacy new-order import and legacy same-ID local retention.
- [x] **Step 4: Run merge tests and type-check**
  Run: `pnpm exec vitest run tests/merge.test.ts && pnpm exec tsc --noEmit`
  Expected: all pass.

### Task 2: Make Merge Transaction Consistent With Sync and Summaries

**Files:**
- Modify: `src/db/merge.ts`
- Test: `tests/merge.test.ts`
- Test: `tests/data-recovery.test.ts`

**Interfaces:**
- `importMerge(backup, options?: { orderChoices?: Record<string, OrderMergeChoice> })`.
- Extend `MergeResult` with `linesUpdated`, `summariesUpdated`, `pendingLinesRemoved`, `conflictsCleared`.
- Include `db.conflicts`, `db.remotePendingLines`, `db.remoteOrderUndo` in the merge transaction.

- [x] **Step 1: Write failing cross-module merge tests**
  Seed a pending remote line for an imported order, a stale conflict, and a remote undo row; import a complete group; assert all three are removed and old-line tombstones/upserts remain. Seed a closed session with stale summary; assert merge recalculates it from final data.
- [x] **Step 2: Run tests and verify RED**
  Run: `pnpm exec vitest run tests/merge.test.ts tests/data-recovery.test.ts`
  Expected: pending/conflict/undo cleanup and summary tests fail.
- [x] **Step 3: Implement transaction cleanup and summary recalculation**
  Clear affected pending/undo rows and changed-record conflicts inside the same transaction; recompute affected closed summaries from final orders/lines/batches and enqueue changed sessions.
- [x] **Step 4: Run tests and type-check**
  Run: `pnpm exec vitest run tests/merge.test.ts tests/data-recovery.test.ts && pnpm exec tsc --noEmit`
  Expected: all pass.

### Task 3: Split Data Generation and Reject Stale Undo

**Files:**
- Modify: `src/db/syncTypes.ts`
- Modify: `src/db/syncControl.ts`
- Modify: `src/db/repo.ts`
- Modify: `src/db/sync.ts`
- Modify: `src/ui/useSync.ts`
- Test: `tests/sync-control.test.ts`
- Test: `tests/data-recovery.test.ts`
- Test: `tests/remote-order-undo.test.ts`
- Test: `tests/sync-reconcile.test.ts`

**Interfaces:**
- Add `dataGeneration: number` to `SyncControlRow`; old rows default to `0`.
- `pause/resume` increment only `generation`; maintenance increments both.
- Add optional `dataGeneration` to `RemoteChange`; `restoreLocalSnapshot`, `dropLocalRecord`, and `adoptRemoteConflict` validate the captured generation when present.
- `updateProduct/updateRecord/voidOrder/restoreOrder` accept and propagate optional expected data generation for undo call sites.

- [x] **Step 1: Write failing pause and stale-undo tests**
  Assert a write captured before ordinary pause still commits. Assert a remote product/order undo created before recovery rejects after recovery; assert current-generation undo still works.
- [x] **Step 2: Run targeted tests and verify RED**
  Run: `pnpm exec vitest run tests/sync-control.test.ts tests/data-recovery.test.ts tests/remote-order-undo.test.ts tests/sync-reconcile.test.ts`
  Expected: pause test fails due generation coupling; stale undo tests fail because no data-generation guard exists.
- [x] **Step 3: Implement split generation and undo guards**
  Add `dataGeneration`, update maintenance/pause semantics, capture it on remote changes/conflicts, validate inside write transactions, and clear stale remote-change UI on config/recovery events.
- [x] **Step 4: Run targeted tests and type-check**
  Run: `pnpm exec vitest run tests/sync-control.test.ts tests/data-recovery.test.ts tests/remote-order-undo.test.ts tests/sync-reconcile.test.ts tests/repo.test.ts && pnpm exec tsc --noEmit`
  Expected: all pass.

### Task 4: Make Destructive Merge Previewable and Recoverable

**Files:**
- Modify: `src/db/merge.ts`
- Modify: `src/db/backup.ts`
- Modify: `src/db/types.ts`
- Modify: `src/db/outbox.ts`
- Modify: `src/ui/pages/SettingsPage.tsx`
- Test: `tests/merge.test.ts`
- Test: `tests/backup.test.ts`

**Interfaces:**
- Add `SnapshotReason = 'pre-merge'`; pruning retains the newest pre-merge snapshot.
- Add `SETTING_KEYS.mergeUndoSnapshotId`; keep it local-only.
- `importMerge` options gain `undoSnapshotId?: number`; writes `lastImportAt` and the undo pointer in the same transaction.
- `PendingMerge` carries `orderChoices` and `orderChanges`; preview renders local/incoming controls.
- `exportBackup` sets an explicit complete-order-manifest capability marker while remaining backward readable.

- [x] **Step 1: Write failing snapshot/metadata/preview-plan tests**
  Assert pre-merge snapshots survive pruning, merge metadata commits atomically, and the planner exposes user-visible order changes. Add a UI helper test for choice state if needed.
- [x] **Step 2: Run tests and verify RED**
  Run: `pnpm exec vitest run tests/merge.test.ts tests/backup.test.ts`
  Expected: new snapshot/metadata/plan-output tests fail.
- [x] **Step 3: Implement persistent snapshot, atomic metadata, and preview model**
  Add the snapshot reason/pointer, atomic settings write, capability marker, and order-change preview data. Update SettingsPage to always persist a pre-merge snapshot, render explicit choices, and remove post-commit `setSetting`.
- [x] **Step 4: Run tests, type-check, and lint**
  Run: `pnpm exec vitest run tests/merge.test.ts tests/backup.test.ts && pnpm exec tsc --noEmit && pnpm lint`
  Expected: tests pass, no new lint errors/warnings.

### Task 5: Make Real E2E Cleanup Resumable

**Files:**
- Modify: `scripts/e2e_sync_cleanup.py`
- Modify: `scripts/e2e-sync.py`
- Modify: `tests/test_e2e_sync_cleanup.py`
- Modify: `docs/08-运维手册.md`

**Interfaces:**
- Add `load_or_create_run(path, base_ledger, url) -> dict`, `save_run(path, run)`, `clear_run(path, run, url, key, opener=urlopen) -> dict`.
- Run file contains `baseLedger`, `url`, `ledger`, `operationId`, `createdAt`; never the key.
- `clear_run` retries transient failures with the same operationId and validates the receipt.
- JWT-like keys add `Authorization: Bearer`.

- [x] **Step 1: Write failing cleanup persistence/retry tests**
  Assert run reuse, no key persistence, same-operation retry after timeout/5xx, JWT auth header, malformed receipt failure, and original exception preservation helper behavior.
- [x] **Step 2: Run Python tests and verify RED**
  Run: `python -m unittest tests.test_e2e_sync_cleanup -v`
  Expected: missing persistence/retry interfaces fail.
- [x] **Step 3: Implement resumable cleanup and script integration**
  Move script-entry testing into the helper module, persist run state under Temp, resolve previous run before a new run, retry same operationId, and preserve the primary browser/test exception.
- [x] **Step 4: Run Python safety tests**
  Run: `python -m unittest tests.test_e2e_sync_cleanup tests.test_e2e_sync_guard -v`
  Expected: all pass without network.

### Task 6: Remove Report Drift and Align Documentation

**Files:**
- Modify: `src/db/calc.ts`
- Modify: `docs/01-需求与设计.md`
- Modify: `docs/03-云同步设置.md`
- Modify: `docs/08-运维手册.md`
- Modify: `docs/superpowers/specs/2026-11-26-cross-module-ledger-hardening-design.md`
- Test: `tests/session-reports.test.ts`
- Test: `tests/calc.test.ts`

**Interfaces:**
- Extract shared report accumulation helpers used by both `sessionReport` and `sessionReports`.
- Document explicit same-ID order choice, persistent pre-merge snapshot, data-generation behavior, and E2E run-file retention/retry.

- [x] **Step 1: Add equivalence coverage for mixed legacy/voided/gift lines**
  Assert every field matches between single and batch paths across a broader mixed fixture.
- [x] **Step 2: Run report tests**
  Run: `pnpm exec vitest run tests/session-reports.test.ts tests/calc.test.ts`
  Expected: pass before and after refactor.
- [x] **Step 3: Extract shared accumulation and update docs**
  Use one helper for order payment, line cost/discount/gift, voided totals, and gross finalization; update current behavior docs without rewriting historical plans.
- [x] **Step 4: Run report tests and type-check**
  Run: `pnpm exec vitest run tests/session-reports.test.ts tests/calc.test.ts && pnpm exec tsc --noEmit`
  Expected: all pass.

### Task 7: Full Verification and Review

**Files:** all modified files from Tasks 1–6.

- [x] **Step 1: Run full unit and Python suites**
  Run: `pnpm test` and `python -m unittest discover -s tests -p 'test*.py'`.
  Expected: all pass with no new skip.
- [x] **Step 2: Run static checks and production build**
  Run: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`, `git diff --check`.
  Expected: commands exit 0; no new lint warnings.
- [x] **Step 3: Review final diff against spec**
  Check transaction scopes, planner/preview parity, legacy behavior, generation semantics, cleanup credential handling, and absence of production/network side effects.
- [x] **Step 4: Complete independent review and fix Critical/Important findings**
  The fresh reviewer found 2 Critical and 3 Important issues. All were fixed with targeted RED→GREEN regressions, the reviewer was asked to re-check the fixes, and full gates were rerun.
