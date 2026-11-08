// 注意：以下三项都会被打进公开前端包，等同于公开信息，不能当作秘密。
// 账本隔离依赖 ledgerKey + RLS；轮换步骤见 docs/03-云同步设置.md。

export const DEFAULT_SYNC = {
  url: 'https://lnmjmnzddncxvwkvdhoo.supabase.co',
  anonKey: 'sb_publishable_e-wn-4h5CA00ZL-KP_ZFTQ_XpKAUzjf',
  ledgerKey: 'beddbf7e285340e3bda1e6319ddaf3ce2dc9d0d652eb42ff'
} as const;