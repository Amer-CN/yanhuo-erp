import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { X, CheckCircle2 } from 'lucide-react';
import type { Category, Product } from '../db/types';
import { CATEGORIES } from '../db/types';
import { fenToStr, strToFen } from '../db/util';
import type { ProductInput } from '../db/repo';

/* ---------------------------------------------------------------- 基础组件 */

type BtnVariant = 'primary' | 'secondary' | 'tertiary' | 'danger';

const BTN_CLASS: Record<BtnVariant, string> = {
  primary: 'glass-btn--primary',
  secondary: 'glass-btn--secondary',
  tertiary: 'glass-btn--tertiary',
  danger: 'glass-btn--tertiary btn-danger'
};

export function Btn({
  variant = 'primary',
  size,
  block = true,
  className = '',
  children,
  type = 'button',
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: BtnVariant;
  size?: 'sm' | 'lg';
  block?: boolean;
}) {
  const cls = [
    'glass-btn',
    BTN_CLASS[variant],
    size ? `glass-btn--${size}` : '',
    block ? '' : 'glass-btn--auto',
    className
  ]
    .filter(Boolean)
    .join(' ');
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
  return (
    <div className={`glass-card card-pad ${flush ? 'card-tight' : ''} ${className}`.trim()}>
      {children}
    </div>
  );
}

export function Field({
  label,
  children,
  hint
}: {
  label?: string;
  children: ReactNode;
  hint?: string;
}) {
  return (
    <div className="glass-input-group">
      {label ? <label className="glass-label">{label}</label> : null}
      {children}
      {hint ? <span className="glass-hint">{hint}</span> : null}
    </div>
  );
}

export function Stat({ k, v, tone }: { k: string; v: ReactNode; tone?: 'brand' | 'ok' | 'bad' }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${tone ?? ''}`.trim()}>{v}</div>
    </div>
  );
}

export function Money({ fen, className = '' }: { fen: number; className?: string }) {
  return <span className={`amount ${className}`.trim()}>¥{fenToStr(fen)}</span>;
}

export function Empty({
  icon,
  text,
  action
}: {
  icon: ReactNode;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="glass-empty">
      <span className="glass-empty__icon">{icon}</span>
      <p className="glass-empty__title">{text}</p>
      {action ? <div className="glass-empty__action">{action}</div> : null}
    </div>
  );
}

/* ---------------------------------------------------------------- 提示条 */

export function Toast({ message }: { message: string }) {
  return (
    <div className="glass-toast glass-toast--success is-visible toast" role="status">
      <CheckCircle2 className="glass-toast__icon" size={20} aria-hidden="true" />
      <span className="glass-toast__text">{message}</span>
    </div>
  );
}

/* ---------------------------------------------------------------- 底部弹层 */

export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    const raf = requestAnimationFrame(() => setActive(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  const close = () => {
    setActive(false);
    window.setTimeout(onClose, 260);
  };

  return (
    <div className={`glass-sheet-overlay ${active ? 'is-active' : ''}`} onClick={close}>
      <div
        className="glass-sheet"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="glass-sheet__grip" aria-hidden="true" />
        <div className="glass-sheet__head">
          <div className="glass-sheet__heading">
            <h2 className="glass-sheet__title">{title}</h2>
            {subtitle ? <div className="glass-sheet__subtitle">{subtitle}</div> : null}
          </div>
          <button className="glass-sheet__close" type="button" onClick={close} aria-label="关闭">
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="glass-sheet__body">{children}</div>
        {footer ? <div className="glass-sheet__actions">{footer}</div> : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- 商品表单 */

export function ProductFormModal({
  initial,
  onClose,
  onSave,
  extraActions
}: {
  initial?: Product;
  onClose: () => void;
  onSave: (input: ProductInput) => void | Promise<void>;
  extraActions?: ReactNode;
}) {
  const [name, setName] = useState(initial?.name ?? '');
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
        <div className="stack-sm">
          <Btn block onClick={submit}>
            保存
          </Btn>
          {extraActions}
        </div>
      }
    >
      <div className="page-stack">
        <Field label="商品名">
          <input
            className="glass-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="比如：大地红 1000 响"
            autoFocus
          />
        </Field>

        <Field label="分类">
          <div className="chip-row">
            {CATEGORIES.map((c) => (
              <button
                key={c}
                type="button"
                className={`glass-badge glass-badge--md glass-badge--interactive ${
                  category === c ? 'glass-badge--selected' : ''
                }`}
                aria-pressed={category === c}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </Field>

        <div className="form-row">
          <Field label="基本单位">
            <input
              className="glass-input"
              value={unitBase}
              onChange={(e) => setUnitBase(e.target.value)}
              placeholder="个 / 挂 / 支"
            />
          </Field>
          <Field label="1 箱 = ? 个">
            <input
              className="glass-input"
              inputMode="numeric"
              value={boxQty}
              onChange={(e) => setBoxQty(e.target.value.replace(/[^\d]/g, ''))}
              placeholder="不拆零填 0"
            />
          </Field>
        </div>

        <Field label={`零售标价（元 / ${unitBase || '个'}）`}>
          <input
            className="glass-input"
            inputMode="decimal"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="12.50"
          />
        </Field>

        <label className="check-row">
          <input
            type="checkbox"
            className="glass-checkbox"
            checked={negotiable}
            onChange={(e) => setNegotiable(e.target.checked)}
          />
          允许现场砍价改价
        </label>

        {err ? <div className="glass-status">{err}</div> : null}
      </div>
    </Sheet>
  );
}