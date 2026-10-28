import { useEffect, useRef } from 'react';
import { useElementSize } from '../useElementSize';
import { OpenDockClock, HOUR12 } from '.';

type Props = {
  face: string; color?: string; width: number; height: number;
  // false = show a still frame (face browser tiles that aren't hovered).
  live?: boolean;
  // Canvas resolution cap; small tiles use 1.
  pixelRatio?: number;
  // Editor faces pause while the face browser is open; browser tiles pass false.
  background?: boolean;
  // How solid the face's own background is, 0 to 100.
  opacity?: number;
};

// Draws a face at the phone's block size (width x height px) and scales it to fit this element,
// the same way the Now Playing preview does, so the editor matches the phone.
// It stops drawing while scrolled out of view.
export function ClockFacePreview({ face, color, width, height, live = true, pixelRatio = 2, background = true, opacity = 100 }: Props) {
  const [frameRef, box] = useElementSize<HTMLDivElement>();
  const hostRef = useRef<HTMLDivElement>(null);
  const mounted = useRef<ReturnType<typeof OpenDockClock.mount> | null>(null);
  const liveRef = useRef(live);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const handle = OpenDockClock.mount(host, { face, color, width, height, hour12: HOUR12, live: liveRef.current, pixelRatio, background, opacity });
    mounted.current = handle;
    const frame = frameRef.current;
    const observer = frame ? new IntersectionObserver(([entry]) => handle.setVisible(entry.isIntersecting)) : null;
    if (frame) observer?.observe(frame);
    return () => { observer?.disconnect(); handle.destroy(); mounted.current = null; };
  }, [face, color, width, height, pixelRatio, background, opacity, frameRef]);
  useEffect(() => {
    liveRef.current = live;
    mounted.current?.setLive(live);
  }, [live]);
  const scale = box.width && box.height ? Math.min(box.width / width, box.height / height) : 0;
  return <div ref={frameRef} className="clock-face-frame">
    <div ref={hostRef} className="clock-face-host" style={{ width, height, left: (box.width - width * scale) / 2, top: (box.height - height * scale) / 2, transform: `scale(${scale})`, visibility: scale ? 'visible' : 'hidden' }} />
  </div>;
}
