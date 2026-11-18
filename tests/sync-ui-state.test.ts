import { describe, expect, it } from 'vitest';
import { canUndoRemoteChange, shouldRetrySyncError } from '../src/ui/useSync';
import { SyncBusyError, SyncLeaseLostError, SyncPausedError } from '../src/db/syncControl';
import type { RemoteChange } from '../src/db/sync';
const change = (extra: Partial<RemoteChange>): RemoteChange => ({
  kind: 'order', type: 'overwritten', recordId: 'o', label: '订单', local: { totalFen: 100 }, remote: { totalFen: 200 }, ...extra
});
describe('sync UI safety decisions', () => {
  it('incomplete or expired order snapshots expose review instead of automatic undo', () => {
    expect(canUndoRemoteChange(change({ canUndo: false }))).toBe(false);
    expect(canUndoRemoteChange(change({}))).toBe(false);
    expect(canUndoRemoteChange(change({ canUndo: true, undoVersionKey: 'v' }))).toBe(true);
    expect(canUndoRemoteChange(change({ kind: 'product' }))).toBe(true);
  });
  it('explicit void/restore semantics remain available for legacy orders', () => {
    expect(canUndoRemoteChange(change({ local: { voided: false }, remote: { voided: true } }))).toBe(true);
    expect(canUndoRemoteChange(change({ type: 'restored' }))).toBe(true);
  });
  it('persistent pause and lost/busy leases never schedule automatic network retry', () => {
    expect(shouldRetrySyncError(new SyncPausedError('restore'))).toBe(false);
    expect(shouldRetrySyncError(new SyncLeaseLostError())).toBe(false);
    expect(shouldRetrySyncError(new SyncBusyError())).toBe(false);
    expect(shouldRetrySyncError(new TypeError('network failed'))).toBe(true);
  });
});
