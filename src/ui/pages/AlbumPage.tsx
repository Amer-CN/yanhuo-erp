import { useEffect, useMemo, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import {
  buildSeasonLedger,
  computeSeasonAlbum,
  computeSeasonSummaries,
  pickAlbumSeason,
  RARITY_ORDER,
  type AlbumSeasonStatus,
  type Rarity
} from '../../db/album';
import type { FifoResult } from '../../db/calc';
import { CATEGORIES, type Category, type Product, type SaleLine, type SalesOrder, type Session } from '../../db/types';
import { fenToStr, localDate } from '../../db/util';
import { Card, Empty } from '../kit';
import AlbumCardDetail from '../album/AlbumCardDetail';
import AlbumCardTile from '../album/AlbumCardTile';
import { detectUpgradedIds } from '../album/upgrade';

type CategoryFilter = 'all' | Category;
type RarityFilter = 'all' | Rarity;

/** 等级超过 5 级时复用第 5 档样式，只把数字往上加 */
const levelClass = (level: number) => `album--lv${Math.min(level, 5)}`;

const STATUS_TEXT: Record<AlbumSeasonStatus, string> = {
  active: '进行中',
  archived: '已收官',
  upcoming: '即将开始'
};

/**
 * 卡册页永远给出一份可看可玩的卡册：
 * 赛期内看当季；赛季外看最近收官的那一季；一场都没有时看下季预览。
 */
export default function AlbumPage({
  products,
  orders,
  lines,
  sessions,
  fifo
}: {
  products: Product[];
  orders: SalesOrder[];
  lines: SaleLine[];
  sessions: Session[];
  fifo: FifoResult;
}) {
  const today = localDate();
  const [cat, setCat] = useState<CategoryFilter>('all');
  const [rarity, setRarity] = useState<RarityFilter>('all');
  const [openId, setOpenId] = useState<string | null>(null);

  const ledger = useMemo(
    () => buildSeasonLedger({ orders, lines, sessions, fifo }),
    [orders, lines, sessions, fifo]
  );

  const picked = useMemo(
    () => pickAlbumSeason(today, ledger),
    // today 只按天变；跨过 12-25 / 元宵节才会换赛季
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [today, ledger]
  );

  const album = useMemo(
    () => computeSeasonAlbum({ season: picked.season, products, ledger }),
    // season 对象每次新建，按开始年份取依赖即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [picked.season.startYear, products, ledger]
  );

  const archive = useMemo(
    () =>
      computeSeasonSummaries({ ledger, products }).filter(
        (s) => s.season.startYear !== picked.season.startYear
      ),
    [ledger, products, picked.season.startYear]
  );

  const cards = useMemo(
    () =>
      album.cards.filter(
        (c) => (cat === 'all' || c.category === cat) && (rarity === 'all' || c.rarity === rarity)
      ),
    [album, cat, rarity]
  );

  const selected = album.cards.find((c) => c.productId === openId);

  /*
   * 升级只闪一次：品质是派生值，没有持久化，所以自己在组件里记住上一帧。
   * 首次打开 prev 为空，detectUpgradedIds 返回空，不会补播历史升级。
   */
  const prevRarities = useRef<Map<string, Rarity>>(new Map());
  const [flashId, setFlashId] = useState<string | null>(null);
  useEffect(() => {
    const upgraded = detectUpgradedIds(prevRarities.current, album.cards);
    prevRarities.current = new Map(album.cards.map((c) => [c.productId, c.rarity]));
    if (upgraded.length === 0) return;
    setFlashId(upgraded[0]);
    const timer = window.setTimeout(() => setFlashId(null), 1400);
    return () => window.clearTimeout(timer);
  }, [album]);

  const isActive = picked.status === 'active';

  return (
    <div className="page-stack">
      <Card className={`album-head ${levelClass(album.level.level)}`}>
        <div className="row-between" style={{ alignItems: 'baseline', gap: 8 }}>
          <span className="tiny-text">
            {album.season.label} · {album.season.startDate} → {album.season.endDate}
            {album.season.endDateEstimated ? '（结束日待更新）' : ''}
          </span>
          <span className="glass-badge">{STATUS_TEXT[picked.status]}</span>
        </div>

        <div className="row-between" style={{ alignItems: 'baseline', marginTop: 4 }}>
          <span className="album-head__level">
            Lv.{album.level.level}
            {picked.status === 'archived' ? ' · 最终' : ''}
          </span>
          <span className="album-head__gross">¥{fenToStr(album.level.grossFen)}</span>
        </div>

        {isActive ? (
          <>
            <div
              className="album-progress"
              role="progressbar"
              aria-label="本赛季等级进度"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(album.level.ratio * 100)}
            >
              <span
                className="album-progress__fill"
                style={{ width: `${Math.round(album.level.ratio * 100)}%` }}
              />
            </div>
            <div className="tiny-text">
              再赚 ¥{fenToStr(album.level.nextFen - album.level.grossFen)} 升到 Lv.
              {album.level.level + 1}
            </div>
          </>
        ) : picked.status === 'archived' ? (
          <div className="tiny-text">这一季已收官，卡面是最终结果。</div>
        ) : (
          <div className="tiny-text">{album.season.startDate} 开赛，届时开始累计。</div>
        )}

        {album.skippedLines > 0 ? (
          <div className="tiny-text album-head__hint">
            有 {album.skippedLines} 条明细的成本待补，暂不计入卡册
          </div>
        ) : null}
      </Card>

      <div className="glass-segmented" role="group" aria-label="按分类筛选">
        <button
          type="button"
          className="glass-segmented__item"
          aria-pressed={cat === 'all'}
          onClick={() => setCat('all')}
        >
          全部
        </button>
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className="glass-segmented__item"
            aria-pressed={cat === c}
            onClick={() => setCat(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="glass-segmented" role="group" aria-label="按品质筛选">
        <button
          type="button"
          className="glass-segmented__item"
          aria-pressed={rarity === 'all'}
          onClick={() => setRarity('all')}
        >
          全部品质
        </button>
        {RARITY_ORDER.map((r) => (
          <button
            key={r}
            type="button"
            className="glass-segmented__item"
            aria-pressed={rarity === r}
            onClick={() => setRarity(r)}
          >
            {r}
          </button>
        ))}
      </div>

      {products.length === 0 ? (
        <Empty icon={<Sparkles size={24} />} text="还没有商品，先去商品管理建几个" />
      ) : cards.length === 0 ? (
        <Empty icon={<Sparkles size={24} />} text="这个筛选下还没有卡" hint="换个分类或品质试试" />
      ) : (
        <div className="album-grid">
          {cards.map((card) => (
            <AlbumCardTile
              key={card.productId}
              card={card}
              flash={flashId === card.productId}
              onOpen={setOpenId}
            />
          ))}
        </div>
      )}

      {archive.length > 0 ? (
        <div>
          <div className="day-header">
            <span>往季归档</span>
            <span className="sub">共 {archive.length} 季</span>
          </div>
          <ul className="glass-list">
            {archive.map((s) => (
              <li key={s.season.startYear} className="glass-list__item">
                <span className="glass-list__content">
                  <span className="glass-list__title">{s.season.label}</span>
                  <span className="glass-list__subtitle">
                    {s.season.startDate} → {s.season.endDate}
                    {s.season.endDateEstimated ? ' · 结束日待更新' : ''}
                  </span>
                </span>
                <span className="glass-list__trailing">
                  Lv.{s.level} · ¥{fenToStr(s.grossFen)}
                  {s.urCount > 0 ? ` · UR ${s.urCount}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {selected ? (
        <AlbumCardDetail
          card={selected}
          updatedAt={album.lastUpdatedAt}
          onClose={() => setOpenId(null)}
        />
      ) : null}
    </div>
  );
}
