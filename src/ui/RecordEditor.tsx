import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  Plus,
  Minus,
  X,
  Banknote,
  QrCode,
  Wallet,
  User,
  PackagePlus,
  Gift
} from 'lucide-react';
import type { PayMethod, Product, SalesOrder } from '../db/types';
import { PAY_LABEL } from '../db/types';
import { addPatchedRecord, deleteRecord, RecordError, saveRecord, undoPatchedRecord, updateRecord, type RecordInput } from '../db/repo';
import { fenToStr } from '../db/util';
import { Btn, ConfirmSheet, Empty, Field, type Done } from './kit';
import ProductPicker from './ProductPicker';
import {
  amountFromText,
  clearDraft,
  draftKey,
  draftLineAmount,
  loadDraft,
  readLastPay,
  saveDraft,
  writeLastPay,
  type RecordDraft,
  type RecordLineDraft
} from './recordDraft';

const PAY_ICON: Record<PayMethod, typeof Banknote> = {
  cash: Banknote,
  wechat: QrCode,
  alipay: Wallet
};

function newLine(p: Product): RecordLineDraft {
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

/** 从已保存的单构造编辑草稿（实现见 recordDraft，供首屏轻量引用） */
export { draftFromOrder } from './recordDraft';

/**
 * 单据编辑（记一笔）：整页，避免 Sheet 内键盘遮挡。
 * 支付方式在顶部，商品行内直接填成交金额；赠品金额 0、成本照算。
 */
export default function RecordEditor({
  mode,
  products,
  inv,
  avgCost,
  operators,
  deviceId,
  sessionId,
  orderId,
  initial,
  sessionOrderCount,
  onSaved,
  onCancel,
  onCreateProduct,
  onOpenHistory,
  onDone
}: {
  mode: 'new' | 'edit' | 'patch';
  products: Product[];
  inv: Map<string, number>;
  avgCost: Map<string, number>;
  operators: string[];
  deviceId: string;
  sessionId?: string;
  orderId?: string;
  initial?: RecordDraft;
  sessionOrderCount: number;
  onSaved: (order: SalesOrder, andNext: boolean, undo?: () => Promise<void>) => void;
  onCancel: () => void;
  onCreateProduct: () => void;
  onOpenHistory: () => void;
  onDone: Done;
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
  const [pickOpen, setPickOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorIndex, setErrorIndex] = useState<number | null>(null);
  const [errorText, setErrorText] = useState('');
  const [showDraftHint, setShowDraftHint] = useState(initialDraftState.restored);
  const [draftRestored, setDraftRestored] = useState(initialDraftState.restored);
  const addBtnRef = useRef<HTMLButtonElement>(null);
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
            ? { ...l, qtyBase: l.qtyBase + 1, amountText: draftLineAmount(l.qtyBase + 1, l.listUnitPriceFen), amountFen: (l.qtyBase + 1) * l.listUnitPriceFen }
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
        const updated: RecordLineDraft = { ...l, qtyBase: next };
        if (!l.amountTouched && !l.gift) {
          updated.amountText = draftLineAmount(next, l.listUnitPriceFen);
          updated.amountFen = next * l.listUnitPriceFen;
        }
        return updated;
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
        if (!l.amountTouched && !l.gift) {
          next.amountText = draftLineAmount(next.qtyBase, l.listUnitPriceFen);
          next.amountFen = next.qtyBase * l.listUnitPriceFen;
        }
        return next;
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

  const lineError = (l: RecordLineDraft): string | undefined => {
    if (l.amountFen < 0) return '填个数字，比如 20 或 19.5';
    if (!l.gift && l.amountFen === 0) return '0 元，是赠品吗？';
    return undefined;
  };

  const validate = (): boolean => {
    if (draft.lines.length === 0) {
      onDone('先加一个商品', 'error');
      addBtnRef.current?.focus();
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

  const buildInput = (): RecordInput => buildInputFrom(draft);
  const originalRef = useRef<RecordDraft | null>(mode === 'edit' && initial ? initial : null);

  const submit = async (andNext: boolean) => {
    if (busy) return;
    if (!validate()) return;
    setBusy(true);
    try {
      writeLastPay(draft.payMethod);
      let order: SalesOrder;
      if (mode === 'edit' && orderId) order = await updateRecord(orderId, buildInput());
      else if (mode === 'patch' && sessionId) order = await addPatchedRecord({ ...buildInput(), sessionId });
      else order = await saveRecord(buildInput());

      const original = originalRef.current;
      const undo =
        mode === 'edit' && orderId && original
          ? async () => {
              await updateRecord(orderId, buildInputFrom(original));
            }
          : async () => {
              if (mode === 'patch') await undoPatchedRecord(order.id);
              else await deleteRecord(order.id);
            };

      if (andNext) {
        clearDraft(draftStorageKey);
        setDraft((d) => ({ ...d, note: '', lines: [] }));
        setErrorIndex(null);
        window.setTimeout(() => addBtnRef.current?.focus(), 30);
      } else {
        clearDraft(draftStorageKey);
      }
      onSaved(order, andNext, undo);
    } catch (e) {
      const msg =
        e instanceof RecordError
          ? e.message
          : e instanceof Error
            ? e.message
            : String(e);
      onDone(`没记上：${msg}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const requestClose = () => {
    if (draft.lines.length > 0 || draft.note.trim()) setConfirmClose(true);
    else onCancel();
  };

  const selectedMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of draft.lines) m.set(l.productId, (m.get(l.productId) ?? 0) + l.qtyBase);
    return m;
  }, [draft.lines]);

  const title = mode === 'patch' ? '补记一笔' : mode === 'edit' ? '改这一单' : '记一笔';
  const stepText =
    mode === 'patch' ? '补到已结账的场次' : mode === 'edit' ? '本场进行中' : `本场第 ${sessionOrderCount + 1} 单`;

  return (
    <div className="record-page">
      <header className="record-top">
        <button className="glass-pill back-btn" type="button" onClick={requestClose} aria-label="返回">
          <ChevronLeft size={22} aria-hidden="true" />
        </button>
        <div className="record-top__title">
          <h1>{title}</h1>
          <span className="tiny-text">{stepText}</span>
        </div>
        <span className="record-top__spacer" aria-hidden="true" />
      </header>

      <div className="record-page__body">
        {showDraftHint ? (
          <div className="first-run-card">
            <div>
              <div className="first-run-card__title">继续上次没记完的单？</div>
              <div className="tiny-text">已经帮你把上次的商品和金额带回来了</div>
            </div>
            <Btn
              block={false}
              size="sm"
              variant="tertiary"
              onClick={() => {
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
              }}
            >
              丢弃
            </Btn>
          </div>
        ) : null}

        <div className="record-bar">
          <div className="record-bar__label">支付方式</div>
          <div className="glass-segmented record-bar__seg" role="group" aria-label="支付方式">
            {(['cash', 'wechat', 'alipay'] as const).map((pay) => {
              const Icon = PAY_ICON[pay];
              return (
                <button
                  key={pay}
                  type="button"
                  className="glass-segmented__item"
                  aria-pressed={draft.payMethod === pay}
                  onClick={() => setDraft((d) => ({ ...d, payMethod: pay }))}
                >
                  <span className="icon-text">
                    <Icon size={16} aria-hidden="true" />
                    {PAY_LABEL[pay]}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="record-bar">
          <div className="record-bar__label">操作人</div>
          <div className="glass-segmented record-bar__seg" role="group" aria-label="操作人">
            {operators.map((op) => (
              <button
                key={op}
                type="button"
                className="glass-segmented__item"
                aria-pressed={draft.operator === op}
                onClick={() => setDraft((d) => ({ ...d, operator: op }))}
              >
                <span className="icon-text">
                  <User size={16} aria-hidden="true" />
                  {op}
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="form-head">
          <h2 className="section-title">这一单的商品</h2>
          <span className="tiny-text">{draft.lines.length > 0 ? `${draft.lines.length} 行` : ''}</span>
        </div>

        {draft.lines.length === 0 ? (
          <Empty
            icon={<PackagePlus size={24} />}
            text="还没加商品"
            action={
              <Btn block={false} onClick={() => setPickOpen(true)}>
                添加商品
              </Btn>
            }
          />
        ) : (
          <div className="stack-sm">
            {draft.lines.map((l, i) => {
              const p = productById.get(l.productId);
              if (!p) return null;
              const listAmount = l.listUnitPriceFen * l.qtyBase;
              const err = lineError(l);
              const unitLabel = l.unit === 'box' ? '箱' : p.unitBase;
              const giftCost = (avgCost.get(l.productId) ?? 0) * l.qtyBase;
              return (
                <div className="record-line" key={`${l.productId}-${i}`}>
                  <div className="record-line__head">
                    <div className="grow">
                      <div className="record-line__name">{p.name}</div>
                      <div className="record-line__meta">
                        标价 ¥{fenToStr(listAmount)} · 让利 ¥
                        {fenToStr(l.gift ? 0 : Math.max(0, listAmount - Math.max(0, l.amountFen)))}
                      </div>
                    </div>
                    <button
                      className="icon-btn"
                      type="button"
                      aria-label={`删除 ${p.name}`}
                      onClick={() => setLines((lines) => lines.filter((_, idx) => idx !== i))}
                    >
                      <X size={18} aria-hidden="true" />
                    </button>
                  </div>

                  <div className="record-line__controls">
                    {p.boxQty > 1 ? (
                      <div className="glass-segmented" role="group" aria-label="销售单位">
                        <button
                          type="button"
                          className="glass-segmented__item"
                          aria-pressed={l.unit === 'base'}
                          onClick={() => switchUnit(i)}
                        >
                          {p.unitBase}
                        </button>
                        <button
                          type="button"
                          className="glass-segmented__item"
                          aria-pressed={l.unit === 'box'}
                          onClick={() => switchUnit(i)}
                        >
                          箱
                        </button>
                      </div>
                    ) : (
                      <span className="tiny-text">{p.unitBase}</span>
                    )}

                    <div className="stepper">
                      <button type="button" aria-label="减少" onClick={() => changeQty(i, -1)}>
                        <Minus size={18} aria-hidden="true" />
                      </button>
                      <span className="val">{Math.round(l.qtyBase / factorOf(l))}</span>
                      <button type="button" aria-label="增加" onClick={() => changeQty(i, 1)}>
                        <Plus size={18} aria-hidden="true" />
                      </button>
                    </div>

                    <label className={`gift-toggle ${l.gift ? 'is-on' : ''}`}>
                      <input
                        type="checkbox"
                        className="glass-checkbox"
                        checked={l.gift}
                        onChange={() => toggleGift(i)}
                      />
                      <Gift size={16} aria-hidden="true" />
                      赠品
                    </label>
                  </div>

                  {l.gift ? (
                    <div className="gift-cost">
                      赠品 ·{' '}
                      {giftCost > 0
                        ? `成本约 ¥${fenToStr(giftCost)}`
                        : '成本结账时按进货批次先进先出计算'}
                    </div>
                  ) : (
                    <Field
                      label={`成交金额（元 / ${unitLabel === '箱' ? '整行' : '整行'}）`}
                      error={err}
                    >
                      <input
                        ref={(el) => {
                          amountRefs.current[i] = el;
                        }}
                        className="glass-input"
                        inputMode="decimal"
                        value={l.amountText}
                        onChange={(e) => setAmount(i, e.target.value)}
                        aria-invalid={Boolean(err) || errorIndex === i}
                        placeholder={fenToStr(listAmount)}
                      />
                    </Field>
                  )}
                  {errorIndex === i && errorText ? (
                    <div className="record-line__error" role="alert">
                      {errorText}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}

        <Btn ref={addBtnRef} variant="secondary" block onClick={() => setPickOpen(true)}>
          <span className="icon-text">
            <Plus size={18} aria-hidden="true" /> 添加商品
          </span>
        </Btn>

        <div className="record-total">
          <div className="record-total__main">
            <span className="k">合计</span>
            <span className="v">¥{fenToStr(totals.total)}</span>
          </div>
          <div className="record-total__meta">
            <span>让利 ¥{fenToStr(totals.discount)}</span>
            <span>赠品成本 ¥{fenToStr(totals.giftCost)}</span>
          </div>
        </div>

        <Field label="备注（可选）" hint="比如：给老顾客搭了一挂">
          <input
            className="glass-input"
            value={draft.note}
            onChange={(e) => setDraft((d) => ({ ...d, note: e.target.value }))}
            placeholder="这一单有什么要记的"
          />
        </Field>

        {mode === 'patch' ? (
          <button type="button" className="link-btn" onClick={onOpenHistory}>
            看这一场的流水
          </button>
        ) : null}
      </div>

      <div className="record-actions">
        <Btn variant="secondary" block disabled={busy} onClick={() => submit(false)}>
          {busy ? '保存中…' : '只保存'}
        </Btn>
        <Btn block disabled={busy} onClick={() => submit(true)}>
          {busy ? '保存中…' : '保存并记下一单'}
        </Btn>
      </div>

      {pickOpen ? (
        <ProductPicker
          products={products}
          inv={inv}
          selected={selectedMap}
          onAdd={addProduct}
          onDone={() => setPickOpen(false)}
          onCreate={() => {
            setPickOpen(false);
            onCreateProduct();
          }}
        />
      ) : null}

      {confirmClose ? (
        <ConfirmSheet
          title="这单还没保存"
          description="离开后商品和金额会清掉（草稿会保留到下次打开）。"
          confirmText="离开"
          cancelText="继续记"
          danger
          onConfirm={() => {
            setConfirmClose(false);
            onCancel();
          }}
          onCancel={() => setConfirmClose(false)}
        />
      ) : null}
    </div>
  );
}