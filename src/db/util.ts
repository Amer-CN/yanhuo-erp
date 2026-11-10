// 通用工具：金额、数量、日期、UUID

export function uuid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  // 兜底（老环境）
  const bytes = new Uint8Array(16);
  if (c && typeof c.getRandomValues === 'function') c.getRandomValues(bytes);
  else for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** 本地日期 YYYY-MM-DD */
export function localDate(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** ISO 时间戳 → 本地日期 */
export function isoToLocalDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return localDate(d);
}

/** ISO → HH:mm */
export function isoToTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

/** 分 → 显示字符串（不带 ¥） */
export function fenToStr(fen: number): string {
  const sign = fen < 0 ? '-' : '';
  const abs = Math.abs(Math.round(fen));
  const yuan = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, '0');
  return `${sign}${yuan}.${cents}`;
}

/** '12.5' / '12' / '0.05' → 分；非法返回 null */
export function strToFen(input: string): number | null {
  const s = input.trim().replace(/[¥￥,，\s]/g, '');
  if (!s) return null;
  if (!/^-?\d*(\.\d{0,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const body = neg ? s.slice(1) : s;
  const [yuanPart, centPart = ''] = body.split('.');
  const yuan = yuanPart === '' ? 0 : Number(yuanPart);
  const cents = Number((centPart + '00').slice(0, 2));
  if (!Number.isFinite(yuan) || !Number.isFinite(cents)) return null;
  const total = yuan * 100 + cents;
  return neg ? -total : total;
}

/** 数量：基本单位 → 显示「3 箱 + 5 个」 */
export function qtyToStr(qtyBase: number, boxQty: number, unitBase: string): string {
  if (!boxQty || boxQty <= 1) return `${qtyBase} ${unitBase}`;
  const sign = qtyBase < 0 ? '-' : '';
  const abs = Math.abs(qtyBase);
  const boxes = Math.floor(abs / boxQty);
  const rest = abs % boxQty;
  if (boxes === 0) return `${sign}${rest} ${unitBase}`;
  if (rest === 0) return `${sign}${boxes} 箱`;
  return `${sign}${boxes} 箱 + ${rest} ${unitBase}`;
}

/** 手机端安全存储的本机标识 */
export function randomDeviceName(): string {
  return Math.random() < 0.5 ? '手机' : '平板';
}

/** 商品已被删除时的统一展示名 */
export const DELETED_PRODUCT = '(已删)';