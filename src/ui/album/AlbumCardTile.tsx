import type { AlbumCard } from '../../db/album';
import { fenToStr } from '../../db/util';
import FireworkArt from './art/FireworkArt';
import { albumCardGapText, albumCardLabel } from './cardText';

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
      aria-label={albumCardLabel(card)}
      onClick={() => onOpen(card.productId)}
    >
      <span className="album-card__frame">
        <span className="album-card__art">
          <FireworkArt
            name={card.name}
            category={card.category}
            family={card.artFamily}
            className="album-card__svg"
          />
        </span>
        <span className="album-card__rarity">{card.rarity}</span>
        {card.rank !== null && card.rank <= 3 ? (
          <span className="album-card__rank">本季 No.{card.rank}</span>
        ) : card.isNew ? (
          <span className="album-card__rank">新品</span>
        ) : null}
        <span className="album-card__sheen" aria-hidden="true" />
      </span>
      <span className="album-card__name">{card.name}</span>
      <span className="album-card__foot">
        <span className="album-card__gross">¥{fenToStr(card.grossFen)}</span>
        <span className="album-card__no">{card.no}</span>
      </span>
      <span className="album-card__next">{albumCardGapText(card)}</span>
      {card.stopped ? <span className="album-card__stopped">已停售</span> : null}
    </button>
  );
}
