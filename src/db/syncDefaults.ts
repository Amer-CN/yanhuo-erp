// 内置同步配置：开箱即用，两台手机不用填任何东西。
// 说明：publishable key 本来就是公开的前端 key；ledger key 只是把你们的账本
// 和同一项目里的其他数据隔开。介意的话可在「设置与同步 → 云同步」里换成自己的同步码。

export const DEFAULT_SYNC = {
  url: 'https://lnmjmnzddncxvwkvdhoo.supabase.co',
  anonKey: 'sb_publishable_e-wn-4h5CA00ZL-KP_ZFTQ_XpKAUzjf',
  ledgerKey: 'beddbf7e285340e3bda1e6319ddaf3ce2dc9d0d652eb42ff'
} as const;