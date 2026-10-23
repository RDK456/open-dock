import { useEffect, useRef } from 'react';
import { useElementSize } from '../useElementSize';
import { OpenDockStats, usePcStatsFeed } from '.';

type Props = { style: string; metric?: string; color?: string; gpu?: string; width: number; height: number; columns: number; rows: number };

// Draws a PC stats widget at the phone's block size (width x height px) and scales it to fit this
// element, like ClockFacePreview, so the editor matches the phone. Readings are this PC's live values.
export function PcStatsPreview({ style, metric, color, gpu, width, height, columns, rows }: Props) {
  usePcStatsFeed(OpenDockStats.needs(style, metric, columns, rows));
  const [frameRef, box] = useElementSize<HTMLDivElement>();
  const hostRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!hostRef.current) return;
    const handle = OpenDockStats.mount(hostRef.current, { style, metric, color, gpu, width, height, columns, rows });
    return () => handle.destroy();
  }, [style, metric, color, gpu, width, height, columns, rows]);
  const scale = box.width && box.height ? Math.min(box.width / width, box.height / height) : 0;
  return <div ref={frameRef} className="clock-face-frame">
    <div ref={hostRef} className="clock-face-host" style={{ width, height, left: (box.width - width * scale) / 2, top: (box.height - height * scale) / 2, transform: `scale(${scale})`, visibility: scale ? 'visible' : 'hidden' }} />
  </div>;
}
