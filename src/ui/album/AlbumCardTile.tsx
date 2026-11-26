import type { AlbumCard } from '../../db/album';
import { fenToStr } from '../../db/util';
import CategoryArt from './CategoryArt';

/** 卡册网格里的单张商品卡：整卡是一个按钮，触控目标 ≥ 44px */
export default function AlbumCardTile({
  card,
  flash = false,
  onOpen
}: {
  card: AlbumCard;
  /** 刚升过品质：播放一次高亮，不改变数据 */
  flash?: boolean;
  onOpen: (productId: string) => void;
}) {
  const cls = [
    'album-card',
    `album-card--${card.rarity.toLowerCase()}`,
    card.stopped ? 'album-card--stopped' : '',
    flash ? 'album-card--flash' : ''
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={cls}
      aria-label={`${card.name}，${card.rarity} 卡，本赛季毛利 ¥${fenToStr(card.grossFen)}`}
      onClick={() => onOpen(card.productId)}
    >
      <span className="album-card__frame">
        <span className="album-card__art">
          <CategoryArt category={card.category} className="album-card__svg" />
        </span>
        <span className="album-card__rarity">{card.rarity}</span>
        <span className="album-card__sheen" aria-hidden="true" />
      </span>
      <span className="album-card__name">{card.name}</span>
      <span className="album-card__gross">¥{fenToStr(card.grossFen)}</span>
      {card.stopped ? <span className="album-card__stopped">已停售</span> : null}
    </button>
  );
}
