import * as Network from 'expo-network';

export type FoundPc = { host: string; port: number; name: string };

const PORT = 39421;

/** Fetch with a deadline; a LAN address nobody answers can otherwise hang for a minute. */
async function fetchWithin(url: string, ms: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The 254 neighbours of an IPv4 address on its /24, or none for anything else. */
export function subnetHosts(ip: string): string[] {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) || parts[0] === 0 || parts[0] === 127) return [];
  return Array.from({ length: 254 }, (_, index) => `${parts[0]}.${parts[1]}.${parts[2]}.${index + 1}`).filter((host) => host !== ip);
}

/** Finds Open Dock PCs on this phone's Wi-Fi by asking every address on its /24. Takes a few seconds. */
// ponytail: /24 sweep only; larger subnets or other VLANs still need the QR code or manual entry.
export async function findPcs(onFound?: (pc: FoundPc) => void): Promise<FoundPc[]> {
  const ip = await Network.getIpAddressAsync().catch(() => '');
  const queue = subnetHosts(ip);
  const found: FoundPc[] = [];
  const worker = async () => {
    for (let host = queue.shift(); host; host = queue.shift()) {
      try {
        const response = await fetchWithin(`http://${host}:${PORT}/discover`, 900);
        const body = await response.json() as { app?: unknown; name?: unknown; port?: unknown };
        if (body.app !== 'opendock') continue;
        const pc = { host, port: typeof body.port === 'number' ? body.port : PORT, name: typeof body.name === 'string' && body.name.length <= 64 ? body.name : host };
        found.push(pc);
        onFound?.(pc);
      } catch { /* nobody there */ }
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  return found;
}

/** Trades the PIN shown on the PC for its pairing key. Throws 'wrong_pin' or 'unreachable'. */
export async function pairWithPin(pc: FoundPc, pin: string): Promise<string> {
  let response: Response;
  try {
    response = await fetchWithin(`http://${pc.host}:${pc.port}/pair`, 6000, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: pin.replace(/\D/g, '') }) });
  } catch {
    throw new Error('unreachable');
  }
  if (response.status === 403) throw new Error('wrong_pin');
  const body = await response.json().catch(() => ({})) as { token?: unknown };
  if (typeof body.token !== 'string' || !/^[a-f\d]{64}$/i.test(body.token)) throw new Error('unreachable');
  return body.token;
}
