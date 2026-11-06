import type { CSSProperties } from 'react';
import { useElementSize } from '../useElementSize';
import { SAMPLE_CLIPS } from '.';

type Props = { face?: string; scroll?: string; color?: string; width: number; height: number };

// The phone's Clipboard widget drawn with CSS at the phone's block size (width x height px) and scaled into this element.
// It shows sample clips; the real ones come from the PC's clipboard while a phone is showing the widget.
export function ClipboardPreview({ face = 'list', scroll = 'swipe', color, width, height }: Props) {
  const [frameRef, box] = useElementSize<HTMLDivElement>();
  const scale = box.width && box.height ? Math.min(box.width / width, box.height / height) : 0;
  const clips = face === 'focus' ? SAMPLE_CLIPS.slice(0, 1) : SAMPLE_CLIPS;
  const style = { width, height, left: (box.width - width * scale) / 2, top: (box.height - height * scale) / 2, transform: `scale(${scale})`, visibility: scale ? 'visible' : 'hidden', '--clip-accent': color ?? '#8b8bf5' } as CSSProperties;
  return <div ref={frameRef} className="clock-face-frame">
    <div className={`clock-face-host clip-prev clip-prev-${face} ${scroll === 'auto' ? 'clip-prev-auto' : ''}`} style={style}>
      <div className="clip-prev-list">
        {clips.map((clip, index) => <div key={clip.text} className={`clip-prev-item ${index === 0 ? 'clip-prev-hot' : ''}`}>
          <span className="clip-prev-text">{clip.text}</span>
          <small>{face === 'focus' ? `${clip.ago} · 1 of ${SAMPLE_CLIPS.length} · tap to copy` : clip.ago}</small>
        </div>)}
      </div>
      {face === 'focus' ? <div className="clip-prev-dots">{SAMPLE_CLIPS.map((clip, index) => <i key={clip.text} className={index === 0 ? 'on' : ''} />)}</div> : null}
    </div>
  </div>;
}
