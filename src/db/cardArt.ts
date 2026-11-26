// 商品名 → 卡面家族/变体匹配。纯函数，不依赖 DOM，方便单测。
//
// 为什么要两层：一个商品名 = 家族（画什么）+ 变体（什么颜色）。
// 「黄金加特林」不是新画，是加特林家族换金色；「网红风车蜻蜓」是风车主、蜻蜓次。

export const ART_FAMILIES = [
  'gatling',
  'jellyfish',
  'windmill',
  'dragonfly',
  'peacock',
  'fountain',
  'sparkler',
  'doubleBang',
  'firecracker',
  'sunflower'
] as const;

export type ArtFamily = (typeof ART_FAMILIES)[number];

export const ART_VARIANTS = ['normal', 'gold', 'silver', 'blue', 'rainbow', 'neon'] as const;
export type ArtVariant = (typeof ART_VARIANTS)[number];

export interface CardArtMatch {
  family: ArtFamily | null;
  /** 复合意象的第二个家族，用来做角标或底纹 */
  secondary: ArtFamily | null;
  variant: ArtVariant;
  /** 0 = 没匹配上，交给分类兜底 */
  confidence: number;
  /** 命中的别名原文，便于排查 */
  matched: string | null;
}

/** 家族 → 别名。长词优先，避免「风车」抢掉「风车蜻蜓」。 */
const FAMILY_ALIASES: Record<ArtFamily, string[]> = {
  gatling: ['加特林机枪', '加特林', '机枪', '连发炮'],
  jellyfish: ['水母伞', '水母'],
  windmill: ['风车', '风火轮', '四叶风车'],
  dragonfly: ['蜻蜓', '小蜻蜓', '飞蜻蜓'],
  peacock: ['孔雀开屏', '孔雀'],
  fountain: ['银色喷泉', '火树银花', '满地珍珠', '喷泉', '瀑布'],
  sparkler: ['电光花', '仙女棒', '手持烟花', '钢丝棉'],
  doubleBang: ['二踢脚', '双响', '高升'],
  firecracker: ['大地红', '鞭炮', '挂鞭', '摔炮', '擦炮', '划炮'],
  sunflower: ['向日葵', '向阳花', '太阳花']
};

const MARKETING_WORDS = [
  '网红',
  '新款',
  '爆款',
  '特价',
  '正品',
  '厂家',
  '直销',
  '加厚',
  '加大',
  '大号',
  '小号',
  '迷你',
  '儿童',
  '批发'
];

const VARIANT_ALIASES: Array<[ArtVariant, string[]]> = [
  ['gold', ['黄金', '金色', '金箔', '金牛']],
  ['silver', ['白银', '银色', '银光', '银']],
  ['rainbow', ['七彩', '彩虹', '彩色', '五彩']],
  ['blue', ['蓝焰', '蓝色', '蓝光', '蓝']],
  ['neon', ['夜光', '荧光', '发光']]
];

function normalize(name: string): string {
  let s = name.toLowerCase();
  s = s.replace(/[\s，。、,.·\-—_/\\()（）【】!！?？:：;；"'“”‘’]/g, '');
  // 规格数字：36发、30cm、2寸、500响
  s = s.replace(/\d+(发|响|管|秒|分钟|cm|mm|寸|米|m|g|克|元)?/g, '');
  for (const w of MARKETING_WORDS) s = s.split(w).join('');
  return s;
}

/** 命中最长别名的家族；同长度取更早出现的 */
function findFamilies(normalized: string): Array<{ family: ArtFamily; index: number; alias: string }> {
  const hits: Array<{ family: ArtFamily; index: number; alias: string }> = [];
  for (const family of ART_FAMILIES) {
    let best: { index: number; alias: string } | null = null;
    for (const alias of FAMILY_ALIASES[family]) {
      const index = normalized.indexOf(alias);
      if (index < 0) continue;
      if (!best || alias.length > best.alias.length || (alias.length === best.alias.length && index < best.index)) {
        best = { index, alias };
      }
    }
    if (best) hits.push({ family, ...best });
  }
  return hits.sort((a, b) => {
    if (b.alias.length !== a.alias.length) return b.alias.length - a.alias.length;
    return a.index - b.index;
  });
}

function detectVariant(name: string): ArtVariant {
  for (const [variant, words] of VARIANT_ALIASES) {
    if (words.some((w) => name.includes(w))) return variant;
  }
  return 'normal';
}

export function matchCardArt(name: string): CardArtMatch {
  const normalized = normalize(name);
  const hits = findFamilies(normalized);
  const variant = detectVariant(name);
  if (hits.length === 0) {
    return { family: null, secondary: null, variant, confidence: 0, matched: null };
  }
  const [primary, next] = hits;
  const secondary = next && next.family !== primary.family ? next.family : null;
  return {
    family: primary.family,
    secondary,
    variant,
    confidence: secondary ? 0.8 : 0.9,
    matched: primary.alias
  };
}
