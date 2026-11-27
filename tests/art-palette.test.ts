import { describe, expect, it } from 'vitest';
import { paletteFor } from '../src/ui/album/art/motifs';

/** 粗略相对亮度：只看线条在浅底上会不会糊掉 */
function luminance(hex: string): number {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16) / 255;
  const g = parseInt(v.slice(2, 4), 16) / 255;
  const b = parseInt(v.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('卡面配色跟随主题', () => {
  it('深色主题用亮线', () => {
    expect(luminance(paletteFor('normal', 'dark').line)).toBeGreaterThan(0.7);
  });

  it('浅色主题用深线，否则卡片上看不见', () => {
    for (const variant of ['normal', 'gold', 'silver', 'blue', 'rainbow', 'neon']) {
      expect(luminance(paletteFor(variant, 'light').line)).toBeLessThan(0.4);
    }
  });

  it('浅色主题的余烬光是深色，不会在浅底上发白', () => {
    expect(luminance(paletteFor('normal', 'light').ember)).toBeLessThan(0.6);
  });
});
