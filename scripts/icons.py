#!/usr/bin/env python3
"""Render the Common app icons from the dotted-ring mark.

    python3 scripts/icons.py

Rewrites the icons in src-tauri/icons/: the app icon at every size Tauri's
bundle config names, icon.icns, icon.ico, and the menu-bar glyph. Needs Pillow
and, for the .icns, macOS `iconutil`; it is a design-time tool, not part of the
build, so neither is a dependency of the app. On a machine without iconutil the
.icns is skipped and everything else is still written.

This was the Electron build's icon renderer, drawing into `assets/`. The drawing
is unchanged; only where the files land and what they are called is. Tauri names
its own set (`32x32.png`, `128x128.png`, `128x128@2x.png`, `icon.icns`,
`icon.ico`) and `src-tauri/tauri.conf.json` lists exactly those five, so those
are the names emitted here. `icon.png` is written too — not in that list, but
conventional.

Why draw the mark instead of downscaling it: twenty dots is the right count at
512px and turns to a solid grey ring at 16px, which is precisely the size
Windows puts in the taskbar and the titlebar. Lanczos cannot help -- the dots
are smaller than a pixel there. So each size gets a dot count that survives it
(see RING), which is ordinary icon hinting: keep the character legible rather
than keep the geometry literal.

The wobble is deterministic. A fixed seed means every size and every rebuild
places its dots identically, so the icon does not quietly change between
releases -- hand-placed once, not randomly each time.
"""
import math
import pathlib
import random
import shutil
import subprocess
import sys
import tempfile

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required: python3 -m pip install Pillow")

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = ROOT / "src-tauri" / "icons"

PAPER = (237, 233, 225)   # --paper #ede9e1
INK = (40, 38, 36)        # --bg    #282624

SS = 8  # supersample factor; every shape is drawn big and downsampled once

# size threshold -> (dot count, dot radius, ring radius), the last two as
# fractions of the plate. Fewer, fatter dots as the canvas shrinks: the gap
# between dots has to stay near a pixel or the ring reads as a solid stroke.
# The ring itself also tightens, because fatter dots on the same circle crowd
# the plate edge.
RING = [(64, 20, 0.032, 0.30), (40, 16, 0.036, 0.29),
        (28, 12, 0.042, 0.28), (0, 8, 0.050, 0.26)]


def ring_for(size):
    for threshold, count, dot, ring in RING:
        if size >= threshold:
            return count, dot, ring
    return RING[-1][1:]


def wobble(count):
    """Per-dot (radial nudge, size multiplier). Fixed seed: see module docstring."""
    rng = random.Random(7)
    return [(rng.uniform(-0.045, 0.045), rng.uniform(0.85, 1.15)) for _ in range(count)]


def plate(size, radius_frac, inset_frac):
    """Rounded square, antialiased by drawing at SS and resizing once."""
    big = size * SS
    inset = round(size * inset_frac) * SS
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        [inset, inset, big - inset - 1, big - inset - 1],
        radius=round(size * radius_frac) * SS, fill=255)
    return mask.resize((size, size), Image.LANCZOS)


def draw(size, fg, bg, radius_frac, inset_frac):
    big = size * SS
    layer = Image.new("RGBA", (big, big), bg + (255,))
    d = ImageDraw.Draw(layer)
    count, dot_frac, ring_frac = ring_for(size)
    span = big - round(size * inset_frac) * SS * 2
    centre, ring, dot = big / 2, span * ring_frac, span * dot_frac
    for i, (nudge, scale) in enumerate(wobble(count)):
        angle = -math.pi / 2 + i * 2 * math.pi / count
        r = ring * (1 + nudge)
        cx, cy = centre + r * math.cos(angle), centre + r * math.sin(angle)
        rr = dot * scale
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=fg + (255,))
    icon = layer.resize((size, size), Image.LANCZOS)
    icon.putalpha(plate(size, radius_frac, inset_frac))
    return icon


# macOS art sits on an 824/1024 plate with a generous corner radius; Windows
# and Linux run closer to full bleed. Same mark, each platform's own grid.
def mac(size):
    return draw(size, INK, PAPER, 185 / 1024, (1024 - 824) / 2 / 1024)


def square(size):
    return draw(size, INK, PAPER, 0.20, 0.02)


# Menu bar: the mark fills more of the canvas than the app icon does, because
# the bar gives it no plate to sit on. Same dotted ring, its own grid.
TRAY_RING = [(32, 12, 0.050, 0.34), (0, 9, 0.062, 0.33)]
TRAY_INSET = 0.04


def tray_ring_for(size):
    for threshold, count, dot, ring in TRAY_RING:
        if size >= threshold:
            return count, dot, ring
    return TRAY_RING[-1][1:]


def tray(size, attention=False):
    """Menu-bar mark: black on transparent, no plate.

    macOS template images read only the alpha and tint the shape to match the
    menu bar, so this one file is right on a light bar and a dark one. The
    `attention` variant puts its signal in the shape -- a dot in the corner --
    instead of recolouring the whole icon, which on the menu bar means guessing
    at a colour the bar may already be using. Nothing in the Tauri app calls for
    it today -- `build_tray` sets one icon and no attention state -- so it is
    kept here rather than emitted, in case a menu bar badge returns.
    """
    big = size * SS
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    count, dot_frac, ring_frac = tray_ring_for(size)
    span = big * (1 - 2 * TRAY_INSET)
    centre, ring, dot = big / 2, span * ring_frac, span * dot_frac
    for i, (nudge, scale) in enumerate(wobble(count)):
        angle = -math.pi / 2 + i * 2 * math.pi / count
        r = ring * (1 + nudge)
        cx, cy = centre + r * math.cos(angle), centre + r * math.sin(angle)
        rr = dot * scale
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(0, 0, 0, 255))
    if attention:
        rr = big * 0.10
        cx = cy = big - rr - big * TRAY_INSET
        d.ellipse([cx - rr, cy - rr, cx + rr, cy + rr], fill=(0, 0, 0, 255))
    return layer.resize((size, size), Image.LANCZOS)


# 44 and not 22: `tray-icon` normalises whatever it is handed to 18 points tall
# and keeps the aspect, so the extra pixels are what survives on a Retina bar.
# See the note above `TRAY_PNG` in src-tauri/src/lib.rs.
TRAY_SIZE = 44

# Windows and Linux read `32x32.png` off the tray instead of this, because a
# black glyph on a dark taskbar is a glyph nobody can see. One file, two jobs:
# the taskbar icon and the non-macOS tray icon.
ICO_SIZES = [16, 24, 32, 48, 64, 128, 256]

ICNS_PLAN = ((16, "icon_16x16"), (32, "icon_16x16@2x"), (32, "icon_32x32"),
             (64, "icon_32x32@2x"), (128, "icon_128x128"), (256, "icon_128x128@2x"),
             (256, "icon_256x256"), (512, "icon_256x256@2x"), (512, "icon_512x512"),
             (1024, "icon_512x512@2x"))


def main():
    ICONS.mkdir(parents=True, exist_ok=True)

    square(512).save(ICONS / "icon.png")
    square(32).save(ICONS / "32x32.png")
    square(128).save(ICONS / "128x128.png")
    square(256).save(ICONS / "128x128@2x.png")

    # .ico: every size Windows asks for, each drawn rather than downscaled.
    images = [square(s) for s in ICO_SIZES]
    images[-1].save(ICONS / "icon.ico", format="ICO",
                    sizes=[(s, s) for s in ICO_SIZES], append_images=images[:-1])

    # macOS menu bar: the mark alone, as a template macOS tints itself.
    tray(TRAY_SIZE).save(ICONS / "tray.png")

    if shutil.which("iconutil") is None:
        print("icon.png, 32x32.png, 128x128.png, 128x128@2x.png, icon.ico and "
              "tray.png written. icon.icns needs macOS iconutil -- skipped.")
        return

    # iconutil insists on a `.iconset` directory beside its output, so the set is
    # built in a temporary one and thrown away after. Writing it into the icons
    # directory would leave ten PNGs there that nothing reads and Tauri does not
    # bundle -- they are an intermediate, not an asset.
    with tempfile.TemporaryDirectory() as scratch:
        work = pathlib.Path(scratch) / "Common.iconset"
        work.mkdir()
        for px, name in ICNS_PLAN:
            mac(px).save(work / f"{name}.png")
        subprocess.run(["iconutil", "-c", "icns", str(work),
                        "-o", str(ICONS / "icon.icns")], check=True)

    print("icon.png, icon.icns, icon.ico, 32x32.png, 128x128.png, 128x128@2x.png "
          "and tray.png written.")


if __name__ == "__main__":
    main()
