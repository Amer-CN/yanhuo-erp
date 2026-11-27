import { useCallback, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { animate, motion, useMotionValue, useReducedMotion } from 'motion/react';
import Tilt from 'react-parallax-tilt';
import type { AlbumCard } from '../../db/album';
import { fenToStr, isoToLocalDate, isoToTime } from '../../db/util';
import { Btn, Sheet } from '../kit';
import FireworkArt from './art/FireworkArt';
import { useHoloTilt } from './useHoloTilt';

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
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null);
  // 指针倾斜交给 Tilt；陀螺仪用 react-holo-card 的实现（重力向量 + 平滑 + 基准 + iOS 授权）
  const holo = useHoloTilt(10, true);

  const flip = useCallback(() => {
    const target = rotate.get() > 90 ? 0 : 180;
    if (reduce) {
      rotate.jump(target);
      return;
    }
    animate(rotate, target, { type: 'spring', stiffness: 220, damping: 26 });
  }, [reduce, rotate]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // iOS 只允许在用户手势里申请体感权限
    holo.requestGyro();
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    holo.onPointerMove(e);
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
        <div className="album-detail__stage">
          <Tilt
            className="album-detail__tilt"
            gyroscope={false}
            tiltEnable={!holo.gyroLive}
            tiltMaxAngleX={10}
            tiltMaxAngleY={10}
            perspective={1200}
            transitionSpeed={450}
            glareEnable
            glareMaxOpacity={0.14}
            glareColor="#ffffff"
            glareBorderRadius="24px"
          >
            <div ref={holo.elRef} className="album-detail__holo">
              <motion.div
                className="album-detail__card"
                style={{ rotateY: rotate }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endDrag}
                onPointerCancel={endDrag}
                onPointerLeave={holo.onPointerLeave}
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
                    className="album-detail__art"
                  />
                  <span className="album-card__rarity">{card.rarity}</span>
                </div>
                <div className={`${faceClass(card)} album-detail__face--back`}>
                  <span className="album-detail__mark">{card.rarity}</span>
                  <span className="album-detail__mark-sub">{card.category} · 烟花卡册</span>
                </div>
              </motion.div>
            </div>
          </Tilt>
        </div>

        <div className="album-gyro-status">
          {!holo.supported ? (
            <span className="tiny-text">这台设备或浏览器不支持体感，手指拖动也能倾斜</span>
          ) : holo.gyroLive ? (
            <span className="tiny-text">体感已开启，晃动手机看光泽</span>
          ) : holo.needsPermission ? (
            <Btn size="sm" variant="secondary" block={false} onClick={() => holo.requestGyro()}>
              开启体感倾斜
            </Btn>
          ) : (
            <span className="tiny-text">体感已就绪：晃动手机试试</span>
          )}
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
