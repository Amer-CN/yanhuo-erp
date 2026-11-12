import { useEffect, useRef, useState } from 'react';
import { Gift, Minus, Plus, X } from 'lucide-react';
import type { Product } from '../db/types';
import { fenToStr } from '../db/util';
import { Field } from './kit';
import { normalizeQtyText, QTY_HINT_DECIMAL, QTY_HINT_TOO_LONG } from './quantityInput';
import type { RecordLineDraft } from './recordDraft';

/** 单据里的一行商品：单位切换、步进、赠品、成交金额 */
export default function RecordLineCard({
  line: l,
  index: i,
  product: p,
  avgCost,
  err,
  errorIndex,
  errorText,
  amountRef,
  qtyRef,
  onRemove,
  onChangeQty,
  onSetQty,
  onSwitchUnit,
  onToggleGift,
  onSetAmount
}: {
  line: RecordLineDraft;
  index: number;
  product: Product;
  avgCost: Map<string, number>;
  err?: string;
  errorIndex: number | null;
  errorText: string;
  amountRef: (el: HTMLInputElement | null) => void;
  /** 数量输入框的引用（L-03：校验出错时光标要能落到这里） */
  qtyRef: (el: HTMLInputElement | null) => void;
  onRemove: () => void;
  onChangeQty: (delta: number) => void;
  /** 直接设数量（按当前单位），与 ± 走同一套换算 */
  onSetQty: (qty: number) => void;
  onSwitchUnit: (unit: 'base' | 'box') => void;
  onToggleGift: () => void;
  onSetAmount: (text: string) => void;
}) {
  const listAmount = l.listUnitPriceFen * l.qtyBase;
  const giftCost = (avgCost.get(l.productId) ?? 0) * l.qtyBase;
  const factor = l.unit === 'box' && p.boxQty > 1 ? p.boxQty : 1;
  /** 数量槽里显示的「按当前单位」的数字（箱模式下是箱数） */
  const display = Math.round(l.qtyBase / factor);
  /*
   * 数量槽改可输入：连点 9 次步进才能卖 10 挂，摊位上太累。
   * editing 期间**故意**不同步外部 display —— 用户正在输入时，
   * 任何重算（± 按钮、单位切换、金额联动）都会把刚敲的数字覆盖掉，
   * 输入框会「自己变字」。失焦后 editing=false，再恢复同步。
   */
  const [editing, setEditing] = useState(false);
  const [qtyText, setQtyText] = useState(String(display));
  /** 非法输入的即时说明（小数 / 超 4 位）：本行内显示，不新增全局状态 */
  const [qtyHint, setQtyHint] = useState('');
  const hintTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!editing) setQtyText(String(display));
  }, [display, editing]);

  useEffect(
    () => () => {
      if (hintTimer.current) window.clearTimeout(hintTimer.current);
    },
    []
  );

  const flashQtyHint = (text: string) => {
    setQtyHint(text);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    // text 为空 = 主动清掉旧提示（输入又合法了，旧红字不能继续挂着）
    hintTimer.current = text ? window.setTimeout(() => setQtyHint(''), 2200) : undefined;
  };

  /*
   * 数量文本归一化：口径已抽到 quantityInput.ts（进货 / 盘亏共用同一份），
   * 这里只负责「非法就回退 + 就地提示」，具体规则见该文件头部注释。
   */

  /**
   * 提交输入框里的数量（M-05）。
   * onBlur 与「± / 单位」按钮的 onPointerDown 共用这一份，两处口径不会漂。
   * 为什么要在 pointerdown 里也调：iOS Safari 点 button 不保证先触发 blur，
   * 如果只在 onBlur 提交，点「+」可能出现「输入框显示 3、实际数量 4」。
   */
  const commitQty = () => {
    setEditing(false);
    const n = Number(qtyText);
    if (!qtyText || !Number.isFinite(n) || n < 1) {
      // 删空 / 输 0 都回到 1：单据里不允许 0 件
      onSetQty(1);
      setQtyText('1');
      return;
    }
    // 去掉前导 0（"007" → "7"），再把绝对值写回 hook
    setQtyText(String(Math.round(n)));
    onSetQty(n);
  };

  /** 点 ± / 单位前先把正在编辑的输入落库（幂等；blur 随后再跑一次也无妨） */
  const primeQty = () => {
    if (editing) commitQty();
  };

  return (
    <div className="record-line">
      <div className="record-line__head">
        <div className="grow">
          <div className="record-line__name">{p.name}</div>
          <div className="record-line__meta">
            标价 ¥{fenToStr(listAmount)} · 让利 ¥
            {fenToStr(l.gift ? 0 : Math.max(0, listAmount - Math.max(0, l.amountFen)))}
          </div>
        </div>
        <button className="icon-btn" type="button" aria-label={`删除 ${p.name}`} onClick={onRemove}>
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
              onPointerDown={primeQty}
              onClick={() => onSwitchUnit('base')}
            >
              {p.unitBase}
            </button>
            <button
              type="button"
              className="glass-segmented__item"
              aria-pressed={l.unit === 'box'}
              /*
               * 2026-11-11 实测回归：这里曾按 M-01 加了 disabled（不足 1 箱不让切），
               * 结果 1 挂根本切不到箱模式，用户得先手改成 20 挂再点 —— 比原来的
               * 静默放大更难用。现在恢复可点：hook 会按 1 箱计，并由 RecordEditor
               * 给一次 Toast「已按 1 箱（N 挂）计」。
               */
              onClick={() => onSwitchUnit('box')}
            >
              箱
            </button>
          </div>
        ) : (
          <span className="tiny-text">{p.unitBase}</span>
        )}

        <div className="stepper">
          <button type="button" aria-label="减少" onPointerDown={primeQty} onClick={() => onChangeQty(-1)}>
            <Minus size={18} aria-hidden="true" />
          </button>
          <input
            ref={qtyRef}
            className="stepper__input"
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            enterKeyHint="done"
            autoComplete="off"
            aria-label={`${p.name} 数量`}
            value={qtyText}
            onFocus={(e) => {
              setEditing(true);
              // 点一下全选：改数量时不用先删掉原来的数字（iOS 会在 focus 后异步重置选区，故补一帧）
              const el = e.currentTarget;
              el.select();
              requestAnimationFrame(() => el.select());
            }}
            onChange={(e) => {
              /* M-04：全角先转半角、小数整次拒绝、超 4 位给提示（细则见 quantityInput.ts） */
              const parsed = normalizeQtyText(e.target.value);
              if (!parsed) {
                // 打了小数点：这次输入作废，输入框退回上一次的数字，绝不拼成 35
                setQtyText(String(display));
                flashQtyHint(QTY_HINT_DECIMAL);
                return;
              }
              if (parsed.tooLong) flashQtyHint(QTY_HINT_TOO_LONG);
              else flashQtyHint('');
              setQtyText(parsed.text);
              // 实时联动：边输边算金额；0 / 空先不写库，等失焦再夹到 1
              const n = Number(parsed.text);
              if (n > 0) onSetQty(n);
            }}
            onBlur={commitQty}
            onKeyDown={(e) => {
              // 摊主输完就收键盘，不用去点别处
              if (e.key === 'Enter') e.currentTarget.blur();
            }}
          />
          <button type="button" aria-label="增加" onPointerDown={primeQty} onClick={() => onChangeQty(1)}>
            <Plus size={18} aria-hidden="true" />
          </button>
        </div>

        <label className={`gift-toggle ${l.gift ? 'is-on' : ''}`}>
          <input
            type="checkbox"
            className="glass-checkbox"
            checked={l.gift}
            onChange={onToggleGift}
          />
          <Gift size={16} aria-hidden="true" />
          赠品
        </label>
      </div>

      {/* 非法数量的就地说明（小数 / 超 4 位）：不再靠静默改数字表达 */}
      {qtyHint ? (
        <div className="record-line__error" role="status">
          {qtyHint}
        </div>
      ) : null}

      {l.gift ? (
        <div className="gift-cost">
          赠品 ·{' '}
          {giftCost > 0
            ? `成本约 ¥${fenToStr(giftCost)}`
            : '成本结账时按进货批次先进先出计算'}
        </div>
      ) : (
        <Field label="成交金额（元 / 整行）" error={err}>
          <input
            ref={amountRef}
            className="glass-input"
            inputMode="decimal"
            value={l.amountText}
            onChange={(e) => onSetAmount(e.target.value)}
            /*
             * 点一下全选：改价场景是「让利 5 元」，预填的是标价，
             * 不全选就得长按 + 拖选 + 删，摊位上要 5 秒。
             * requestAnimationFrame 里再选一次是给 iOS Safari 的：
             * 它会 focus 之后异步重置选区，只调一次 select() 会被吃掉。
             */
            onFocus={(e) => {
              const el = e.currentTarget;
              el.select();
              requestAnimationFrame(() => el.select());
            }}
            autoComplete="off"
            enterKeyHint="done"
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
}