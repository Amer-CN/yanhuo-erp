import { useMemo, useState } from 'react';
import { Search, Boxes, TriangleAlert, ChevronRight, X } from 'lucide-react';
import type { Batch, Product } from '../../db/types';
import type { FifoResult } from '../../db/calc';
import { batchStock } from '../../db/calc';
import { createAdjustment } from '../../db/repo';
import { fenToStr, localDate, MS_PER_DAY, qtyToStr } from '../../db/util';
import { Btn, Empty, Field, Sheet, Stat, rowProps, type Done } from '../kit';

/** 设置里没配置时的默认临期预警天数（与 App 的默认值保持一致） */
const DEFAULT_EXPIRY_WARN_DAYS = 30;

export default function StockPage({
  products,
  batches,
  inv,
  fifo,
  deviceId,
  warnDays = DEFAULT_EXPIRY_WARN_DAYS,
  onDone
}: {
  products: Product[];
  batches: Batch[];
  inv: Map<string, number>;
  fifo: FifoResult;
  deviceId: string;
  /** 临期阈值（天），跟设置页里的值走，别写死 30 */
  warnDays?: number;
  onDone: Done;
}) {
  const [q, setQ] = useState('');
  /*
   * 只看缺货：从统计卡角标点进来（见下面的 stat-badge）。
   * 用局部 state 而不是路由/全局：离开这一页筛选就该自动失效，
   * 免得用户切回来发现列表少了东西、以为货被删了。
   */
  const [onlyLow, setOnlyLow] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [adjust, setAdjust] = useState('');
  const [reason, setReason] = useState('');
  /*
   * 调整方向单独成段，不让用户输入负号。
   * 原因：iOS / 安卓的 inputMode="numeric" 键盘没有减号键，
   * 原来 placeholder 写「-2」等于让用户填一个打不出来的数（盘亏根本记不上）。
   * 默认「少了」：摊位上盘亏 / 摔坏远多于盘盈。
   */
  const [dir, setDir] = useState<'loss' | 'more'>('loss');
  // 写库中禁点：盘亏重复提交会连记两笔调整
  const [saving, setSaving] = useState(false);

  const list = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return products
      .filter((p) => !p.archived)
      .filter((p) => (kw ? p.name.toLowerCase().includes(kw) : true))
      // 缺货口径与 lowCount 完全一致（stock <= 0），不另立一套判断
      .filter((p) => (onlyLow ? (inv.get(p.id) ?? 0) <= 0 : true))
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'zh'));
  }, [products, q, onlyLow, inv]);

  const { totalQty, totalValue, lowCount } = useMemo(() => {
    let qty = 0;
    let value = 0;
    let low = 0;
    for (const p of products) {
      const s = inv.get(p.id) ?? 0;
      qty += Math.max(0, s);
      if (s <= 0) low++;
    }
    for (const b of batches) {
      const remain = fifo.batchRemaining.get(b.id) ?? 0;
      if (remain > 0) value += remain * b.unitCostFen;
    }
    return { totalQty: qty, totalValue: value, lowCount: low };
  }, [products, batches, inv, fifo]);

  const open = products.find((p) => p.id === openId);

  // 一次算好批次行（原来同一次渲染里调两遍 batchStock）
  const rows = useMemo(() => (open ? batchStock(batches, open.id, fifo) : []), [batches, open, fifo]);
  const openStock = open ? inv.get(open.id) ?? 0 : 0;
  /**
   * 库存口径：件数取 inventory（含盘亏/退货调整），成本取 FIFO 批次剩余。
   * 两者的差就是「没摊到批次上的调整」，显式标出来，避免同屏数字看着矛盾。
   */
  const batchRemainingTotal = useMemo(
    () => rows.reduce((sum, r) => sum + r.remaining, 0),
    [rows]
  );
  const adjustGap = openStock - batchRemainingTotal;

  const submitAdjust = async () => {
    if (!open || saving) return;
    const n = Number(adjust);
    if (!Number.isFinite(n) || n === 0) {
      onDone('填个非 0 的数，方向点上面「少了 / 多了」', 'error');
      return;
    }
    // 输入框只收正数，符号由分段决定：少了 → 负库存调整，多了 → 盘盈修正
    const signed = dir === 'loss' ? -Math.abs(n) : Math.abs(n);
    setSaving(true);
    try {
      await createAdjustment(
        {
          productId: open.id,
          qtyBase: Math.round(signed),
          type: dir === 'loss' ? 'loss' : 'correction',
          reason: reason || undefined
        },
        deviceId
      );
      onDone(dir === 'loss' ? '已记盘亏' : '已记盘盈');
      setAdjust('');
      setReason('');
      setDir('loss');
      setOpenId(null);
    } catch (e) {
      // 写失败必须说一声，否则用户以为盘亏已经记上了
      onDone(`没记上：${e instanceof Error ? e.message : '未知错误'}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    /*
     * 滚动模型：这一页不跟着整页滚。
     * .app-main--split 把外层 overflow 关掉，唯一的滚动条长在 .stock-page__scroll 里，
     * 所以统计卡 / 缺货提示 / 搜索框永远留在原位（不会被长列表挤出屏幕），
     * 也不会出现「外层一条 + 内层一条」的双层滚动条。
     */
    <div className="page-stack stock-page">
      <div className="stat-grid">
        {/*
         * 缺货提示从「常驻玻璃横幅」改成「统计卡角标」。
         * 原因：那条横幅高约 56px，只要有一个商品没货就一直在，等于用最贵的一屏空间
         * 换一句「年后进货前先看一眼」。现在缺货只体现为「库存总件数」右上角一个数字，
         * 点一下就把列表筛成只有没货的，再点一下复原 —— 同样的信息，零占位。
         *
         * 为什么外面还要包一层 .stat-slot：角标要绝对定位贴着这张卡的角，
         * 直接改 kit 的 Stat 会波及别的页面；包一层只影响这一处。
         */}
        <div className="stat-slot">
          <Stat k="库存总件数" v={totalQty} />
          {lowCount > 0 ? (
            <button
              type="button"
              className="stat-badge"
              aria-label={`缺货 ${lowCount} 个，点击只看缺货`}
              aria-pressed={onlyLow}
              onClick={() => setOnlyLow((v) => !v)}
            >
              {/* 视觉上是小胶囊；按钮本体被 CSS 撑到 44×44 满足触控下限 */}
              <span className="stat-badge__pill">缺货 {lowCount}</span>
            </button>
          ) : null}
        </div>
        <Stat k="库存成本" v={<span>¥{fenToStr(totalValue)}</span>} tone="brand" />
      </div>

      <div className="glass-search">
        <Search className="glass-search__icon" size={18} aria-hidden="true" />
        <input
          className="glass-input"
          type="search"
          placeholder="搜商品"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        {/*
         * 筛选中的「退出」入口。放在搜索行里而不是另起一行：
         * 标题旁角标是「进入」，这里负责「出来」，两者都零占位。
         */}
        {onlyLow ? (
          <button
            type="button"
            className="stock-filter-chip"
            aria-label="只看缺货，点击取消筛选"
            onClick={() => setOnlyLow(false)}
          >
            <span>只看缺货</span>
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>

      {/*
        列表区：唯一可滚的一层。min-height:0 + flex:1 由 .stock-page__scroll 提供，
        商品再多也只是这里滚，上面的搜索框不会跟着走。
        data-scroll-root 是给弹层滚动锁看的：这一页真正在滚的是这里，不是 .app-main。

        --surface：列表非空时才给滚动容器铺玻璃面。空态（Empty）自己有排版，
        垫一块空的玻璃矩形只会显得像加载失败。
        圆角的来龙去脉见 styles.css 里 .stock-page__scroll--surface 上方的注释。
      */}
      <div
        className={`stock-page__scroll${list.length > 0 ? ' stock-page__scroll--surface' : ''}`}
        data-scroll-root="1"
      >
        {list.length === 0 ? (
          products.length === 0 ? (
            <Empty icon={<Boxes size={24} />} text="还没有商品" />
          ) : q.trim() ? (
            /*
             * 有搜索词但没命中（M-08）：老实现和「一个商品都没有」共用「还没有商品」，
             * 搜错字/用了别名时摊主会以为货丢了。这里明确说是没搜到，并给一键清空。
             */
            <Empty
              icon={<Search size={24} />}
              text={`没搜到「${q.trim()}」`}
              action={
                <Btn block={false} size="sm" variant="secondary" onClick={() => setQ('')}>
                  看全部商品
                </Btn>
              }
            />
          ) : onlyLow ? (
            /* 刚补完货 / 盘盈后缺货清空：说明是「筛选没了」而不是「商品没了」 */
            <Empty
              icon={<Boxes size={24} />}
              text="现在没有缺货商品了"
              action={
                <Btn block={false} size="sm" variant="secondary" onClick={() => setOnlyLow(false)}>
                  看全部商品
                </Btn>
              }
            />
          ) : (
            <Empty icon={<Boxes size={24} />} text="商品都归档了，去「更多 → 商品管理」看看" />
          )
        ) : (
          <ul className="glass-list">
            {list.map((p) => {
              const stock = inv.get(p.id) ?? 0;
              return (
                <li
                  key={p.id}
                  className="glass-list__item glass-list__item--interactive list-item"
                  {...rowProps(() => setOpenId(p.id))}
                >
                  <span className="glass-list__leading">
                    {stock < 0 ? (
                      <TriangleAlert size={22} aria-hidden="true" style={{ color: 'var(--gl-color-error)' }} />
                    ) : (
                      <Boxes size={22} aria-hidden="true" />
                    )}
                  </span>
                  <div className="glass-list__content">
                    <div className="glass-list__title-row">
                      <div className="glass-list__title">{p.name}</div>
                      {p.boxQty > 1 ? (
                        <span className="glass-badge">
                          1箱={p.boxQty}
                          {p.unitBase}
                        </span>
                      ) : null}
                    </div>
                    <div className="glass-list__subtitle">
                      库存 {qtyToStr(stock, p.boxQty, p.unitBase)}
                    </div>
                  </div>
                  <div className="glass-list__trailing">
                    {stock < 0 ? (
                      <span className="glass-badge glass-badge--error">负库存</span>
                    ) : stock === 0 ? (
                      <span className="glass-badge glass-badge--error">没货</span>
                    ) : null}
                    <ChevronRight size={18} aria-hidden="true" />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {open ? (
        <Sheet title={open.name} onClose={() => setOpenId(null)}>
          <div className="page-stack">
            <div className="row-between">
              <span className="muted-text">当前库存</span>
              <span style={{ fontWeight: 'var(--yh-weight-semibold)', fontVariantNumeric: 'tabular-nums' }}>
                {qtyToStr(openStock, open.boxQty, open.unitBase)}
              </span>
            </div>

            <div>
              <h2 className="section-title" style={{ marginBottom: 8 }}>
                批次明细
              </h2>
              {/* 件数含盘亏/退货调整，成本按批次算：差额在这里显式说明，同屏数字才对得上 */}
              <p className="tiny-text" style={{ marginTop: 0 }}>
                成本按批次计，不含盘亏/退货调整
                {adjustGap !== 0
                  ? `；其中调整 ${adjustGap > 0 ? `+${adjustGap}` : adjustGap} ${open.unitBase}（未分摊到批次）`
                  : ''}
              </p>
              {rows.length === 0 ? (
                <Empty icon={<Boxes size={24} />} text="还没录进货" />
              ) : (
                <div className="stack-sm">
                  {rows.map(({ batch, remaining }) => {
                    const days = batch.expiryDate
                      ? Math.round(
                          (new Date(`${batch.expiryDate}T00:00:00`).getTime() -
                            new Date(`${localDate()}T00:00:00`).getTime()) /
                            MS_PER_DAY
                        )
                      : null;
                    return (
                      <div key={batch.id} className="mini-card">
                        <div className="row-between">
                          <div>
                            <div className="cart-line__name">
                              {batch.batchNo ? `批号 ${batch.batchNo}` : '（无批号）'}
                            </div>
                            <div className="cart-line__meta">
                              到货 {batch.receivedAt} · 进价 ¥{fenToStr(batch.unitCostFen)}/{open.unitBase}
                            </div>
                            {batch.expiryDate ? (
                              <div className="cart-line__meta">
                                有效期至 {batch.expiryDate}
                                {days !== null
                                  ? `（${days < 0 ? '已过期' : `剩 ${days} 天`}）`
                                  : ''}
                                {days !== null && days <= warnDays ? (
                                  <span className="glass-badge glass-badge--error" style={{ marginLeft: 6 }}>
                                    临期
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                          </div>
                          <div style={{ fontWeight: 'var(--yh-weight-semibold)', fontVariantNumeric: 'tabular-nums' }}>
                            剩 {qtyToStr(remaining, open.boxQty, open.unitBase)}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <h2 className="section-title" style={{ marginBottom: 8 }}>
                修正库存（盘亏/盘盈）
              </h2>
              <p className="tiny-text" style={{ marginTop: 0 }}>
                盘点发现对不上时用：先点方向，数量只填正数，单位是{open.unitBase}。
              </p>
              <div className="page-stack">
                {/* 方向在这里点，不用打负号：数字键盘本来就没有减号键 */}
                <div className="glass-segmented glass-segmented--full" role="group" aria-label="调整方向">
                  <button
                    type="button"
                    className="glass-segmented__item"
                    aria-pressed={dir === 'loss'}
                    onClick={() => setDir('loss')}
                  >
                    少了（盘亏 / 摔坏）
                  </button>
                  <button
                    type="button"
                    className="glass-segmented__item"
                    aria-pressed={dir === 'more'}
                    onClick={() => setDir('more')}
                  >
                    多了（盘盈）
                  </button>
                </div>
                <Field label={`调整数量（${open.unitBase}）`} hint="填正数就行，方向上面已经选了">
                  <input
                    className="glass-input"
                    inputMode="numeric"
                    value={adjust}
                    onChange={(e) => setAdjust(e.target.value.replace(/\D/g, ''))}
                    placeholder="2"
                  />
                </Field>
                <Field label="原因（可空）">
                  <input
                    className="glass-input"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="摔坏 / 数错"
                  />
                </Field>
                <Btn block variant="secondary" onClick={submitAdjust} disabled={saving}>
                  记一笔调整
                </Btn>
              </div>
            </div>
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}
