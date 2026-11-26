import { useId } from 'react';
import { matchCardArt } from '../../../db/cardArt';
import type { Category } from '../../../db/types';
import CategoryArt from '../CategoryArt';
import { defsMarkup, motifMarkup, paletteFor } from './motifs';

/**
 * 按商品名自动选家族插画。
 * 匹配不到就退回原来的分类图，保证任何商品都有卡面。
 */
export default function FireworkArt({
  name,
  category,
  className = ''
}: {
  name: string;
  category: Category;
  className?: string;
}) {
  const rawId = useId();
  const uid = `art${rawId.replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const match = matchCardArt(name);

  if (!match.family) {
    // 没匹配到家族时退回分类线稿：它是个图标，不能按满版插画放大
    const iconClass = className ? `${className} ${className}--icon` : '';
    return <CategoryArt category={category} className={iconClass} />;
  }

  const palette = paletteFor(match.variant);
  const markup =
    defsMarkup(palette, uid) +
    `<rect width="320" height="448" fill="url(#${uid}-bg)"/>` +
    motifMarkup(match.family, palette, uid) +
    `<rect width="320" height="448" fill="url(#${uid}-vig)"/>`;

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
