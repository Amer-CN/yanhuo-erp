import { useMemo, useState } from 'react';
import { Search, Package, Sparkles } from 'lucide-react';
import type { Category, Product } from '../db/types';
import { CATEGORIES } from '../db/types';
import { fenToStr, qtyToStr } from '../db/util';
import { Btn, Empty, Sheet } from './kit';

/**
 * 选商品：点选加入本单，Sheet 保持打开；点"完成"回单据。
 * 已加角标显示本单数量；库存 ≤0 仍可加，只提示"账面 0"。
 */
export default function ProductPicker({
  products,
  inv,
  selected,
  onAdd,
  onDone,
  onCreate
}: {
  products: Product[];
  inv: Map<string, number>;
  /** productId → 本单已加的基本单位数量 */
  selected: Map<string, number>;
  onAdd: (p: Product) => void;
  onDone: () => void;
  onCreate?: () => void;
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

  const selectedKinds = selected.size;

  return (
    <Sheet
      title="选商品"
      subtitle={selectedKinds > 0 ? `本单已加 ${selectedKinds} 种` : '点商品加入本单'}
      onClose={onDone}
      footer={
        <Btn block onClick={onDone}>
          完成（回单据）
        </Btn>
      }
    >
      <div className="page-stack">
        <div className="glass-search">
          <Search className="glass-search__icon" size={18} aria-hidden="true" />
          <input
            className="glass-input"
            type="search"
            placeholder="搜商品名"
            aria-label="搜商品名"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            autoFocus
          />
        </div>

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
              const stock = inv.get(p.id) ?? 0;
              const added = selected.get(p.id) ?? 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  className={`prod-btn ${added > 0 ? 'is-added' : ''}`}
                  onClick={() => onAdd(p)}
                  aria-label={`${p.name}，¥${fenToStr(p.priceList)}，${added > 0 ? `本单已加 ${added}` : '未添加'}`}
                >
                  <span className="prod-btn__name">{p.name}</span>
                  <span className="prod-btn__price">¥{fenToStr(p.priceList)}</span>
                  <span className="prod-btn__meta">
                    /{p.unitBase}
                    {p.boxQty > 1 ? ` · 1箱${p.boxQty}${p.unitBase}` : ''}
                  </span>
                  <span className={`prod-btn__stock ${stock < 0 ? 'low' : ''}`}>
                    {stock <= 0 ? '账面 0' : `库存 ${qtyToStr(stock, p.boxQty, p.unitBase)}`}
                  </span>
                  {added > 0 ? <span className="prod-btn__added">已加 {added}</span> : null}
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
    </Sheet>
  );
}