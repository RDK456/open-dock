"""Delta updates: a small patch that turns the last release's file into this one's.

python scripts/make-delta.py diff OLD NEW PATCH   writes PATCH and prints NEW's size and SHA-256
python scripts/make-delta.py apply OLD PATCH OUT  rebuilds OUT (what the phone and the PC do)
python scripts/make-delta.py check                self-check on generated files
python scripts/make-delta.py release FROM OLD_SETUP NEW_SETUP OLD_APK NEW_APK LATEST_JSON
    writes both patches next to LATEST_JSON and adds its "delta" block. FROM is the previous release's version.
    The exe a setup installs is taken out of it with 7-Zip (Tauri patches the exe while bundling, so the build
    output differs). The new exe is signed with `tauri signer sign`, so TAURI_SIGNING_PRIVATE_KEY (and its
    _PASSWORD) must be set as for a release build. Upload the two .patch files with the release.

The patch is bsdiff (via the bsdiff4 package) with its three blocks recompressed from bzip2 to zlib, which the
phone (java.util.zip) and the PC (flate2) both read without another library:

    "ODPATCH1"  u64 new size  u64 control length  u64 diff length   (little-endian; lengths are compressed)
    zlib(control)  zlib(diff)  zlib(extra)

Control is bsdiff's triples (x, y, z) of 8-byte sign-magnitude integers: add x bytes of diff to old, copy y bytes
of extra, then move the old position by z. Appliers: phone-app/modules/keep-alive (DeltaPatch.kt) and
pc-companion/src-tauri/src/delta.rs.
"""
import bz2
import hashlib
import json
import os
import struct
import subprocess
import sys
import tempfile
import zlib

MAGIC = b'ODPATCH1'


def offtin(raw):
    value = int.from_bytes(raw[:7] + bytes([raw[7] & 0x7F]), 'little')
    return -value if raw[7] & 0x80 else value


def diff(old, new):
    import bsdiff4  # only the release machine needs it
    patch = bsdiff4.diff(old, new)
    assert patch[:8] == b'BSDIFF40'
    ctrl_len, diff_len, new_size = offtin(patch[8:16]), offtin(patch[16:24]), offtin(patch[24:32])
    blocks = [patch[32:32 + ctrl_len], patch[32 + ctrl_len:32 + ctrl_len + diff_len], patch[32 + ctrl_len + diff_len:]]
    ctrl, delta, extra = (zlib.compress(bz2.decompress(block), 9) for block in blocks)
    return MAGIC + struct.pack('<QQQ', new_size, len(ctrl), len(delta)) + ctrl + delta + extra


def apply(old, patch):
    assert patch[:8] == MAGIC, 'not an Open Dock patch'
    new_size, ctrl_len, diff_len = struct.unpack('<QQQ', patch[8:32])
    body = patch[32:]
    ctrl = zlib.decompress(body[:ctrl_len])
    delta = zlib.decompress(body[ctrl_len:ctrl_len + diff_len])
    extra = zlib.decompress(body[ctrl_len + diff_len:])
    out = bytearray()
    old_pos = diff_pos = extra_pos = 0
    for at in range(0, len(ctrl), 24):
        x, y, z = (offtin(ctrl[at + i:at + i + 8]) for i in (0, 8, 16))
        for i in range(x):
            source = old[old_pos + i] if 0 <= old_pos + i < len(old) else 0
            out.append((delta[diff_pos + i] + source) & 0xFF)
        diff_pos += x
        old_pos += x
        out += extra[extra_pos:extra_pos + y]
        extra_pos += y
        old_pos += z
    assert len(out) == new_size, 'patch did not rebuild the whole file'
    return bytes(out)


def check():
    import random
    rng = random.Random(7)
    old = bytes(rng.getrandbits(8) for _ in range(200_000))
    new = bytearray(old)
    new[1000:1010] = b'0123456789'                       # a changed run
    new[50_000:50_000] = b'inserted bytes' * 300         # an insertion
    del new[120_000:121_000]                             # a deletion
    new += bytes(rng.getrandbits(8) for _ in range(5000))  # new data at the end
    new = bytes(new)
    patch = diff(old, new)
    assert apply(old, patch) == new
    assert len(patch) < len(new) // 5, f'patch too big: {len(patch)} of {len(new)}'
    assert apply(b'', diff(b'', b'abc')) == b'abc'
    assert apply(b'same', diff(b'same', b'same')) == b'same'
    print(f'make-delta: ok ({len(patch)} byte patch for a {len(new)} byte file)')


SEVEN_ZIP = os.path.join(os.environ.get('ProgramFiles', 'C:/Program Files'), '7-Zip', '7z.exe')
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def installed_exe(setup, into):
    subprocess.run([SEVEN_ZIP, 'x', '-y', f'-o{into}', setup, 'open-dock-pc.exe'], check=True, stdout=subprocess.DEVNULL)
    return open(os.path.join(into, 'open-dock-pc.exe'), 'rb').read()


def release(source, old_setup, new_setup, old_apk, new_apk, latest_path):
    latest = json.load(open(latest_path, encoding='utf8'))
    version, out_dir = latest['version'], os.path.dirname(os.path.abspath(latest_path))
    base = f'https://github.com/RDK456/open-dock/releases/download/v{version}/'
    delta = {}
    with tempfile.TemporaryDirectory() as work:
        old_exe = installed_exe(old_setup, os.path.join(work, 'old'))
        new_exe_path = os.path.join(work, 'new', 'open-dock-pc.exe')
        new_exe = installed_exe(new_setup, os.path.join(work, 'new'))
        subprocess.run('npx tauri signer sign "' + new_exe_path + '"', cwd=os.path.join(REPO, 'pc-companion'), shell=True, check=True, stdout=subprocess.DEVNULL)
        signature = open(new_exe_path + '.sig', encoding='utf8').read().strip()
        for platform, old, new, name, extra in (
            ('android', open(old_apk, 'rb').read(), open(new_apk, 'rb').read(), 'OpenDock', {}),
            ('windows', old_exe, new_exe, 'open-dock-pc', {'signature': signature}),
        ):
            patch_name = f'{name}-{source}-to-{version}.patch'
            patch = diff(old, new)
            assert apply(old, patch) == new
            open(os.path.join(out_dir, patch_name), 'wb').write(patch)
            delta[platform] = {'from': source, 'fromSha256': hashlib.sha256(old).hexdigest(), 'url': base + patch_name,
                               'bytes': len(patch), 'sha256': hashlib.sha256(new).hexdigest(), **extra}
            print(f'{patch_name}: {len(patch)} bytes instead of {len(new)}')
    latest['delta'] = delta
    json.dump(latest, open(latest_path, 'w', encoding='utf8'), indent=2)


if __name__ == '__main__':
    command, *paths = sys.argv[1:] or ['check']
    if command == 'check':
        check()
    elif command == 'diff':
        old_path, new_path, patch_path = paths
        new = open(new_path, 'rb').read()
        patch = diff(open(old_path, 'rb').read(), new)
        open(patch_path, 'wb').write(patch)
        print(f'{patch_path}: {len(patch)} bytes for {len(new)} ({100 * len(patch) // max(1, len(new))}%), sha256 {hashlib.sha256(new).hexdigest()}')
    elif command == 'release':
        release(*paths)
    elif command == 'apply':
        old_path, patch_path, out_path = paths
        open(out_path, 'wb').write(apply(open(old_path, 'rb').read(), open(patch_path, 'rb').read()))
    else:
        sys.exit(__doc__)
