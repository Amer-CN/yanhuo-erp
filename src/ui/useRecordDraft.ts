import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Product } from '../db/types';
import type { RecordInput } from '../db/repo';
import { fenToStr } from '../db/util';
import {
  amountFromText,
  clearDraft,
  draftKey,
  draftLineAmount,
  loadDraft,
  newLineKey,
  readLastPay,
  saveDraft,
  type RecordDraft,
  type RecordLineDraft
} from './recordDraft';

/**
 * 草稿落盘的合并窗口（L-11）。
 * 数量输入是「边打边 setDraft」的，逐字写 localStorage 在低端机上会卡；
 * 200ms 足够把一次连打合并成一次写，又不至于让人觉得「刚填的没存上」。
 */
const DRAFT_SAVE_MS = 200;

/** 新商品行（默认按基本单位、数量 1、标价成交） */
export function newLine(p: Product): RecordLineDraft {
  return {
    key: newLineKey(),
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
        // 改了本机编号后，旧草稿里的「我/老婆」已不在当前 operators 里，统一回落到本机编号
        draft: {
          ...saved,
          operator: operators.includes(saved.operator) ? saved.operator : operators[0] || '我'
        },
        restored: true
      };
    }
    if (initial) {
      /*
       * 编辑历史单时 operator 也要归一化（M-12）：「我 / 老婆」时代的老单进来编辑，
       * 保存后会把旧字符串原样写回，报表里于是同时存在「我」和 001/002 两套人名，
       * 按人统计直接失效。统一走与新建草稿同一个口径（不在当前 operators 里就回落本机编号）。
       */
      return {
        draft: {
          ...initial,
          operator: operators.includes(initial.operator) ? initial.operator : operators[0] || '我'
        },
        restored: false
      };
    }
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
  /**
   * 行内输入框引用按 `RecordLineDraft.key` 索引（L-12）。
   * 原来按数组下标存在普通数组里：删掉中间一行后，下标整体前移，
   * 高位槽位还留着已卸载的 DOM，校验聚焦可能指到别人的输入框上。
   * key 是行的稳定标识（删行时不重建），所以两张 Map 都以 key 为键。
   */
  const amountRefs = useRef<Map<string, HTMLInputElement>>(new Map());
  /** 数量框（L-03：数量出错时光标要落在数量上，别再送进金额框） */
  const qtyRefs = useRef<Map<string, HTMLInputElement>>(new Map());

  const setRef = (map: Map<string, HTMLInputElement>, key: string, el: HTMLInputElement | null) => {
    // 回调 ref 每渲染都会先 null 再给元素，null 时清掉即可，避免留陈旧引用
    if (el) map.set(key, el);
    else map.delete(key);
  };
  const registerAmountRef = (key: string, el: HTMLInputElement | null) =>
    setRef(amountRefs.current, key, el);
  const registerQtyRef = (key: string, el: HTMLInputElement | null) =>
    setRef(qtyRefs.current, key, el);
  const mountDraftRef = useRef(JSON.stringify(initialDraftState.draft));

  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  /*
   * 所有模式都存草稿：new 固定键，edit/patch 按目标隔离；没动过时不为 DB 原值写草稿。
   *
   * L-11：写入改成 200ms debounce（数量输入框是逐字 setDraft 的）。为了「立刻离开
   * 也不丢草稿」，有三处强制 flush：组件卸载、beforeunload/pagehide、页面失焦
   * （见下面第二个 effect）。空草稿不 debounce —— 直接清，留着旧内容比丢掉更危险。
   */
  const saveTimer = useRef<number | undefined>(undefined);
  const pendingDraft = useRef<{ draft: RecordDraft; key: string } | null>(null);

  /** 立即把待写草稿落盘（幂等） */
  const flushDraft = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    const pending = pendingDraft.current;
    pendingDraft.current = null;
    if (pending) saveDraft(pending.draft, pending.key);
  }, []);

  /**
   * 丢弃草稿：连 debounce 队列一起清。
   * 保存成功后如果只清 storage 不清队列，紧接着的卸载 flush 会把刚保存的单又写回草稿箱，
   * 下次开单会冒出「继续上次没记完的单？」—— 用户会以为那单没记上。
   */
  const discardDraft = useCallback(() => {
    if (saveTimer.current) {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
    }
    pendingDraft.current = null;
    clearDraft(draftStorageKey);
  }, [draftStorageKey]);

  useEffect(() => {
    const empty = draft.lines.length === 0 && !draft.note.trim();
    if (empty) {
      if (saveTimer.current) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = undefined;
      }
      pendingDraft.current = null;
      clearDraft(draftStorageKey);
      return;
    }
    if (!draftRestored && JSON.stringify(draft) === mountDraftRef.current) {
      return;
    }
    pendingDraft.current = {
      draft: {
        ...draft,
        sessionId: mode === 'patch' ? sessionId : draft.sessionId,
        orderId: mode === 'edit' ? orderId : undefined
      },
      key: draftStorageKey
    };
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(flushDraft, DRAFT_SAVE_MS);
  }, [draft, draftStorageKey, mode, orderId, sessionId, draftRestored, flushDraft]);

  /* L-11 的三个强制 flush 时机：卸载、关页/切后台、失焦（摊主切到微信那一刻） */
  useEffect(() => {
    const onFlush = () => flushDraft();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flushDraft();
    };
    window.addEventListener('beforeunload', onFlush);
    window.addEventListener('pagehide', onFlush);
    window.addEventListener('blur', onFlush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('beforeunload', onFlush);
      window.removeEventListener('pagehide', onFlush);
      window.removeEventListener('blur', onFlush);
      document.removeEventListener('visibilitychange', onVisibility);
      // 卸载这一下最重要：从开单页返回时组件立刻消失，pending 里可能还压着最后 200ms 的输入
      flushDraft();
    };
  }, [flushDraft]);

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

  /**
   * 直接设置「显示数量」（按当前单位），与 ± 步进同一套换算与金额联动。
   * 为什么不做成 changeQty 的 delta：数量直接输入是绝对值语义，
   * 而且输入框里删空 / 输 0 时只能在落库时夹到 1，用 delta 表达不了。
   */
  const setQty = (idx: number, displayQty: number) => {
    setLines((lines) =>
      lines.map((l, i) => {
        if (i !== idx) return l;
        const f = factorOf(l);
        const next = Math.max(1, Math.round(displayQty) * f);
        // 数量没变就别重算：否则会把用户手填的成交金额按标价覆盖掉
        if (next === l.qtyBase) return l;
        return { ...l, qtyBase: next, ...syncAmount(l, next, l.listUnitPriceFen) };
      })
    );
  };

  /**
   * 显式切到目标单位（幂等）：两个按钮各传各的单位，点当前项不再反向切换。
   *
   * 两条硬规则（H-02 / M-01，**别改回**）：
   * 1. 基本单位数量 `qtyBase` 永远是唯一真值。切回「个」时直接用它，
   *    **不能**去还原来一份 `baseBefore` 快照 —— 老实现就是还原快照，于是
   *    「10 个 → 切箱 → + 两次 = 2 箱 20 个 → 切回个」会退回 10 个，
   *    数量与金额一起少一半（eq 少收钱），且界面毫无提示。
   *    `baseBefore` 字段保留写入（旧草稿里还有它），但已不再被任何代码读取。
   * 2. 不足一箱时**按 1 箱计并显式提示**（2026-11-11 实测回归后的口径）：
   *    既不静默放大（老实现用 Math.max(1, floor(...)) 把 3 个变 10 个却一声不吭），
   *    也不阻断切换（上一版 disabled 按钮，导致 1 挂根本切不到箱模式，
   *    用户得先手改成 20 挂再切，比原来更难用）。
   *    → 现在允许切、按 1 箱落库，由调用方（RecordEditor）Toast 一次
   *      「已按 1 箱（N 个）计」；返回值 `bumpedToBox` 就是这个提示的开关。
   *    整箱换算本身还会丢掉零头（25 挂 → 2 箱 = 20 挂），那是「箱不可拆」的固有语义，
   *    数量在界面上立刻可见，不额外提示。
   */
  const switchUnit = (
    idx: number,
    target: 'base' | 'box'
  ): { ok: boolean; bumpedToBox: boolean } => {
    const line = draft.lines[idx];
    const p = line ? productById.get(line.productId) : undefined;
    // 没商品 / 不拆零 / 已经是目标单位：什么都不做，也不算切换成功（调用方不必提示）
    if (!line || !p || p.boxQty <= 1 || line.unit === target) {
      return { ok: false, bumpedToBox: false };
    }
    // 只在这一行上算一次，供调用方决定要不要提示（不在 setLines 的 updater 里改外部变量）
    const bumpedToBox = target === 'box' && line.qtyBase < p.boxQty;
    setLines((lines) =>
      lines.map((l, i) => {
        if (i !== idx || l.unit === target) return l;
        let next: RecordLineDraft;
        if (target === 'box') {
          // 不足 1 箱按 1 箱计（不再静默放大：调用方拿到 bumpedToBox 会 Toast 告知）
          const boxes = Math.max(1, Math.floor(l.qtyBase / p.boxQty));
          next = { ...l, unit: 'box', baseBefore: l.qtyBase, qtyBase: boxes * p.boxQty };
        } else {
          // 真值就是 qtyBase：箱模式下 ± / 输入改过的数量原样带回基本单位
          next = { ...l, unit: 'base', qtyBase: l.qtyBase };
        }
        return { ...next, ...syncAmount(l, next.qtyBase, l.listUnitPriceFen) };
      })
    );
    return { ok: true, bumpedToBox };
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
      const line = draft.lines[bad];
      setErrorIndex(bad);
      setErrorText(lineError(line) ?? '数量要大于 0');
      /*
       * L-03：按出错字段聚焦。原来一律聚焦金额框，于是「数量要大于 0」把光标送进金额里；
       * 赠品行根本不渲染金额框，那个 ref 是空的，用户只能自己去找哪一行错了。
       */
      const amountEl = amountRefs.current.get(line.key);
      const qtyEl = qtyRefs.current.get(line.key);
      const amountProblem = !line.gift && (line.amountFen < 0 || line.amountFen === 0);
      (amountProblem ? (amountEl ?? qtyEl) : (qtyEl ?? amountEl))?.focus();
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
      const f = factorOf(l);
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
    // 用 discardDraft 而不是 clearDraft：要把 debounce 队列一起清掉，否则 200ms 内
    // 切页 / 卸载会触发一次 flush，把刚被「丢弃」的草稿又写回去
    discardDraft();
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
    /** 按行 key 注册金额 / 数量输入框（L-12；RecordEditor 的回调 ref 用） */
    registerAmountRef,
    registerQtyRef,
    factorOf,
    setLines,
    addProduct,
    changeQty,
    setQty,
    switchUnit,
    toggleGift,
    setAmount,
    lineError,
    validate,
    buildInputFrom,
    buildInput: () => buildInputFrom(draft),
    totals,
    resetDraft,
    /** 保存成功后丢弃草稿（含 debounce 队列），见 discardDraft 注释 */
    discardDraft,
    /** 立即落盘（L-11；RecordEditor 保存前也可以主动调一次） */
    flushDraft
  };
}