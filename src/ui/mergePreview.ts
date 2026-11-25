import type { OrderMergeChange, OrderMergeChoice } from '../db/merge';

export type OrderChoices = Record<string, OrderMergeChoice>;

/** 所有需要用户选择的同 ID 冲突都默认保留本机。 */
export function initialOrderChoices(changes: OrderMergeChange[]): OrderChoices {
  return Object.fromEntries(
    changes
      .filter((change) => change.action === 'conflict' && change.canChooseIncoming)
      .map((change) => [change.orderId, 'local' as const])
  );
}

export function chooseOrder(choices: OrderChoices, orderId: string, choice: OrderMergeChoice): OrderChoices {
  return { ...choices, [orderId]: choice };
}
