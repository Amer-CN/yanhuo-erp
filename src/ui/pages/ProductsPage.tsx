import { useMemo, useState } from 'react';
import { Search, Plus, Package, ChevronRight, Power, Trash2 } from 'lucide-react';
import type { Product } from '../../db/types';
import { createProduct, deleteProduct, updateProduct, type ProductInput } from '../../db/repo';
import { fenToStr, qtyToStr } from '../../db/util';
import { Btn, Empty, ProductFormModal } from '../kit';

export default function ProductsPage({
  products,
  inv,
  onDone
}: {
  products: Product[];
  inv: Map<string, number>;
  onDone: (msg: string) => void;
}) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return products
      .filter((p) => (kw ? p.name.toLowerCase().includes(kw) : true))
      .sort(
        (a, b) =>
          Number(a.archived) - Number(b.archived) ||
          a.sortOrder - b.sortOrder ||
          a.name.localeCompare(b.name, 'zh')
      );
  }, [products, q]);

  const save = async (input: ProductInput) => {
    if (editing === 'new') {
      await createProduct(input);
      onDone('商品已建');
    } else if (editing) {
      await updateProduct(editing.id, input);
      onDone('已保存');
    }
    setEditing(null);
  };

  return (
    <div className="page-stack">
      <div className="row-between">
        <div className="glass-search grow">
          <Search className="glass-search__icon" size={18} aria-hidden="true" />
          <input
            className="glass-input"
            type="search"
            placeholder="搜商品"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <Btn block={false} onClick={() => setEditing('new')}>
          <span className="icon-text">
            <Plus size={18} aria-hidden="true" /> 新建
          </span>
        </Btn>
      </div>

      {list.length === 0 ? (
        <Empty
          icon={<Package size={24} />}
          text="还没有商品"
          action={
            <Btn block={false} size="sm" onClick={() => setEditing('new')}>
              新建商品
            </Btn>
          }
        />
      ) : (
        <ul className="glass-list">
          {list.map((p) => {
            const stock = inv.get(p.id) ?? 0;
            return (
              <li
                key={p.id}
                className="glass-list__item glass-list__item--interactive list-item"
                role="button"
                tabIndex={0}
                onClick={() => setEditing(p)}
              >
                <span className="glass-list__leading">
                  <Package size={22} aria-hidden="true" />
                </span>
                <div className="glass-list__content">
                  <div className="glass-list__title-row">
                    <div className="glass-list__title">{p.name}</div>
                    <span className="glass-badge">{p.category}</span>
                    {p.archived ? (
                      <span className="glass-badge glass-badge--error">已停用</span>
                    ) : null}
                  </div>
                  <div className="glass-list__subtitle">
                    ¥{fenToStr(p.priceList)}/{p.unitBase}
                    {p.boxQty > 1 ? ` · 1箱=${p.boxQty}${p.unitBase}` : ''}
                    {p.negotiable ? ' · 可砍价' : ''}
                  </div>
                  <div className="glass-list__subtitle">
                    库存 {qtyToStr(stock, p.boxQty, p.unitBase)}
                  </div>
                </div>
                <div className="glass-list__trailing">
                  <ChevronRight size={18} aria-hidden="true" />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {editing ? (
        <ProductFormModal
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={save}
          extraActions={
            editing !== 'new' ? (
              <div className="row-between" style={{ gap: 8 }}>
                <Btn
                  block={false}
                  variant="secondary"
                  size="sm"
                  onClick={async () => {
                    await updateProduct(editing.id, { archived: !editing.archived });
                    onDone(editing.archived ? '已启用' : '已停用');
                    setEditing(null);
                  }}
                >
                  <span className="icon-text">
                    <Power size={16} aria-hidden="true" />
                    {editing.archived ? '启用' : '停用'}
                  </span>
                </Btn>
                <Btn
                  block={false}
                  variant="danger"
                  size="sm"
                  onClick={async () => {
                    if (!confirm(`删除「${editing.name}」？有进货/销售记录的商品不会被删，只会停用。`))
                      return;
                    await deleteProduct(editing.id);
                    onDone('已处理');
                    setEditing(null);
                  }}
                >
                  <span className="icon-text">
                    <Trash2 size={16} aria-hidden="true" /> 删除
                  </span>
                </Btn>
              </div>
            ) : undefined
          }
        />
      ) : null}
    </div>
  );
}