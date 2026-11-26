import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import type { AlbumCard } from '../../db/album';
import { fenToStr } from '../../db/util';
import { Btn, Sheet } from '../kit';
import CategoryArt from './CategoryArt';
import { useDeviceTilt } from './useDeviceTilt';

/** 横向每拖 1px 转多少度：一整屏约转两圈 */
const DEG_PER_PX = 0.6;
/** 位移小于这个值当成点击（翻面） */
const CLICK_SLOP = 3;
/** 体感跟随的最大角度 */
const TILT_RANGE_DEG = 8;

interface DragState {
  startX: number;
  startRotate: number;
  moved: number;
  lastX: number;
  lastAt: number;
  velocity: number;
}

/** 品质 → 正反面样式类；UR 额外加全息边框 */
const faceClass = (card: AlbumCard) =>
  card.rarity === 'UR' ? 'album-detail__face album-detail__face--ur' : 'album-detail__face';

export default function AlbumCardDetail({
  card,
  onClose
}: {
  card: AlbumCard;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const rotate = useMotionValue(0);
  const tiltX = useSpring(0, { stiffness: 120, damping: 20 });
  const tiltY = useSpring(0, { stiffness: 120, damping: 20 });
  const [dragging, setDragging] = useState(false);
  const [denied, setDenied] = useState(false);
  const drag = useRef<DragState | null>(null);
  /** 惯性/翻面动画：再次按下时必须先停，否则会和手指抢同一根 motion value */
  const spin = useRef<ReturnType<typeof animate> | null>(null);

  useEffect(() => () => spin.current?.stop(), []);

  const onLean = useCallback(
    (lean: { x: number; y: number }) => {
      tiltY.set(lean.x * TILT_RANGE_DEG);
      tiltX.set(-lean.y * TILT_RANGE_DEG);
    },
    [tiltX, tiltY]
  );

  const tilt = useDeviceTilt({ enabled: !dragging, onLean });

  const flip = useCallback(() => {
    const next = Math.round(rotate.get() / 180 + 1) * 180;
    spin.current?.stop();
    if (reduce) {
      rotate.jump(next);
      return;
    }
    spin.current = animate(rotate, next, { type: 'spring', stiffness: 240, damping: 30 });
  }, [reduce, rotate]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    spin.current?.stop();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = {
      startX: e.clientX,
      startRotate: rotate.get(),
      moved: 0,
      lastX: e.clientX,
      lastAt: performance.now(),
      velocity: 0
    };
    setDragging(true);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    d.moved = Math.max(d.moved, Math.abs(dx));
    rotate.jump(d.startRotate + dx * DEG_PER_PX);

    const now = performance.now();
    const dt = Math.max(1, now - d.lastAt);
    d.velocity = ((e.clientX - d.lastX) / dt) * 1000 * DEG_PER_PX;
    d.lastX = e.clientX;
    d.lastAt = now;
  };

  const endDrag = () => {
    const d = drag.current;
    drag.current = null;
    setDragging(false);
    if (!d) return;

    if (d.moved < CLICK_SLOP) {
      flip();
      return;
    }
    const settle = () => Math.round(rotate.get() / 180) * 180;
    if (reduce) {
      rotate.jump(settle());
      return;
    }
    // 惯性自然减速；modifyTarget 让最终停靠落在正面或反面，而不是薄薄一条边
    spin.current = animate(rotate, rotate.get(), {
      type: 'inertia',
      velocity: d.velocity,
      power: 0.6,
      restDelta: 0.5,
      modifyTarget: settle
    });
  };

  const askTilt = async () => {
    const ok = await tilt.requestPermission();
    setDenied(!ok);
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
        {tilt.needsPermission && !tilt.active ? (
          <div>
            <Btn block variant="secondary" onClick={() => void askTilt()}>
              开启体感倾斜
            </Btn>
            {denied ? <p className="tiny-text">没拿到体感权限，仍然可以拖动卡片。</p> : null}
          </div>
        ) : null}

        <div className="album-detail__stage">
          <motion.div style={{ rotateX: tiltX, rotateY: tiltY, transformStyle: 'preserve-3d' }}>
            <motion.div
              className="album-detail__card"
              style={{ rotateY: rotate }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
              role="button"
              tabIndex={0}
              aria-label={`${card.name} 卡；横向拖动可旋转，回车或点击翻面`}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  flip();
                }
              }}
            >
              <div className={faceClass(card)}>
                <CategoryArt category={card.category} className="album-detail__art" />
                <span className="album-card__rarity">{card.rarity}</span>
                <span className="album-detail__glare" aria-hidden="true" />
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
      </div>
    </Sheet>
  );
}
