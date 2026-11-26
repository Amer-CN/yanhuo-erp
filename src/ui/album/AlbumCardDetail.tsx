import {
  useCallback,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react';
import {
  animate,
  motion,
  useMotionValue,
  useReducedMotion,
  useSpring,
  useTransform
} from 'motion/react';
import type { AlbumCard } from '../../db/album';
import { fenToStr, isoToLocalDate, isoToTime } from '../../db/util';
import { Btn, Sheet } from '../kit';
import FireworkArt from './art/FireworkArt';
import { tiltAngles } from './orientation';
import { useDeviceTilt } from './useDeviceTilt';

/** 触摸倾斜：每拖 1px 转多少度（±12° 满量程） */
const DEG_PER_PX = 0.14;
/** 位移小于这个值当成点击（翻面） */
const CLICK_SLOP = 4;
/** 触摸倾斜回中的弹簧 */
const RETURN = { type: 'spring' as const, stiffness: 220, damping: 26 };

const faceClass = (card: AlbumCard) =>
  card.rarity === 'UR' ? 'album-detail__face album-detail__face--ur' : 'album-detail__face';

export default function AlbumCardDetail({
  card,
  updatedAt,
  onClose
}: {
  card: AlbumCard;
  updatedAt?: string | null;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const rotate = useMotionValue(0);
  const tiltX = useSpring(0, { stiffness: 140, damping: 22 });
  const tiltZ = useSpring(0, { stiffness: 140, damping: 22 });
  const [denied, setDenied] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);

  const onLean = useCallback(
    (lean: { x: number; y: number }) => {
      const a = tiltAngles(lean);
      tiltX.set(a.x);
      tiltZ.set(a.z);
    },
    [tiltX, tiltZ]
  );

  const tilt = useDeviceTilt({ onLean });

  const flip = useCallback(() => {
    const target = rotate.get() > 90 ? 0 : 180;
    if (reduce) {
      rotate.jump(target);
      return;
    }
    animate(rotate, target, { type: 'spring', stiffness: 220, damping: 26 });
  }, [reduce, rotate]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // iOS 只允许在用户手势里申请体感权限：第一次摸卡就自动申请
    if (tilt.needsPermission && !tilt.active) {
      void tilt.requestPermission().then((ok) => {
        if (!ok) setDenied(true);
      });
    }
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    d.moved = Math.max(d.moved, Math.abs(dx) + Math.abs(dy));
    // 有体感就不再用手指改倾斜：两种输入二选一，避免抢同一张卡
    if (tilt.active) return;
    tiltZ.set(Math.max(-12, Math.min(12, dx * DEG_PER_PX)));
    tiltX.set(Math.max(-12, Math.min(12, -dy * DEG_PER_PX)));
  };

  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved < CLICK_SLOP) {
      flip();
      return;
    }
    if (!tilt.active && !reduce) {
      animate(tiltX, 0, RETURN);
      animate(tiltZ, 0, RETURN);
    }
  };

  const glareX = useTransform(tiltZ, (v) => `${v * 1.6}px`);
  const glareY = useTransform(tiltX, (v) => `${-v * 1.6}px`);

  return (
    <Sheet
      title={card.name}
      subtitle={`${card.rarity} · 本赛季毛利 ¥${fenToStr(card.grossFen)}`}
      onClose={onClose}
      footer={
        <Btn block variant="secondary" onClick={onClose}>
          关闭
        </Btn>
      }
    >
      <div className="album-detail">
        {denied ? (
          <p className="tiny-text" style={{ margin: 0 }}>
            没拿到体感权限，拖动卡片也能倾斜查看。
          </p>
        ) : null}

        <div className="album-detail__stage">
          <motion.div style={{ rotateX: tiltX, rotateZ: tiltZ, transformStyle: 'preserve-3d' }}>
            <motion.div
              className="album-detail__card"
              style={{ rotateY: rotate }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              role="button"
              tabIndex={0}
              aria-label={`${card.name} 卡；点按翻面，倾斜可看光泽`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  flip();
                }
              }}
            >
              <div className={faceClass(card)}>
                <FireworkArt
                  name={card.name}
                  category={card.category}
                  family={card.artFamily}
                  className="album-detail__art"
                />
                <motion.span
                  className="album-detail__glare"
                  aria-hidden="true"
                  style={{ x: glareX, y: glareY }}
                />
                <span className="album-card__rarity">{card.rarity}</span>
              </div>
              <div className={`${faceClass(card)} album-detail__face--back`}>
                <span className="album-detail__mark">{card.rarity}</span>
                <span className="album-detail__mark-sub">{card.category} · 烟花卡册</span>
              </div>
            </motion.div>
          </motion.div>
        </div>

        <p className="muted-text" style={{ margin: 0 }}>
          {card.nextFen === null
            ? '已经是最高品质 UR。'
            : `距离下一档还差 ¥${fenToStr(card.nextFen - card.grossFen)}。`}
        </p>
        {updatedAt ? (
          <p className="tiny-text" style={{ margin: 0 }}>
            数据更新于 {isoToLocalDate(updatedAt).slice(5)} {isoToTime(updatedAt)}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
