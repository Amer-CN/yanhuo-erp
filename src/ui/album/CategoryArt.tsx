import type { Category } from '../../db/types';

/**
 * 卡面分类插画：四个类别各一套极简线性图，断网可用、不依赖图片资源。
 * 统一 48×48 视框、2px 描边、currentColor 取色，由外层决定品质色。
 */
export default function CategoryArt({
  category,
  className = ''
}: {
  category: Category;
  className?: string;
}) {
  const common = {
    className,
    viewBox: '0 0 48 48',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  };

  if (category === '炮') {
    return (
      <svg {...common}>
        <rect x="14" y="20" width="8" height="18" rx="2" />
        <rect x="24" y="16" width="8" height="22" rx="2" />
        <path d="M18 20c0-4 4-5 4-8" />
        <path d="M28 16c1-4 5-5 5-8" />
        <path d="M12 38h24" />
        <path d="M18 12l2 2M33 8l2 2" />
      </svg>
    );
  }

  if (category === '儿童') {
    return (
      <svg {...common}>
        <path d="M20 30L30 42" />
        <circle cx="22" cy="18" r="2" />
        <path d="M22 18l-6-4M22 18l1-7M22 18l6-3M22 18l-5 3M22 18l5 5" />
        <path d="M31 27l1.5 1.5M35 22l1.5 1.5M27 24l1.5 1.5" />
      </svg>
    );
  }

  if (category === '组合') {
    return (
      <svg {...common}>
        <rect x="10" y="20" width="28" height="18" rx="2" />
        <path d="M10 27h28" />
        <path d="M24 20v18" />
        <path d="M24 20c-5 0-9-2-9-5s4-3 5-1 4 6 4 6z" />
        <path d="M24 20c5 0 9-2 9-5s-4-3-5-1-4 6-4 6z" />
      </svg>
    );
  }

  // 烟花（也是无法识别分类时的兜底）
  return (
    <svg {...common}>
      <circle cx="24" cy="24" r="4" />
      <path d="M24 6v8M24 34v8M6 24h8M34 24h8" />
      <path d="M11 11l6 6M31 31l6 6M37 11l-6 6M17 31l-6 6" />
      <circle cx="24" cy="24" r="10" strokeDasharray="2 4" />
    </svg>
  );
}
