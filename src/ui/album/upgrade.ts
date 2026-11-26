import { RARITY_ORDER, type AlbumCard, type Rarity } from '../../db/album';

/**
 * 找出「品质变高」的商品。
 *
 * 卡册品质是派生值，没有持久化；要播放一次升级高亮就得自己记住上一帧。
 * 首次载入（没有旧快照）或新出现的商品都不算升级——否则每次打开卡册都会闪。
 */
export function detectUpgradedIds(prev: Map<string, Rarity>, cards: AlbumCard[]): string[] {
  const out: string[] = [];
  for (const card of cards) {
    const before = prev.get(card.productId);
    if (before === undefined) continue;
    if (RARITY_ORDER.indexOf(card.rarity) > RARITY_ORDER.indexOf(before)) out.push(card.productId);
  }
  return out;
}
