/**
 * 数量输入的唯一口径（开单行 / 进货 / 盘亏三处共用）。
 *
 * 为什么集中到这一份：这三个输入框原来各写各的过滤逻辑 —— 开单行已经按
 * 「小数整次拒绝」处理，进货页和盘亏框却还是 `replace(/\D/g,'')` 逐字过滤，
 * 于是 `1.5` 会被敲成 `15`（静默放大十倍，事后对账也查不出来）。
 * 把口径搬到一处，三处就不会再漂。
 *
 * 规则（原则：任何非法输入都不能把数量变成用户没打过的值）：
 * - 全角数字先转半角：老人手写 / 九宫格会打出 `５`，老实现直接吞成空串；
 * - 出现小数点 / 逗号（含全角）→ 返回 null，整次输入作废，由调用方回退原值 + 就地提示；
 * - 只留数字并截到 4 位，截断时用 tooLong 告知调用方（不静默）。
 */

/** 数量最多 4 位（9999 件 / 挂，摆摊一天到不了 5 位数） */
export const QTY_MAX_DIGITS = 4;

/** 就地提示文案：三处共用，免得一处说「最多 4 位」另一处说别的 */
export const QTY_HINT_DECIMAL = '数量填整数';
export const QTY_HINT_TOO_LONG = `最多 ${QTY_MAX_DIGITS} 位（9999）`;

export interface NormalizedQty {
  /** 归一后的纯数字文本（可能为空串，表示用户删空了） */
  text: string;
  /** 原始输入超过 QTY_MAX_DIGITS 位，已被截断 */
  tooLong: boolean;
}

/**
 * 归一化数量文本；返回 null 表示这次输入必须整次拒绝（出现小数点/逗号）。
 * 调用方拿到 null 时要把输入框恢复成上一个合法值，并给出 QTY_HINT_DECIMAL。
 */
export function normalizeQtyText(raw: string): NormalizedQty | null {
  const half = raw.replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
  if (/[.,．，]/.test(half)) return null;
  const digits = half.replace(/\D/g, '');
  const text = digits.slice(0, QTY_MAX_DIGITS);
  /*
   * 去掉前导 0（"07" → "7"）：九宫格 + 全角输入下很容易先按出一个 0。
   * 单个 "0" 保留（用户可能正想删掉重打，清空会显得「字被吃了」）。
   * 开单行失焦时本来就有一次同样的归一（RecordLineCard.commitQty），这里提前做，三处一致。
   */
  return { text: text.replace(/^0+(?=\d)/, ''), tooLong: digits.length > QTY_MAX_DIGITS };
}