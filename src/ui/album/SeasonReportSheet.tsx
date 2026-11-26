import { useState } from 'react';
import type { AlbumSeasonStatus, SeasonReportData } from '../../db/album';
import { fenToStr } from '../../db/util';
import { Btn, Sheet, Stat } from '../kit';

/** 赛季战报：一页能截图、也能复制成文字发微信 */
export default function SeasonReportSheet({
  report,
  status,
  onClose
}: {
  report: SeasonReportData;
  status: AlbumSeasonStatus;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  const delta =
    report.grossDeltaRatio === null
      ? null
      : `${report.grossDeltaRatio >= 0 ? '+' : ''}${Math.round(report.grossDeltaRatio * 100)}%`;

  const text = [
    `${report.season.label}（${report.season.startDate} → ${report.season.endDate}）`,
    `毛利 ¥${fenToStr(report.grossFen)} · ${report.orderCount} 单 · 售出 ${report.qtyBase} 件`,
    `平均每单 ¥${fenToStr(report.avgGrossFen)}`,
    `品质 R ${report.rarityCounts.R} / SR ${report.rarityCounts.SR} / SSR ${report.rarityCounts.SSR} / UR ${report.rarityCounts.UR}`,
    report.topProducts.length
      ? `最赚：${report.topProducts.map((p) => `${p.name} ¥${fenToStr(p.grossFen)}`).join('、')}`
      : '本赛季还没有正毛利商品',
    delta ? `较上季 ${delta}` : '没有上一季可对比'
  ].join('\n');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied('已复制，可以直接发微信');
    } catch {
      setCopied('复制失败，可以截图代替');
    }
  };

  return (
    <Sheet
      title={`${report.season.label} 战报`}
      subtitle={status === 'active' ? '进行中 · 数字会继续变化' : '已收官 · 最终数字'}
      onClose={onClose}
    >
      <div className="page-stack">
        <div className="stat-grid">
          <Stat k="本赛季毛利" v={`¥${fenToStr(report.grossFen)}`} tone="brand" />
          <Stat k="订单" v={`${report.orderCount} 单`} />
          <Stat k="平均每单" v={`¥${fenToStr(report.avgGrossFen)}`} />
          <Stat k="售出件数" v={`${report.qtyBase} 件`} />
        </div>

        <div className="tiny-text">品质分布</div>
        <div className="row-between">
          <span className="glass-badge">R {report.rarityCounts.R}</span>
          <span className="glass-badge">SR {report.rarityCounts.SR}</span>
          <span className="glass-badge">SSR {report.rarityCounts.SSR}</span>
          <span className="glass-badge">UR {report.rarityCounts.UR}</span>
        </div>

        <p className="muted-text" style={{ margin: 0 }}>
          {report.previous
            ? `较上季（${report.previous.season.label} ¥${fenToStr(report.previous.grossFen)}）${
                delta ?? '无可比数据'
              }`
            : '没有上一季可对比。'}
        </p>

        <div className="day-header">
          <span>最赚 {report.topProducts.length ? `Top${report.topProducts.length}` : ''}</span>
        </div>
        {report.topProducts.length ? (
          <ul className="glass-list">
            {report.topProducts.map((p) => (
              <li key={p.productId} className="glass-list__item">
                <span className="glass-list__content">
                  <span className="glass-list__title">{p.name}</span>
                  <span className="glass-list__subtitle">{p.rarity} 卡</span>
                </span>
                <span className="glass-list__trailing">¥{fenToStr(p.grossFen)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="tiny-text">本赛季还没有正毛利商品。</p>
        )}

        {report.skippedLines > 0 ? (
          <p className="tiny-text" style={{ margin: 0 }}>
            另有 {report.skippedLines} 条明细因成本待补，未计入毛利。
          </p>
        ) : null}

        <Btn block onClick={() => void copy()}>
          {copied ?? '复制文字战报'}
        </Btn>
      </div>
    </Sheet>
  );
}
