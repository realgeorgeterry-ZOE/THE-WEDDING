import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { photoUrl } from '../services/wedding';

type Photo = Record<string, any>;

type Props = {
  photos: Photo[];
  onSelect: (photo: Photo) => void;
};

type Position = {
  x: number;
  y: number;
  z: number;
  rotation: number;
  scale: number;
};

function hashId(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function makePosition(photo: Photo, index: number): Position {
  const hash = hashId(String(photo.id ?? index));
  const value = (shift: number) => ((hash >>> shift) & 0xffff) / 0xffff;
  return {
    x: (value(0) - 0.5) * 86,
    y: (value(8) - 0.5) * 62,
    z: -650 - index * 820 - value(16) * 180,
    rotation: (value(4) - 0.5) * 12,
    scale: 0.86 + value(12) * 0.28,
  };
}

function supportsSpatialView() {
  return typeof CSS !== 'undefined'
    && CSS.supports('perspective', '1000px')
    && CSS.supports('transform-style', 'preserve-3d');
}

export default function MemorySpaceGallery({ photos, onSelect }: Props) {
  const trackRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const [spatial, setSpatial] = useState(false);
  const [visibleRange, setVisibleRange] = useState<[number, number]>([0, 5]);
  const positions = useMemo(() => photos.map(makePosition), [photos]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setSpatial(supportsSpatialView() && !preference.matches && photos.length > 0);
    update();
    preference.addEventListener('change', update);
    return () => preference.removeEventListener('change', update);
  }, [photos.length]);

  useEffect(() => {
    if (!spatial) return;
    const track = trackRef.current;
    const stage = stageRef.current;
    const world = worldRef.current;
    if (!track || !stage || !world) return;

    let targetProgress = 0;
    let progress = 0;
    let targetX = 0;
    let targetY = 0;
    let lookX = 0;
    let lookY = 0;
    let frame = 0;
    let lastFrameTime = 0;
    const travel = Math.max(1350, photos.length * 820 + 900);

    const updateVisibleRange = (cameraZ: number) => {
      const buffer = 2200;
      const first = Math.max(0, Math.floor((cameraZ - buffer - 830) / 820));
      const last = Math.min(photos.length, Math.ceil((cameraZ + buffer + 830) / 820));
      setVisibleRange(current => current[0] === first && current[1] === last ? current : [first, last]);
    };

    const updateProgress = () => {
      const top = track.getBoundingClientRect().top + window.scrollY;
      const range = Math.max(1, track.offsetHeight - window.innerHeight);
      targetProgress = Math.max(0, Math.min(1, (window.scrollY - top) / range));
      if (!frame) frame = window.requestAnimationFrame(animate);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      const bounds = stage.getBoundingClientRect();
      targetX = Math.max(-1, Math.min(1, ((event.clientX - bounds.left) / bounds.width - 0.5) * 2));
      targetY = Math.max(-1, Math.min(1, ((event.clientY - bounds.top) / bounds.height - 0.5) * 2));
      if (!frame) frame = window.requestAnimationFrame(animate);
    };
    const onPointerLeave = () => {
      targetX = 0;
      targetY = 0;
      if (!frame) frame = window.requestAnimationFrame(animate);
    };

    function animate(timestamp: number) {
      frame = 0;
      const elapsed = lastFrameTime ? Math.min(timestamp - lastFrameTime, 50) : 16.67;
      lastFrameTime = timestamp;
      const smoothing = 1 - Math.exp(-elapsed / 120);
      progress += (targetProgress - progress) * smoothing;
      lookX += (targetX - lookX) * smoothing;
      lookY += (targetY - lookY) * smoothing;
      const cameraZ = progress * travel;
      updateVisibleRange(cameraZ);
      world!.style.transform = `translate3d(0, 0, ${cameraZ}px) rotateX(${-lookY * 1.25}deg) rotateY(${lookX * 1.8}deg)`;
      if (Math.abs(targetProgress - progress) > 0.001 || Math.abs(targetX - lookX) > 0.001 || Math.abs(targetY - lookY) > 0.001) {
        frame = window.requestAnimationFrame(animate);
      }
    }

    updateProgress();
    window.addEventListener('scroll', updateProgress, { passive: true });
    window.addEventListener('resize', updateProgress);
    stage.addEventListener('pointermove', onPointerMove);
    stage.addEventListener('pointerleave', onPointerLeave);
    return () => {
      window.removeEventListener('scroll', updateProgress);
      window.removeEventListener('resize', updateProgress);
      stage.removeEventListener('pointermove', onPointerMove);
      stage.removeEventListener('pointerleave', onPointerLeave);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [photos.length, spatial]);

  if (!spatial) {
    return <div className="masonry">{photos.map(photo => <button key={photo.id} onClick={() => onSelect(photo)}><img loading="lazy" src={photoUrl(photo)} alt={photo.caption || 'Wedding memory'}/>{photo.caption && <span>{photo.caption}</span>}</button>)}</div>;
  }

  return <div className="memory-space-track" ref={trackRef} style={{ height: `${Math.max(1.8, photos.length * 0.82 + 0.8) * 100}vh` }}>
    <div className="memory-space-stage" ref={stageRef} aria-label="Wedding photographs in a 3D space">
      <div className="memory-space-world" ref={worldRef}>
        {photos.slice(visibleRange[0], visibleRange[1]).map((photo, offset) => {
          const index = visibleRange[0] + offset;
          const position = positions[index];
          return <button
            className="memory-space-photo"
            key={photo.id}
            onClick={() => onSelect(photo)}
            onPointerMove={event => {
              if (event.pointerType === 'touch') return;
              const bounds = event.currentTarget.getBoundingClientRect();
              const x = (event.clientX - bounds.left) / bounds.width - 0.5;
              const y = (event.clientY - bounds.top) / bounds.height - 0.5;
              event.currentTarget.style.setProperty('--photo-tilt-x', `${-y * 3}deg`);
              event.currentTarget.style.setProperty('--photo-tilt-y', `${x * 3}deg`);
            }}
            onPointerDown={event => {
              if (event.pointerType !== 'touch') return;
              event.currentTarget.classList.add('is-engaged');
            }}
            onPointerUp={event => {
              if (event.pointerType !== 'touch') return;
              const photo = event.currentTarget;
              window.setTimeout(() => photo.classList.remove('is-engaged'), 140);
            }}
            onPointerCancel={event => event.currentTarget.classList.remove('is-engaged')}
            onPointerLeave={event => {
              if (event.pointerType === 'touch') return;
              event.currentTarget.style.removeProperty('--photo-tilt-x');
              event.currentTarget.style.removeProperty('--photo-tilt-y');
              event.currentTarget.classList.remove('is-engaged');
            }}
            aria-label={photo.caption || `Open wedding memory ${index + 1}`}
            style={{
              '--photo-x': `${position.x}vw`,
              '--photo-y': `${position.y}vh`,
              '--photo-z': `${position.z}px`,
              '--photo-rotation': `${position.rotation}deg`,
              '--photo-scale': position.scale,
            } as CSSProperties}
          >
            <img loading="lazy" src={photoUrl(photo)} alt={photo.caption || 'Wedding memory'}/>
            {photo.caption && <span>{photo.caption}</span>}
          </button>;
        })}
      </div>
    </div>
  </div>;
}
