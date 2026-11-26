import { RARITY_ORDER, RARITY_THRESHOLDS_FEN } from '../../db/album';
import { fenToStr } from '../../db/util';
import FireworkArt from './art/FireworkArt';

/** 品质样张：开赛前也能看到 SR/SSR/UR 长什么样，不计入收集 */
export default function QualitySamples() {
  return (
    <div className="album-samples">
      {RARITY_ORDER.map((rarity) => (
        <div key={rarity} className={`album-sample album-card--${rarity.toLowerCase()}`}>
          <div className="album-sample__frame">
            <FireworkArt name="加特林" category="烟花" className="album-sample__art" />
            <span className="album-card__rarity">{rarity}</span>
          </div>
          <span className="album-sample__label">
            {rarity} · 单件毛利 ≥ ¥{fenToStr(RARITY_THRESHOLDS_FEN[rarity])}
          </span>
        </div>
      ))}
    </div>
  );
}
