import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronLeft,
  Plus,
  Banknote,
  QrCode,
  Wallet,
  PackagePlus
} from 'lucide-react';
import type { PayMethod, Product, SalesOrder } from '../db/types';
import { PAY_LABEL } from '../db/types';
import { addPatchedRecord, deleteRecord, RecordError, saveRecord, undoPatchedRecord, updateRecord } from '../db/repo';
import { fenToStr } from '../db/util';
import { Btn, ConfirmSheet, Empty, Field, type Done } from './kit';
import ProductPicker from './ProductPicker';
import RecordLineCard from './RecordLineCard';
import { writeLastPay, type RecordDraft } from './recordDraft';
import { useRecordDraft } from './useRecordDraft';

const PAY_ICON: Record<PayMethod, typeof Banknote> = {
  cash: Banknote,
  wechat: QrCode,
  alipay: Wallet
};

/** 从已保存的单构造编辑草稿（实现见 recordDraft，供首屏轻量引用） */
export { draftFromOrder } from './recordDraft';

/**
 * 连续开单：保存成功后隔多久自动开「选商品」层（P1）。
 * 原来 30ms —— 手指还没离开屏幕，弹层就顶到指尖下面，连点会点到商品卡 /
 * 「完成」/ 又点回「保存」，实测 5 连点（0.1s）记成 3 单并多卖掉一样货。
 * 600ms 大约是一次「抬手 + 看一眼」的时间，够手指离开屏幕。
 */
const PICK_OPEN_DELAY_MS = 600;

/**
 * 弹层入场锁时长（P1）：自动弹出的层在头 400ms 内不吃指针。
 * 即便 600ms 后仍然有残余连点，也会被这一层挡住，不会落到商品卡上。
 */
const PICK_ARM_MS = 400;

/**
 * 底栏内联回执的停留时间（P3）。与原先 Toast 的 6 秒撤销寿命保持一致
 * （docs/ux-proactive-20261112.md 五.7：6 秒足够，延长反而更久压住底栏）。
 */
const RECEIPT_MS = 6000;

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
  online,
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
  /**
   * 当前是否在线（沿用 App 里 sync.online，不新增全局状态）。
   * P4：这一页顶栏是隐藏的（整页编辑，避免键盘遮挡），断网时页面上
   * 原来没有任何离线标记 —— 摊主看不出「这单到底存没存上云」。
   */
  online: boolean;
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
    errorIndex,
    errorText,
    setErrorIndex,
    showDraftHint,
    registerAmountRef,
    registerQtyRef,
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
    buildInput,
    totals,
    resetDraft,
    discardDraft
  } = useRecordDraft({ mode, products, avgCost, operators, deviceId, sessionId, orderId, initial });

  const [pickOpen, setPickOpen] = useState(false);
  /** 弹层入场锁（P1）：只有「保存后自动弹」的那一层会短时上锁 */
  const [pickArmed, setPickArmed] = useState(false);
  /**
   * 底栏内联回执（P3）：连续开单时不发浮层 Toast —— Toast 置顶 72–150，
   * 而自动弹开的选商品层顶边在 84，标题「选商品 / 本单已加 N 种」会被完全盖住。
   * 文案保留「已记 1 单」子串（e2e 按它断言），撤销按钮调的是同一个 undo。
   */
  const [receipt, setReceipt] = useState<{ text: string; undo?: () => Promise<void> } | null>(null);
  /** 回执到期前的淡出态（6 秒到点前 260ms 开始，与弹层关闭时长同值） */
  const [receiptLeaving, setReceiptLeaving] = useState(false);
  const [receiptBusy, setReceiptBusy] = useState(false);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);
  const originalRef = useRef<RecordDraft | null>(mode === 'edit' && initial ? initial : null);
  /** 自动开层 / 入场锁的计时器：卸载要清，否则会打到已卸载的组件上 */
  const openTimer = useRef<number | undefined>(undefined);
  const armTimer = useRef<number | undefined>(undefined);
  /**
   * 保存成功 → 弹层真正开出来 之间，多余的手指点按一律忽略。
   * 这段时间里草稿已经清空，再走一次 submit 只会弹出「先加一个商品」的红字，
   * 把「刚才那一下点多了」说成一条错误，反而更像页面出错。
   */
  const swallowSubmitRef = useRef(false);

  useEffect(
    () => () => {
      if (openTimer.current) window.clearTimeout(openTimer.current);
      if (armTimer.current) window.clearTimeout(armTimer.current);
    },
    []
  );

  /**
   * 回执的 6 秒倒计时：弹层开着的时候不开始计时。
   * 自动弹出的选商品层会盖住底栏，回执其实看不见；如果照样倒计时，
   * 用户「保存 → 选货 → 点完成」回来时看到的是一条早就过期、已经不存在的回执。
   */
  useEffect(() => {
    if (!receipt || pickOpen) return;
    setReceiptLeaving(false);
    const fadeAt = window.setTimeout(() => setReceiptLeaving(true), RECEIPT_MS - 260);
    const clearAt = window.setTimeout(() => {
      setReceipt(null);
      setReceiptLeaving(false);
    }, RECEIPT_MS);
    return () => {
      window.clearTimeout(fadeAt);
      window.clearTimeout(clearAt);
      setReceiptLeaving(false);
    };
  }, [receipt, pickOpen]);

  /** 手动开层（点「添加商品」）：用户明确要选货，不加锁、也不延迟 */
  const openPicker = () => {
    if (openTimer.current) window.clearTimeout(openTimer.current);
    if (armTimer.current) window.clearTimeout(armTimer.current);
    swallowSubmitRef.current = false;
    setPickArmed(false);
    setPickOpen(true);
  };

  const closePicker = () => {
    setPickOpen(false);
    setPickArmed(false);
  };

  /** 撤销底栏回执里的那一单（与 Toast 的撤销是同一个 undo 闭包） */
  const undoReceipt = async () => {
    if (!receipt?.undo || receiptBusy) return;
    setReceiptBusy(true);
    try {
      await receipt.undo();
      setReceipt({ text: '已撤销这一单' });
    } catch (e) {
      setReceipt({ text: `撤销失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setReceiptBusy(false);
    }
  };

  const submit = async (andNext: boolean) => {
    if (busy || swallowSubmitRef.current) return;
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
        // 用 discardDraft（含 debounce 队列）：只清 storage 会在卸载 flush 时把
        // 刚保存的这一单又写回草稿箱，下次开单冒出「继续上次没记完的单？」（L-11）
        discardDraft();
        setDraft((d) => ({ ...d, note: '', lines: [] }));
        setErrorIndex(null);
        window.setTimeout(() => addBtnRef.current?.focus(), 30);
        /*
         * P3：回执改到底栏内联（.record-receipt），App 侧对 andNext 不再发 Toast。
         * 主串「已记 1 单」保持不动（e2e / 文档都按它断言），
         * P4 只在断网时追一句「· 待联网上传」。
         */
        setReceipt({
          text: `已记 1 单${
            order.totalFen === 0 ? '（赠品）' : ` ¥${fenToStr(order.totalFen)}`
          }${online ? '' : ' · 待联网上传'}`,
          undo
        });
        /*
         * P1：连点穿透。原来 30ms 就弹层，手指还在屏幕上，后续连点落到
         * 商品卡 / 「完成」/ 又点回「保存」上（实测 5 连点 → 3 单 + 多卖一样货）。
         * 现在两手一起做：
         * ① 600ms 后才开层（先给手指离开的时间）；
         * ② 开出来后再锁 400ms 指针（Sheet 的 arming），残余连点被吞掉。
         * 这段时间内到弹层真正出现为止，多余的 submit 也被 swallowSubmitRef 挡掉。
         */
        swallowSubmitRef.current = true;
        if (openTimer.current) window.clearTimeout(openTimer.current);
        openTimer.current = window.setTimeout(() => {
          // 弹层用 initialFocus="panel"（ProductPicker），不会一保存完就弹键盘
          setPickArmed(true);
          setPickOpen(true);
          swallowSubmitRef.current = false;
          if (armTimer.current) window.clearTimeout(armTimer.current);
          armTimer.current = window.setTimeout(() => setPickArmed(false), PICK_ARM_MS);
        }, PICK_OPEN_DELAY_MS);
      } else {
        discardDraft();
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

  const onRemoveLine = (idx: number) => {
    const removed = draft.lines[idx];
    if (!removed) return;
    setLines((lines) => lines.filter((_, i) => i !== idx));
    // 删掉的可能正是报错那一行：不复位的话红字会停在下一行上
    setErrorIndex(null);
    /*
     * 误触（戴手套 / 强光 / 手抖）后不该只能重选重填，所以给一条可撤销的提示。
     * 插回按原索引，靠 RecordLineDraft.key 稳定，其它行不会重挂载；
     * 顺便把草稿里可能已改过的金额原样带回来（removed 是删之前的快照）。
     */
    onDone(`已移除 ${productById.get(removed.productId)?.name ?? '商品'}`, 'warning', {
      label: '撤销',
      onClick: () =>
        setLines((lines) => [...lines.slice(0, idx), removed, ...lines.slice(idx)])
    });
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

        <div className="form-head">
          <h2 className="section-title">这一单的商品</h2>
          <div className="form-head__aside">
            <span className="tiny-text">{draft.lines.length > 0 ? `${draft.lines.length} 行` : ''}</span>
            {/*
             * P8 的「顶部入口」：商品行多的时候不用先滚到最下面才能再加一个。
             * 盒子 44（触控下限）但用负外边距压回行高，标题行不会因此变高。
             */}
            <button
              ref={addBtnRef}
              type="button"
              className="record-add-link"
              onClick={openPicker}
            >
              <Plus size={14} aria-hidden="true" /> 添加商品
            </button>
          </div>
        </div>

        {draft.lines.length === 0 ? (
          <Empty
            icon={<PackagePlus size={24} />}
            text="还没加商品"
            action={
              <Btn block={false} onClick={openPicker}>
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
                  key={l.key}
                  line={l}
                  index={i}
                  product={p}
                  avgCost={avgCost}
                  err={lineError(l)}
                  errorIndex={errorIndex}
                  errorText={errorText}
                  /* L-12：按行 key 注册（而非数组下标），删行后不会留下陈旧引用 */
                  amountRef={(el) => registerAmountRef(l.key, el)}
                  qtyRef={(el) => registerQtyRef(l.key, el)}
                  onRemove={() => {
                    // 行删除仍走 hook 的 setLines，保持原来的过滤语义
                    onRemoveLine(i);
                  }}
                  onChangeQty={(delta) => changeQty(i, delta)}
                  onSetQty={(qty) => setQty(i, qty)}
                  onSwitchUnit={(unit) => {
                    /*
                     * 不足 1 箱时 hook 按 1 箱计（不再是 disabled、也不再静默放大）：
                     * 这里用一条非模态 Toast 明确告知，且只在这一步提示一次 ——
                     * 切过去以后再次点「箱」会命中「已经是目标单位」分支，不会再弹。
                     */
                    const res = switchUnit(i, unit);
                    if (res.bumpedToBox) {
                      onDone(
                        `已按 1 箱（${p.boxQty}${p.unitBase}）计，可再调整数量`,
                        'warning'
                      );
                    }
                  }}
                  onToggleGift={() => toggleGift(i)}
                  onSetAmount={(text) => setAmount(i, text)}
                />
              );
            })}
          </div>
        )}

        {/*
         * P8：块级「添加商品」入口已经移到合计明细之后（见下方）。
         * 原来它就在这个位置（列表尾部），实测中心 y≈502，比下 1/3 的起点（562）
         * 还高 60px，戴手套单手要挪握姿；顶部入口改由标题行的小链接承担。
         */}

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

        {/*
         * P8：第二个「添加商品」入口，放在合计明细之后（自然落到屏幕下半）。
         * 原来的唯一入口在商品行尾部，实测中心 y≈502，而下 1/3 的起点是 562 ——
         * 戴手套单手要挪一次握姿才够得到。这一条正好落在拇指区，且上沿离底栏还有
         * 一段空隙；顶部的入口改成标题行里的小链接（见 .record-add-link），
         * 商品行多的时候不用先滚到底。
         * 为什么只留一个块级入口：两个块级按钮会把下面的备注框顶到固定底栏底下
         * （实测备注输入框只露出 7px），页面没变长、内容却被挡住，比放高一点更糟。
         * 空单时不渲染：那时空态卡片里已经有一个「添加商品」。
         */}
        {draft.lines.length > 0 ? (
          <Btn variant="tertiary" block onClick={openPicker}>
            <span className="icon-text">
              <Plus size={18} aria-hidden="true" /> 添加商品
            </span>
          </Btn>
        ) : null}

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
        {/*
         * P3：连续开单的回执内联在底栏，不再用浮层 Toast。
         * 浮层 Toast 置顶 72–150，而自动弹开的「选商品」层顶边在 84，
         * 标题和「本单已加 N 种」会被整条盖住（实测，见 docs/ux-proactive-20261112.md）。
         */}
        {receipt ? (
          <div className={`record-receipt${receiptLeaving ? ' is-leaving' : ''}`} role="status" aria-live="polite">
            <span className="record-receipt__text">{receipt.text}</span>
            {receipt.undo ? (
              <>
                <span className="record-receipt__dot" aria-hidden="true">
                  ·
                </span>
                <button
                  type="button"
                  className="record-receipt__undo"
                  onClick={() => void undoReceipt()}
                  disabled={receiptBusy}
                >
                  {receiptBusy ? '撤销中…' : '撤销'}
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {/*
         * 合计常驻在底栏左侧：单手录到第 4 个商品时不用滚回去确认「这单 380 对不对」。
         * 上面的 .record-total 明细区保留（还有让利 / 赠品成本）。
         */}
        <div className="record-actions__total">
          <span className="k">合计</span>
          <span className="v">¥{fenToStr(totals.total)}</span>
          {/*
           * P4：离线徽标。这一页没有顶栏（整页编辑），断网时原来一个标记都没有，
           * 摊主无法判断「这单到底存没存上云」。状态直接取 App 的 sync.online。
           */}
          {!online ? (
            <span
              className="record-offline"
              role="status"
              aria-label="当前离线，保存的单会等联网后上传"
            >
              离线 · 待上传
            </span>
          ) : null}
        </div>
        <Btn variant="secondary" block disabled={busy} onClick={() => submit(false)}>
          {busy ? '保存中…' : '只保存'}
        </Btn>
        <Btn block disabled={busy} onClick={() => submit(true)}>
          {/*
           * 文案保持「保存并记下一单」不动：e2e-smoke.py:76 按这个可访问名点按钮，
           * 改名会让 CI 的 e2e 门禁失败。宽度靠 record.css 里收紧 gap / 内边距解决。
           */}
          {busy ? '保存中…' : '保存并记下一单'}
        </Btn>
      </div>

      {pickOpen ? (
        <ProductPicker
          products={products}
          inv={inv}
          selected={selectedMap}
          arming={pickArmed}
          onAdd={addProduct}
          onDone={closePicker}
          onCreate={() => {
            closePicker();
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