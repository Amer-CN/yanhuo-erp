import { ChevronRight, Package, Receipt, Settings } from 'lucide-react';
import type { Session } from '../db/types';
import { fenToStr, isoToTime } from '../db/util';
import { Btn, Card, Empty, rowProps } from './kit';
import type { SubPage } from './AppShell';

/** 「更多」页：本场汇总 + 商品管理 / 销售记录 / 设置与同步入口。 */
export default function MorePage({
  products,
  orders,
  session,
  summary,
  deviceName,
  sync,
  onOpen,
  onCloseSession
}: {
  products: number;
  orders: number;
  session?: Session;
  summary: { revenueFen: number; orderCount: number };
  deviceName: string;
  sync: {
    configured: boolean;
    online: boolean;
    syncing: boolean;
    pending: number;
    error: string | null;
    /** B3：新设备首轮「下载历史」状态；running 时不能再显示「已连接」骗人 */
    initialSync: 'idle' | 'running' | 'done';
    /** B3：首轮已拉到的行数（不是单数，文案写「条」） */
    pulledCount: number;
  };
  onOpen: (p: Exclude<SubPage, null>) => void;
  onCloseSession: () => void;
}) {
  /*
   * B3：新设备首次接入时账本看着是空的（历史还在下载），
   * 这一行原来直接写「已连接 · 待推送 0 条」，等于告诉用户「没有历史」。
   * 首轮 pull 期间优先显示下载进度，拉完才回落到常规文案。
   */
  const syncText = !sync.configured
    ? '未开启（点设置与同步）'
    : sync.initialSync === 'running'
      ? `正在下载历史…（已拉 ${sync.pulledCount} 条）`
      : !sync.online
        ? '离线，联网后自动同步'
        : sync.syncing
          ? '同步中…'
          : sync.error
            ? '同步出错'
            : `已连接 · 待推送 ${sync.pending} 条`;

  return (
    <div className="page-stack">
      <Card>
        <div className="row-between" style={{ alignItems: 'flex-start' }}>
          <div>
            <div className="tiny-text">
              {session ? `本场 · ${isoToTime(session.startedAt)} 开始` : '本场还没开张'}
            </div>
            <div
              style={{
                fontSize: 'var(--yh-text-3xl)',
                fontWeight: 'var(--yh-weight-semibold)',
                color: 'var(--yh-price-ink)',
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 'var(--yh-leading-tight)'
              }}
            >
              ¥{fenToStr(summary.revenueFen)}
            </div>
            <div className="tiny-text">已记 {summary.orderCount} 单</div>
          </div>
          <Btn
            block={false}
            size="sm"
            variant="secondary"
            disabled={!session || summary.orderCount === 0}
            onClick={onCloseSession}
          >
            收摊结账
          </Btn>
        </div>
        <div className="tiny-text" style={{ marginTop: 8 }}>
          设备：{deviceName} · 云同步：{syncText}
        </div>
      </Card>

      <ul className="glass-list">
        <li
          className="glass-list__item glass-list__item--interactive list-item"
          {...rowProps(() => onOpen('products'))}
        >
          <span className="glass-list__leading">
            <Package size={22} aria-hidden="true" />
          </span>
          <div className="glass-list__content">
            <div className="glass-list__title">商品管理</div>
            <div className="glass-list__subtitle">共 {products} 个商品</div>
          </div>
          <div className="glass-list__trailing">
            <ChevronRight size={18} aria-hidden="true" />
          </div>
        </li>

        <li
          className="glass-list__item glass-list__item--interactive list-item"
          {...rowProps(() => onOpen('history'))}
        >
          <span className="glass-list__leading">
            <Receipt size={22} aria-hidden="true" />
          </span>
          <div className="glass-list__content">
            <div className="glass-list__title">销售记录</div>
            <div className="glass-list__subtitle">共 {orders} 单，按场次看明细</div>
          </div>
          <div className="glass-list__trailing">
            <ChevronRight size={18} aria-hidden="true" />
          </div>
        </li>

        <li
          className="glass-list__item glass-list__item--interactive list-item"
          {...rowProps(() => onOpen('settings'))}
        >
          <span className="glass-list__leading">
            <Settings size={22} aria-hidden="true" />
          </span>
          <div className="glass-list__content">
            <div className="glass-list__title">设置与同步</div>
            <div className="glass-list__subtitle">操作人、导出备份、导入合并</div>
          </div>
          <div className="glass-list__trailing">
            <ChevronRight size={18} aria-hidden="true" />
          </div>
        </li>
      </ul>

      <Card>
        <p className="muted-text" style={{ margin: 0 }}>
          摆摊流程：进货 → 记一笔 → 收摊结账 → 看报表对现金。两台设备会自动同步；每天收摊再导出一次备份，发微信存着。
        </p>
      </Card>

      {products === 0 ? <Empty icon={<Package size={24} />} text="还没有商品，先去商品管理建几个" /> : null}
    </div>
  );
}