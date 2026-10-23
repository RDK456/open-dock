// Run: node scripts/bump-version.ts 1.2.0          (writes the version everywhere)
//      node scripts/bump-version.ts --check 1.2.0  (CI: fails if any file disagrees)
// The desktop and phone apps ship from one tag, so they share one version.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const check = args[0] === '--check';
const version = (check ? args[1] : args[0])?.replace(/^v/, '') ?? '';
const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
if (!match || +match[2] > 99 || +match[3] > 99) {
  console.error('Usage: node scripts/bump-version.ts [--check] <major.minor.patch>, minor and patch up to 99');
  process.exit(1);
}
// Android must see a higher versionCode on every update: 1.2.3 -> 10203.
const versionCode = +match[1] * 10000 + +match[2] * 100 + +match[3];

const json = (path: string, apply: (data: any) => void) => ({
  path,
  edit: (text: string) => { const data = JSON.parse(text); apply(data); return JSON.stringify(data, null, 2) + '\n'; },
});
const lock = (path: string) => json(path, (data) => { data.version = version; data.packages[''].version = version; });
const files = [
  json('pc-companion/package.json', (data) => { data.version = version; }),
  lock('pc-companion/package-lock.json'),
  json('pc-companion/src-tauri/tauri.conf.json', (data) => { data.version = version; }),
  { path: 'pc-companion/src-tauri/Cargo.toml', edit: (text: string) => text.replace(/^version = ".*"$/m, `version = "${version}"`) },
  { path: 'pc-companion/src-tauri/Cargo.lock', edit: (text: string) => text.replace(/(name = "open-dock-pc"\r?\nversion = )".*"/, `$1"${version}"`) },
  json('phone-app/package.json', (data) => { data.version = version; }),
  lock('phone-app/package-lock.json'),
  json('phone-app/app.json', (data) => { data.expo.version = version; data.expo.android.versionCode = versionCode; }),
];

const stale: string[] = [];
for (const { path, edit } of files) {
  const url = new URL(`../${path}`, import.meta.url);
  const text = readFileSync(url, 'utf8');
  const next = edit(text);
  if (next.replace(/\r\n/g, '\n') === text.replace(/\r\n/g, '\n')) continue;
  if (check) stale.push(path);
  else writeFileSync(url, next);
}
if (check && stale.length) {
  console.error(`Version ${version} doesn't match: ${stale.join(', ')}. Run node scripts/bump-version.ts ${version} and commit.`);
  process.exit(1);
}
console.log(check ? `All files are at ${version}` : `Set version ${version} (Android versionCode ${versionCode})`);
