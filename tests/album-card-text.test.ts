import { describe, expect, it } from 'vitest';
import { albumCardGapText, albumCardLabel } from '../src/ui/album/cardText';
import type { AlbumCard } from '../src/db/album';

const card = (patch: Partial<AlbumCard>): AlbumCard => ({
  productId: 'p1',
  name: '加特林',
  category: '烟花',
  stopped: false,
  grossFen: 0,
  rarity: 'R',
  nextFen: 5000,
  no: '#001',
  rank: null,
  isNew: false,
  ...patch
});

describe('网格卡的下一档差额', () => {
  it('R 卡显示离 SR 还差多少', () => {
    expect(albumCardGapText(card({ grossFen: 1200, nextFen: 5000 }))).toBe('距 SR 还差 ¥38.00');
  });

  it('UR 卡显示已满级', () => {
    expect(albumCardGapText(card({ rarity: 'UR', grossFen: 80000, nextFen: null }))).toBe('已满级');
  });

  it('负毛利按 0 起算，差额不会超过下一档', () => {
    expect(albumCardGapText(card({ grossFen: -3000, nextFen: 5000 }))).toBe('距 SR 还差 ¥50.00');
  });
});

describe('网格卡的可访问名', () => {
  it('包含商品名、品质、本赛季毛利与差额', () => {
    expect(albumCardLabel(card({ name: '二踢脚', rarity: 'SR', grossFen: 6000, nextFen: 20000 }))).toBe(
      '二踢脚，SR 卡，本赛季毛利 ¥60.00，距 SSR 还差 ¥140.00'
    );
  });
});
