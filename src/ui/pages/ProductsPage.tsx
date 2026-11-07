import { useMemo, useState } from 'react';
import type { Product } from '../../db/types';
import { createProduct, deleteProduct, updateProduct, type ProductInput } from '../../db/repo';
import { fenToStr, qtyToStr } from '../../db/util';
import { Btn, Card, Empty, ProductFormModal } from '../kit';

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
      .sort((a, b) => Number(a.archived) - Number(b.archived) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh'));
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
    <div className="page">
      <div className="row">
        <div className="search grow">
          <input className="input" placeholder="搜商品" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Btn onClick={() => setEditing('new')}>＋ 新建</Btn>
      </div>

      {list.length === 0 ? (
        <Empty icon="🏷️" text="还没有商品，点右上角新建" />
      ) : (
        <Card flush>
          <div className="list">
            {list.map((p) => {
              const stock = inv.get(p.id) ?? 0;
              return (
                <div key={p.id} className="list-item">
                  <div className="main" onClick={() => setEditing(p)}>
                    <div className="t1">
                      {p.name}
                      <span className="badge">{p.category}</span>
                      {p.archived ? <span className="badge bad">已停用</span> : null}
                    </div>
                    <div className="t2">
                      ¥{fenToStr(p.priceList)}/{p.unitBase}
                      {p.boxQty > 1 ? ` · 1箱=${p.boxQty}${p.unitBase}` : ''}
                      {p.negotiable ? ' · 可砍价' : ''}
                    </div>
                    <div className="t2">库存 {qtyToStr(stock, p.boxQty, p.unitBase)}</div>
                  </div>
                  <Btn
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      await updateProduct(p.id, { archived: !p.archived });
                      onDone(p.archived ? '已启用' : '已停用');
                    }}
                  >
                    {p.archived ? '启用' : '停用'}
                  </Btn>
                  <Btn
                    variant="danger"
                    size="sm"
                    onClick={async () => {
                      if (!confirm(`删除「${p.name}」？有进货/销售记录的商品不会被删，只会停用。`)) return;
                      await deleteProduct(p.id);
                      onDone('已处理');
                    }}
                  >
                    删
                  </Btn>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {editing ? (
        <ProductFormModal
          initial={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
          onSave={save}
        />
      ) : null}
    </div>
  );
}