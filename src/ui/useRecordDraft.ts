import { useEffect, useMemo, useRef, useState } from 'react';
import type { Product } from '../db/types';
import type { RecordInput } from '../db/repo';
import { fenToStr } from '../db/util';
import {
  amountFromText,
  clearDraft,
  draftKey,
  draftLineAmount,
  loadDraft,
  readLastPay,
  saveDraft,
  type RecordDraft,
  type RecordLineDraft
} from './recordDraft';

/** 新商品行（默认按基本单位、数量 1、标价成交） */
export function newLine(p: Product): RecordLineDraft {
  return {
    productId: p.id,
    unit: 'base',
    qtyBase: 1,
    listUnitPriceFen: p.priceList,
    amountText: fenToStr(p.priceList),
    amountFen: p.priceList,
    gift: false
  };
}

/**
 * C7：未改价且非赠品时，按数量回写金额文本与分数。
 * 返回空对象表示「保持用户手填的金额」。三处金额联动共用这一条规则。
 */
export function syncAmount(
  line: RecordLineDraft,
  qtyBase: number,
  priceFen: number
): Partial<RecordLineDraft> {
  if (line.amountTouched || line.gift) return {};
  return { amountText: draftLineAmount(qtyBase, priceFen), amountFen: qtyBase * priceFen };
}

export function useRecordDraft({
  mode,
  products,
  avgCost,
  operators,
  deviceId,
  sessionId,
  orderId,
  initial
}: {
  mode: 'new' | 'edit' | 'patch';
  products: Product[];
  avgCost: Map<string, number>;
  operators: string[];
  deviceId: string;
  sessionId?: string;
  orderId?: string;
  initial?: RecordDraft;
}) {
  const draftStorageKey = draftKey(mode, orderId, sessionId);
  const [initialDraftState] = useState<{ draft: RecordDraft; restored: boolean }>(() => {
    const saved = loadDraft(draftStorageKey);
    const matched =
      Boolean(saved) &&
      (mode === 'new' ||
        (mode === 'edit' && Boolean(orderId) && saved?.orderId === orderId) ||
        (mode === 'patch' && Boolean(sessionId) && saved?.sessionId === sessionId));
    if (saved && matched) {
      return {
        draft: { ...saved, operator: saved.operator || operators[0] || '我' },
        restored: true
      };
    }
    if (initial) return { draft: initial, restored: false };
    return {
      draft: {
        payMethod: readLastPay(),
        operator: operators[0] || '我',
        note: '',
        lines: []
      },
      restored: false
    };
  });
  const [draft, setDraft] = useState<RecordDraft>(initialDraftState.draft);
  const [errorIndex, setErrorIndex] = useState<number | null>(null);
  const [errorText, setErrorText] = useState('');
  const [showDraftHint, setShowDraftHint] = useState(initialDraftState.restored);
  const [draftRestored, setDraftRestored] = useState(initialDraftState.restored);
  const amountRefs = useRef<(HTMLInputElement | null)[]>([]);
  const mountDraftRef = useRef(JSON.stringify(initialDraftState.draft));

  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  // 所有模式都存草稿：new 固定键，edit/patch 按目标隔离；没动过时不为 DB 原值写草稿
  useEffect(() => {
    const empty = draft.lines.length === 0 && !draft.note.trim();
    if (empty) {
      clearDraft(draftStorageKey);
      return;
    }
    if (!draftRestored && JSON.stringify(draft) === mountDraftRef.current) {
      return;
    }
    saveDraft(
      {
        ...draft,
        sessionId: mode === 'patch' ? sessionId : draft.sessionId,
        orderId: mode === 'edit' ? orderId : undefined
      },
      draftStorageKey
    );
  }, [draft, draftStorageKey, mode, orderId, sessionId, draftRestored]);

  const factorOf = (l: RecordLineDraft): number => {
    const p = productById.get(l.productId);
    return l.unit === 'box' && p && p.boxQty > 1 ? p.boxQty : 1;
  };

  const setLines = (fn: (lines: RecordLineDraft[]) => RecordLineDraft[]) =>
    setDraft((d) => ({ ...d, lines: fn(d.lines) }));

  const patchLine = (idx: number, patch: Partial<RecordLineDraft>) =>
    setLines((lines) => lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const addProduct = (p: Product) => {
    setShowDraftHint(false);
    setLines((lines) => {
      // 同商品、同单位、未改价、未赠品 → 直接 +1，方便连点
      const found = lines.findIndex(
        (l) =>
          l.productId === p.id &&
          l.unit === 'base' &&
          !l.gift &&
          l.listUnitPriceFen === p.priceList &&
          !l.amountTouched
      );
      if (found >= 0) {
        return lines.map((l, i) =>
          i === found
            ? { ...l, qtyBase: l.qtyBase + 1, ...syncAmount(l, l.qtyBase + 1, l.listUnitPriceFen) }
            : l
        );
      }
      return [...lines, newLine(p)];
    });
  };

  const changeQty = (idx: number, delta: number) => {
    setLines((lines) =>
      lines.map((l, i) => {
        if (i !== idx) return l;
        const f = factorOf(l);
        const next = Math.max(1, l.qtyBase + delta * f);
        return { ...l, qtyBase: next, ...syncAmount(l, next, l.listUnitPriceFen) };
      })
    );
  };

  const switchUnit = (idx: number) => {
    const line = draft.lines[idx];
    const p = productById.get(line.productId);
    if (!p || p.boxQty <= 1) return;
    setLines((lines) =>
      lines.map((l, i) => {
        if (i !== idx) return l;
        let next: RecordLineDraft;
        if (l.unit === 'base') {
          const boxes = Math.max(1, Math.floor(l.qtyBase / p.boxQty));
          next = { ...l, unit: 'box', baseBefore: l.qtyBase, qtyBase: boxes * p.boxQty };
        } else {
          next = { ...l, unit: 'base', qtyBase: l.baseBefore ?? l.qtyBase };
        }
        return { ...next, ...syncAmount(l, next.qtyBase, l.listUnitPriceFen) };
      })
    );
  };

  const toggleGift = (idx: number) => {
    setLines((lines) =>
      lines.map((l, i) => {
        if (i !== idx) return l;
        if (l.gift) {
          // 关闭赠品：恢复标价金额
          return {
            ...l,
            gift: false,
            amountTouched: false,
            amountText: draftLineAmount(l.qtyBase, l.listUnitPriceFen),
            amountFen: l.qtyBase * l.listUnitPriceFen
          };
        }
        return { ...l, gift: true, amountText: '0.00', amountFen: 0 };
      })
    );
  };

  const setAmount = (idx: number, text: string) => {
    const fen = amountFromText(text);
    setErrorIndex(null);
    patchLine(idx, { amountText: text, amountFen: fen, amountTouched: true });
  };

  const lineError = (l: RecordLineDraft): string | undefined => {
    if (l.amountFen < 0) return '填个数字，比如 20 或 19.5';
    if (!l.gift && l.amountFen === 0) return '0 元，是赠品吗？';
    return undefined;
  };

  /** 校验并把焦点移到出错的金额框；返回 false 时调用方直接中止提交 */
  const validate = (onEmpty: () => void): boolean => {
    if (draft.lines.length === 0) {
      onEmpty();
      return false;
    }
    const bad = draft.lines.findIndex((l) => lineError(l) !== undefined || l.qtyBase <= 0);
    if (bad >= 0) {
      setErrorIndex(bad);
      setErrorText(lineError(draft.lines[bad]) ?? '数量要大于 0');
      amountRefs.current[bad]?.focus();
      return false;
    }
    return true;
  };

  const buildInputFrom = (d: RecordDraft): RecordInput => ({
    deviceId,
    operator: d.operator || operators[0] || '我',
    payMethod: d.payMethod,
    sessionId: mode === 'patch' ? sessionId : undefined,
    note: d.note,
    lines: d.lines.map((l) => {
      const p = productById.get(l.productId);
      const f = l.unit === 'box' && p && p.boxQty > 1 ? p.boxQty : 1;
      const amount = l.gift ? 0 : Math.max(0, l.amountFen);
      return {
        productId: l.productId,
        qtyBase: l.qtyBase,
        unit: l.unit,
        qty: Math.round(l.qtyBase / f),
        listUnitPriceFen: l.listUnitPriceFen,
        unitPriceFen: l.gift ? 0 : Math.round(amount / l.qtyBase),
        amountFen: amount,
        gift: l.gift
      };
    })
  });

  const totals = useMemo(() => {
    let total = 0;
    let discount = 0;
    let giftCost = 0;
    for (const l of draft.lines) {
      const amount = Math.max(0, l.amountFen);
      total += l.gift ? 0 : amount;
      if (l.gift) giftCost += (avgCost.get(l.productId) ?? 0) * l.qtyBase;
      else discount += Math.max(0, l.listUnitPriceFen * l.qtyBase - amount);
    }
    return { total, discount, giftCost };
  }, [draft.lines, avgCost]);

  /** 「丢弃草稿」：恢复到 initial / 上次支付方式，并把挂载基线一起更新 */
  const resetDraft = () => {
    const reset = initial ?? {
      payMethod: readLastPay(),
      operator: operators[0] || '我',
      note: '',
      lines: []
    };
    clearDraft(draftStorageKey);
    mountDraftRef.current = JSON.stringify(reset);
    setDraft(reset);
    setDraftRestored(false);
    setShowDraftHint(false);
  };

  return {
    draft,
    setDraft,
    productById,
    draftStorageKey,
    errorIndex,
    errorText,
    setErrorIndex,
    showDraftHint,
    setShowDraftHint,
    setDraftRestored,
    amountRefs,
    factorOf,
    setLines,
    addProduct,
    changeQty,
    switchUnit,
    toggleGift,
    setAmount,
    lineError,
    validate,
    buildInputFrom,
    buildInput: () => buildInputFrom(draft),
    totals,
    resetDraft
  };
}