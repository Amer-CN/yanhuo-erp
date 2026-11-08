import { useMemo, useState } from 'react';
import { ChevronRight, Clock, Receipt, Sparkles, WifiOff } from 'lucide-react';
import type { Product, SaleLine, SalesOrder, Session, SessionSummary } from '../../db/types';
import { PAY_LABEL } from '../../db/types';
import { fenToStr, isoToLocalDate, isoToTime, localDate } from '../../db/util';
import { Btn, Card, Empty, rowProps } from '../kit';

function startLabel(session: Session): string {
  const d = new Date(session.startedAt);
  if (Number.isNaN(d.getTime())) return session.startedAt;
  return `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${isoToTime(
    session.startedAt
  )}`;
}

function orderSummary(order: SalesOrder, lines: SaleLine[], products: Map<string, Product>): string {
  const ls = lines.filter((l) => l.orderId === order.id);
  if (ls.length === 0) return '没有明细';
  const shown = ls.slice(0, 2).map((l) => {
    const p = products.get(l.productId);
    return `${p?.name ?? '已删商品'} ×${l.qty}${l.gift ? '（赠）' : ''}`;
  });
  return ls.length > 2 ? `${shown.join(' · ')} 等 ${ls.length} 种` : shown.join(' · ');
}

/**
 * 记账首页：本场概览 + 最近流水 + 记一笔。
 * 金额是本场累计，不是自然日。
 */
export default function RecordPage({
  session,
  summary,
  orders,
  lines,
  products,
  online,
  onNewRecord,
  onOpenOrder,
  onCloseSession,
  onOpenHistory,
  onGoStock
}: {
  session?: Session;
  summary: SessionSummary;
  orders: SalesOrder[];
  lines: SaleLine[];
  products: Product[];
  online: boolean;
  onNewRecord: () => void;
  onOpenOrder: (id: string) => void;
  onCloseSession: () => void;
  onOpenHistory: () => void;
  onGoStock: () => void;
}) {
  const [crossDayDismissed, setCrossDayDismissed] = useState(false);

  const productMap = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of products) m.set(p.id, p);
    return m;
  }, [products]);

  const recent = useMemo(
    () =>
      [...orders]
        .filter((o) => !o.voided)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
        .slice(0, 8),
    [orders]
  );

  const crossDay = Boolean(session && isoToLocalDate(session.startedAt) < localDate());
  const hasSession = Boolean(session);
  const empty = summary.orderCount === 0;

  return (
    <div className="page-stack">
      {!online ? (
        <div className="offline-note" role="status">
          <WifiOff size={16} aria-hidden="true" />
          <span>离线，照常记账；联网自动补发</span>
        </div>
      ) : null}

      {crossDay && session && !crossDayDismissed ? (
        <div className="first-run-card first-run-card--warn">
          <div>
            <div className="first-run-card__title">昨天那场还没结账</div>
            <div className="tiny-text">这场从 {startLabel(session)} 开始，继续记会并进这一场</div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <Btn block={false} size="sm" variant="secondary" onClick={() => setCrossDayDismissed(true)}>
              继续记
            </Btn>
            <Btn block={false} size="sm" onClick={onCloseSession}>
              去结账
            </Btn>
          </div>
        </div>
      ) : null}

      <Card>
        {hasSession && session ? (
          <>
            <div className="row-between" style={{ alignItems: 'flex-start' }}>
              <div>
                <div className="tiny-text">本场 · {startLabel(session)} 开始</div>
                <div className="session-summary__revenue" aria-live="polite">
                  ¥{fenToStr(summary.revenueFen)}
                </div>
                <div className="session-summary__meta">已记 {summary.orderCount} 单</div>
              </div>
              <Btn
                block={false}
                size="sm"
                variant="secondary"
                disabled={empty}
                onClick={onCloseSession}
                title={empty ? '还没记单' : undefined}
              >
                收摊结账
              </Btn>
            </div>

            <div className="pay-rows">
              <div className="pay-row">
                <span>现金</span>
                <span>¥{fenToStr(summary.cashFen)}</span>
              </div>
              <div className="pay-row">
                <span>微信</span>
                <span>¥{fenToStr(summary.wechatFen)}</span>
              </div>
              <div className="pay-row">
                <span>支付宝</span>
                <span>¥{fenToStr(summary.alipayFen)}</span>
              </div>
            </div>
          </>
        ) : (
          <div className="session-empty">
            <Clock size={22} aria-hidden="true" />
            <div>
              <div className="first-run-card__title">还没开张</div>
              <div className="tiny-text">记一笔就开始这一场；第一单会自动开场</div>
            </div>
          </div>
        )}
      </Card>

      <Card flush>
        <div className="form-head" style={{ margin: '4px 4px 8px' }}>
          <h2>本场流水</h2>
          <button type="button" className="link-btn" onClick={onOpenHistory}>
            看全部
          </button>
        </div>

        {recent.length === 0 ? (
          <Empty
            icon={<Receipt size={24} />}
            text="这一场还没记单"
            action={
              <Btn block={false} size="sm" onClick={onNewRecord}>
                记一笔
              </Btn>
            }
          />
        ) : (
          <ul className="glass-list" style={{ borderRadius: 'var(--yh-radius-lg)' }}>
            {recent.map((o) => (
              <li
                key={o.id}
                className="glass-list__item glass-list__item--interactive list-item"
                {...rowProps(() => onOpenOrder(o.id))}
              >
                <div className="glass-list__content">
                  <div className="glass-list__title-row">
                    <div className="glass-list__title">
                      {isoToTime(o.createdAt)} · {o.operator} · {PAY_LABEL[o.payMethod]}
                    </div>
                    <span className="amount">¥{fenToStr(o.totalFen)}</span>
                  </div>
                  <div className="glass-list__subtitle">{orderSummary(o, lines, productMap)}</div>
                </div>
                <div className="glass-list__trailing">
                  <ChevronRight size={18} aria-hidden="true" />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {empty && hasSession ? (
        <button type="button" className="link-btn" onClick={onGoStock}>
          账面没货？去库存看看是不是漏记进货
        </button>
      ) : null}

      <div className="checkout-dock record-dock">
        <div className="checkout-dock__total" style={{ textAlign: 'left', marginLeft: 0 }}>
          <div className="k">本场已记 {summary.orderCount} 单</div>
          <div className="v">¥{fenToStr(summary.revenueFen)}</div>
        </div>
        <Btn block={false} onClick={onNewRecord}>
          <span className="icon-text">
            <Sparkles size={18} aria-hidden="true" /> 记一笔
          </span>
        </Btn>
      </div>
    </div>
  );
}