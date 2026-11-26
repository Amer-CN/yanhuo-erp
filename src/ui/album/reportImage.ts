import type { SeasonReportData } from '../../db/album';
import { fenToStr } from '../../db/util';

const W = 1080;
const H = 1440;
const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';

const INK = '#eaf2f4';
const MUTED = '#8fa1a7';
const DIM = '#5f6d73';
const ACCENT = '#ffb15c';
const LINE = 'rgba(255,255,255,0.12)';

function font(size: number, weight = 400) {
  return `${weight} ${size}px ${FONT}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** 把名字截到指定宽度，超长加省略号 */
function fit(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) out = out.slice(0, -1);
  return `${out}…`;
}

/** 画一张 1080×1440 的战报图；返回 PNG Blob，可直接下载或分享 */
export function renderSeasonReportImage(report: SeasonReportData): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.reject(new Error('当前浏览器不支持导出图片'));

  const bg = ctx.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#0c141a');
  bg.addColorStop(1, '#141d22');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(190, 120, 0, 190, 120, 760);
  glow.addColorStop(0, 'rgba(255,138,0,0.16)');
  glow.addColorStop(1, 'rgba(255,138,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const x = 80;

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.font = font(52, 600);
  ctx.fillText(`${report.season.label} 战报`, x, 152);

  ctx.fillStyle = MUTED;
  ctx.font = font(26);
  ctx.fillText(`${report.season.startDate} → ${report.season.endDate}`, x, 202);

  ctx.fillStyle = MUTED;
  ctx.font = font(26);
  ctx.fillText('本赛季毛利', x, 296);

  ctx.fillStyle = ACCENT;
  ctx.font = font(104, 600);
  ctx.fillText(`¥${fenToStr(report.grossFen)}`, x, 396);

  const stats: Array<[string, string]> = [
    ['订单', `${report.orderCount} 单`],
    ['售出', `${report.qtyBase} 件`],
    ['平均每单', `¥${fenToStr(report.avgGrossFen)}`]
  ];
  stats.forEach(([label, value], i) => {
    const sx = x + i * 310;
    ctx.fillStyle = MUTED;
    ctx.font = font(24);
    ctx.fillText(label, sx, 486);
    ctx.fillStyle = INK;
    ctx.font = font(44, 600);
    ctx.fillText(value, sx, 540);
  });

  ctx.strokeStyle = LINE;
  ctx.beginPath();
  ctx.moveTo(x, 590);
  ctx.lineTo(W - x, 590);
  ctx.stroke();

  ctx.fillStyle = MUTED;
  ctx.font = font(26);
  ctx.fillText('品质分布', x, 650);

  const counts: Array<[string, number, string]> = [
    ['R', report.rarityCounts.R, '#d6e0e2'],
    ['SR', report.rarityCounts.SR, '#7ee2a8'],
    ['SSR', report.rarityCounts.SSR, '#ffb15c'],
    ['UR', report.rarityCounts.UR, '#f0a8e0']
  ];
  const pillW = 208;
  const gap = 24;
  counts.forEach(([label, n, color], i) => {
    const px = x + i * (pillW + gap);
    roundRect(ctx, px, 676, pillW, 72, 36);
    ctx.fillStyle = 'rgba(255,255,255,0.06)';
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.font = font(30, 600);
    ctx.fillText(`${label} ${n}`, px + 28, 724);
  });

  ctx.fillStyle = MUTED;
  ctx.font = font(26);
  ctx.fillText(
    `较上季 ${
      report.grossDeltaRatio === null
        ? '无可比数据'
        : `${report.grossDeltaRatio >= 0 ? '+' : ''}${Math.round(report.grossDeltaRatio * 100)}%`
    }`,
    x,
    812
  );

  ctx.fillStyle = MUTED;
  ctx.font = font(26);
  ctx.fillText(`最赚 Top${report.topProducts.length || 0}`, x, 896);

  report.topProducts.forEach((p, i) => {
    const ry = 956 + i * 74;
    ctx.fillStyle = DIM;
    ctx.font = font(30, 600);
    ctx.fillText(String(i + 1).padStart(2, '0'), x, ry);

    ctx.fillStyle = INK;
    ctx.font = font(34);
    ctx.fillText(fit(ctx, p.name, 620), x + 64, ry);

    ctx.fillStyle = ACCENT;
    ctx.font = font(34, 600);
    ctx.textAlign = 'right';
    ctx.fillText(`¥${fenToStr(p.grossFen)}`, W - x, ry);
    ctx.textAlign = 'left';
  });

  if (report.topProducts.length === 0) {
    ctx.fillStyle = DIM;
    ctx.font = font(30);
    ctx.fillText('本赛季还没有正毛利商品', x, 956);
  }

  if (report.skippedLines > 0) {
    ctx.fillStyle = DIM;
    ctx.font = font(24);
    ctx.fillText(`另有 ${report.skippedLines} 条明细因成本待补未计入`, x, 1320);
  }

  ctx.fillStyle = DIM;
  ctx.font = font(24);
  ctx.fillText('烟花账 · 夫妻卡册', x, 1382);

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('生成图片失败'));
    }, 'image/png');
  });
}
