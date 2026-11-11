import { CalendarClock, CloudOff, CircleAlert, PackageX, RotateCcw, TriangleAlert } from 'lucide-react';
import type { Session, SessionSummary } from '../db/types';
import { fenToStr, isoToTime } from '../db/util';
import { Btn, Sheet, Stat } from './kit';

function rangeText(session: Session): string {
  const start = new Date(session.startedAt);
  const fmt = (d: Date) =>
    `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(
      d.getHours()
    ).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if (Number.isNaN(start.getTime())) return session.startedAt;
  const end = session.closedAt ? new Date(session.closedAt) : new Date();
  return `${fmt(start)} → ${fmt(end)}`;
}

function SummaryBody({ summary, costMissing }: { summary: SessionSummary; costMissing: boolean }) {
  return (
    <>
      <div className="hero-stats">
        <div className="stat stat--hero">
          <div className="k">销售额</div>
          <div className="v brand">¥{fenToStr(summary.revenueFen)}</div>
        </div>
        <div className="stat stat--hero">
          <div className="k">毛利{costMissing ? '（成本待补）' : ''}</div>
          <div className={`v ${costMissing ? '' : summary.grossFen >= 0 ? 'ok' : 'bad'}`}>
            {costMissing ? '—' : `¥${fenToStr(summary.grossFen)}`}
          </div>
        </div>
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

      <div className="stat-grid stat-grid--compact">
        <Stat k="单数" v={summary.orderCount} />
        <Stat k="让利" v={`¥${fenToStr(summary.discountFen)}`} tone="bad" />
        <Stat k="赠品成本" v={`¥${fenToStr(summary.giftCostFen)}`} />
      </div>
    </>
  );
}

/** 收摊结账预览：检查项不阻止结账，只提示 */
export default function CloseSessionSheet({
  session,
  summary,
  pendingSync,
  uncoveredQty,
  negativeCount,
  busy,
  onConfirm,
  onCancel,
  onSyncNow,
  onRecordMore,
  onGoPurchase,
  onGoStock
}: {
  session: Session;
  summary: SessionSummary;
  pendingSync: number;
  uncoveredQty: number;
  negativeCount: number;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  onSyncNow: () => void;
  onRecordMore: () => void;
  onGoPurchase: () => void;
  onGoStock: () => void;
}) {
  const costMissing = uncoveredQty > 0;
  const checks: { icon: typeof TriangleAlert; text: string; action: string; onClick: () => void; tone?: 'warn' | 'bad' }[] =
    [];

  checks.push({
    icon: CalendarClock,
    text: '还有没记的单？先补一笔再结账也行',
    action: '再记一笔',
    onClick: onRecordMore
  });
  if (pendingSync > 0) {
    checks.push({
      icon: CloudOff,
      text: `待推送 ${pendingSync} 条`,
      action: '立即同步',
      onClick: onSyncNow,
      tone: 'warn'
    });
  }
  if (uncoveredQty > 0) {
    checks.push({
      icon: CircleAlert,
      text: `${uncoveredQty} 个（基本单位）成本缺失（可能漏记进货）`,
      action: '去补录',
      onClick: onGoPurchase,
      tone: 'warn'
    });
  }
  if (negativeCount > 0) {
    checks.push({
      icon: PackageX,
      text: `${negativeCount} 个商品账面为负`,
      action: '去看看',
      onClick: onGoStock,
      tone: 'bad'
    });
  }

  return (
    <Sheet
      title="收摊结账"
      subtitle={rangeText(session)}
      onClose={onCancel}
      dismissible={!busy}
      footer={
        <Btn block disabled={busy} onClick={onConfirm}>
          {busy ? '结账中…' : '确认收摊结账'}
        </Btn>
      }
    >
      <div className="page-stack">
        <SummaryBody summary={summary} costMissing={costMissing} />

        <div className="check-list">
          <div className="form-head" style={{ marginBottom: 4 }}>
            <h2 className="section-title">结账前看一眼</h2>
          </div>
          {checks.map((c) => {
            const Icon = c.icon;
            return (
              <div className="check-row" key={c.text}>
                <Icon
                  size={18}
                  aria-hidden="true"
                  style={{
                    color:
                      c.tone === 'bad'
                        ? 'var(--yh-ink-bad)'
                        : c.tone === 'warn'
                          ? 'var(--yh-ink-warn)'
                          : 'var(--gl-color-text-muted)'
                  }}
                />
                <span className="grow">{c.text}</span>
                <button type="button" className="link-btn" onClick={c.onClick}>
                  {c.action}
                </button>
              </div>
            );
          })}
        </div>

        <p className="tiny-text" style={{ margin: 0 }}>
          结账后本场截止，下一单自动算新的一场。结账不删任何单；发现漏记可以再补记到这一场。
        </p>
      </div>
    </Sheet>
  );
}

/** 结账结果页 */
export function CloseSessionResult({
  session,
  summary,
  costMissing,
  onViewReport,
  onReopen,
  onClose
}: {
  session: Session;
  summary: SessionSummary;
  costMissing: boolean;
  onViewReport: () => void;
  onReopen: () => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      title="本场已结账"
      subtitle={session.closedAt ? `${isoToTime(session.closedAt)} 截止` : undefined}
      onClose={onClose}
      footer={
        <div className="row" style={{ gap: 8 }}>
          <Btn block={false} variant="secondary" style={{ flex: 1 }} onClick={onClose}>
            完成
          </Btn>
          <Btn block={false} style={{ flex: 2 }} onClick={onViewReport}>
            查看本场报表
          </Btn>
        </div>
      }
    >
      <div className="page-stack">
        <SummaryBody summary={summary} costMissing={costMissing} />
        <button type="button" className="link-btn" onClick={onReopen}>
          <span className="icon-text">
            <RotateCcw size={16} aria-hidden="true" /> 撤销结账（下一场开始前可用）
          </span>
        </button>
        <p className="tiny-text" style={{ margin: 0 }}>
          下一单会自动开新的一场。
        </p>
      </div>
    </Sheet>
  );
}