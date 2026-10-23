import { useEffect, useSyncExternalStore } from 'react';
import { invoke } from '@tauri-apps/api/core';
import './pc-stats.js';
import { currentTheme, onThemeChange } from '../theme';

export type PcStatsSize = '1x1' | '2x1' | '2x2' | 'dash';
export type PcStatsStyle = { id: string; size: PcStatsSize; span: [number, number]; name: string; blurb: string; dashboard: boolean };
export type PcStatsMetric = { id: string; name: string; gpu?: boolean };
export type PcGpu = {
  id: string; name: string; vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'; kind: 'integrated' | 'discrete' | 'unknown';
  state: 'ok' | 'sleeping' | 'no-driver'; tempApprox: boolean; memKind: string; sources?: Record<string, string>;
} & Partial<Record<'load' | 'temp' | 'hotspot' | 'power' | 'powerLimit' | 'powerPercent' | 'fan' | 'fanRpm' | 'memUsed' | 'memTotal', number | null>>;
export type PcStatsSample = { seq: number; cputemp?: number; cputempApprox: boolean; cputempSource?: string; gpus?: PcGpu[] };
type OpenDockStatsApi = {
  metrics: PcStatsMetric[];
  styles: PcStatsStyle[];
  resolve(style: string, columns: number, rows: number): string;
  needs(style: string, metric: string | undefined, columns: number, rows: number): string[];
  setHistory(samples: unknown[]): void;
  push(sample: unknown): void;
  latest(): PcStatsSample | null;
  setTheme(theme: 'light' | 'dark', background?: string): void;
  mount(host: HTMLElement, options: { style: string; metric?: string; color?: string; gpu?: string; width: number; height: number; columns: number; rows: number }): { destroy(): void };
};

export const OpenDockStats = (globalThis as unknown as { OpenDockStats: OpenDockStatsApi }).OpenDockStats;
// Widgets follow the app's light or dark look, and change with it.
OpenDockStats.setTheme(currentTheme());
onThemeChange(() => OpenDockStats.setTheme(currentTheme()));
export const PC_STATS_SIZES: [PcStatsSize, string][] = [['1x1', '1 × 1'], ['2x1', '2 × 1'], ['2x2', '2 × 2'], ['dash', 'Dashboards']];
export const DEFAULT_PC_STATS_STYLE = 'ring';

export function pcStatsStyle(id?: string): PcStatsStyle {
  return OpenDockStats.styles.find((style) => style.id === id) ?? OpenDockStats.styles.find((style) => style.id === DEFAULT_PC_STATS_STYLE)!;
}

// Desktop previews draw this PC's real readings. Each mounted preview registers the readings it
// shows; while any are registered and the window is visible, the feed asks the PC for the newest
// samples once a second, naming only those readings. The PC samples nothing else, and stops when
// the previews go (its request lapses after 3 s without a poll).
const registered = new Map<number, string[]>();
let nextId = 0;
let timer: ReturnType<typeof setInterval> | undefined;
let lastSeq: number | undefined;
const listeners = new Set<() => void>();
const needed = () => [...new Set([...registered.values()].flat())];
function refresh() {
  const needs = needed();
  if (!needs.length || document.hidden) return;
  void invoke<PcStatsSample[]>('pc_stats_history', { needs, since: lastSeq ?? null }).then((samples) => {
    if (!samples.length) return;
    // New samples continue from the last one seen; anything else (first poll, sampling restarted)
    // is the whole minute and replaces what we have.
    if (lastSeq !== undefined && samples[0].seq === lastSeq + 1) samples.forEach((sample) => OpenDockStats.push(sample));
    else OpenDockStats.setHistory(samples);
    lastSeq = samples[samples.length - 1].seq;
    listeners.forEach((listener) => listener());
  }).catch(() => {});
}
function sync() {
  const active = registered.size > 0 && !document.hidden;
  if (active && !timer) { refresh(); timer = setInterval(refresh, 1000); }
  if (!active && timer) { clearInterval(timer); timer = undefined; }
}
document.addEventListener('visibilitychange', sync);

/** Keeps `needs` sampled while the calling component is mounted. */
export function usePcStatsFeed(needs: string[]) {
  const key = needs.join();
  useEffect(() => {
    const id = nextId++;
    registered.set(id, key ? key.split(',') : []);
    sync();
    refresh();
    return () => { registered.delete(id); sync(); };
  }, [key]);
}

/** The newest sample, re-rendering when a new one arrives. Keeps `needs` sampled while mounted. */
export function usePcStatsSample(needs: string[]): PcStatsSample | null {
  usePcStatsFeed(needs);
  return useSyncExternalStore((onChange) => { listeners.add(onChange); return () => listeners.delete(onChange); }, () => OpenDockStats.latest());
}
