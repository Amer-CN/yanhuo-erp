import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent
} from 'react';
import { animate, motion, useMotionValue, useReducedMotion, useSpring } from 'motion/react';
import type { AlbumCard } from '../../db/album';
import { fenToStr, isoToLocalDate, isoToTime } from '../../db/util';
import { Btn, Sheet } from '../kit';
import FireworkArt from './art/FireworkArt';
import { tiltAngles } from './orientation';
import { useDeviceTilt } from './useDeviceTilt';

/**
 * 横向每拖 1px 转多少度。
 * 1.2 意味着在 260px 宽的卡上横扫一屏大约转 310°，够顺手转起来；
 * 原来 0.6 的设定一次滑动只转半圈不到，看起来就像「转不动」。
 */
const DEG_PER_PX = 1.2;
/** 位移小于这个值当成点击（翻面） */
const CLICK_SLOP = 3;

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

/** 离当前角度最近的正面/反面 */
const nearestFace = (deg: number) => Math.round(deg / 180) * 180;

export default function AlbumCardDetail({
  card,
  updatedAt,
  onClose
}: {
  card: AlbumCard;
  /** 本赛季数据最近更新时间；没有计入明细时为 null */
  updatedAt?: string | null;
  onClose: () => void;
}) {
  const reduce = useReducedMotion();
  const rotate = useMotionValue(0);
  const tiltX = useSpring(0, { stiffness: 120, damping: 20 });
  const tiltZ = useSpring(0, { stiffness: 120, damping: 20 });
  const [dragging, setDragging] = useState(false);
  const [spinning, setSpinning] = useState(false);
  const [denied, setDenied] = useState(false);
  const drag = useRef<DragState | null>(null);
  /** 惯性/翻面动画：再次按下时必须先停，否则会和手指抢同一根 motion value */
  const spin = useRef<ReturnType<typeof animate> | null>(null);

  useEffect(() => () => spin.current?.stop(), []);

  const onLean = useCallback(
    (lean: { x: number; y: number }) => {
      const angles = tiltAngles(lean);
      tiltX.set(angles.x);
      tiltZ.set(angles.z);
    },
    [tiltX, tiltZ]
  );

  // 手指按住或惯性还在跑时，体感先让位并回正：避免两股力量抢同一张卡
  const tiltEnabled = !dragging && !spinning;
  const tilt = useDeviceTilt({ enabled: tiltEnabled, onLean });

  useEffect(() => {
    if (tiltEnabled) return;
    tiltX.set(0);
    tiltZ.set(0);
  }, [tiltEnabled, tiltX, tiltZ]);

  const trackSpin = useCallback((controls: ReturnType<typeof animate>) => {
    spin.current = controls;
    setSpinning(true);
    const done = () => {
      if (spin.current !== controls) return;
      spin.current = null;
      setSpinning(false);
    };
    controls.then(done, done);
  }, []);

  const flip = useCallback(() => {
    const current = rotate.get();
    const nearest = nearestFace(current);
    // 停歪了就回到最近的一面；正停在某一面时翻到另一面
    const target = Math.abs(current - nearest) < 1 ? nearest + 180 : nearest;
    spin.current?.stop();
    if (reduce) {
      rotate.jump(target);
      return;
    }
    trackSpin(animate(rotate, target, { type: 'spring', stiffness: 240, damping: 30 }));
  }, [reduce, rotate, trackSpin]);

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // iOS 只允许在用户手势里申请体感权限：第一次摸卡就自动申请，不再单独放按钮
    if (tilt.needsPermission && !tilt.active) {
      void tilt.requestPermission().then((ok) => {
        if (!ok) setDenied(true);
      });
    }
    spin.current?.stop();
    setSpinning(false);
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
    if (reduce) {
      rotate.jump(nearestFace(rotate.get()));
      return;
    }
    // 松手后接着转：按最后一段速度继续，自然减到停。
    // 不做「吸附到正反面」——那会让惯性刚起就被拉回近处，看起来根本没转。
    trackSpin(
      animate(rotate, rotate.get(), {
        type: 'inertia',
        velocity: d.velocity,
        restDelta: 0.1
      })
    );
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
            没拿到体感权限，拖动卡片照常可用。
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
              aria-label={`${card.name} 卡；横向拖动可旋转，回车或点击翻面`}
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
        {updatedAt ? (
          <p className="tiny-text" style={{ margin: 0 }}>
            数据更新于 {isoToLocalDate(updatedAt).slice(5)} {isoToTime(updatedAt)}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
