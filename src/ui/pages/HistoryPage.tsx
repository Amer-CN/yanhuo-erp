import { useMemo, useState } from 'react';
import { Receipt, RotateCcw, Ban } from 'lucide-react';
import type { Product, SaleLine, SalesOrder } from '../../db/types';
import { PAY_LABEL } from '../../db/types';
import { restoreOrder, voidOrder } from '../../db/repo';
import {
  DELETED_PRODUCT,
  fenToStr,
  isoToLocalDate,
  isoToTime,
  localDate,
  qtyToStr
} from '../../db/util';
import { Btn, ConfirmSheet, Empty, Sheet, rowProps, type Done } from '../kit';

/** 时间范围过滤：只换渲染窗口，不动数据 */
type RangeKey = '7' | '30' | 'all';

/** 7 / 30 天放最左（手指习惯），「全部」放最右 */
const RANGE_OPTIONS: { key: RangeKey; label: string }[] = [
  { key: '7', label: '近 7 天' },
  { key: '30', label: '近 30 天' },
  { key: 'all', label: '全部' }
];

export default function HistoryPage({
  products,
  orders,
  lines,
  onDone
}: {
  products: Product[];
  orders: SalesOrder[];
  lines: SaleLine[];
  onDone: Done;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [voidConfirm, setVoidConfirm] = useState(false);
  const [voiding, setVoiding] = useState(false);
  /** 正在撤销的订单 id（L-04：防连点，同时把按钮置灰） */
  const [restoring, setRestoring] = useState<string | null>(null);
  const [voidError, setVoidError] = useState('');
  /**
   * 默认「全部」而不是「近 7 天」：这一页是摊主对账用的，默认藏掉旧账
   * 会让人以为数据丢了（而且筛选条在最上面，滚下去就看不见了）。
   * 「近 7 天」仍然保留，因为一季 2000 单时首屏 DOM 太大，主动切一下能把
   * 渲染量压到 100 单内 —— 这只是省渲染，不是省数据。
   */
  const [range, setRange] = useState<RangeKey>('all');

  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const sorted = useMemo(() => {
    const all = [...orders].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (range === 'all') return all;
    // 用「本地日期字符串」比较，不拿毫秒差算：毫秒差会把今天 23:59 的单
    // 挤出「近 7 天」，而且在时区边界上最容易出错。
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (Number(range) - 1));
    const fromKey = localDate(from);
    // 只影响渲染，不改数据：作废（界面上叫「删除」）的单据只要落在范围内就照常留着，
    // 灰显 + 撤销入口都在，用户不会以为这笔凭空没了。
    return all.filter((o) => isoToLocalDate(o.createdAt) >= fromKey);
  }, [orders, range]);

  const grouped = useMemo(() => {
    const m = new Map<string, SalesOrder[]>();
    for (const o of sorted) {
      const d = isoToLocalDate(o.createdAt);
      const arr = m.get(d) ?? [];
      arr.push(o);
      m.set(d, arr);
    }
    return [...m.entries()];
  }, [sorted]);

  const open = openId ? orders.find((o) => o.id === openId) : undefined;
  const openLines = open ? lines.filter((l) => l.orderId === open.id) : [];

  // 一次循环建索引：原来每行都 lines.filter 扫一遍全量明细（O(订单数 × 明细数)）
  const lineCountByOrder = useMemo(() => {
    const m = new Map<string, number>();
    for (const l of lines) m.set(l.orderId, (m.get(l.orderId) ?? 0) + 1);
    return m;
  }, [lines]);

  /**
   * 撤销删除：成功/失败都必须如实告知，不能让用户以为已经恢复
   * （写失败可能是配额或事务冲突）。
   *
   * `restoring` 是防连点用的（L-04）：这一行没有 busy 态时，连点两次会跑两遍
   * restoreOrder，虽然幂等，但会连弹两条 Toast、并且把详情框重复关一次。
   */
  const undoDelete = async (id: string) => {
    if (restoring) return;
    /*
     * L-05：先确认这一单还在本机。db 层的 restoreOrder 找不到记录会静默 return，
     * 界面却照样提示「已撤销删除」—— 用户会以为救回来了，其实那条记录早被另一台
     * 手机清空/物理删掉。orders 就是 liveQuery 的最新快照，不用另外查库。
     */
    if (!orders.some((o) => o.id === id)) {
      onDone('这一单已经不在了（可能被另一台手机清空过）', 'warning');
      setOpenId(null);
      return;
    }
    setRestoring(id);
    try {
      await restoreOrder(id);
      onDone('已撤销删除');
      setOpenId(null);
    } catch {
      // L-02：撤销失败是错误语气，不是「提醒」
      onDone('撤销失败，请重试', 'error');
    } finally {
      setRestoring(null);
    }
  };

  /**
   * 删除这一笔：底层仍是 voidOrder（不计入报表、库存加回、可反复撤销），
   * 只是对用户改称「删除」——摊主脑子里就是这个词。成功才关框，失败保持打开并就地说明原因。
   */
  const doVoid = async () => {
    if (!open || voiding) return;
    const id = open.id;
    setVoiding(true);
    setVoidError('');
    try {
      await voidOrder(id);
      // Toast 带「撤销」：删错后不用点回来找，直接在这里救。常驻入口在列表行右侧。
      onDone('已删除这笔', 'warning', { label: '撤销', onClick: () => void undoDelete(id) });
      setVoidConfirm(false);
      setOpenId(null);
    } catch (e) {
      setVoidError(`删除失败：${e instanceof Error ? e.message : '请重试'}`);
    } finally {
      setVoiding(false);
    }
  };

  return (
    <div className="page-stack">
      {/* 筛选条：只换渲染窗口，不改数据。放在流内而不吸顶，
          是为了不让两条 sticky（筛选条 + 天标题）叠在一起抢 top:0。 */}
      <div className="glass-segmented" role="group" aria-label="时间范围">
        {RANGE_OPTIONS.map((o) => (
          <button
            key={o.key}
            type="button"
            className="glass-segmented__item"
            aria-pressed={range === o.key}
            onClick={() => setRange(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>

      {grouped.length === 0 ? (
        <Empty
          icon={<Receipt size={24} />}
          text={orders.length === 0 ? '还没有销售记录' : '这段时间没有销售记录'}
          action={
            orders.length > 0 && range !== 'all' ? (
              <Btn block={false} size="sm" variant="secondary" onClick={() => setRange('all')}>
                看全部
              </Btn>
            ) : undefined
          }
        />
      ) : (
        grouped.map(([day, list]) => {
          const total = list.filter((o) => !o.voided).reduce((s, o) => s + o.totalFen, 0);
          return (
            <div key={day}>
              <div className="day-header">
                <span>{day}</span>
                <span className="sub">
                  {list.length} 单 · 合计 ¥{fenToStr(total)}
                </span>
              </div>
              <ul className="glass-list">
                {list.map((o) => {
                  const n = lineCountByOrder.get(o.id) ?? 0;
                  return (
                    // 已删除（底层 voided）的行整体降透明度 + 标题划掉：
                    // 强光下只压透明度看不出「这单不算钱」，删除线是必需的
                    <li
                      key={o.id}
                      className={`glass-list__item glass-list__item--interactive list-item${
                        o.voided ? ' is-voided' : ''
                      }`}
                      {...rowProps(() => setOpenId(o.id))}
                    >
                      <span className="glass-list__leading">
                        <Receipt size={22} aria-hidden="true" />
                      </span>
                      <div className="glass-list__content">
                        <div className="glass-list__title-row">
                          <div className="glass-list__title">
                            {isoToTime(o.createdAt)} · {o.operator}
                          </div>
                          <span
                            className={`glass-badge ${
                              o.payMethod === 'cash' ? '' : 'glass-badge--primary'
                            }`}
                          >
                            {PAY_LABEL[o.payMethod]}
                          </span>
                          {o.voided ? (
                            <span className="glass-badge glass-badge--error">已删除</span>
                          ) : null}
                        </div>
                        <div className="glass-list__subtitle">{n} 个商品</div>
                      </div>
                      <div className="glass-list__trailing">
                        {o.voided ? (
                          // 常驻撤销入口：Toast 只停留几秒，用户回到列表也要能一眼撤销。
                          // stopPropagation 防止冒泡到 <li> 的 rowProps（否则会顺带打开详情）。
                          <button
                            className="link-btn"
                            type="button"
                            aria-label={`撤销删除 ${isoToTime(o.createdAt)} 这一单`}
                            disabled={restoring === o.id}
                            onClick={(e) => {
                              e.stopPropagation();
                              void undoDelete(o.id);
                            }}
                          >
                            撤销
                          </button>
                        ) : (
                          <span
                            style={{
                              fontWeight: 'var(--yh-weight-semibold)',
                              fontVariantNumeric: 'tabular-nums'
                            }}
                          >
                            ¥{fenToStr(o.totalFen)}
                          </span>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}

      {open ? (
        <Sheet
          title={`${isoToLocalDate(open.createdAt)} ${isoToTime(open.createdAt)}`}
          subtitle={`${open.operator} · ${PAY_LABEL[open.payMethod]}${open.voided ? ' · 已删除' : ''}`}
          onClose={() => setOpenId(null)}
          footer={
            open.voided ? (
              <Btn
                block
                variant="secondary"
                /* L-04：撤销中禁用，避免连点跑两遍（与行内撤销按钮同一份守卫） */
                disabled={Boolean(restoring)}
                onClick={() => void undoDelete(open.id)}
              >
                <span className="icon-text">
                  <RotateCcw size={18} aria-hidden="true" /> 撤销删除
                </span>
              </Btn>
            ) : (
              <Btn
                block
                variant="danger"
                onClick={() => setVoidConfirm(true)}
              >
                <span className="icon-text">
                  <Ban size={18} aria-hidden="true" /> 删除这笔
                </span>
              </Btn>
            )
          }
        >
          <div className="page-stack">
            {openLines.map((l) => {
              const p = productById.get(l.productId);
              return (
                <div key={l.id} className="mini-card">
                  <div className="row-between">
                    <div className="grow">
                      <div className="cart-line__name">{p?.name ?? DELETED_PRODUCT}</div>
                      <div className="cart-line__meta">
                        {qtyToStr(l.qtyBase, p?.boxQty ?? 0, p?.unitBase ?? '个')} × ¥
                        {fenToStr(l.unitPriceFen)}
                        {l.discountFen > 0 ? ` · 让利 ¥${fenToStr(l.discountFen)}` : ''}
                      </div>
                    </div>
                    <div style={{ fontWeight: 'var(--yh-weight-semibold)', fontVariantNumeric: 'tabular-nums' }}>
                      ¥{fenToStr(l.amountFen)}
                    </div>
                  </div>
                </div>
              );
            })}
            <div className="row-between" style={{ padding: '4px 2px' }}>
              <span style={{ fontWeight: 'var(--yh-weight-semibold)' }}>合计</span>
              <span
                style={{
                  fontWeight: 'var(--yh-weight-semibold)',
                  fontSize: 'var(--yh-text-2xl)',
                  color: 'var(--gl-color-primary)',
                  fontVariantNumeric: 'tabular-nums'
                }}
              >
                ¥{fenToStr(open.totalFen)}
              </span>
            </div>
          </div>
        </Sheet>
      ) : null}

      {voidConfirm ? (
        <ConfirmSheet
          title="删除这笔？"
          description={
            voidError ? (
              <span className="glass-hint glass-hint--error" role="alert">
                {voidError}
              </span>
            ) : (
              '删除后不计入报表、库存会加回来，随时可以撤销。'
            )
          }
          confirmText="删除这笔"
          danger
          busy={voiding}
          onConfirm={() => void doVoid()}
          onCancel={() => {
            setVoidConfirm(false);
            setVoidError('');
          }}
        />
      ) : null}
    </div>
  );
}