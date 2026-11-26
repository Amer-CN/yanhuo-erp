import { RARITY_ORDER, RARITY_THRESHOLDS_FEN, type AlbumCard } from '../../db/album';
import { fenToStr } from '../../db/util';

/** 下一档品质的名字；`nextFen` 为空（已满级）时返回 null */
export function nextRarityName(nextFen: number | null): string | null {
  if (nextFen === null) return null;
  const hit = RARITY_ORDER.find((r) => RARITY_THRESHOLDS_FEN[r] === nextFen);
  return hit ?? null;
}

/**
 * 网格卡上的「下一档差额」。
 *
 * 规格要求每张卡直接显示离下一档还差多少；负毛利按 0 起算，避免出现「还差 ¥80」
 * 这种比门槛还大的数。
 */
export function albumCardGapText(card: AlbumCard): string {
  if (card.nextFen === null) return '已满级';
  const name = nextRarityName(card.nextFen);
  const gap = Math.max(0, card.nextFen - Math.max(0, card.grossFen));
  return name ? `距 ${name} 还差 ¥${fenToStr(gap)}` : `还差 ¥${fenToStr(gap)}`;
}

/** 读屏可访问名：把卡面信息串成一句，别让读屏只念出「按钮」 */
export function albumCardLabel(card: AlbumCard): string {
  return `${card.name}，${card.rarity} 卡，本赛季毛利 ¥${fenToStr(card.grossFen)}，${albumCardGapText(card)}`;
}
