import { useId } from 'react';
import { matchCardArt, type ArtFamily } from '../../../db/cardArt';
import type { Category } from '../../../db/types';
import CategoryArt from '../CategoryArt';
import { defsMarkup, motifMarkup, paletteFor } from './motifs';

/**
 * 按商品名自动选家族插画；商品手动指定了家族时优先用手动值。
 * 两者都没有就退回原来的分类图，保证任何商品都有卡面。
 */
export default function FireworkArt({
  name,
  category,
  family = null,
  compact = false,
  className = ''
}: {
  name: string;
  category: Category;
  /** 商品手动指定的家族；空 = 按名字自动匹配 */
  family?: ArtFamily | null;
  /** 网格缩略图用：省掉整层模糊，低端机滚动更稳 */
  compact?: boolean;
  className?: string;
}) {
  const rawId = useId();
  const uid = `art${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const match = matchCardArt(name);
  const resolved = family ?? match.family;

  if (!resolved) {
    // 没匹配到家族时退回分类线稿：它是个图标，不能按满版插画放大
    const iconClass = className ? `${className} ${className}--icon` : '';
    return <CategoryArt category={category} className={iconClass} />;
  }

  const palette = paletteFor(match.variant);
  const body = motifMarkup(resolved, palette, uid);
  const markup =
    defsMarkup(palette, uid) +
    `<rect width="320" height="448" fill="url(#${uid}-halo)"/>` +
    // 先铺一层大模糊的暖光，再压上清晰线稿：玻璃里的余烬，而不是印刷海报。
    // 网格缩略图（compact）省掉这层模糊，滚动时不必为每张卡做一次高斯模糊。
    (compact ? '' : `<g filter="url(#${uid}-soft)" opacity="0.7">${body}</g>`) +
    body;

  return (
    <svg
      viewBox="0 0 320 448"
      className={className}
      role="img"
      aria-label={`${name} 卡面`}
      dangerouslySetInnerHTML={{ __html: markup }}
    />
  );
}
