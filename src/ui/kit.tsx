import { useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import type { Category, Product } from '../db/types';
import { CATEGORIES } from '../db/types';
import { fenToStr, strToFen } from '../db/util';
import type { ProductInput } from '../db/repo';

/* ---------------------------------------------------------------- 基础组件 */

type BtnVariant = 'primary' | 'soft' | 'ghost' | 'danger';

export function Btn({
  variant = 'primary',
  size,
  block,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: 'sm' | 'lg' | 'icon';
  block?: boolean;
}) {
  const cls = ['btn', variant, size ?? '', block ? 'block' : '', className].filter(Boolean).join(' ');
  return (
    <button type={type} className={cls} {...rest}>
      {children}
    </button>
  );
}

export function Card({
  children,
  flush,
  className = ''
}: {
  children: ReactNode;
  flush?: boolean;
  className?: string;
}) {
  return <div className={`card ${flush ? 'flush' : ''} ${className}`.trim()}>{children}</div>;
}

export function Field({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="field">
      {label ? <label>{label}</label> : null}
      {children}
    </div>
  );
}

export function Stat({
  k,
  v,
  tone
}: {
  k: string;
  v: ReactNode;
  tone?: 'brand' | 'ok' | 'bad';
}) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ''}`}>{v}</div>
    </div>
  );
}

export function Money({ fen, className = '' }: { fen: number; className?: string }) {
  return <span className={`amount ${className}`.trim()}>¥{fenToStr(fen)}</span>;
}

export function Empty({ icon, text }: { icon: string; text: string }) {
  return (
    <div className="empty">
      <div className="big">{icon}</div>
      <div>{text}</div>
    </div>
  );
}

/* ---------------------------------------------------------------- 底部弹层 */

export function Sheet({
  title,
  onClose,
  children,
  footer
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        {children}
        {footer ? <div style={{ marginTop: 14 }}>{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 商品表单 */

function defaultProduct(): ProductInput {
  return {
    name: '',
    category: '炮',
    unitBase: '个',
    boxQty: 0,
    priceList: 0,
    negotiable: true
  };
}

export function ProductFormModal({
  initial,
  onClose,
  onSave
}: {
  initial?: Product;
  onClose: () => void;
  onSave: (input: ProductInput) => void | Promise<void>;
}) {
  const [name, setName] = useState(initial?.name ?? defaultProduct().name);
  const [category, setCategory] = useState<Category>(initial?.category ?? '炮');
  const [unitBase, setUnitBase] = useState(initial?.unitBase ?? '个');
  const [boxQty, setBoxQty] = useState(String(initial?.boxQty ?? 0));
  const [price, setPrice] = useState(initial ? fenToStr(initial.priceList) : '');
  const [negotiable, setNegotiable] = useState(initial?.negotiable ?? true);
  const [err, setErr] = useState('');

  const submit = async () => {
    if (!name.trim()) {
      setErr('商品名不能为空');
      return;
    }
    const priceFen = strToFen(price);
    if (priceFen === null || priceFen < 0) {
      setErr('零售价填个数字，比如 12.5');
      return;
    }
    const bq = Number(boxQty);
    if (!Number.isFinite(bq) || bq < 0 || Math.floor(bq) !== bq) {
      setErr('1 箱装几个要填整数（不拆零填 0）');
      return;
    }
    await onSave({
      name: name.trim(),
      category,
      unitBase: unitBase.trim() || '个',
      boxQty: bq,
      priceList: priceFen,
      negotiable
    });
  };

  return (
    <Sheet
      title={initial ? '编辑商品' : '新建商品'}
      onClose={onClose}
      footer={
        <Btn block size="lg" onClick={submit}>
          保存
        </Btn>
      }
    >
      <div className="col">
        <Field label="商品名">
          <input
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="比如：大地红 1000 响"
            autoFocus
          />
        </Field>
        <Field label="分类">
          <div className="chips">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                className={`chip ${category === c ? 'on' : ''}`}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </Field>
        <div className="row" style={{ gap: 10 }}>
          <Field label="基本单位">
            <input
              className="input"
              value={unitBase}
              onChange={(e) => setUnitBase(e.target.value)}
              placeholder="个 / 挂 / 支 / 盒"
            />
          </Field>
          <Field label="1 箱 = ? 个（不拆零填 0）">
            <input
              className="input num"
              inputMode="numeric"
              value={boxQty}
              onChange={(e) => setBoxQty(e.target.value.replace(/[^\d]/g, ''))}
            />
          </Field>
        </div>
        <Field label={`零售标价（元 / ${unitBase || '个'}）`}>
          <input
            className="input num"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="12.50"
          />
        </Field>
        <label className="row" style={{ gap: 8, fontSize: 14 }}>
          <input
            type="checkbox"
            checked={negotiable}
            onChange={(e) => setNegotiable(e.target.checked)}
            style={{ width: 18, height: 18 }}
          />
          允许现场砍价改价
        </label>
        {err ? <div className="notice bad">{err}</div> : null}
      </div>
    </Sheet>
  );
}