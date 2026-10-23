import type { PcConnection } from './connection';

// The PC opens `opendock://pair?...` on a phone that USB debugging trusts, so the phone pairs without a QR code.
// Only the USB route is accepted from a link, and its host only if it is on a local network: any app or web page on
// the phone can open a link, and it must not be able to leave behind an address on the internet.
// A real address on a private network, or a single-label mDNS name. A hostname that merely starts with digits
// (`10.evil.com`, `127.0.0.1.nip.io`) is not one.
function isLocalHost(host: string): boolean {
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    if ([a, b, c, d].some((octet) => octet > 255)) return false;
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31);
  }
  if (/^[a-z0-9-]{1,63}\.local$/i.test(host)) return true;
  const v6 = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (v6.length > 45 || !/^[0-9a-f:]+$/.test(v6) || v6.split(':').length < 3) return false;
  return v6 === '::1' || /^f[cd][0-9a-f]{2}:/.test(v6) || /^fe[89ab][0-9a-f]:/.test(v6);
}

export function parsePairLink(params: Record<string, string | string[] | undefined>): PcConnection | null {
  const one = (key: string) => {
    const value = params[key];
    return typeof value === 'string' ? value : undefined;
  };
  const host = one('host');
  const port = Number(one('port'));
  const token = one('token');
  const name = one('name');
  if (
    one('transport') !== 'usb' ||
    !host || host.length > 253 || /[\s/?#]/.test(host) ||
    !Number.isInteger(port) || port < 1 || port > 65535 ||
    !token || !/^[a-f\d]{64}$/i.test(token)
  ) return null;
  const local = isLocalHost(host) ? host : '127.0.0.1';
  return { host: local, port, token, deviceName: name && name.length <= 64 ? name : local, transport: 'usb' };
}
