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
import { X, Search, CheckCircle2, TriangleAlert } from 'lucide-react';
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

export function Empty({
  icon,
  text,
  hint,
  action,
  compact
}: {
  icon: ReactNode;
  text: string;
  /** 补充说明（可选）：只有标题说不清「接下来会怎样」时才用 */
  hint?: string;
  action?: ReactNode;
  /** 放进已有卡片里时用紧凑档：默认内边距是给整页空态留的 */
  compact?: boolean;
}) {
  return (
    <div className={`glass-empty${compact ? ' glass-empty--compact' : ''}`}>
      <span className="glass-empty__icon">{icon}</span>
      <p className="glass-empty__title">{text}</p>
      {hint ? <p className="glass-empty__text">{hint}</p> : null}
      {action ? <div className="glass-empty__action">{action}</div> : null}
    </div>
  );
}

/**
 * 搜索框：商品管理 / 库存 / 选商品弹层共用。
 *
 * 为什么要抽：同一段 JSX 原来抄了三遍，其中两份连 aria-label 都忘了写
 * （占位符不构成可访问名，读屏只念「搜索」）。收敛后 label 变成必填参数，
 * 新增入口也不会再漏。
 *
 * 为什么自绘清除按钮：WebKit 的 `::-webkit-search-cancel-button` 是系统灰 X，
 * 在深色玻璃框上颜色不受主题控制；CSS 里已把它关掉，这里换成主题色的 X。
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  autoFocus,
  className = '',
  children
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  /** 可访问名（必填）：视觉上不显示，但读屏与测试都靠它定位 */
  label: string;
  autoFocus?: boolean;
  /** 外层 .glass-search 的附加类（如 `grow`） */
  className?: string;
  /** 搜索行里跟在输入框后的额外内容（库存页的「只看缺货」chip） */
  children?: ReactNode;
}) {
  // 清空后把焦点送回输入框：手机上否则会收起键盘，摊主要再点一次才能继续搜
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <div className={`glass-search ${className}`.trim()}>
      <Search className="glass-search__icon" size={18} aria-hidden="true" />
      <span className={`glass-search__field${value ? ' glass-search__field--clear' : ''}`}>
        <input
          ref={inputRef}
          className="glass-input"
          type="search"
          placeholder={placeholder}
          aria-label={label}
          value={value}
          autoFocus={autoFocus}
          onChange={(e) => onChange(e.target.value)}
        />
        {value ? (
          <button
            type="button"
            className="glass-search__clear"
            aria-label={`清空${label}`}
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
          >
            <X size={16} aria-hidden="true" />
          </button>
        ) : null}
      </span>
      {children}
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
      /*
       * 只响应「行自己」拿到焦点时的 Enter / Space（M-07）。
       * 行内可能还嵌着按钮（销售记录的「撤销」、进货明细的删除），它们的 keydown
       * 会冒泡到这一层：老写法下一次 Enter 会同时被当成「撤销」和「打开详情」，
       * 撤销成功后还顺手弹出那张单的明细框。
       */
      if (e.target !== e.currentTarget) return;
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

/** 关闭动画时长：与 tokens.css 的 --yh-dur-sheet（260ms）同值，改 CSS 时这里同步 */
const SHEET_CLOSE_MS = 260;

/**
 * body / 内容区滚动锁引用计数：弹层可以嵌套（确认框开在明细弹层上）。
 * 只有 0→1 的那一层记录滚动位置并上锁，1→0 时才解除并还原；
 * 内层进出不改滚动，否则会读到 scrollTop=0 并把页面弹回顶部。
 *
 * 改造后整页不再滚动，滚动发生在 .app-main 里，此时 window.scrollY 恒为 0，
 * 继续锁 body 等于「锁了个寂寞」——弹层打开时背景列表照样能被手指带走。
 * 所以优先锁滚动容器；容器不存在（或这一页是文档滚动的开单页）才退回锁 body。
 */
let sheetLockCount = 0;
let sheetSavedY = 0;
/** 本次锁的是哪个容器；null = 本次锁的是 body（或尚未上锁） */
let sheetLockScroller: HTMLElement | null = null;

/**
 * 找真正的滚动容器。
 * 1) 页面自己声明了主滚动区（data-scroll-root，例如库存页把滚动下移到列表区）→ 锁它，
 *    此时 .app-main 本来就是 overflow:hidden，锁它等于没锁；
 * 2) 否则锁 .app-main；
 * 3) 开单页的 .app-main 是 overflow:visible（靠文档滚），锁它既锁不住内容，
 *    又会挡住 fixed 底栏，所以显式排除；再兜一层计算样式判断，
 *    免得以后有人把 .app-main 改回 visible 忘了改这里。
 */
function scrollLockTarget(): HTMLElement | null {
  const marked = document.querySelector<HTMLElement>('.app-main [data-scroll-root]');
  const el = marked ?? document.querySelector<HTMLElement>('.app-main');
  if (!el || el.classList.contains('app-main--editor')) return null;
  const { overflowY } = window.getComputedStyle(el);
  return overflowY === 'visible' ? null : el;
}

function lockBodyScroll() {
  if (++sheetLockCount !== 1) return;
  const scroller = scrollLockTarget();
  if (scroller) {
    sheetLockScroller = scroller;
    sheetSavedY = scroller.scrollTop;
    scroller.dataset.locked = '1';
    return;
  }
  sheetLockScroller = null;
  sheetSavedY = window.scrollY;
  document.body.style.position = 'fixed';
  document.body.style.top = `-${sheetSavedY}px`;
  document.body.style.width = '100%';
}

function unlockBodyScroll() {
  if (sheetLockCount === 0) return;
  if (--sheetLockCount !== 0) return;
  const scroller = sheetLockScroller;
  sheetLockScroller = null;
  if (scroller) {
    delete scroller.dataset.locked;
    // overflow:hidden 不会清掉 scrollTop（display:none 才会），所以能原地还原
    scroller.scrollTop = sheetSavedY;
    return;
  }
  document.body.style.position = '';
  document.body.style.top = '';
  document.body.style.width = '';
  window.scrollTo(0, sheetSavedY);
}

/**
 * 弹层栈（按挂载顺序，栈顶 = 最上层）。Esc 只让栈顶响应，
 * 否则一次 Esc 会把确认框和它下面的明细框一起关掉。
 * 只存实例 token，不存组件引用，避免持有已卸载的 DOM。
 */
const sheetStack: symbol[] = [];

function pushSheet(token: symbol) {
  sheetStack.push(token);
}

function popSheet(token: symbol) {
  const i = sheetStack.lastIndexOf(token);
  if (i >= 0) sheetStack.splice(i, 1);
}

/* ------------------------------------------------------- 返回键守卫（P7） */
/**
 * 为什么需要这一层：弹层没有自己的 URL，安卓返回键 / iOS 侧滑走的是浏览器历史，
 * 于是「弹层开着时按返回」会把应用整个退掉（实测停在 about:blank）。草稿还在
 * localStorage 里，但用户会以为刚才那一单丢了。
 *
 * 做法：每打开一层就往历史里 push 一条同名占位记录，返回键先吃掉它。
 * 两个动作必须成对、且都被正确处理，缺一个就会连退或连关：
 *
 * ① 收到 popstate 且栈非空（用户按了返回）：**先 pushState 把位置补回来**，
 *    再关栈顶那一层。补位是为了让「关这一层」与它的卸载清理 back() 一次刚好抵消；
 *    不补位的话，用户每按一次返回都会真的往后走一格，几次之后退出应用。
 * ② 弹层正常关闭（点 X / 完成 / Esc / 上面的 ①）：自己的清理里 back() 掉那条占位记录。
 *    这一次 back() 同样会触发 popstate —— 必须用 suppressNextPop 标记跳过，
 *    否则会被当成「用户又按了一次返回」，把下面那一层也关掉。
 *
 * 栈为空时什么都不做：此时返回键就该生效（退出应用 / 回上一页）。
 * 监听器一直挂着，不随栈空摘除：摘掉后再挂会把 suppressNextPop 留在 true 上，
 * 下一次真正的返回就被吞掉了。常驻一个空转的 popstate 回调代价可以忽略。
 */
const sheetHistory: symbol[] = [];
/** token → 该层「像点关闭那样关掉」的回调 + 当前是否可关（dismissible 会随 busy 变化，所以存取值函数） */
const sheetHistoryEntry = new Map<symbol, { close: () => void; dismissible: () => boolean }>();
/** true = 下一次 popstate 是我们自己 back() 制造的，不能当成用户操作 */
let suppressNextPop = false;
let popGuardBound = false;
/**
 * 已经「欠」调用方几条历史记录待回收（推迟到下一轮事件循环再 back()）。
 * 为什么要推迟：React StrictMode（仅 dev）会把 effect 跑成「挂载 → 清理 → 再挂载」。
 * 如果清理里立刻 back()，这次后退会晚于第二次挂载的 pushState 落地，
 * 结果弹层开着、历史里却已经没有它的占位记录 —— 下一次返回直接退出应用（实测如此）。
 * 推迟一帧后，重挂载的 push 能先把这些待回收项「抵消」掉，位置就不会漂。
 */
let pendingPops = 0;
let popTimer: number | undefined;

function schedulePopFlush() {
  if (popTimer !== undefined) return;
  popTimer = window.setTimeout(flushPendingPops, 0);
}

function flushPendingPops() {
  popTimer = undefined;
  if (pendingPops <= 0) return;
  const state = window.history.state as { __yhSheet?: boolean } | null;
  if (!state?.__yhSheet) {
    pendingPops = 0; // 当前历史项不是我们的，别乱退
    return;
  }
  pendingPops -= 1;
  suppressNextPop = true;
  window.history.back();
  if (pendingPops > 0) schedulePopFlush();
}

function onSheetPopState() {
  if (suppressNextPop) {
    suppressNextPop = false;
    return;
  }
  const token = sheetHistory[sheetHistory.length - 1];
  if (!token) return; // 没有弹层：这次后退就该生效

  // 补回被吃掉的那一格（见上方 ①）
  try {
    window.history.pushState({ __yhSheet: true }, '');
  } catch {
    /* 极端环境（沙箱 iframe）不允许 pushState：退化成「只关层」，不影响主流程 */
  }
  const entry = sheetHistoryEntry.get(token);
  // 忙碌中的弹层（结账中 / 保存中）不能被返回键关掉，但位置已经补回，历史不会漂
  if (entry && entry.dismissible()) entry.close();
}

function ensurePopGuard() {
  if (popGuardBound || typeof window === 'undefined') return;
  window.addEventListener('popstate', onSheetPopState);
  popGuardBound = true;
}

/** 打开一层：入栈 + 历史占位。close / dismissible 都是取值函数，随时反映最新状态 */
function pushSheetHistory(token: symbol, close: () => void, dismissible: () => boolean) {
  sheetHistory.push(token);
  sheetHistoryEntry.set(token, { close, dismissible });
  if (pendingPops > 0) {
    /*
     * 上一轮清理刚要求回收一条、同一轮里又开了新的一层（StrictMode 的重挂载正是这种）：
     * 直接复用那条还没被 back() 掉的占位记录，不再 push —— 多推一条会让位置永久漂一格。
     */
    pendingPops -= 1;
  } else {
    try {
      window.history.pushState({ __yhSheet: true }, '');
    } catch {
      /* 不允许 pushState 的环境：只做栈内记账，返回键回到原行为 */
    }
  }
  ensurePopGuard();
}

/** 关闭一层：出栈 + 回收它那条历史占位（推迟一帧，见 pendingPops 的注释） */
function popSheetHistory(token: symbol) {
  const i = sheetHistory.lastIndexOf(token);
  if (i < 0) return;
  sheetHistory.splice(i, 1);
  sheetHistoryEntry.delete(token);

  const state = window.history.state as { __yhSheet?: boolean } | null;
  if (!state?.__yhSheet) return; // 当前历史项不是我们的占位记录，不要乱退
  pendingPops += 1;
  schedulePopFlush();
}

export function Sheet({
  title,
  subtitle,
  onClose,
  children,
  footer,
  dismissible = true,
  initialFocus = 'panel',
  arming = false
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** false = 结账中/保存中，禁止遮罩、Esc 与关闭按钮 */
  dismissible?: boolean;
  /**
   * 挂载后焦点给谁（2026-11-11 起默认 'panel'，别再改回 'first'）：
   * - 'panel'（默认）= 面板自身（`.glass-sheet` 已 tabIndex={-1}）。
   *   移动端只有「焦点落到 input」才会拉起输入法；默认给面板，
   *   「点开就弹键盘、半屏被盖住」从根上不会发生。aria-modal / 焦点陷阱 /
   *   标题播报 / Esc 栈顶判定全部不变。
   * - 'first' = 面板内第一个非关闭按钮的可聚焦元素。**只给「用户点进来就是要打字」的表单**
   *   （见下方 ProductFormModal：唯一的用法）。逐个弹层打补丁修输入法问题会漏，
   *   所以策略写在默认值上；以后新增弹层除非真的要打字，否则什么都别传。
   */
  initialFocus?: 'first' | 'panel';
  /**
   * 入场锁定（P1 连点穿透）：自动弹出的弹层（例如连续开单时保存后自己开的选商品层）
   * 在开出来的头几百毫秒里不响应触摸 —— 手指还停在上一屏的按钮上，连点会落到
   * 刚出现的商品卡 / 关闭按钮上，于是「一键卖一样货」变成「记三单 + 多卖两样」。
   *
   * 实现是两层，缺一层都不够：
   * 1) 面板 `pointer-events: none`（CSS `.glass-sheet-overlay[data-arming='1'] .glass-sheet`），
   *    卡片、完成键都点不动；
   * 2) 遮罩这时**不挂关闭回调**（见下方 onClick），否则点空的遮罩会把刚开的层关掉。
   * 遮罩本身仍是 pointer-events:auto，所以这一下点击被吞掉、不会穿透到下面的页面。
   * 键盘不受影响（pointer-events 只管指针），可访问性不回退。
   * 手动点「添加商品」打开的层不要传 true：用户是明确要选货，加锁只会觉得卡。
   */
  arming?: boolean;
}) {
  const [active, setActive] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const dismissibleRef = useRef(dismissible);
  dismissibleRef.current = dismissible;
  // 本实例在弹层栈里的身份；跨渲染保持不变（Symbol 只创建一次）
  const tokenRef = useRef<symbol | null>(null);
  if (!tokenRef.current) tokenRef.current = Symbol('sheet');

  useEffect(() => {
    const raf = requestAnimationFrame(() => setActive(true));
    return () => cancelAnimationFrame(raf);
  }, []);

  /**
   * 进出栈跟着「是否已展开」走，而不是跟着挂载走：
   * close() 之后还有 260ms 过渡，父组件通常才卸载；这段时间里已经视觉关闭的
   * 弹层要立刻让出栈顶，否则会一直挡住下面那层的 Esc。
   */
  useEffect(() => {
    const token = tokenRef.current!;
    if (!active) {
      popSheet(token);
      return;
    }
    pushSheet(token);
    return () => popSheet(token);
  }, [active]);

  useEffect(() => {
    const prevFocus = document.activeElement as HTMLElement | null;
    lockBodyScroll();
    // 自己这一层的身份：进栈后才能判断“我是不是最上层”
    const token = tokenRef.current!;

    const focusable = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ) ?? []
      );

    const items = focusable();
    // 焦点落点：'panel' 直接给面板自身（不发键盘），'first' 优先内容区第一个控件（如搜索框），
    // 关闭按钮放最后兜底。initialFocus 是挂载期常量，随 focusable() 一起留在本闭包里即可。
    const target =
      initialFocus === 'panel'
        ? panelRef.current
        : (items.find((el) => !el.classList.contains('glass-sheet__close')) ?? items[0] ?? panelRef.current);
    target?.focus({ preventScroll: true });

    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 只有最上层弹层处理 Esc：嵌套时一次按键只关一层
        if (sheetStack[sheetStack.length - 1] !== token) return;
        e.preventDefault();
        if (dismissibleRef.current) close();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      /*
       * 焦点已经不在面板里（M-15）：initialFocus="panel" 时按 Shift+Tab 会从这里走出去，
       * 或者用户用鼠标点了背景 —— 模态开着却把焦点送到背景页面，是硬伤。
       * 先把它拉回面板内的另一端，再走下面的首尾循环。
       */
      const panelEl = panelRef.current;
      if (panelEl && !panelEl.contains(document.activeElement)) {
        e.preventDefault();
        (e.shiftKey ? lastEl : firstEl).focus();
        return;
      }
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
      popSheet(token);
      unlockBodyScroll();
      prevFocus?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 关闭延时动画的定时器：卸载 / 重复关闭都要清掉，避免打到已卸载的弹层
  const closeTimer = useRef<number | undefined>(undefined);
  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    []
  );

  const close = () => {
    setActive(false);
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => onCloseRef.current(), SHEET_CLOSE_MS);
  };

  /*
   * P7：返回键守卫。挂载时往历史里放一条占位记录，卸载时收回。
   * closeRef 指向「与点 X 完全相同」的关闭动作（setActive(false) + 260ms 后再 onClose），
   * 所以返回键关层不会绕过关闭动画，也不会绕开父组件的清理逻辑。
   * dismissible 用取值函数传进去：忙碌态（结账中 / 保存中）会拒绝返回键。
   */
  const closeFnRef = useRef(close);
  closeFnRef.current = close;
  useEffect(() => {
    const token = tokenRef.current!;
    pushSheetHistory(
      token,
      () => closeFnRef.current(),
      () => dismissibleRef.current
    );
    return () => popSheetHistory(token);
  }, []);

  return (
    <div
      className={`glass-sheet-overlay ${active ? 'is-active' : ''}`}
      /* arming 期间不挂关闭：此时面板 pointer-events:none，点空处会落到遮罩上，
         如果照旧 close()，连点就会把刚弹出来的层立刻关掉（P1）。 */
      onClick={dismissible && !arming ? close : undefined}
      data-arming={arming ? '1' : undefined}
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
  const [saving, setSaving] = useState(false);
  // 分类是「一组按钮」而不是表单控件，不能用 Field 的 label for
  const catLabelId = useId();

  const submit = async () => {
    if (saving) return;
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
    setErr('');
    setSaving(true);
    try {
      await onSave({
        name: name.trim(),
        category,
        unitBase: unitBase.trim() || '个',
        boxQty: bq,
        priceList: priceFen,
        negotiable
      });
    } catch (e) {
      // 失败就留在表单里显示原因：关掉框再说「没存上」用户会以为存过了
      setErr(`没存上：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Sheet
      title={initial ? '编辑商品' : '新建商品'}
      /* 全仓唯一显式要 'first' 的弹层：新建/编辑商品就是「进来先填商品名」，
         焦点直接落在第一个输入框，省一次点击（其它弹层一律用默认 'panel'）。 */
      initialFocus="first"
      onClose={onClose}
      footer={
        <div className="stack-sm">
          <Btn block onClick={submit} disabled={saving}>
            {saving ? '保存中…' : '保存'}
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
          />
        </Field>

        <div role="group" aria-labelledby={catLabelId} className="glass-input-group">
          <div className="glass-label" id={catLabelId}>
            分类
          </div>
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
        </div>

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

        {/*
          * 校验失败统一走 glass-hint--error（与 Field 的错误提示同一套视觉）：
          原来装进 .glass-status 的玻璃卡片里，和表单里 13px 的小红字是两种语气。
          这里用 role="alert" 是因为它是提交后新出现的文本，读屏要念出来。
        */}
        {err ? (
          <div className="glass-hint glass-hint--error" role="alert">
            {err}
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}