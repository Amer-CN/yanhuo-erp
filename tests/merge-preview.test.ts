import { describe, expect, it } from 'vitest';
import type { OrderMergeChange, OrderMergeChoice } from '../src/db/merge';
import { chooseOrder, initialOrderChoices } from '../src/ui/mergePreview';

function conflict(id: string): OrderMergeChange {
  return { orderId: id, label: id, action: 'conflict', localLineCount: 1,
    incomingLineCount: 1, canChooseIncoming: true, selected: 'local' };
}

describe('merge preview choices', () => {
  it('defaults every selectable conflict to local and leaves non-conflicts out', () => {
    const choices = initialOrderChoices([
      conflict('o1'),
      { ...conflict('o2'), canChooseIncoming: false },
      { ...conflict('o3'), action: 'added', canChooseIncoming: false, selected: 'incoming' }
    ]);
    expect(choices).toEqual({ o1: 'local' });
  });

  it('changes one order choice without mutating the previous state', () => {
    const before: Record<string, OrderMergeChoice> = { o1: 'local', o2: 'local' };
    const after = chooseOrder(before, 'o1', 'incoming');
    expect(after).toEqual({ o1: 'incoming', o2: 'local' });
    expect(before).toEqual({ o1: 'local', o2: 'local' });
  });
});
