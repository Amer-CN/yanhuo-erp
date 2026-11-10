import { Gift, Minus, Plus, X } from 'lucide-react';
import type { Product } from '../db/types';
import { fenToStr } from '../db/util';
import { Field } from './kit';
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
  onRemove,
  onChangeQty,
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
  onRemove: () => void;
  onChangeQty: (delta: number) => void;
  onSwitchUnit: () => void;
  onToggleGift: () => void;
  onSetAmount: (text: string) => void;
}) {
  const listAmount = l.listUnitPriceFen * l.qtyBase;
  const unitLabel = l.unit === 'box' ? '箱' : p.unitBase;
  const giftCost = (avgCost.get(l.productId) ?? 0) * l.qtyBase;
  const factor = l.unit === 'box' && p.boxQty > 1 ? p.boxQty : 1;

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
              onClick={onSwitchUnit}
            >
              {p.unitBase}
            </button>
            <button
              type="button"
              className="glass-segmented__item"
              aria-pressed={l.unit === 'box'}
              onClick={onSwitchUnit}
            >
              箱
            </button>
          </div>
        ) : (
          <span className="tiny-text">{p.unitBase}</span>
        )}

        <div className="stepper">
          <button type="button" aria-label="减少" onClick={() => onChangeQty(-1)}>
            <Minus size={18} aria-hidden="true" />
          </button>
          <span className="val">{Math.round(l.qtyBase / factor)}</span>
          <button type="button" aria-label="增加" onClick={() => onChangeQty(1)}>
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

      {l.gift ? (
        <div className="gift-cost">
          赠品 ·{' '}
          {giftCost > 0
            ? `成本约 ¥${fenToStr(giftCost)}`
            : '成本结账时按进货批次先进先出计算'}
        </div>
      ) : (
        <Field label={`成交金额（元 / ${unitLabel === '箱' ? '整行' : '整行'}）`} error={err}>
          <input
            ref={amountRef}
            className="glass-input"
            inputMode="decimal"
            value={l.amountText}
            onChange={(e) => onSetAmount(e.target.value)}
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