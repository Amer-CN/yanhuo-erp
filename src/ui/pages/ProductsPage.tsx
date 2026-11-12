import { useMemo, useState } from 'react';
import { Plus, Package, ChevronRight, Power, Trash2 } from 'lucide-react';
import type { Product } from '../../db/types';
import { createProduct, deleteProduct, updateProduct, type ProductInput } from '../../db/repo';
import { fenToStr, qtyToStr } from '../../db/util';
import {
  Btn,
  ConfirmSheet,
  Empty,
  ProductFormModal,
  SearchField,
  rowProps,
  type Done
} from '../kit';

export default function ProductsPage({
  products,
  inv,
  onDone,
  onCreated
}: {
  products: Product[];
  inv: Map<string, number>;
  onDone: Done;
  /**
   * P9：新建成功后的回调（只在「新建」这条路上触发，编辑/停用不触发），参数是新建商品 id。
   * 由上层决定要不要跳回开单页并把这个商品加进本单 ——
   * 从「更多 → 商品管理」进来时上层没有意图，什么也不做，就停在这一页。
   */
  onCreated?: (productId: string) => void;
}) {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Product | 'new' | null>(null);
  const [delConfirm, setDelConfirm] = useState(false);
  // 商品表单与停用/删除都走这里：写库中一律禁点，避免同一商品建两份
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [delError, setDelError] = useState('');

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
    if (saving) return;
    setSaving(true);
    try {
      if (editing === 'new') {
        // createProduct 返回完整的新商品（repo.ts:134），这里只把 id 交给上层
        const created = await createProduct(input);
        onDone('商品已建');
        // 先关表单（路径 B 要留在本页看列表），再按意图决定是否跳回开单页
        setEditing(null);
        onCreated?.(created.id);
      } else if (editing) {
        await updateProduct(editing.id, input);
        onDone('已保存');
        setEditing(null);
      }
    } finally {
      // 失败不 catch：抛回 ProductFormModal，由表单就地显示原因（不关框）
      setSaving(false);
    }
  };

  /** 删除/停用：失败时确认框保持打开并就地提示 */
  const doDelete = async () => {
    if (!editing || editing === 'new' || deleting) return;
    setDeleting(true);
    setDelError('');
    try {
      await deleteProduct(editing.id);
      onDone('已处理');
      setDelConfirm(false);
      setEditing(null);
    } catch (e) {
      setDelError(e instanceof Error ? e.message : '删除失败，稍后重试');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page-stack">
      <div className="row-between">
        <SearchField
          className="grow"
          value={q}
          onChange={setQ}
          placeholder="搜商品"
          label="搜商品"
        />
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
                {...rowProps(() => setEditing(p))}
              >
                <span className="glass-list__leading">
                  <Package size={22} aria-hidden="true" />
                </span>
                <div className="glass-list__content">
                  <div className="glass-list__title-row">
                    <div className="glass-list__title">{p.name}</div>
                    <span className="glass-badge">{p.category}</span>
                    {p.sample ? (
                      <span className="glass-badge glass-badge--warning">示例</span>
                    ) : null}
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
                  <span className="list-edit-hint">编辑</span>
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
                    if (saving) return;
                    setSaving(true);
                    try {
                      await updateProduct(editing.id, { archived: !editing.archived });
                      onDone(editing.archived ? '已启用' : '已停用');
                      setEditing(null);
                    } catch (e) {
                      onDone(`没改上：${e instanceof Error ? e.message : '未知错误'}`, 'error');
                    } finally {
                      setSaving(false);
                    }
                  }}
                  disabled={saving}
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
                  onClick={() => {
                    setDelError('');
                    setDelConfirm(true);
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

      {delConfirm && editing && editing !== 'new' ? (
        <ConfirmSheet
          title={`删除「${editing.name}」？`}
          description={
            <span>
              有进货/销售记录的商品不会被删，只会停用。
              {delError ? (
                <>
                  <br />
                  <span className="glass-hint glass-hint--error" role="alert">
                    {delError}
                  </span>
                </>
              ) : null}
            </span>
          }
          confirmText="删除"
          danger
          busy={deleting}
          onConfirm={() => void doDelete()}
          onCancel={() => {
            setDelConfirm(false);
            setDelError('');
          }}
        />
      ) : null}
    </div>
  );
}