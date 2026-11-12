import { useMemo, useState } from 'react';
import { Search, Package, Sparkles } from 'lucide-react';
import type { Category, Product } from '../db/types';
import { CATEGORIES } from '../db/types';
import { fenToStr, qtyToStr } from '../db/util';
import { Btn, Empty, SearchField, Sheet } from './kit';

/** 空角标：'pick' 模式（进货选商品）没有「本单已加」概念，用同一个常量省一次 new Map */
const EMPTY_QTY = new Map<string, number>();

/**
 * 选商品弹层，两个模式共用同一套「搜索 + 分类 chip + 玻璃列表」：
 *
 * - `mode='add'`（默认，记账页）：点一行把该商品加入本单，弹层保持打开，
 *   行上显示「已加 N」，底部有「完成（回单据）」。
 * - `mode='pick'`（进货页）：点一行就是「选中这个商品」，回调 `onPick` 后由调用方
 *   关闭弹层并把商品回填到表单。没有「已加 / 完成」，因为这里不存在「一单多品」。
 *
 * 为什么进货页不再用原生 `<select>`：移动端展开的是系统白底列表 + 单选圈，
 * 样式完全不受控（深色玻璃界面里冒出一块白），而且**没法搜索**——货一多，
 * 只能在几十项里上下翻。复用这一个组件，两个入口的选货体验就一致了。
 */
export default function ProductPicker({
  products,
  inv,
  selected,
  onAdd,
  onDone,
  onCreate,
  arming = false,
  mode = 'add',
  onPick,
  fullHeight = true
}: {
  products: Product[];
  /** productId → 当前库存（基本单位）。不传则不显示库存行（进货页没有 inv 数据源） */
  inv?: Map<string, number>;
  /** productId → 本单已加的基本单位数量（仅 'add' 模式） */
  selected?: Map<string, number>;
  /** 加入本单（仅 'add' 模式） */
  onAdd?: (p: Product) => void;
  /** 关闭弹层（点「完成」/ 右上角 X / 遮罩 / 返回键都会走到这里） */
  onDone: () => void;
  onCreate?: () => void;
  /**
   * 入场锁定（P1）：连续开单保存后这一层是「自动弹」的，开出来的头 400ms
   * 不响应触摸，避免手指连点直接加到商品 / 点掉「完成」。细则见 kit.tsx 的 Sheet。
   */
  arming?: boolean;
  /** 'add' = 加入本单（记账页）；'pick' = 选中一个商品并回调（进货页） */
  mode?: 'add' | 'pick';
  /** 仅 'pick' 模式：点中一行时回调，调用方负责回填并关闭弹层 */
  onPick?: (p: Product) => void;
  /**
   * 全屏（默认 true）：高度 100dvh，顶部不露出背景，列表区是唯一滚动容器。
   * 由 `.picker--full` + CSS `:has()` 作用到承载它的 Sheet 面板上，
   * 不需要改 kit 的 Sheet 接口；浏览器不支持 :has() 时会退回 90dvh，仍可正常用。
   */
  fullHeight?: boolean;
}) {
  const [q, setQ] = useState('');
  const [cat, setCat] = useState<'全部' | Category>('全部');

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return products
      .filter((p) => !p.archived)
      .filter((p) => (cat === '全部' ? true : p.category === cat))
      .filter((p) => (kw ? p.name.toLowerCase().includes(kw) : true))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh'));
  }, [products, cat, q]);

  const selectedQty = selected ?? EMPTY_QTY;
  const selectedKinds = selectedQty.size;
  const picking = mode === 'pick';

  const handleRow = (p: Product) => {
    if (picking) {
      onPick?.(p);
      return;
    }
    onAdd?.(p);
  };

  return (
    // 不聚焦搜索框：摊位开单是「点商品」而不是打字，一打开就弹输入法会把半屏
    // 商品盖掉（诉求 1）。2026-11-11 起 Sheet 默认就是 'panel'，这里保留显式声明，
    // 让「这一层故意不抢焦点」在调用处一眼可见，不会被后来者当成漏改。
    <Sheet
      title="选商品"
      subtitle={
        picking
          ? '点一个商品'
          : selectedKinds > 0
            ? `本单已加 ${selectedKinds} 种`
            : '点商品加入本单'
      }
      initialFocus="panel"
      arming={arming}
      onClose={onDone}
      footer={
        picking ? undefined : (
          <Btn block onClick={onDone}>
            完成（回单据）
          </Btn>
        )
      }
    >
      {/*
       * 结构：头部（Sheet 自带，不滚）+ 筛选区（不滚）+ 列表区（唯一滚动容器）
       * + 底部按钮（Sheet 的 footer，不滚）。全屏时由 CSS 把 .glass-sheet__body
       * 变成 flex 列、只给 .picker__list 打开 overflow —— 页面本身不滚，
       * 商品 50 个时搜索框和「完成」也始终留在屏幕上。
       */}
      <div className={`picker ${fullHeight ? 'picker--full' : ''}`}>
        <div className="picker__filters">
          <SearchField
            value={q}
            onChange={setQ}
            placeholder="搜商品名"
            label="搜商品名"
          />

          <div className="chip-row">
            {(['全部', ...CATEGORIES] as const).map((c) => (
              <button
                key={c}
                type="button"
                className={`glass-badge glass-badge--md glass-badge--interactive ${
                  cat === c ? 'glass-badge--selected' : ''
                }`}
                aria-pressed={cat === c}
                onClick={() => setCat(c)}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        <div className="picker__list">
          {list.length === 0 ? (
            <Empty
              icon={q.trim() ? <Search size={24} /> : <Package size={24} />}
              text={q.trim() ? '没搜到这个商品' : '还没有商品'}
              action={
                <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
                  {q.trim() ? (
                    <Btn block={false} variant="secondary" size="sm" onClick={() => setQ('')}>
                      看全部
                    </Btn>
                  ) : null}
                  {onCreate ? (
                    <Btn block={false} size="sm" onClick={onCreate}>
                      去建商品
                    </Btn>
                  ) : null}
                </div>
              }
            />
          ) : (
            <div className="product-grid">
              {list.map((p) => {
                const stock = inv?.get(p.id) ?? 0;
                const added = picking ? 0 : selectedQty.get(p.id) ?? 0;
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`prod-btn ${added > 0 ? 'is-added' : ''}`}
                    onClick={() => handleRow(p)}
                    aria-label={
                      picking
                        ? `${p.name}，¥${fenToStr(p.priceList)}，选择这个商品`
                        : `${p.name}，¥${fenToStr(p.priceList)}，${
                            added > 0 ? `本单已加 ${added}` : '未添加'
                          }`
                    }
                  >
                    <span className="prod-btn__name">{p.name}</span>
                    <span className="prod-btn__price">¥{fenToStr(p.priceList)}</span>
                    <span className="prod-btn__meta">
                      /{p.unitBase}
                      {p.boxQty > 1 ? ` · 1箱${p.boxQty}${p.unitBase}` : ''}
                      {/*
                        已加 N 从「左侧绝对定位角标」改成元信息里的行内小胶囊：
                        绝对定位必须给所有行预留 44px 左边距，名称会被白白挤窄，
                        而且加了货的行与没加的行文字不对齐。行内胶囊不动布局。
                      */}
                      {added > 0 ? <span className="prod-btn__added">已加 {added}</span> : null}
                    </span>
                    {/* 进货页没有 inv 数据源：宁可不显示库存，也不显示误导性的「账面 0」 */}
                    {inv ? (
                      <span className={`prod-btn__stock ${stock < 0 ? 'low' : ''}`}>
                        {stock <= 0 ? '账面 0' : `库存 ${qtyToStr(stock, p.boxQty, p.unitBase)}`}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          )}

          {products.length === 0 ? (
            <div className="glass-status">
              <Sparkles size={18} aria-hidden="true" />
              <p>先在「更多 → 商品管理」建几个货，再回来记账。</p>
            </div>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}