import { useCallback, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react';
import Tilt from 'react-parallax-tilt';
import type { AlbumCard } from '../../db/album';
import { fenToStr, isoToLocalDate, isoToTime } from '../../db/util';
import { Btn, Sheet } from '../kit';
import FireworkArt from './art/FireworkArt';
import { useGyroPermission } from './useGyroPermission';

/** 位移小于这个值当成点击（翻面） */
const CLICK_SLOP = 4;

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
  const [denied, setDenied] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  const gyro = useGyroPermission();

  const flip = useCallback(() => {
    const target = rotate.get() > 90 ? 0 : 180;
    if (reduce) {
      rotate.jump(target);
      return;
    }
    animate(rotate, target, { type: 'spring', stiffness: 220, damping: 26 });
  }, [reduce, rotate]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (gyro.needsPermission && !gyro.granted) {
      void gyro.requestPermission().then((ok) => {
        if (!ok) setDenied(true);
      });
    }
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    d.moved = Math.max(d.moved, Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y));
  };

  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    if (d && d.moved < CLICK_SLOP) flip();
  };

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
            没拿到体感权限，手指拖动也能倾斜查看。
          </p>
        ) : null}

        <div className="album-detail__stage">
          <Tilt
            className="album-detail__tilt"
            gyroscope
            tiltMaxAngleX={10}
            tiltMaxAngleY={10}
            perspective={1200}
            transitionSpeed={450}
            glareEnable
            glareMaxOpacity={0.14}
            glareColor="#ffffff"
            glareBorderRadius="24px"
          >
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
                <FireworkArt name={card.name} category={card.category} className="album-detail__art" />
                <span className="album-card__rarity">{card.rarity}</span>
              </div>
              <div className={`${faceClass(card)} album-detail__face--back`}>
                <span className="album-detail__mark">{card.rarity}</span>
                <span className="album-detail__mark-sub">{card.category} · 烟花卡册</span>
              </div>
            </motion.div>
          </Tilt>
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
