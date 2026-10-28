import { useEffect, useRef } from 'react';
import { useElementSize } from '../useElementSize';
import { OpenDockPet, type PetOptions, type PetTouch } from '.';

type Props = { face?: string; color?: string; width: number; height: number; opacity?: number; pet?: PetOptions };

// Draws the pet at the phone's block size (width x height px) and scales it to fit this element, like the other
// widget previews. The mouse stands in for a finger: click, double-click, hold or drag it to play with it.
export function PetPreview({ face, color, width, height, opacity, pet }: Props) {
  const petKey = JSON.stringify(pet ?? null);
  const [frameRef, box] = useElementSize<HTMLDivElement>();
  const hostRef = useRef<HTMLDivElement>(null);
  const handleRef = useRef<ReturnType<typeof OpenDockPet.mount> | null>(null);
  useEffect(() => {
    if (!hostRef.current) return;
    const handle = OpenDockPet.mount(hostRef.current, { face, color, width, height, opacity, pet });
    handleRef.current = handle;
    return () => { handleRef.current = null; handle.destroy(); };
  }, [face, color, width, height, opacity, petKey]);
  const scale = box.width && box.height ? Math.min(box.width / width, box.height / height) : 0;
  // x and y in the widget's own px: undo the preview's scale.
  const touch = (kind: PetTouch) => (event: React.PointerEvent<HTMLDivElement>) => {
    if (!scale) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (kind === 'down') event.currentTarget.setPointerCapture(event.pointerId);
    handleRef.current?.touch(kind, (event.clientX - rect.left) / scale, (event.clientY - rect.top) / scale);
  };
  return <div ref={frameRef} className="clock-face-frame">
    <div ref={hostRef} className="clock-face-host" onPointerDown={touch('down')} onPointerMove={(event) => { if (event.buttons) touch('move')(event); }} onPointerUp={touch('up')} onPointerCancel={touch('cancel')} style={{ width, height, left: (box.width - width * scale) / 2, top: (box.height - height * scale) / 2, transform: `scale(${scale})`, visibility: scale ? 'visible' : 'hidden' }} />
  </div>;
}
