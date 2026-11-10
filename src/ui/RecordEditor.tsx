import { useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  Plus,
  Banknote,
  QrCode,
  Wallet,
  User,
  PackagePlus
} from 'lucide-react';
import type { PayMethod, Product, SalesOrder } from '../db/types';
import { PAY_LABEL } from '../db/types';
import { addPatchedRecord, deleteRecord, RecordError, saveRecord, undoPatchedRecord, updateRecord } from '../db/repo';
import { fenToStr } from '../db/util';
import { Btn, ConfirmSheet, Empty, Field, type Done } from './kit';
import ProductPicker from './ProductPicker';
import RecordLineCard from './RecordLineCard';
import { clearDraft, writeLastPay, type RecordDraft } from './recordDraft';
import { useRecordDraft } from './useRecordDraft';

const PAY_ICON: Record<PayMethod, typeof Banknote> = {
  cash: Banknote,
  wechat: QrCode,
  alipay: Wallet
};

/** 从已保存的单构造编辑草稿（实现见 recordDraft，供首屏轻量引用） */
export { draftFromOrder } from './recordDraft';

/**
 * 单据编辑（记一笔）：整页，避免 Sheet 内键盘遮挡。
 * 支付方式在顶部，商品行内直接填成交金额；赠品金额 0、成本照算。
 * 草稿状态 / 单位换算 / 金额联动都收在 useRecordDraft，这里只保留提交与整页骨架。
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
  const {
    draft,
    setDraft,
    productById,
    draftStorageKey,
    errorIndex,
    errorText,
    setErrorIndex,
    showDraftHint,
    amountRefs,
    setLines,
    addProduct,
    changeQty,
    switchUnit,
    toggleGift,
    setAmount,
    lineError,
    validate,
    buildInputFrom,
    buildInput,
    totals,
    resetDraft
  } = useRecordDraft({ mode, products, avgCost, operators, deviceId, sessionId, orderId, initial });

  const [pickOpen, setPickOpen] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const originalRef = useRef<RecordDraft | null>(mode === 'edit' && initial ? initial : null);

  const submit = async (andNext: boolean) => {
    if (busy) return;
    if (
      !validate(() => {
        onDone('先加一个商品', 'error');
        addBtnRef.current?.focus();
      })
    )
      return;
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

  const onRemoveLine = (idx: number) =>
    setLines((lines) => lines.filter((_, i) => i !== idx));

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
                resetDraft();
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
              return (
                <RecordLineCard
                  key={`${l.productId}-${i}`}
                  line={l}
                  index={i}
                  product={p}
                  avgCost={avgCost}
                  err={lineError(l)}
                  errorIndex={errorIndex}
                  errorText={errorText}
                  amountRef={(el) => {
                    amountRefs.current[i] = el;
                  }}
                  onRemove={() => {
                    // 行删除仍走 hook 的 setLines，保持原来的过滤语义
                    onRemoveLine(i);
                  }}
                  onChangeQty={(delta) => changeQty(i, delta)}
                  onSwitchUnit={() => switchUnit(i)}
                  onToggleGift={() => toggleGift(i)}
                  onSetAmount={(text) => setAmount(i, text)}
                />
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