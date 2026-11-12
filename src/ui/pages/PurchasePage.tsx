import { useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Trash2, PackagePlus } from 'lucide-react';
import type { Batch, Product } from '../../db/types';
import { createBatch, createProduct, deleteBatch, RecordError } from '../../db/repo';
import { DELETED_PRODUCT, fenToStr, localDate, qtyToStr, strToFen } from '../../db/util';
import {
  normalizeQtyText,
  QTY_HINT_DECIMAL,
  QTY_HINT_TOO_LONG
} from '../quantityInput';
import { Btn, Card, ConfirmSheet, Empty, Field, ProductFormModal, Sheet, rowProps, type Done } from '../kit';
import ProductPicker from '../ProductPicker';

/** 「今天已录」抽屉只显示最近这么多条；条数统计仍按全量算 */
const TODAY_LIST_LIMIT = 30;

interface PurchaseForm {
  productId: string;
  qty: string;
  unit: 'base' | 'box';
  cost: string;
  batchNo: string;
  produceDate: string;
  expiryDate: string;
  supplier: string;
  receivedAt: string;
}

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
  const [form, setForm] = useState<PurchaseForm>({
    productId: '',
    qty: '1',
    unit: 'base',
    cost: '',
    batchNo: '',
    produceDate: '',
    expiryDate: '',
    supplier: '',
    receivedAt: localDate()
  });
  const { productId, qty, unit, cost, batchNo, produceDate, expiryDate, supplier, receivedAt } = form;
  const patchForm = (patch: Partial<PurchaseForm>) => setForm((f) => ({ ...f, ...patch }));
  const [newProduct, setNewProduct] = useState(false);
  /**
   * 选商品弹层（ProductPicker）。为什么进货页不再直接用原生 `<select>`：
   * 手机上点开的是系统白底列表 + 单选圈，和这套深色玻璃界面完全不是一类；
   * 而且原生 select 不能搜索，货一多只能一格格翻。改用与记账页同一个
   * ProductPicker，既有搜索框和分类 chip，样式也统一。
   */
  const [pickerOpen, setPickerOpen] = useState(false);
  /** 数量框：选完商品把焦点送到这里，摊位顺手就能输数量 */
  const qtyRef = useRef<HTMLInputElement>(null);
  const [todayOpen, setTodayOpen] = useState(false);
  const [delBatchId, setDelBatchId] = useState<string | null>(null);
  // 删除失败的就地提示：已卖出的批次不能删（不能只用 toast，否则用户看不到原因）
  // 必须带上出错的批次 id：提示渲染在 Sheet 内部的失败条目下方，避免被模态遮罩盖住
  const [delError, setDelError] = useState<{ batchId: string; message: string } | null>(null);
  const [errors, setErrors] = useState<{ product?: string; qty?: string; cost?: string }>({});
  /**
   * 数量框的即时提示（P2）：小数 / 超 4 位时在框下说一句，而不是把 1.5 吞成 15。
   * 与 errors.qty（提交时的「数量要大于 0」）分开存，否则打字过程中提示会被提交校验覆盖。
   */
  const [qtyHint, setQtyHint] = useState('');
  const hintTimer = useRef<number | undefined>(undefined);
  // 写库中禁止再点：同一批货录两遍会直接改写 FIFO 成本
  const [saving, setSaving] = useState(false);
  const [delConfirmError, setDelConfirmError] = useState('');
  const [deleting, setDeleting] = useState(false);

  const product = active.find((p) => p.id === productId);
  const factor = unit === 'box' && product && product.boxQty > 1 ? product.boxQty : 1;

  const qtyNum = Number(qty) || 0;
  const qtyBase = Math.round(qtyNum * factor);
  /*
   * costFen 只有「显示折算」会用兜底 0（填了 - 或空就是没填）；
   * 但兜底值绝不能当成进价写库 —— P6：负数原来被 Math.max(0, …) 静默存成 0 成本，
   * 毛利被虚高却看不出来。现在负价在 save() 里直接拦截，这里不再夹。
   */
  const costFen = strToFen(cost) ?? 0;
  const unitCostFen = Math.round(costFen / factor);
  const totalCost = qtyBase * unitCostFen;

  const today = localDate();
  // 统计走全量（原来直接拿截断后的 length 当总数，第 31 条起永远显示 30）
  const todayCount = useMemo(
    () => batches.filter((b) => b.receivedAt === today).length,
    [batches, today]
  );
  const todayBatches = useMemo(
    () =>
      batches
        .filter((b) => b.receivedAt === today)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, TODAY_LIST_LIMIT),
    [batches, today]
  );

  const pname = (id: string) => products.find((p) => p.id === id)?.name ?? DELETED_PRODUCT;

  const flashQtyHint = (text: string) => {
    setQtyHint(text);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    // text 为空 = 主动清掉上一次的提示（输入又合法了，不能让旧红字继续挂着）
    hintTimer.current = text ? window.setTimeout(() => setQtyHint(''), 2200) : undefined;
  };

  // 卸载时清掉计时器：离开进货页后不该再 setState
  useEffect(
    () => () => {
      if (hintTimer.current) window.clearTimeout(hintTimer.current);
    },
    []
  );

  const resetForm = () => {
    patchForm({ qty: '1', cost: '', batchNo: '', produceDate: '', expiryDate: '' });
    setErrors({});
  };

  /** 选中一个商品：回填商品字段并把单位重置为「按基本单位」（与原 select 口径一致） */
  const changeProduct = (id: string) => {
    patchForm({ productId: id, unit: 'base' });
    setErrors((p) => ({ ...p, product: undefined }));
  };

  /**
   * ProductPicker 的 'pick' 模式回调：选中即关弹层。
   * 关闭后弹层卸载会先把焦点还给触发按钮（Sheet 的焦点归还），
   * 所以下一帧再把焦点落到「数量」——用户接下来一定要输数量。
   */
  const pickProduct = (p: Product) => {
    changeProduct(p.id);
    setPickerOpen(false);
    requestAnimationFrame(() => qtyRef.current?.focus({ preventScroll: true }));
  };

  const save = async () => {
    if (saving) return;
    const next: typeof errors = {};
    if (!product) next.product = '先选一个商品';
    if (qtyBase <= 0) next.qty = '数量要大于 0';
    const rawCost = strToFen(cost);
    if (rawCost === null) next.cost = '进价填个数字，比如 120 或 12.5';
    /*
     * P6：负进价直接拦住，不再 Math.max(0, …) 静默存成 0 成本。
     * repo.createBatch 侧也用同一个错误码（INVALID_AMOUNT）兜同步/合并这条旁路，
     * 这里只是把话说在用户看得见的地方。strToFen 已返回「分」，-5 元 → -500 分。
     */
    else if (rawCost < 0) next.cost = '进价不能是负数';
    setErrors(next);
    if (Object.keys(next).length > 0) return;

    setSaving(true);
    try {
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
    } catch (e) {
      // 没存上必须说清楚：否则用户以为录过了，第二遍会改写 FIFO 成本
      onDone(`没存上：${e instanceof Error ? e.message : '未知错误'}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  /** 删除一条进货：失败时确认框保持打开并就地显示原因 */
  const doDeleteBatch = async () => {
    const id = delBatchId;
    if (!id || deleting) return;
    setDeleting(true);
    setDelConfirmError('');
    try {
      await deleteBatch(id);
      setDelError(null);
      /*
       * M-14：这里**没有**「撤销」按钮，是刻意的。
       * 撤销必须「按原 id 把批次恢复」，否则换了 id 就等于凭空多出一条进货，
       * 和已同步/已审计的数据对不上，属于半吊子撤销。db 层目前只有
       * createBatch（repo.ts:240 一律 `id: uuid()`）与 deleteBatch，
       * 没有按 id 恢复的入口，而 db 层不归本次改动 —— 所以如实告诉用户恢复路径。
       */
      onDone('已删除这条进货。删错了可在「设置与同步 → 本地备份 / 导入备份」恢复', 'warning');
      setDelBatchId(null);
    } catch (e) {
      // 已卖出的批次会被 repo 拦下
      const message = e instanceof RecordError ? e.message : '删除失败，稍后重试';
      setDelConfirmError(message);
      setDelError({ batchId: id, message });
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="page-stack page-stack--fixed-bar">
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
            {/*
             * 触发按钮做成 .glass-select 的外观，但点开的是 ProductPicker，
             * 不再是系统原生列表。Field 会把 label 的 htmlFor 指到这个按钮上，
             * 所以「点标签 ≈ 点按钮」与屏幕阅读器读到的名字都还在。
             */}
            <button
              type="button"
              className={`glass-select picker-trigger ${product ? '' : 'is-placeholder'}`}
              aria-haspopup="dialog"
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen(true)}
            >
              <span className="picker-trigger__text">{product ? product.name : '选择商品…'}</span>
            </button>
          </Field>

          {/* 选商品只走上面的按钮 + ProductPicker；旧的 1×1 原生 select 兼容通道已删。 */}

          {product && product.boxQty > 1 ? (
            <div className="glass-segmented glass-segmented--full" role="group" aria-label="进货单位">
              <button
                type="button"
                className="glass-segmented__item"
                aria-pressed={unit === 'base'}
                onClick={() => patchForm({ unit: 'base' })}
              >
                按{product.unitBase}
              </button>
              <button
                type="button"
                className="glass-segmented__item"
                aria-pressed={unit === 'box'}
                onClick={() => patchForm({ unit: 'box' })}
              >
                按箱（1箱={product.boxQty}
                {product.unitBase}）
              </button>
            </div>
          ) : null}

          <div className="form-row">
            <Field
              label={`数量（${unit === 'box' ? '箱' : product?.unitBase ?? '个'}）`}
              /* 即时提示优先于提交校验：打字当下就要说清，别等点保存才知道 */
              error={qtyHint || errors.qty}
            >
              <input
                ref={qtyRef}
                className="glass-input"
                inputMode="numeric"
                value={qty}
                onChange={(e) => {
                  /*
                   * P2：数量口径与开单行一致（quantityInput.ts）。
                   * 老实现 `replace(/\D/g,'')` 逐字过滤，1.5 会先变 1 再变 15，
                   * 记账放大十倍且没有任何提示。现在小数点整次拒绝：
                   * 不写 state → 输入框回退原值，并在框下说「数量填整数」。
                   */
                  const parsed = normalizeQtyText(e.target.value);
                  if (!parsed) {
                    flashQtyHint(QTY_HINT_DECIMAL);
                    return;
                  }
                  if (parsed.tooLong) flashQtyHint(QTY_HINT_TOO_LONG);
                  else flashQtyHint('');
                  patchForm({ qty: parsed.text });
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
                  patchForm({ cost: e.target.value });
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

          <details className="purchase-extra">
            <summary>批次信息（可选：批号、生产日期、有效期、厂家）</summary>
            <div className="page-stack" style={{ marginTop: 10 }}>
              <div className="form-row">
                <Field label="批号">
                  <input
                    className="glass-input"
                    value={batchNo}
                    onChange={(e) => patchForm({ batchNo: e.target.value })}
                  />
                </Field>
                <Field label="到货日期">
                  <input
                    className="glass-input"
                    type="date"
                    value={receivedAt}
                    onChange={(e) => patchForm({ receivedAt: e.target.value })}
                  />
                </Field>
              </div>

              <div className="form-row">
                <Field label="生产日期">
                  <input
                    className="glass-input"
                    type="date"
                    value={produceDate}
                    onChange={(e) => patchForm({ produceDate: e.target.value })}
                  />
                </Field>
                <Field label="有效期至">
                  <input
                    className="glass-input"
                    type="date"
                    value={expiryDate}
                    onChange={(e) => patchForm({ expiryDate: e.target.value })}
                  />
                </Field>
              </div>

              <Field label="供货厂家">
                <input
                  className="glass-input"
                  value={supplier}
                  onChange={(e) => patchForm({ supplier: e.target.value })}
                />
              </Field>
            </div>
          </details>

          <p className="tiny-text" style={{ margin: 0 }}>
            照着纸质送货单一条条录，录完一条必填项会清空，商品和批次信息保留。
          </p>
        </div>
      </Card>

      {/*
       * 保存按钮移出卡片流（三.8）：原来夹在「进价」和「批次信息」折叠面板之间，
       * 页面一滚按钮就跑到屏幕上方，单手拇指够不到。
       * 复用开单页底栏样式，加 --above-dock 变体抬到浮动 Tab Bar 之上；
       * saving 的禁用态一起带过来，避免同一批货连点两遍改坏 FIFO 成本。
       */}
      <div className="record-actions record-actions--above-dock">
        <Btn block onClick={save} disabled={saving}>
          {saving ? '保存中…' : '保存这一条'}
        </Btn>
      </div>

      <ul className="glass-list">
        <li
          className="glass-list__item glass-list__item--interactive list-item"
          {...rowProps(() => setTodayOpen(true))}
        >
          <span className="glass-list__leading">
            <PackagePlus size={22} aria-hidden="true" />
          </span>
          <div className="glass-list__content">
            <div className="glass-list__title">今天已录 {todayCount} 条</div>
            <div className="glass-list__subtitle">点开看明细 / 删错</div>
          </div>
        </li>
      </ul>

      {todayOpen ? (
        <Sheet
          title="今天录入的进货"
          subtitle={`共 ${todayCount} 条${
            todayCount > todayBatches.length ? ` · 显示最近 ${todayBatches.length} 条` : ''
          }`}
          onClose={() => {
            setTodayOpen(false);
            // 关掉明细就清掉上一次的删除失败提示，避免下次点开还残留
            setDelError(null);
          }}
        >
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
                        onClick={() => {
                          setDelError(null);
                          setDelConfirmError('');
                          setDelBatchId(b.id);
                        }}
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </Btn>
                    </div>
                    {/* 删除失败原因就地显示在这一条下面：Sheet 是带遮罩的模态，提示放到页面主体会被挡住 */}
                    {delError?.batchId === b.id ? (
                      <p
                        className="glass-hint glass-hint--error"
                        role="alert"
                        style={{ margin: '6px 0 0' }}
                      >
                        {delError.message}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Sheet>
      ) : null}

      {/*
       * 选商品：与记账页同一个 ProductPicker（mode='pick'）。
       * 进货页没有 inv 数据源，所以不传 inv —— 组件会隐藏库存行，
       * 而不是给每个货都显示误导性的「账面 0」。
       */}
      {pickerOpen ? (
        <ProductPicker
          mode="pick"
          products={products}
          onPick={pickProduct}
          onDone={() => setPickerOpen(false)}
          onCreate={() => {
            // 空态里的「去建商品」：先关选货层，再开新建商品表单
            setPickerOpen(false);
            setNewProduct(true);
          }}
        />
      ) : null}

      {newProduct ? (
        <ProductFormModal
          onClose={() => setNewProduct(false)}
          onSave={async (input) => {
            const p = await createProduct(input);
            patchForm({ productId: p.id });
            setNewProduct(false);
            onDone('商品已建');
          }}
        />
      ) : null}

      {delBatchId ? (
        <ConfirmSheet
          title="删除这条进货记录？"
          confirmText="删除"
          danger
          busy={deleting}
          description={
            delConfirmError ? (
              <span className="glass-hint glass-hint--error" role="alert">
                {delConfirmError}
              </span>
            ) : undefined
          }
          onConfirm={() => void doDeleteBatch()}
          onCancel={() => {
            setDelBatchId(null);
            setDelConfirmError('');
          }}
        />
      ) : null}
    </div>
  );
}