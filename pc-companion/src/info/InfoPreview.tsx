import type { CSSProperties, ReactNode } from 'react';
import { useElementSize } from '../useElementSize';
import { INFO_LEAGUES, infoStyles, type InfoOptions } from '.';

type Props = { face?: string; info?: InfoOptions; width: number; height: number };

const muted: CSSProperties = { opacity: 0.6, fontSize: 11 };
const row: CSSProperties = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '5px 0', borderBottom: '1px solid rgba(127,127,127,0.18)', fontSize: 12 };
const center: CSSProperties = { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 4, textAlign: 'center' };
const big = (size: number): CSSProperties => ({ fontSize: size, fontWeight: 300, lineHeight: 1, fontVariantNumeric: 'tabular-nums' });
const chip = (on: boolean): CSSProperties => ({ padding: '3px 8px', borderRadius: 5, fontSize: 10, whiteSpace: 'nowrap', background: on ? 'rgba(127,127,127,0.22)' : 'rgba(127,127,127,0.1)' });
const card: CSSProperties = { borderRadius: 8, padding: 8, background: 'rgba(127,127,127,0.1)' };
const up = '#1f9d57', down = '#d64545';

const QUOTES: [string, string, string][] = [['AAPL', '232.10', '+1.24%'], ['MSFT', '418.55', '-0.31%'], ['BTC-USD', '97,420', '+2.05%'], ['^GSPC', '5,980.4', '+0.42%']];
const GAMES: [string, string, string][] = [['BOS 112', 'LAL 108', 'Final'], ['GSW 96', 'MIA 99', 'Q4 2:31'], ['NYK 0', 'CHI 0', '7:30 PM']];
const STORIES = ['Scientists map the deepest ocean trench in detail', 'New battery tech doubles phone life in lab tests', 'City opens its largest solar park to date', 'Markets steady ahead of the rate decision'];

/** Sample content for each info face and design; the phone fills in the real thing. */
function sample(face: string, style: string, info: InfoOptions, height: number): { title: string; body: ReactNode } {
  const tall = height >= 150;
  switch (face) {
    case 'weather': {
      const city = info.city ?? 'London';
      if (style === 'hero') return { title: city, body: <div style={center}><span style={{ fontSize: 34 }}>⛅</span><div style={big(64)}>18°</div><div style={muted}>Partly cloudy · H 21° L 12°</div></div> };
      if (style === 'minimal') return { title: '', body: <div style={{ ...center, flexDirection: 'row', gap: 10 }}><span style={{ fontSize: 26 }}>⛅</span><div style={big(36)}>18°</div><div style={{ fontSize: 13 }}>{city}</div></div> };
      return { title: city, body: <>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}><span style={{ fontSize: 40 }}>⛅</span><div><div style={big(34)}>18°</div><div style={muted}>Partly cloudy · feels 17°</div></div></div>
        {tall ? <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>{['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((day, index) => <div key={day} style={{ textAlign: 'center', fontSize: 11 }}><div style={muted}>{day}</div><div>{['☀️', '⛅', '🌧️', '⛅', '☀️'][index]}</div><div>{[21, 19, 15, 17, 22][index]}°</div></div>)}</div> : null}
      </> };
    }
    case 'news':
      if (style === 'headline') return { title: 'BBC', body: <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6 }}><div style={{ fontSize: 18, fontWeight: 600, lineHeight: 1.25 }}>{STORIES[0]}</div><div style={muted}>1 / 20 · tap to read</div></div> };
      if (style === 'compact') return { title: 'News', body: STORIES.map((title) => <div key={title} style={{ ...row, padding: '3px 0', fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block' }}>{title}</div>) };
      return { title: 'News', body: <>
        {height >= 120 ? <div style={{ display: 'flex', gap: 4 }}><span style={chip(true)}>BBC</span><span style={chip(false)}>Hacker News</span><span style={chip(false)}>The Verge</span></div> : null}
        {STORIES.map((title) => <div key={title} style={row}>{title}</div>)}
      </> };
    case 'stocks': {
      const symbols = info.symbols ? info.symbols.split(/[,\s]+/).filter(Boolean).slice(0, 8) : null;
      const quotes = symbols ? symbols.map((symbol, index): [string, string, string] => [symbol, QUOTES[index % QUOTES.length][1], QUOTES[index % QUOTES.length][2]]) : QUOTES;
      if (style === 'tiles') return { title: 'Markets', body: <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 6 }}>{quotes.slice(0, 4).map(([symbol, price, change]) => <div key={symbol} style={{ ...card, background: change.startsWith('+') ? 'rgba(31,157,87,0.16)' : 'rgba(214,69,69,0.16)' }}><b style={{ fontSize: 12 }}>{symbol}</b><div style={{ fontSize: 15 }}>{price}</div><div style={{ fontSize: 11, color: change.startsWith('+') ? up : down }}>{change}</div></div>)}</div> };
      if (style === 'ticker') { const [symbol, price, change] = quotes[0]; return { title: 'Markets', body: <div style={center}><b>{symbol}</b><div style={big(40)}>{price}</div><div style={{ color: change.startsWith('+') ? up : down, fontWeight: 600 }}>{change.startsWith('+') ? '▲' : '▼'} {change}</div><div style={muted}>1 / {quotes.length}</div></div> }; }
      return { title: 'Markets', body: quotes.map(([symbol, price, change]) => <div key={symbol} style={row}><b>{symbol}</b><span>{price}</span><span style={{ color: change.startsWith('+') ? up : down, fontWeight: 600 }}>{change}</span></div>) };
    }
    case 'sports': {
      const league = INFO_LEAGUES.find(([id]) => id === info.league)?.[1] ?? 'NBA';
      if (style === 'cards') return { title: league, body: <div style={center}><div style={{ display: 'flex', gap: 18, alignItems: 'center' }}><div><div style={muted}>BOS</div><div style={big(40)}>112</div></div><div style={muted}>–</div><div><div style={muted}>LAL</div><div style={big(40)}>108</div></div></div><div style={muted}>Final · 1 / 3</div></div> };
      if (style === 'compact') return { title: league, body: GAMES.map(([away, home]) => <div key={away} style={{ ...row, padding: '3px 0', fontSize: 11 }}><span>{away}</span><span>{home}</span></div>) };
      return { title: league, body: GAMES.map(([away, home, status]) => <div key={away} style={row}><b>{away}</b><span style={muted}>at</span><b>{home}</b><span style={muted}>{status}</span></div>) };
    }
    case 'countdown':
      if (style === 'units') return { title: 'Holiday', body: <div style={{ ...center, flexDirection: 'row', gap: 14 }}>{[['42', 'days'], ['07', 'hrs'], ['15', 'min']].map(([value, unit]) => <div key={unit}><div style={big(36)}>{value}</div><div style={muted}>{unit}</div></div>)}</div> };
      if (style === 'minimal') return { title: '', body: <div style={center}><div style={{ fontSize: 15 }}><b>42 days</b> to Holiday</div></div> };
      return { title: 'Holiday', body: <div style={center}><div style={big(48)}>42</div><div style={muted}>days to go</div></div> };
    case 'timer':
      if (style === 'ring') return { title: 'Timer', body: <div style={center}><div style={{ width: 96, height: 96, borderRadius: '50%', border: '6px solid rgba(127,127,127,0.18)', borderTopColor: 'currentColor', display: 'grid', placeItems: 'center' }}><div style={big(24)}>3:12</div></div></div> };
      if (style === 'minimal') return { title: '', body: <div style={center}><div style={big(52)}>5:00</div><div style={muted}>tap to start</div></div> };
      return { title: 'Timer', body: <>
        {height >= 120 ? <div style={{ display: 'flex', gap: 4 }}>{['1', '5', '10', '25', '60'].map((value) => <span key={value} style={chip(value === '5')}>{value}</span>)}</div> : null}
        <div style={center}><div style={big(44)}>5:00</div><div style={{ display: 'flex', gap: 10 }}><span style={{ ...chip(false), borderRadius: 99, padding: '8px 11px' }}>▶</span><span style={{ ...chip(false), borderRadius: 99, padding: '8px 11px' }}>↺</span></div></div>
      </> };
    case 'reminders': {
      const items: [string, boolean][] = info.items?.length ? info.items.slice(0, 4).map((text) => [text, false]) : [['Call the dentist', false], ['Buy milk', true], ['Send the report', false]];
      const shown = info.done === 'hide' ? items.filter(([, done]) => !done) : info.done === 'bottom' ? [...items.filter(([, done]) => !done), ...items.filter(([, done]) => done)] : items;
      if (style === 'compact') return { title: 'Reminders', body: <div style={center}><div style={big(40)}>{items.filter(([, done]) => !done).length}</div><div style={muted}>left · next: {items.find(([, done]) => !done)?.[0] ?? 'nothing'}</div></div> };
      if (style === 'cards') return { title: 'Reminders', body: <div style={{ display: 'grid', gap: 6 }}>{shown.map(([text, done]) => <div key={text} style={{ ...card, fontSize: 12, textDecoration: done ? 'line-through' : undefined, opacity: done ? 0.5 : 1 }}>{done ? '☑' : '☐'} {text}</div>)}</div> };
      return { title: 'Reminders', body: <>
        <div style={{ border: '1px solid rgba(127,127,127,0.3)', borderRadius: 5, padding: '6px 8px', fontSize: 11, opacity: 0.6 }}>Add a reminder</div>
        {shown.map(([text, done]) => <div key={text} style={{ ...row, textDecoration: done ? 'line-through' : undefined, opacity: done ? 0.5 : 1 }}>{text}</div>)}
      </> };
    }
    default:
      if (style === 'bold') return { title: '', body: <div style={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6, borderLeft: '4px solid currentColor', paddingLeft: 12 }}><div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1.2 }}>Simplicity is the ultimate sophistication.</div><div style={muted}>Leonardo da Vinci</div></div> };
      if (style === 'minimal') return { title: '', body: <div style={center}><div style={{ fontSize: 12, fontStyle: 'italic', opacity: 0.8 }}>“Simplicity is the ultimate sophistication.”</div><div style={{ ...muted, fontSize: 10 }}>Leonardo da Vinci</div></div> };
      return { title: 'Quote of the day', body: <div style={center}><div style={{ fontSize: 15, lineHeight: 1.35 }}>“Simplicity is the ultimate sophistication.”</div><div style={muted}>Leonardo da Vinci</div></div> };
  }
}

// An info widget drawn at the phone's block size (width x height px) and scaled into this element, like the other previews.
export function InfoPreview({ face = 'quote', info = {}, width, height }: Props) {
  const [frameRef, box] = useElementSize<HTMLDivElement>();
  const scale = box.width && box.height ? Math.min(box.width / width, box.height / height) : 0;
  const style = infoStyles(face).find(([id]) => id === info.style)?.[0] ?? infoStyles(face)[0][0];
  const { title, body } = sample(face, style, info, height);
  const frame = { width, height, left: (box.width - width * scale) / 2, top: (box.height - height * scale) / 2, transform: `scale(${scale})`, visibility: scale ? 'visible' : 'hidden', display: 'flex', flexDirection: 'column', gap: 6, padding: 10, boxSizing: 'border-box', overflow: 'hidden', textAlign: 'left' } as CSSProperties;
  return <div ref={frameRef} className="clock-face-frame">
    <div className="clock-face-host" style={frame}>
      {title && height >= 80 ? <div style={{ fontSize: 12, fontWeight: 600, opacity: 0.6 }}>{title}</div> : null}
      {body}
    </div>
  </div>;
}
