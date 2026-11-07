import { useMemo, useState } from 'react';
import type { Batch, Product } from '../../db/types';
import { createBatch, createProduct, deleteBatch } from '../../db/repo';
import { fenToStr, localDate, qtyToStr, strToFen } from '../../db/util';
import { Btn, Card, Empty, Field, ProductFormModal, Sheet } from '../kit';

export default function PurchasePage({
  products,
  batches,
  deviceId,
  onDone
}: {
  products: Product[];
  batches: Batch[];
  deviceId: string;
  onDone: (msg: string) => void;
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

  const product = active.find((p) => p.id === productId);
  const factor = unit === 'box' && product && product.boxQty > 1 ? product.boxQty : 1;

  const qtyNum = Number(qty) || 0;
  const qtyBase = Math.round(qtyNum * factor);
  const costFen = strToFen(cost) ?? 0;
  const unitCostFen = unitCostBase(costFen, factor);
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
  };

  const save = async () => {
    if (!product) {
      onDone('先选一个商品');
      return;
    }
    if (qtyBase <= 0) {
      onDone('数量要大于 0');
      return;
    }
    if (strToFen(cost) === null) {
      onDone('进价填个数字，比如 120 或 12.5');
      return;
    }
    await createBatch(
      {
        productId: product.id,
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
    onDone(`已进货 ${product.name} ${qtyToStr(qtyBase, product.boxQty, product.unitBase)}`);
    resetForm();
  };

  return (
    <div className="page">
      <Card>
        <div className="col">
          <div className="row between">
            <span style={{ fontWeight: 700 }}>录入进货</span>
            <Btn variant="ghost" size="sm" onClick={() => setNewProduct(true)}>
              ＋ 新建商品
            </Btn>
          </div>

          <Field label="商品">
            <select className="select" value={productId} onChange={(e) => setProductId(e.target.value)}>
              <option value="">选择商品…</option>
              {active.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>

          {product && product.boxQty > 1 ? (
            <div className="seg">
              <button className={unit === 'base' ? 'on' : ''} onClick={() => setUnit('base')}>
                按{product.unitBase}
              </button>
              <button className={unit === 'box' ? 'on' : ''} onClick={() => setUnit('box')}>
                按箱（1箱={product.boxQty}{product.unitBase}）
              </button>
            </div>
          ) : null}

          <div className="row" style={{ gap: 10 }}>
            <Field label={`数量（${unit === 'box' ? '箱' : product?.unitBase ?? '个'}）`}>
              <input
                className="input num"
                inputMode="decimal"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
              />
            </Field>
            <Field label={`进价（元 / ${unit === 'box' ? '箱' : product?.unitBase ?? '个'}）`}>
              <input
                className="input num"
                inputMode="decimal"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="120"
              />
            </Field>
          </div>

          {qtyBase > 0 && strToFen(cost) !== null ? (
            <div className="tiny">
              折算：{qtyToStr(qtyBase, product?.boxQty ?? 0, product?.unitBase ?? '个')} ·
              成本合计 ¥{fenToStr(totalCost)}
            </div>
          ) : null}

          <div className="row" style={{ gap: 10 }}>
            <Field label="批号（可空）">
              <input className="input" value={batchNo} onChange={(e) => setBatchNo(e.target.value)} />
            </Field>
            <Field label="到货日期">
              <input
                className="input"
                type="date"
                value={receivedAt}
                onChange={(e) => setReceivedAt(e.target.value)}
              />
            </Field>
          </div>

          <div className="row" style={{ gap: 10 }}>
            <Field label="生产日期（可空）">
              <input
                className="input"
                type="date"
                value={produceDate}
                onChange={(e) => setProduceDate(e.target.value)}
              />
            </Field>
            <Field label="有效期至（可空）">
              <input
                className="input"
                type="date"
                value={expiryDate}
                onChange={(e) => setExpiryDate(e.target.value)}
              />
            </Field>
          </div>

          <Field label="供货厂家（可空）">
            <input className="input" value={supplier} onChange={(e) => setSupplier(e.target.value)} />
          </Field>

          <Btn block size="lg" onClick={save}>
            保存这一条
          </Btn>
          <div className="tiny">照着纸质送货单一条条录，录完一条这条表单会清空，商品保留。</div>
        </div>
      </Card>

      <Card flush>
        <div className="list-item" onClick={() => setTodayOpen(true)}>
          <div className="main">
            <div className="t1">今天已录 {todayBatches.length} 条</div>
            <div className="t2">点开看明细 / 删错</div>
          </div>
          <span className="tiny">›</span>
        </div>
      </Card>

      {todayOpen ? (
        <Sheet
          title="今天录入的进货"
          onClose={() => setTodayOpen(false)}
          footer={
            <Btn block variant="ghost" onClick={() => setTodayOpen(false)}>
              关闭
            </Btn>
          }
        >
          {todayBatches.length === 0 ? (
            <Empty icon="📦" text="今天还没录进货" />
          ) : (
            <div className="col">
              {todayBatches.map((b) => {
                const p = products.find((x) => x.id === b.productId);
                return (
                  <div key={b.id} className="card" style={{ padding: 12 }}>
                    <div className="row between">
                      <div className="grow">
                        <div style={{ fontWeight: 700 }}>{pname(b.productId)}</div>
                        <div className="tiny">
                          {qtyToStr(b.qtyBase, p?.boxQty ?? 0, p?.unitBase ?? '个')} · 进价 ¥
                          {fenToStr(b.unitCostFen)}/{p?.unitBase ?? '个'} · 合计 ¥
                          {fenToStr(b.qtyBase * b.unitCostFen)}
                        </div>
                        {b.batchNo || b.expiryDate ? (
                          <div className="tiny">
                            {b.batchNo ? `批号 ${b.batchNo}` : ''}
                            {b.expiryDate ? ` · 有效期至 ${b.expiryDate}` : ''}
                          </div>
                        ) : null}
                      </div>
                      <Btn
                        variant="danger"
                        size="sm"
                        onClick={async () => {
                          if (!confirm('删除这条进货记录？')) return;
                          await deleteBatch(b.id);
                          onDone('已删除');
                        }}
                      >
                        删
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

function unitCostBase(costPerUnit: number, factor: number): number {
  return Math.max(0, Math.round(costPerUnit / factor));
}