import { describe, expect, it } from 'vitest';
import { detectUpgradedIds } from '../src/ui/album/upgrade';
import type { AlbumCard, Rarity } from '../src/db/album';

const card = (productId: string, rarity: Rarity): AlbumCard => ({
  productId,
  name: productId,
  category: '烟花',
  stopped: false,
  grossFen: 0,
  rarity,
  nextFen: null,
  no: '#001',
  rank: null,
  isNew: false
});

describe('升级检测', () => {
  it('首次载入（没有旧快照）不返回任何升级', () => {
    expect(detectUpgradedIds(new Map(), [card('p1', 'UR')])).toEqual([]);
  });

  it('品质升高才算升级', () => {
    const prev = new Map<string, Rarity>([
      ['p1', 'R'],
      ['p2', 'SSR']
    ]);
    expect(detectUpgradedIds(prev, [card('p1', 'SR'), card('p2', 'SR')])).toEqual(['p1']);
  });

  it('新出现的商品不算升级', () => {
    const prev = new Map<string, Rarity>([['p1', 'R']]);
    expect(detectUpgradedIds(prev, [card('p1', 'R'), card('p2', 'UR')])).toEqual([]);
  });
});
