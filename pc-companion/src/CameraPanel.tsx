import { useCallback, useEffect, useRef, useState } from 'react';
import { Channel, invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// Phone cameras as webcams. Every phone that can stream shows up as its own camera; one of them at a time feeds the
// "Open Dock Camera" that Zoom, Teams, Chrome and OBS see (the PC side lives in src-tauri/src/camera.rs).

type Source = { id: string; name: string; transport: 'wifi' | 'usb'; connected: boolean };
type Caps = {
  zoomMin?: number; zoomMax?: number; evMin?: number; evMax?: number; evStep?: number; manual?: boolean;
  isoMin?: number; isoMax?: number; expMin?: number; expMax?: number; focusMax?: number; af?: boolean; apertures?: number[];
  torch?: boolean; stab?: boolean; wb?: string[]; portrait?: boolean; modes?: string[]; facings?: string[];
};
type State = {
  facing?: string; zoom?: number; mode?: string; af?: boolean; focus?: number; ev?: number; iso?: number; exp?: number; wb?: string;
  aperture?: number; torch?: boolean; stab?: boolean; res?: string; fps?: number; mbps?: number; live?: boolean;
  mirror?: boolean; rot180?: boolean; conn?: string; demand?: boolean;
};
type Feed = { id: string; name: string; connected: boolean; caps: Caps | null; state: State | null; active: boolean };
type Host = { available: boolean; installed?: boolean; running: boolean; ready: boolean; error: string; consumer: boolean; active: string | null };

const RES_NAMES: Record<string, string> = { '3840x2160': '4K', '2560x1440': '1440p', '1920x1080': '1080p', '1280x720': '720p' };
const shutter = (ns: number) => (ns >= 100_000_000 ? `${(ns / 1e9).toFixed(1)}s` : `1/${Math.round(1e9 / ns)}`);
const message = (error: unknown) => (typeof error === 'string' ? error : error instanceof Error ? error.message : 'Something went wrong');

/** The profile and level bytes of the first SPS in an Annex B config, as a WebCodecs codec string. */
function codecOf(config: Uint8Array): string {
  for (let i = 0; i + 6 < config.length; i++) {
    if (config[i] === 0 && config[i + 1] === 0 && config[i + 2] === 1 && (config[i + 3] & 0x1f) === 7) {
      const hex = (n: number) => n.toString(16).padStart(2, '0');
      return `avc1.${hex(config[i + 4])}${hex(config[i + 5])}${hex(config[i + 6])}`;
    }
  }
  return 'avc1.640028';
}

/** Live picture of one phone: the PC sends its H.264 and this window decodes it (WebCodecs). */
function Preview({ id, state }: { id: string; state: State | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [waiting, setWaiting] = useState(true);
  useEffect(() => {
    let closed = false;
    let decoder: VideoDecoder | null = null;
    let config = new Uint8Array();
    let skipping = false;
    let drawn = false;
    const channel = new Channel<ArrayBuffer>();
    channel.onmessage = (buffer) => {
      if (closed) return;
      const bytes = new Uint8Array(buffer);
      const data = bytes.subarray(10);
      if (bytes[0] === 1) {
        config = data.slice();
        try { decoder?.close(); } catch { /* already closed */ }
        decoder = new VideoDecoder({
          output: (frame) => {
            const target = canvas.current;
            if (target) {
              if (target.width !== frame.displayWidth || target.height !== frame.displayHeight) { target.width = frame.displayWidth; target.height = frame.displayHeight; }
              target.getContext('2d')?.drawImage(frame, 0, 0);
              drawn = true;
              setWaiting(false);
            }
            frame.close();
          },
          error: () => { /* the next config starts a new decoder */ },
        });
        // `avc.format` is in the WebCodecs spec but not yet in TypeScript's DOM types.
        decoder.configure({ codec: codecOf(config), avc: { format: 'annexb' }, optimizeForLatency: true } as VideoDecoderConfig);
        return;
      }
      if (!decoder || decoder.state !== 'configured') return;
      const key = bytes[1] === 1;
      // Behind: drop frames until the next keyframe instead of showing a smeared picture or building delay.
      if (decoder.decodeQueueSize > 4) skipping = true;
      if (key) skipping = false;
      if (skipping) return;
      let payload = data;
      if (key) { payload = new Uint8Array(config.length + data.length); payload.set(config); payload.set(data, config.length); }
      decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: Number(new DataView(buffer).getBigInt64(2)), data: payload }));
    };
    void invoke('camera_preview', { id, channel });
    // No picture yet (the phone's camera was still starting, or a packet was lost): ask again for config and a keyframe.
    const retry = window.setInterval(() => { if (!drawn) void invoke('camera_preview', { id, channel }); }, 3000);
    return () => {
      closed = true;
      window.clearInterval(retry);
      void invoke('camera_preview_stop', { id });
      try { decoder?.close(); } catch { /* already closed */ }
    };
  }, [id]);
  const flip = `${state?.mirror ? 'scaleX(-1) ' : ''}${state?.rot180 ? 'rotate(180deg)' : ''}`.trim();
  return <div className="camera-preview">
    <canvas ref={canvas} style={{ transform: flip || undefined }} />
    {waiting ? <span>{state?.live === false ? 'Paused' : 'Waiting for the picture…'}</span> : null}
  </div>;
}

export function CameraPanel() {
  const [sources, setSources] = useState<Source[]>([]);
  const [feeds, setFeeds] = useState<Record<string, Feed>>({});
  const [host, setHost] = useState<Host | null>(null);
  const [selected, setSelected] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const started = useRef(false);
  const autoUsed = useRef(new Set<string>());
  // Cameras the user disconnected: not reconnected on their own until the user presses Connect.
  const userOff = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const [list, snapshot, status] = await Promise.all([
      invoke<Source[]>('camera_sources'), invoke<Feed[]>('camera_snapshot'), invoke<Host>('camera_host_status'),
    ]);
    setSources(list);
    setFeeds(Object.fromEntries(snapshot.map((feed) => [feed.id, feed])));
    setHost(status);
    // The camera must be running for Discord, OBS and the rest to list it.
    if (status.installed && !status.running && !started.current) {
      started.current = true;
      await invoke('camera_host_start').catch(() => { started.current = false; });
    }
    // No Connect button needed: a Wi-Fi phone whose camera is running is picked up on its own (a phone that isn't running just refuses).
    const live = new Set(snapshot.map((feed) => feed.id));
    for (const source of list) {
      if (source.transport === 'wifi' && !live.has(source.id) && !userOff.current.has(source.id)) void invoke('camera_connect', { id: source.id }).catch(() => {});
    }
    // The first camera that connects feeds the virtual camera; after that the choice is the user's.
    const first = snapshot[0];
    if (first && !status.active && !autoUsed.current.has(first.id)) {
      autoUsed.current.add(first.id);
      await invoke('camera_set_active', { id: first.id }).catch(() => {});
    }
  }, []);

  useEffect(() => {
    void refresh().catch(() => {});
    const timer = window.setInterval(() => void refresh().catch(() => {}), 4000);
    const stopState = listen<Feed>('camera-state', ({ payload }) => {
      setFeeds((current) => {
        const next = { ...current };
        if (payload.connected) next[payload.id] = payload; else delete next[payload.id];
        return next;
      });
    });
    const stopHost = listen<Host>('camera-host', ({ payload }) => setHost((current) => ({ ...current, ...payload })));
    return () => { window.clearInterval(timer); void stopState.then((off) => off()); void stopHost.then((off) => off()); };
  }, [refresh]);

  const act = async (label: string, run: () => Promise<unknown>) => {
    setBusy(label); setError('');
    try { await run(); await refresh(); } catch (failure) { setError(message(failure)); } finally { setBusy(''); }
  };

  const current = sources.find((source) => source.id === selected) ?? sources[0];
  const feed = current ? feeds[current.id] : undefined;
  const connected = current ? current.connected || !!feed : false;
  const caps = feed?.caps ?? null;
  const state = feed?.state ?? null;
  const activeId = host?.active ?? null;
  const set = (key: string, value: unknown) => { if (current) void invoke('camera_set', { id: current.id, key, value }); };

  const chip = (label: string, on: boolean | undefined, ok: boolean, onClick: () => void) =>
    <button type="button" key={label} className={`transport-tab ${on ? 'selected' : ''}`} disabled={!ok} onClick={onClick}>{label}</button>;
  const slider = (label: string, value: number, min: number, max: number, step: number, show: string, ok: boolean, key: string, log = false) => (
    <label className={`camera-slider ${ok ? '' : 'off'}`}>
      <span>{label}</span>
      <input type="range" disabled={!ok} min={log ? Math.log(min) : min} max={log ? Math.log(max) : max} step={log ? 0.01 : step}
        value={log ? Math.log(Math.max(value, min)) : value}
        onChange={(event) => { const raw = Number(event.target.value); set(key, log ? Math.round(Math.exp(raw)) : raw); }} />
      <b>{show}</b>
    </label>
  );

  const modes = caps?.modes ?? [];
  const resList = [...new Set(modes.map((mode) => mode.split('@')[0]))];
  const fpsList = modes.filter((mode) => mode.startsWith(`${state?.res}@`)).map((mode) => Number(mode.split('@')[1]));
  const pro = state?.mode === 'pro';

  return <>
    <div className="page-heading"><div><h1>Camera</h1><p>Use your phones as webcams. Each phone is its own camera; pick the one Zoom, Teams and OBS should see as “Open Dock Camera”.</p></div></div>
    {error ? <p className="usb-error" role="alert">{error}</p> : null}

    <section className="camera-virtual">
      <div>
        <strong>Open Dock Camera</strong>
        <span>{host?.error ? `Could not start (${host.error})` : !host?.available ? 'Needs Windows 11.' : !host.installed ? 'Not installed yet. Windows asks for permission once.'
          : activeId ? `${host.consumer ? 'In use by an app' : 'Ready: choose “Open Dock Camera” in Discord, OBS or Zoom'} · showing ${sources.find((s) => s.id === activeId)?.name ?? 'a phone'}` : 'Off. Choose a camera below to turn it on.'}</span>
      </div>
      {host?.available && !host.installed
        ? <button className="secondary-button" disabled={busy === 'install'} onClick={() => void act('install', () => invoke('camera_install'))}>{busy === 'install' ? 'Installing…' : 'Install'}</button>
        : activeId ? <button className="secondary-button" onClick={() => void act('off', () => invoke('camera_set_active', { id: null }))}>Turn off</button> : null}
    </section>

    {sources.length === 0
      ? <p className="camera-empty">No phone found. Connect a phone to Open Dock (Wi-Fi or USB), then open its Camera tab and tap Start camera.</p>
      : <div className="camera-layout">
        <div className="camera-list" role="listbox" aria-label="Cameras">
          {sources.map((source) => {
            const live = source.connected || !!feeds[source.id];
            return <button type="button" key={source.id} role="option" aria-selected={source.id === current?.id} className={`camera-item ${source.id === current?.id ? 'selected' : ''}`} onClick={() => setSelected(source.id)}>
              <strong>{source.name}</strong>
              <span>{source.transport === 'usb' ? 'USB' : 'Wi-Fi'} · {activeId === source.id ? 'Open Dock Camera' : live ? 'Connected' : 'Not connected'}</span>
            </button>;
          })}
        </div>

        {current ? <div className="camera-detail">
          <div className="camera-actions">
            {connected
              ? <button className="secondary-button" onClick={() => { userOff.current.add(current.id); void act('disconnect', async () => {
                if (activeId === current.id) await invoke('camera_set_active', { id: null });
                await invoke('camera_disconnect', { id: current.id });
                setFeeds((all) => { const next = { ...all }; delete next[current.id]; return next; });
              }); }}>Disconnect</button>
              : <button className="primary-button" disabled={busy === 'connect'} onClick={() => { userOff.current.delete(current.id); void act('connect', () => invoke('camera_connect', { id: current.id })); }}>{busy === 'connect' ? 'Connecting…' : 'Connect'}</button>}
            {connected ? <button className={activeId === current.id ? 'secondary-button' : 'primary-button'} disabled={!host?.available || !host.installed || activeId === current.id}
              onClick={() => void act('use', () => invoke('camera_set_active', { id: current.id }))}>{activeId === current.id ? 'Feeding Open Dock Camera' : 'Use as Open Dock Camera'}</button> : null}
          </div>

          {connected ? <>
            <Preview key={current.id} id={current.id} state={state} />
            {caps && state ? <div className="camera-controls">
              <div className="camera-row">
                {chip(state.live === false ? 'Paused' : 'LIVE', state.live !== false, true, () => set('live', state.live === false))}
                {chip(state.facing === 'front' ? 'Front' : 'Back', false, (caps.facings?.length ?? 0) > 1, () => set('facing', state.facing === 'front' ? 'back' : 'front'))}
                {chip('Torch', state.torch, !!caps.torch, () => set('torch', !state.torch))}
                {chip('Stabilise', state.stab, !!caps.stab, () => set('stab', !state.stab))}
                {chip('Mirror', state.mirror, true, () => set('mirror', !state.mirror))}
                {chip('Rotate 180°', state.rot180, true, () => set('rot180', !state.rot180))}
              </div>
              <div className="camera-row">
                {['video', 'pro', 'portrait'].map((mode) => chip(mode, state.mode === mode, mode !== 'portrait' || !!caps.portrait, () => set('mode', mode)))}
                {chip('Autofocus', state.af !== false, !!caps.af, () => set('af', state.af === false))}
              </div>
              {slider('Zoom', state.zoom ?? 1, caps.zoomMin ?? 1, caps.zoomMax ?? 1, 0.1, `${(state.zoom ?? 1).toFixed(1)}×`, (caps.zoomMax ?? 1) > (caps.zoomMin ?? 1), 'zoom')}
              {slider('Exposure', state.ev ?? 0, caps.evMin ?? 0, caps.evMax ?? 0, 1, ((state.ev ?? 0) * (caps.evStep ?? 1)).toFixed(1), !pro && (caps.evMax ?? 0) > 0, 'ev')}
              {slider('Focus', state.focus ?? 0, 0, caps.focusMax ?? 0, 0.1, (state.focus ?? 0).toFixed(1), state.af === false && (caps.focusMax ?? 0) > 0, 'focus')}
              {pro ? <>
                {slider('ISO', state.iso ?? caps.isoMin ?? 100, caps.isoMin ?? 100, caps.isoMax ?? 3200, 1, `${state.iso ?? '—'}`, !!caps.manual, 'iso', true)}
                {slider('Shutter', state.exp ?? caps.expMin ?? 1e6, caps.expMin ?? 1e6, caps.expMax ?? 1e9, 1, state.exp ? shutter(state.exp) : '—', !!caps.manual, 'exp', true)}
                {(caps.apertures?.length ?? 0) > 1 ? <div className="camera-row"><span>Aperture</span>{caps.apertures!.map((a) => chip(`f/${a}`, state.aperture === a, true, () => set('aperture', a)))}</div> : null}
              </> : null}
              <div className="camera-row"><span>White balance</span>{(caps.wb ?? []).map((w) => chip(w, state.wb === w, true, () => set('wb', w)))}</div>
              <div className="camera-row"><span>Resolution</span>{resList.map((r) => chip(RES_NAMES[r] ?? r, state.res === r, true, () => set('res', r)))}
                {fpsList.map((f) => chip(`${f} fps`, state.fps === f, true, () => set('fps', f)))}</div>
              {slider('Bitrate', state.mbps ?? 0, 0, 60, 1, state.mbps ? `${state.mbps} Mbps` : 'Auto', true, 'mbps')}
            </div> : <p className="camera-empty">Waiting for the phone's camera…</p>}
          </> : <p className="camera-empty">On the phone, open Camera and tap Start camera, then press Connect.</p>}
        </div> : null}
      </div>}
  </>;
}
