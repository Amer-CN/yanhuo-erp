# Audit Contract Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Fix the four reproduced ledger/report/E2E contract defects with regression tests while preserving offline writes and old backup compatibility.

**Architecture:** Keep the current React/Dexie/PostgREST design. Add a generation fence to read-then-write business commands, merge modern orders as complete aggregates with explicit legacy/conflict outcomes, align batch reporting defaults, and make real E2E cleanup use a per-run ledger plus the existing clear RPC.

**Tech Stack:** TypeScript, Dexie, Vitest + fake-indexeddb, Python unittest, urllib, Supabase PostgREST.

**Spec:** `docs/superpowers/specs/2026-11-25-audit-contract-repairs-design.md`

## Global Constraints

- Local-first writes remain available while sync is paused; only maintenance or stale generations reject a command.
- Business write and outbox enqueue remain in one Dexie transaction including `syncMeta`.
- Order `lineIds` is the complete manifest when present; do not guess completeness for a same-ID legacy backup.
- Preserve same-ID idempotence for non-order immutable ledgers and preserve tombstone semantics.
- Test defaults keep cloud sync disabled; real-mode E2E must use a run-scoped test ledger and never use the built-in ledger.
- Do not run production SQL, touch a real ledger, push, or deploy.

## Review Focus

- A command that read an old order before recovery must fail after recovery without restoring the order or creating outbox rows; cover in Task 1.
- Recovery starting after a valid write fence must serialize against the same transaction and retain the committed write in its snapshot; cover in Task 1.
- Complete order manifests with a missing/extra/duplicate line or incorrect total must reject atomically; cover in Task 2.
- Legacy same-ID orders without a manifest must not gain extra lines during merge; cover in Task 2.
- Missing `discountFen` must produce the same finite report in single and batch paths; cover in Task 3.
- Real cleanup HTTP failures or mismatched receipts must fail closed; cover in Task 4.

---

### Task 1: Fence Stale Business Writes Across Recovery

**Files:**
- Modify: `src/db/syncControl.ts`
- Modify: `src/db/repo.ts`
- Test: `tests/repo.test.ts`
- Test: `tests/data-recovery.test.ts`

**Interfaces:**
- Produce `captureWriteGeneration(): Promise<number>` and `assertWriteGeneration(expected: number): Promise<void>` in `syncControl.ts`.
- Require an `expectedGeneration: number` argument on `writeWithOutbox` and all internal read-then-write call sites.
- A generation mismatch uses the existing `SyncGenerationMismatchError`; maintenance continues to use `SyncMaintenanceError`.

- [x] **Step 1: Write a failing race regression**
  Gate the order/lines/outbox/syncMeta write transaction after `updateRecord` has read and built its replacement, restore an empty backup, then release the write. Assert the update rejects, the order remains absent, and outbox remains empty.
- [x] **Step 2: Run the targeted test and verify it fails for the stale write**
  Run: `pnpm exec vitest run tests/repo.test.ts tests/data-recovery.test.ts`
  Expected: the new race test fails because the old update writes after recovery; existing tests pass.
- [x] **Step 3: Add generation capture and in-transaction validation**
  Capture before pre-reads in `ensureBootstrapSettings`, `updateProduct`, `deleteProduct`, `createBatch` follow-up recalculation, `deleteBatch`, `ensureOpenSession`, `saveRecord`, `updateRecord`, `deleteRecord`, `undoPatchedRecord`, `closeSession`, `reopenSession`, `addPatchedRecord`, `refreshSessionSummary`, `writeClosedSummaries`, `migrateSessions`, `voidOrder`, and `restoreOrder`; also pass the captured value through nested repository calls. Simple create/set operations capture immediately before their write. Keep `ensureDeviceId` and `clearAllData` as transaction-internal read/write operations. Pass the captured generation to `writeWithOutbox`; check it inside the same transaction that includes `syncMeta`. Ensure all call sites compile with the required generation argument.
- [x] **Step 4: Run the targeted tests**
  Run: `pnpm exec vitest run tests/repo.test.ts tests/data-recovery.test.ts`
  Expected: all targeted tests pass; the update neither restores data nor enqueues stale rows.
- [x] **Step 5: Verify same-generation offline writes remain allowed**
  Add/retain an assertion that paused-but-not-maintenance state accepts a local business write; run `pnpm exec vitest run tests/repo.test.ts tests/data-recovery.test.ts tests/sync-control.test.ts`.
  Expected: all pass.

### Task 2: Merge Orders as Complete Aggregates

**Files:**
- Modify: `src/db/merge.ts`
- Modify: `src/ui/pages/SettingsPage.tsx`
- Test: `tests/merge.test.ts`

**Interfaces:**
- Extend `MergeResult` with `ordersUpdated`, `ordersKept`, `ordersConflicted`, and `linesRemoved`.
- Add a private order-group planner in `merge.ts`; non-order ledgers keep their current `addOnly` behavior.
- Incoming complete groups are selected by `updatedAt` with `createdAt` fallback; equal-time divergent or incomplete same-ID groups retain local state and increment `ordersConflicted`.

- [x] **Step 1: Add failing full-order replacement and legacy/conflict tests**
  Assert a newer manifest replaces header and child lines together, deletes old line IDs, and emits outbox tombstones/upserts. Add tests that older/equal-time conflicting versions do not append extra children, legacy same-ID data remains local, and malformed manifests leave the whole import unchanged.
- [x] **Step 2: Run merge tests and verify the aggregate regression fails**
  Run: `pnpm exec vitest run tests/merge.test.ts`
  Expected: the new current-order edit/import regression fails by retaining both old and new lines or by lacking conflict reporting.
- [x] **Step 3: Implement manifest validation and group merge**
  Validate unique `lineIds`, exact child membership, and `sum(amountFen) === totalFen` before mutation. Apply the selected header and child set in the existing transaction; enqueue old-line deletes and selected-line upserts in the same transaction.
- [x] **Step 4: Expose merge outcomes in the UI**
  Replace the unconditional “merge only adds” copy with the actual mixed policy; show updated, kept/conflicted order groups and removed lines in the result sheet.
- [x] **Step 5: Run targeted tests and type-check**
  Run: `pnpm exec vitest run tests/merge.test.ts tests/data-recovery.test.ts && pnpm exec tsc --noEmit`
  Expected: all tests pass and the result UI compiles.

### Task 3: Align Batch Report Defaults

**Files:**
- Modify: `src/db/calc.ts`
- Test: `tests/session-reports.test.ts`

- [x] **Step 1: Add a legacy line to the single/batch equivalence test**
  Remove `discountFen` from one non-gift line and assert every field matches between `sessionReport` and `sessionReports`; assert the resulting discount is finite and exactly 0.
- [x] **Step 2: Run the targeted test and verify it fails with `NaN`**
  Run: `pnpm exec vitest run tests/session-reports.test.ts`
  Expected: the batch equivalence assertion fails because `discountFen` becomes `NaN`.
- [x] **Step 3: Apply the same zero default in batch aggregation**
  Use `l.discountFen ?? 0`, matching the single-session and product-margin calculations.
- [x] **Step 4: Run calculation tests**
  Run: `pnpm exec vitest run tests/session-reports.test.ts tests/calc.test.ts`
  Expected: all report/calculation tests pass.

### Task 4: Isolate and Correct Real E2E Cleanup

**Files:**
- Create: `scripts/e2e_sync_cleanup.py`
- Modify: `scripts/e2e-sync.py`
- Test: `tests/test_e2e_sync_cleanup.py`
- Modify: `scripts/e2e-sync.py` module documentation

**Interfaces:**
- `make_run_ledger(base_ledger: str, run_id: str) -> str`
- `build_clear_request(url: str, key: str, ledger: str, operation_id: str) -> urllib.request.Request`
- `validate_clear_receipt(payload: object, operation_id: str) -> None`

- [x] **Step 1: Add failing helper tests**
  Verify run ledger isolation, RPC URL/method/headers/body, operationId receipt validation, and rejection of malformed/mismatched receipt.
- [x] **Step 2: Run Python tests and verify they fail for missing helpers/current PATCH contract**
  Run: `python -m unittest discover -s tests -p 'test_e2e_sync_cleanup.py' -v`
  Expected: import/contract tests fail before the helpers are implemented.
- [x] **Step 3: Implement per-run ledger and RPC cleanup**
  Derive `REAL_LEDGER` from the explicitly configured test namespace plus a unique suffix. Replace whole-ledger PATCH with `POST /rest/v1/rpc/yh_clear_ledger` and a fresh operationId; validate the receipt and let cleanup errors fail the script.
- [x] **Step 4: Run Python safety tests**
  Run: `python -m unittest tests.test_e2e_sync_cleanup tests.test_e2e_sync_guard -v`
  Expected: all pass without network access.

### Task 5: Full Verification and Review

**Files:** all modified files from Tasks 1–4.

- [x] **Step 1: Run full unit and Python suites**
  Run: `pnpm test` and `python -m unittest discover -s tests -p 'test*.py'`.
  Expected: all Vitest and Python tests pass with no new skip.
- [x] **Step 2: Run static checks and production build**
  Run: `pnpm exec tsc --noEmit`, `pnpm lint`, `pnpm build`, `git diff --check`.
  Expected: commands exit 0; no new lint warnings in touched files.
- [x] **Step 3: Review the final diff**
  Check changed-file scope, transaction table scopes, merge counters/UI, legacy behavior, and that no network/real-ledger test was run.
- [x] **Step 4: Perform the final read-only code review**
  Subagent routing was unavailable in this session, so the executor performed a separate read-only review against this plan; two findings were fixed with RED→GREEN regressions and full suites rerun.
