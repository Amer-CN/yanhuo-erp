import { describe, expect, it } from 'vitest';
import { matchCardArt } from '../src/db/cardArt';

describe('卡面名字匹配', () => {
  it('直接命中家族', () => {
    expect(matchCardArt('加特林').family).toBe('gatling');
    expect(matchCardArt('水母').family).toBe('jellyfish');
    expect(matchCardArt('孔雀开屏').family).toBe('peacock');
    expect(matchCardArt('仙女棒').family).toBe('sparkler');
    expect(matchCardArt('二踢脚').family).toBe('doubleBang');
    expect(matchCardArt('大地红').family).toBe('firecracker');
  });

  it('识别变体颜色', () => {
    const gold = matchCardArt('黄金加特林');
    expect(gold.family).toBe('gatling');
    expect(gold.variant).toBe('gold');

    expect(matchCardArt('银色喷泉').variant).toBe('silver');
    expect(matchCardArt('七彩莲花').variant).toBe('rainbow');
  });

  it('复合意象取先出现的做主、另一个做次', () => {
    const m = matchCardArt('网红风车蜻蜓');
    expect(m.family).toBe('windmill');
    expect(m.secondary).toBe('dragonfly');
  });

  it('忽略发数、口径、营销词', () => {
    expect(matchCardArt('36发 黄金加特林 网红爆款').family).toBe('gatling');
    expect(matchCardArt('加特林-2026新款').family).toBe('gatling');
  });

  it('匹配不到就返回空，交给分类兜底', () => {
    const m = matchCardArt('随便一个名字');
    expect(m.family).toBeNull();
    expect(m.confidence).toBe(0);
  });
});

describe('新增家族', () => {
  it('蝴蝶 / 蜜蜂 / 莲花 / 火箭 / 组合礼花 / 旋转类都能识别', () => {
    expect(matchCardArt('蝴蝶').family).toBe('butterfly');
    expect(matchCardArt('小蜜蜂').family).toBe('bee');
    expect(matchCardArt('七彩莲花').family).toBe('lotus');
    expect(matchCardArt('窜天猴').family).toBe('rocket');
    expect(matchCardArt('金玉满堂').family).toBe('bouquet');
    expect(matchCardArt('彩菊').family).toBe('spinner');
  });
});
