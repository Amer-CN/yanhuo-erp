// 单据草稿：自动存 localStorage，防止补记中途被打断白做。
// 用 localStorage 而非 sessionStorage：PWA 被系统回收（摊位切微信再回来）后
// sessionStorage 会随进程蒸发，localStorage 才能把半张单留住。
// 金额一律整数分；输入框保留文本，避免受控输入跳光标。

import type { PayMethod, SalesOrder } from '../db/types';
import { fenToStr, strToFen } from '../db/util';

export interface RecordLineDraft {
  /** 稳定行标识：删行后不让后面所有卡片重挂载（输入框失焦） */
  key: string;
  productId: string;
  unit: 'box' | 'base';
  qtyBase: number;
  /** 切到"箱"前的基本单位数量，切回来时恢复 */
  baseBefore?: number;
  listUnitPriceFen: number;
  /** 输入框文本 */
  amountText: string;
  /** 派生金额；-1 表示输入非法 */
  amountFen: number;
  /** 用户手动改过整行金额（改数量时不自动覆盖） */
  amountTouched?: boolean;
  gift: boolean;
}

export interface RecordDraft {
  /** 补记时固定；新建/编辑为空 */
  sessionId?: string;
  /** 编辑时记录目标单据，恢复草稿前用于校验，避免串单 */
  orderId?: string;
  payMethod: PayMethod;
  operator: string;
  note: string;
  lines: RecordLineDraft[];
}

export const DRAFT_KEY = 'yh-record-draft';
export const LAST_PAY_KEY = 'yh-last-pay';

export type DraftMode = 'new' | 'edit' | 'patch';

/**
 * 草稿键：new 用新键并从旧键兼容读取；edit/patch 按单据/场次隔离，避免互相覆盖。
 */
export function draftKey(mode: DraftMode, orderId?: string, sessionId?: string): string {
  if (mode === 'edit') return `${DRAFT_KEY}:edit:${orderId ?? ''}`;
  if (mode === 'patch') return `${DRAFT_KEY}:patch:${sessionId ?? ''}`;
  return `${DRAFT_KEY}:new`;
}

function legacyKeyFor(key: string): string | null {
  return key === `${DRAFT_KEY}:new` ? DRAFT_KEY : null;
}

export function readLastPay(): PayMethod {
  try {
    const v = localStorage.getItem(LAST_PAY_KEY);
    return v === 'wechat' || v === 'alipay' ? v : 'cash';
  } catch {
    return 'cash';
  }
}

export function writeLastPay(pay: PayMethod): void {
  try {
    localStorage.setItem(LAST_PAY_KEY, pay);
  } catch {
    /* 隐私模式忽略 */
  }
}

export function saveDraft(draft: RecordDraft, key: string = DRAFT_KEY): void {
  try {
    localStorage.setItem(key, JSON.stringify(draft));
  } catch {
    /* 存不下就只留在内存 */
  }
}

export function loadDraft(key: string = DRAFT_KEY): RecordDraft | null {
  try {
    const legacy = legacyKeyFor(key);
    const raw = localStorage.getItem(key) ?? (legacy ? localStorage.getItem(legacy) : null);
    if (!raw) return null;
    const d = JSON.parse(raw) as Partial<RecordDraft>;
    if (!Array.isArray(d.lines)) return null;
    // 与保存侧契约一致：有行或有备注都算有效草稿。
    // 只填了备注的草稿以前会被这里丢掉，用户看到「已保存草稿」回来却是空的。
    const hasLines = d.lines.length > 0;
    const hasNote = typeof d.note === 'string' && d.note.trim().length > 0;
    if (!hasLines && !hasNote) return null;
    return {
      sessionId: typeof d.sessionId === 'string' ? d.sessionId : undefined,
      orderId: typeof d.orderId === 'string' ? d.orderId : undefined,
      payMethod: d.payMethod === 'wechat' || d.payMethod === 'alipay' ? d.payMethod : 'cash',
      operator: typeof d.operator === 'string' ? d.operator : '',
      note: typeof d.note === 'string' ? d.note : '',
      lines: d.lines.map((l, i) => ({
        // 老草稿没有 key：用「商品+下标」兜底，只影响首次恢复时的重挂载
        key: typeof l.key === 'string' && l.key ? l.key : `${l.productId}-${i}`,
        productId: l.productId,
        unit: l.unit === 'box' ? 'box' : 'base',
        qtyBase: Number(l.qtyBase) || 1,
        baseBefore: l.baseBefore,
        listUnitPriceFen: Number(l.listUnitPriceFen) || 0,
        amountText: String(l.amountText ?? fenToStr(Number(l.amountFen) || 0)),
        amountFen: Number(l.amountFen) || 0,
        amountTouched: Boolean(l.amountTouched),
        gift: Boolean(l.gift)
      }))
    };
  } catch {
    return null;
  }
}

export function clearDraft(key: string = DRAFT_KEY): void {
  try {
    localStorage.removeItem(key);
    const legacy = legacyKeyFor(key);
    // 旧键也要从同一个存储里清，否则升级后旧键会一直留着
    if (legacy) localStorage.removeItem(legacy);
  } catch {
    /* ignore */
  }
}

/** 草稿行稳定标识（用作 React key，删中间行时不让其它行重挂载） */
export function newLineKey(): string {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `l-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 按文本重算金额；非法返回 -1 */
export function amountFromText(text: string): number {
  const v = strToFen(text);
  return v === null ? -1 : v;
}

export function draftLineAmount(qtyBase: number, listUnitPriceFen: number): string {
  return fenToStr(Math.max(0, qtyBase * listUnitPriceFen));
}

/** 从已保存的单构造编辑草稿 */
export function draftFromOrder(
  order: SalesOrder,
  lines: {
    productId: string;
    qtyBase: number;
    unit: 'box' | 'base';
    listUnitPriceFen: number;
    amountFen: number;
    gift?: boolean;
  }[]
): RecordDraft {
  return {
    sessionId: order.sessionId,
    orderId: order.id,
    payMethod: order.payMethod,
    operator: order.operator,
    note: order.note ?? '',
    lines: lines.map((l) => ({
      key: newLineKey(),
      productId: l.productId,
      unit: l.unit,
      qtyBase: l.qtyBase,
      listUnitPriceFen: l.listUnitPriceFen,
      amountText: fenToStr(l.amountFen),
      amountFen: l.amountFen,
      amountTouched: true,
      gift: Boolean(l.gift)
    }))
  };
}