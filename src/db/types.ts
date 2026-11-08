// 数据模型：钱一律用整数「分」，数量一律用整数「基本单位」（个/挂/支）。

export type Category = '炮' | '烟花' | '儿童' | '组合';

export const CATEGORIES: Category[] = ['炮', '烟花', '儿童', '组合'];

export type PayMethod = 'cash' | 'wechat' | 'alipay';

export const PAY_LABEL: Record<PayMethod, string> = {
  cash: '现金',
  wechat: '微信',
  alipay: '支付宝'
};

export type AdjustType = 'return' | 'loss' | 'correction';

/** 商品主数据 */
export interface Product {
  id: string;
  name: string;
  category: Category;
  /** 基本单位：个 / 挂 / 支 */
  unitBase: string;
  /** 1 箱 = N 基本单位；0 表示不拆零（只按基本单位卖） */
  boxQty: number;
  /** 零售标价（分/基本单位） */
  priceList: number;
  /** 是否允许临时改价 */
  negotiable: boolean;
  /** 种子示例商品（用户改过任意字段后自动清除） */
  sample?: boolean;
  archived: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

/** 进货批次（纸质送货单上的一行） */
export interface Batch {
  id: string;
  productId: string;
  batchNo?: string;
  /** YYYY-MM-DD */
  produceDate?: string;
  /** YYYY-MM-DD */
  expiryDate?: string;
  /** 进货数量（基本单位） */
  qtyBase: number;
  /** 进货单价（分/基本单位） */
  unitCostFen: number;
  supplier?: string;
  /** YYYY-MM-DD */
  receivedAt: string;
  deviceId: string;
  createdAt: string;
}

/** 一场（一次出摊）：第一笔记账到收摊结账之间 */
export interface Session {
  id: string;
  deviceId: string;
  /** 第一笔记账时间，ISO */
  startedAt: string;
  /** 结账时间；空 = 进行中 */
  closedAt?: string;
  status: 'open' | 'closed';
  openedBy: string;
  closedBy?: string;
  /** 结账后补记的单数 */
  patchedCount: number;
  /** 结账汇总快照；避免历史被后续补录影响，补记后重算 */
  summary?: SessionSummary;
  note?: string;
  /** 合并/同步冲突用 */
  updatedAt: string;
}

export interface SessionSummary {
  orderCount: number;
  lineCount: number;
  revenueFen: number;
  cashFen: number;
  wechatFen: number;
  alipayFen: number;
  costFen: number;
  grossFen: number;
  discountFen: number;
  giftCostFen: number;
  giftQty: number;
}

/** 销售单头 */
export interface SalesOrder {
  id: string;
  deviceId: string;
  operator: string;
  createdAt: string;
  payMethod: PayMethod;
  totalFen: number;
  /** 所属场次；迁移前的旧数据为空，由 migrateSessions 补齐 */
  sessionId?: string;
  note?: string;
  /** 整单作废（退货/录错），报表里不计 */
  voided?: boolean;
}

/** 销售明细 */
export interface SaleLine {
  id: string;
  orderId: string;
  productId: string;
  /** 换算成基本单位的数量 */
  qtyBase: number;
  /** 销售单位，用于展示 */
  unit: 'box' | 'base';
  /** 以销售单位计的数量（展示用） */
  qty: number;
  /** 原价（分/基本单位） */
  listUnitPriceFen: number;
  /** 成交价（分/基本单位） */
  unitPriceFen: number;
  /** 成交金额（分） */
  amountFen: number;
  /** 砍价让利（分）；赠品行恒为 0 */
  discountFen: number;
  /** 赠品：金额 0，成本照算 */
  gift?: boolean;
}

/** 库存调整：盘亏/退货/修正 */
export interface Adjustment {
  id: string;
  productId: string;
  /** 有符号：正=入库，负=出库 */
  qtyBase: number;
  type: AdjustType;
  reason?: string;
  createdAt: string;
  deviceId: string;
}

export interface Setting {
  key: string;
  value: string;
}

export const SETTING_KEYS = {
  deviceId: 'deviceId',
  deviceName: 'deviceName',
  operatorA: 'operatorA',
  operatorB: 'operatorB',
  expiryWarnDays: 'expiryWarnDays',
  lastExportAt: 'lastExportAt',
  lastImportAt: 'lastImportAt',
  sampleNoticeDismissed: 'sampleNoticeDismissed',
  seeded: 'seeded',
  /** 历史订单已聚合出场次 */
  sessionsMigrated: 'sessionsMigrated'
} as const;

export interface AppData {
  products: Product[];
  batches: Batch[];
  orders: SalesOrder[];
  lines: SaleLine[];
  adjustments: Adjustment[];
  sessions: Session[];
  settings: Setting[];
}

export const EMPTY_DATA: AppData = {
  products: [],
  batches: [],
  orders: [],
  lines: [],
  adjustments: [],
  sessions: [],
  settings: []
};