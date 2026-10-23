// Run: node scripts/check-pairing-link.ts
// The phone's side of USB pairing: the `opendock://pair` link the PC opens over the cable. The sample below is the
// exact text the PC builds (see `pair_link` in usb_pair.rs), so the two sides cannot drift apart unnoticed.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parsePairLink } from '../phone-app/src/pairing-link.ts';

const token = 'ab'.repeat(32);
const fromLink = (link: string) => {
  const url = new URL(link);
  return parsePairLink(Object.fromEntries(url.searchParams));
};

// The PC's own test pins this exact link, so a change on either side fails one of the two checks.
const rust = readFileSync(join(import.meta.dirname, '..', 'pc-companion', 'src-tauri', 'src', 'usb_pair.rs'), 'utf8');
assert.ok(rust.includes('opendock://pair?host=192.168.1.5&port=39421&token={}&name=Dev%27s%20PC%20%26%20more&transport=usb'), 'the PC changed its link format');
assert.deepEqual(fromLink(`opendock://pair?host=192.168.1.5&port=39421&token=${token}&name=Dev%27s%20PC%20%26%20more&transport=usb`), {
  host: '192.168.1.5', port: 39421, token, deviceName: "Dev's PC & more", transport: 'usb',
});

// A missing name falls back to the host.
assert.equal(fromLink(`opendock://pair?host=10.0.0.2&port=39421&token=${token}&transport=usb`)?.deviceName, '10.0.0.2');

// A host that is not on a local network is not kept: the link cannot plant an address on the internet.
for (const host of ['evil.example.com', '8.8.8.8', '172.32.0.1', '11.0.0.1', '10.evil.com', '192.168.attacker.net', '127.0.0.1.nip.io', '169.254.evil.com', '10.0.0.256', 'a.b.local', 'fd.evil.com', 'fe80.evil.com:1']) {
  assert.equal(fromLink(`opendock://pair?host=${host}&port=39421&token=${token}&transport=usb`)?.host, '127.0.0.1', host);
}
for (const host of ['10.1.2.3', '192.168.0.9', '172.16.0.1', '172.31.255.1', '169.254.1.1', 'my-pc.local', 'fd12:3456::1', 'fe80::1', '::1', '127.0.0.1']) {
  assert.equal(fromLink(`opendock://pair?host=${host}&port=39421&token=${token}&transport=usb`)?.host, host, host);
}

// Anything wrong is refused rather than half-applied.
const bad = [
  `opendock://pair?host=10.0.0.2&port=39421&token=${token}&transport=wifi`, // a link can only pair the USB route
  `opendock://pair?host=10.0.0.2&port=39421&token=${token}`,
  `opendock://pair?host=10.0.0.2&port=39421&token=${'zz'.repeat(32)}&transport=usb`,
  `opendock://pair?host=10.0.0.2&port=39421&token=abc&transport=usb`,
  `opendock://pair?host=10.0.0.2&port=0&token=${token}&transport=usb`,
  `opendock://pair?host=10.0.0.2&port=99999&token=${token}&transport=usb`,
  `opendock://pair?host=10.0.0.2&port=x&token=${token}&transport=usb`,
  `opendock://pair?host=a%2Fb&port=39421&token=${token}&transport=usb`,
  `opendock://pair?port=39421&token=${token}&transport=usb`,
];
for (const link of bad) assert.equal(fromLink(link), null, link);
// Repeated keys (an array in the router) are not trusted either.
assert.equal(parsePairLink({ host: ['a', 'b'], port: '39421', token, transport: 'usb' }), null);

console.log('check-pairing-link: ok');
