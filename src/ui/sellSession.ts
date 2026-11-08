import type { Category } from '../db/types';

export interface CartLine {
  productId: string;
  unit: 'box' | 'base';
  qtyBase: number;
  /** 切到“箱”之前的基本单位数量，切回来时恢复，避免 1挂→箱→挂 变成 20 */
  baseBefore?: number;
  listUnitPriceFen: number;
  unitPriceFen: number;
}

export interface SellState {
  cart: CartLine[];
  operator: string;
  cat: '全部' | Category;
  q: string;
}

export const EMPTY_SELL: SellState = {
  cart: [],
  operator: '',
  cat: '全部',
  q: ''
};

const KEY = 'yh-sell-session';

export function loadSell(): SellState {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return { ...EMPTY_SELL };
    const parsed = JSON.parse(raw) as Partial<SellState>;
    return {
      cart: Array.isArray(parsed.cart) ? parsed.cart : [],
      operator: typeof parsed.operator === 'string' ? parsed.operator : '',
      cat: parsed.cat ?? '全部',
      q: typeof parsed.q === 'string' ? parsed.q : ''
    };
  } catch {
    return { ...EMPTY_SELL };
  }
}

export function saveSell(state: SellState): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    /* 隐私模式写不进去就算了 */
  }
}