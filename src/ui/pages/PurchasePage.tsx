import { useMemo, useState } from 'react';
import { Plus, Trash2, PackagePlus } from 'lucide-react';
import type { Batch, Product } from '../../db/types';
import { createBatch, createProduct, deleteBatch } from '../../db/repo';
import { fenToStr, localDate, qtyToStr, strToFen } from '../../db/util';
import { Btn, Card, Empty, Field, ProductFormModal, Sheet, rowProps, type Done } from '../kit';

export default function PurchasePage({
  products,
  batches,
  deviceId,
  onDone
}: {
  products: Product[];
  batches: Batch[];
  deviceId: string;
  onDone: Done;
}) {
  const active = useMemo(
    () => products.filter((p) => !p.archived).sort((a, b) => a.name.localeCompare(b.name, 'zh')),
    [products]
  );
  const [productId, setProductId] = useState('');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState<'base' | 'box'>('base');
  const [cost, setCost] = useState('');
  const [batchNo, setBatchNo] = useState('');
  const [produceDate, setProduceDate] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [supplier, setSupplier] = useState('');
  const [receivedAt, setReceivedAt] = useState(localDate());
  const [newProduct, setNewProduct] = useState(false);
  const [todayOpen, setTodayOpen] = useState(false);
  const [errors, setErrors] = useState<{ product?: string; qty?: string; cost?: string }>({});

  const product = active.find((p) => p.id === productId);
  const factor = unit === 'box' && product && product.boxQty > 1 ? product.boxQty : 1;

  const qtyNum = Number(qty) || 0;
  const qtyBase = Math.round(qtyNum * factor);
  const costFen = strToFen(cost) ?? 0;
  const unitCostFen = Math.max(0, Math.round(costFen / factor));
  const totalCost = qtyBase * unitCostFen;

  const today = localDate();
  const todayBatches = useMemo(
    () =>
      batches
        .filter((b) => b.receivedAt === today)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 30),
    [batches, today]
  );

  const pname = (id: string) => products.find((p) => p.id === id)?.name ?? '(已删)';

  const resetForm = () => {
    setQty('1');
    setCost('');
    setBatchNo('');
    setProduceDate('');
    setExpiryDate('');
    setErrors({});
  };

  const save = async () => {
    const next: typeof errors = {};
    if (!product) next.product = '先选一个商品';
    if (qtyBase <= 0) next.qty = '数量要大于 0';
    if (strToFen(cost) === null) next.cost = '进价填个数字，比如 120 或 12.5';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    await createBatch(
      {
        productId: product!.id,
        qtyBase,
        unitCostFen,
        batchNo: batchNo || undefined,
        produceDate: produceDate || undefined,
        expiryDate: expiryDate || undefined,
        supplier: supplier || undefined,
        receivedAt
      },
      deviceId
    );
    onDone(`已进货 ${product!.name} ${qtyToStr(qtyBase, product!.boxQty, product!.unitBase)}`);
    resetForm();
  };

  return (
    <div className="page-stack">
      <Card>
        <div className="form-head">
          <h2>录入进货</h2>
          <Btn block={false} variant="tertiary" size="sm" onClick={() => setNewProduct(true)}>
            <span className="icon-text">
              <Plus size={16} aria-hidden="true" /> 新建商品
            </span>
          </Btn>
        </div>

        <div className="page-stack" style={{ marginTop: 10 }}>
          <Field label="商品" error={errors.product}>
            <select
              className="glass-select"
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                setUnit('base');
                setErrors((p) => ({ ...p, product: undefined }));
              }}
            >
              <option value="" disabled hidden>
                选择商品…
              </option>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          {product && product.boxQty > 1 ? (
            <div className="glass-segmented glass-segmented--full" role="group" aria-label="进货单位">
              <button
                type="button"
                className="glass-segmented__item"
                aria-pressed={unit === 'base'}
                onClick={() => setUnit('base')}
              >
                按{product.unitBase}
              </button>
              <button
                type="button"
                className="glass-segmented__item"
                aria-pressed={unit === 'box'}
                onClick={() => setUnit('box')}
              >
                按箱（1箱={product.boxQty}
                {product.unitBase}）
              </button>
            </div>
          ) : null}

          <div className="form-row">
            <Field label={`数量（${unit === 'box' ? '箱' : product?.unitBase ?? '个'}）`} error={errors.qty}>
              <input
                className="glass-input"
                inputMode="decimal"
                value={qty}
                onChange={(e) => {
                  setQty(e.target.value);
                  setErrors((p) => ({ ...p, qty: undefined }));
                }}
              />
            </Field>
            <Field label={`进价（元 / ${unit === 'box' ? '箱' : product?.unitBase ?? '个'}）`} error={errors.cost}>
              <input
                className="glass-input"
                inputMode="decimal"
                value={cost}
                onChange={(e) => {
                  setCost(e.target.value);
                  setErrors((p) => ({ ...p, cost: undefined }));
                }}
                placeholder="120"
              />
            </Field>
          </div>

          {qtyBase > 0 && strToFen(cost) !== null ? (
            <p className="tiny-text" style={{ margin: 0 }}>
              折算：{qtyToStr(qtyBase, product?.boxQty ?? 0, product?.unitBase ?? '个')} · 成本合计 ¥
              {fenToStr(totalCost)}
            </p>
          ) : null}

          <Btn block onClick={save}>
            保存这一条
          </Btn>

          <details className="purchase-extra">
            <summary>批次信息（可选：批号、生产日期、有效期、厂家）</summary>
            <div className="page-stack" style={{ marginTop: 10 }}>
              <div className="form-row">
                <Field label="批号">
                  <input
                    className="glass-input"
                    value={batchNo}
                    onChange={(e) => setBatchNo(e.target.value)}
                  />
                </Field>
                <Field label="到货日期">
                  <input
                    className="glass-input"
                    type="date"
                    value={receivedAt}
                    onChange={(e) => setReceivedAt(e.target.value)}
                  />
                </Field>
              </div>

              <div className="form-row">
                <Field label="生产日期">
                  <input
                    className="glass-input"
                    type="date"
                    value={produceDate}
                    onChange={(e) => setProduceDate(e.target.value)}
                  />
                </Field>
                <Field label="有效期至">
                  <input
                    className="glass-input"
                    type="date"
                    value={expiryDate}
                    onChange={(e) => setExpiryDate(e.target.value)}
                  />
                </Field>
              </div>

              <Field label="供货厂家">
                <input
                  className="glass-input"
                  value={supplier}
                  onChange={(e) => setSupplier(e.target.value)}
                />
              </Field>
            </div>
          </details>

          <p className="tiny-text" style={{ margin: 0 }}>
            照着纸质送货单一条条录，录完一条必填项会清空，商品和批次信息保留。
          </p>
        </div>
      </Card>

      <ul className="glass-list">
        <li
          className="glass-list__item glass-list__item--interactive list-item"
          {...rowProps(() => setTodayOpen(true))}
        >
          <span className="glass-list__leading">
            <PackagePlus size={22} aria-hidden="true" />
          </span>
          <div className="glass-list__content">
            <div className="glass-list__title">今天已录 {todayBatches.length} 条</div>
            <div className="glass-list__subtitle">点开看明细 / 删错</div>
          </div>
        </li>
      </ul>

      {todayOpen ? (
        <Sheet title="今天录入的进货" onClose={() => setTodayOpen(false)}>
          {todayBatches.length === 0 ? (
            <Empty icon={<PackagePlus size={24} />} text="今天还没录进货" />
          ) : (
            <div className="stack-sm">
              {todayBatches.map((b) => {
                const p = products.find((x) => x.id === b.productId);
                return (
                  <div key={b.id} className="mini-card">
                    <div className="row-between">
                      <div className="grow">
                        <div className="cart-line__name">{pname(b.productId)}</div>
                        <div className="cart-line__meta">
                          {qtyToStr(b.qtyBase, p?.boxQty ?? 0, p?.unitBase ?? '个')} · 进价 ¥
                          {fenToStr(b.unitCostFen)}/{p?.unitBase ?? '个'} · 合计 ¥
                          {fenToStr(b.qtyBase * b.unitCostFen)}
                        </div>
                        {b.batchNo || b.expiryDate ? (
                          <div className="cart-line__meta">
                            {b.batchNo ? `批号 ${b.batchNo}` : ''}
                            {b.expiryDate ? ` · 有效期至 ${b.expiryDate}` : ''}
                          </div>
                        ) : null}
                      </div>
                      <Btn
                        block={false}
                        variant="danger"
                        size="sm"
                        aria-label={`删除 ${pname(b.productId)} 这条进货`}
                        onClick={async () => {
                          if (!confirm('删除这条进货记录？')) return;
                          await deleteBatch(b.id);
                          onDone('已删除', 'warning');
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </Btn>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Sheet>
      ) : null}

      {newProduct ? (
        <ProductFormModal
          onClose={() => setNewProduct(false)}
          onSave={async (input) => {
            const p = await createProduct(input);
            setProductId(p.id);
            setNewProduct(false);
            onDone('商品已建');
          }}
        />
      ) : null}
    </div>
  );
}