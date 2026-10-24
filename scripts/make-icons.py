"""Draws the Open Dock icon: three keys set, one left open, on a 100-unit grid (46-unit keys, 8-unit gap).

python scripts/make-icons.py [android-res-dir]
Writes the phone's Expo assets and the PC's 1024 px source (then run `npx tauri icon src-tauri/icons/app-icon.png`
in pc-companion). Given the prebuilt app's res folder (F:/b/android/app/src/main/res), also writes its launcher
icons and splash logos, which Expo only makes on prebuild.
"""
import os
import sys
from PIL import Image, ImageDraw

INK = (11, 11, 11, 255)
PAPER = (250, 250, 250, 255)
SS = 4  # drawn this many times larger, then scaled down for smooth edges
ROOT = os.path.join(os.path.dirname(__file__), '..')


def glyph(draw, x, y, size, color, hole):
    unit = size / 100
    r = 12 * unit
    for col, row in ((0, 0), (1, 0), (0, 1)):
        left, top = x + col * 54 * unit, y + row * 54 * unit
        draw.rounded_rectangle((left, top, left + 46 * unit, top + 46 * unit), r, fill=color)
    left, top = x + 54 * unit, y + 54 * unit
    draw.rounded_rectangle((left, top, left + 46 * unit, top + 46 * unit), r, fill=color)
    draw.rounded_rectangle((left + 11.5 * unit, top + 11.5 * unit, left + 34.5 * unit, top + 34.5 * unit), 4 * unit, fill=hole)


def render(size, ground, mark, glyph_share, shape='square'):
    """`ground` None leaves the canvas clear; the glyph spans `glyph_share` of the canvas, centred."""
    big = size * SS
    image = Image.new('RGBA', (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    if ground and shape == 'tile':
        draw.rounded_rectangle((0, 0, big - 1, big - 1), big * 0.225, fill=ground)
    elif ground and shape == 'circle':
        draw.ellipse((0, 0, big - 1, big - 1), fill=ground)
    elif ground:
        draw.rectangle((0, 0, big, big), fill=ground)
    g = big * glyph_share
    glyph(draw, (big - g) / 2, (big - g) / 2, g, mark, ground or (0, 0, 0, 0))
    return image.resize((size, size), Image.LANCZOS)


def save(image, *parts):
    path = os.path.join(*parts)
    image.save(path)
    print('wrote', os.path.normpath(path))


assets = os.path.join(ROOT, 'phone-app', 'assets')
save(render(1024, INK, PAPER, 0.49), assets, 'icon.png')
# Adaptive icon: 108 dp canvas, the launcher masks to about the middle 66%.
save(render(1024, None, PAPER, 0.34), assets, 'android-icon-foreground.png')
save(render(1024, None, PAPER, 0.34), assets, 'android-icon-monochrome.png')
save(render(1024, None, PAPER, 0.42), assets, 'splash-icon.png')
save(render(1024, None, INK, 0.42), assets, 'splash-icon-light.png')
save(render(128, INK, PAPER, 0.49, 'tile'), assets, 'favicon.png')
save(render(1024, INK, PAPER, 0.49, 'tile'), ROOT, 'pc-companion', 'src-tauri', 'icons', 'app-icon.png')

if len(sys.argv) > 1:
    res = sys.argv[1]
    for density, scale in (('mdpi', 1), ('hdpi', 1.5), ('xhdpi', 2), ('xxhdpi', 3), ('xxxhdpi', 4)):
        mip = os.path.join(res, 'mipmap-' + density)
        save(render(int(108 * scale), None, PAPER, 0.34), mip, 'ic_launcher_foreground.webp')
        save(render(int(108 * scale), None, PAPER, 0.34), mip, 'ic_launcher_monochrome.webp')
        save(render(int(48 * scale), INK, PAPER, 0.49, 'tile'), mip, 'ic_launcher.webp')
        save(render(int(48 * scale), INK, PAPER, 0.49, 'circle'), mip, 'ic_launcher_round.webp')
        save(render(int(288 * scale), None, INK, 0.42), res, 'drawable-' + density, 'splashscreen_logo.png')
        save(render(int(288 * scale), None, PAPER, 0.42), res, 'drawable-night-' + density, 'splashscreen_logo.png')
