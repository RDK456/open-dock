import { Platform } from 'react-native';
import { requireOptionalNativeModule } from 'expo';

export type CamCaps = {
  zoomMin?: number; zoomMax?: number; evMin?: number; evMax?: number; evStep?: number;
  manual?: boolean; isoMin?: number; isoMax?: number; expMin?: number; expMax?: number;
  focusMax?: number; af?: boolean; apertures?: number[]; torch?: boolean; stab?: boolean;
  wb?: string[]; portrait?: boolean; modes?: string[]; facings?: string[];
};
export type CamState = {
  facing?: string; zoom?: number; mode?: string; af?: boolean; focus?: number; ev?: number; iso?: number; exp?: number;
  wb?: string; aperture?: number; torch?: boolean; stab?: boolean; res?: string; fps?: number; mbps?: number;
  live?: boolean; mirror?: boolean; rot180?: boolean; conn?: string; demand?: boolean; cam?: boolean; ip?: string; model?: string;
};
export type CamUpdate = { caps?: CamCaps; state?: CamState; quit?: boolean };

type Native = {
  start(token: string): void;
  stop(): void;
  snapshot(): string | null;
  set(key: string, value: string): void;
  addListener(event: 'onUpdate', cb: (e: { json: string }) => void): { remove(): void };
};

// Android only: the phone's camera streams H.264 to the PC's virtual camera (see pc-companion camera.rs).
const native = Platform.OS === 'android' ? requireOptionalNativeModule<Native>('OpenCam') : null;

export const cameraAvailable = native !== null;

export function startCamera(token: string) { try { native?.start(token); } catch { /* Android refused: app not in front */ } }
export function stopCamera() { try { native?.stop(); } catch { /* not running */ } }
export function setCamera(key: string, value: unknown) { try { native?.set(key, JSON.stringify(value)); } catch { /* not running */ } }

export function cameraSnapshot(): CamUpdate | null {
  try { const s = native?.snapshot(); return s ? JSON.parse(s) : null; } catch { return null; }
}

export function onCameraUpdate(cb: (u: CamUpdate) => void) {
  const sub = native?.addListener('onUpdate', (e) => { try { cb(JSON.parse(e.json)); } catch { /* bad json */ } });
  return () => sub?.remove();
}
