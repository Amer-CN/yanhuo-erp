import {
  cloneElement,
  forwardRef,
  isValidElement,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode
} from 'react';
import { X, CheckCircle2, TriangleAlert } from 'lucide-react';
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

export const Btn = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: BtnVariant;
    size?: 'sm' | 'lg';
    block?: boolean;
  }
>(function Btn(
  { variant = 'primary', size, block = true, className = '', children, type = 'button', ...rest },
  ref
) {
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
    <button ref={ref} type={type} className={cls} {...rest}>
      {children}
    </button>
  );
});

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

/** 给 label + 控件做程序化关联；错误/提示自动挂 aria-describedby */
export function Field({
  label,
  children,
  hint,
  error
}: {
  label?: string;
  children: ReactNode;
  hint?: string;
  error?: string;
}) {
  const auto = useId();
  const id = `f-${auto}`;
  const desc = error || hint;
  const describedBy = desc ? `${id}-desc` : undefined;

  let control = children;
  if (isValidElement(children)) {
    const el = children as ReactElement<{ id?: string; className?: string; 'aria-describedby'?: string }>;
    const ownClass = el.props.className ?? '';
    control = cloneElement(el, {
      id,
      'aria-describedby': describedBy,
      className: error ? `${ownClass} glass-input--error`.trim() : ownClass
    });
  }

  return (
    <div className="glass-input-group">
      {label ? (
        <label className="glass-label" htmlFor={id}>
          {label}
        </label>
      ) : null}
      {control}
      {error ? (
        <span className="glass-hint glass-hint--error" id={describedBy}>
          {error}
        </span>
      ) : hint ? (
        <span className="glass-hint" id={describedBy}>
          {hint}
        </span>
      ) : null}
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

/** li 行也能用键盘：Enter / Space 触发 */
export function rowProps(onClick: () => void) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    onClick,
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onClick();
      }
    }
  };
}

/* ---------------------------------------------------------------- 提示条 */

export type ToastTone = 'success' | 'error' | 'warning';

/** 页面统一的反馈回调：第二个参数决定语气，第三个参数可带“撤销”等动作 */
export type Done = (
  msg: string,
  tone?: ToastTone,
  action?: { label: string; onClick: () => void }
) => void;

export function Toast({
  message,
  tone = 'success',
  action,
  onAction,
  onClose,
  onPause,
  onResume
}: {
  message: string;
  tone?: ToastTone;
  action?: string;
  onAction?: () => void;
  onClose?: () => void;
  onPause?: () => void;
  onResume?: () => void;
}) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'error' ? X : TriangleAlert;
  return (
    <div
      className={`glass-toast glass-toast--${tone} is-visible toast`}
      role={tone === 'error' ? 'alert' : 'status'}
      aria-live={tone === 'error' ? 'assertive' : 'polite'}
      onMouseEnter={onPause}
      onMouseLeave={onResume}
      onFocus={onPause}
      onBlur={onResume}
    >
      <Icon className="glass-toast__icon" size={20} aria-hidden="true" />
      <span className="glass-toast__text">{message}</span>
      {action && onAction ? (
        <button className="glass-toast__action" type="button" onClick={onAction}>
          {action}
        </button>
      ) : null}
      {onClose ? (
        <button className="glass-toast__close" type="button" aria-label="关闭" onClick={onClose}>
          <X size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

/* ---------------------------------------------------------------- 底部弹层 */

export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  dismissible = true
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** false = 结账中/保存中，禁止遮罩、Esc 与关闭按钮 */
  dismissible?: boolean;
}) {
  const [active, setActive] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;

  useEffect(() => {
    const raf = requestAnimationFrame(() => setActive(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    const scrollY = window.scrollY;
    document.body.style.position = 'fixed';
    document.body.style.top = `-${scrollY}px`;
    document.body.style.width = '100%';

    const focusable = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );

    const items = focusable();
    // 优先聚焦内容区第一个控件（如搜索框），关闭按钮放最后兜底
    const first = items.find((el) => !el.classList.contains('glass-sheet__close')) ?? items[0];
    (first ?? panelRef.current)?.focus({ preventScroll: true });

    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        if (dismissibleRef.current) close();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.position = '';
      document.body.style.top = '';
      document.body.style.width = '';
      window.scrollTo(0, scrollY);
      prevFocus?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    setActive(false);
    window.setTimeout(() => onCloseRef.current(), 260);
  };

  return (
    <div
      className={`glass-sheet-overlay ${active ? 'is-active' : ''}`}
      onClick={dismissible ? close : undefined}
    >
      <div
        ref={panelRef}
        className="glass-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="glass-sheet__grip" aria-hidden="true" />
        <div className="glass-sheet__head">
          <div className="glass-sheet__heading">
            <h2 className="glass-sheet__title" id={titleId}>
              {title}
            </h2>
            {subtitle ? <div className="glass-sheet__subtitle">{subtitle}</div> : null}
          </div>
          <button
            ref={closeRef}
            className="glass-sheet__close"
            type="button"
            onClick={close}
            aria-label="关闭"
            disabled={!dismissible}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="glass-sheet__body">{children}</div>
        {footer ? <div className="glass-sheet__actions">{footer}</div> : null}
      </div>
    </div>
  );
}

/** 统一确认弹层：替代原生 confirm()，支持 danger 语气 */
export function ConfirmSheet({
  title,
  description,
  confirmText = '确定',
  cancelText = '取消',
  danger,
  busy,
  onConfirm,
  onCancel
}: {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Sheet
      title={title}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <div className="stack-sm">
          <Btn variant={danger ? 'danger' : 'primary'} block disabled={busy} onClick={onConfirm}>
            {busy ? '处理中…' : confirmText}
          </Btn>
          <Btn variant="secondary" block disabled={busy} onClick={onCancel}>
            {cancelText}
          </Btn>
        </div>
      }
    >
      {description ? <p className="muted-text" style={{ margin: 0 }}>{description}</p> : null}
    </Sheet>
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
          <Field label={`1 箱 = ? ${unitBase || '个'}`}>
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