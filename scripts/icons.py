#!/usr/bin/env python3
"""Render the Common app icons from the dotted-ring mark.

    python3 scripts/icons.py

Rewrites assets/icon.png, icon.icns, icon.ico and tray.png. Needs Pillow and,
for the .icns, macOS `iconutil`; it is a design-time tool, not part of the
build, so neither is a dependency of the app.

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

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit("Pillow is required: python3 -m pip install Pillow")

ROOT = pathlib.Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"

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


def main():
    square(512).save(ASSETS / "icon.png")

    # .ico: every size Windows asks for, each drawn rather than downscaled.
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [square(s) for s in sizes]
    images[-1].save(ASSETS / "icon.ico", format="ICO",
                    sizes=[(s, s) for s in sizes], append_images=images[:-1])

    # Tray: a dark badge, so it reads against a light menu bar or taskbar.
    draw(32, PAPER, INK, 0.22, 0.0).save(ASSETS / "tray.png")

    if shutil.which("iconutil") is None:
        print("icon.png, icon.ico and tray.png written. "
              "icon.icns needs macOS iconutil -- skipped.")
        return
    work = ASSETS / "Common.iconset"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir()
    for px, name in ((16, "icon_16x16"), (32, "icon_16x16@2x"), (32, "icon_32x32"),
                     (64, "icon_32x32@2x"), (128, "icon_128x128"), (256, "icon_128x128@2x"),
                     (256, "icon_256x256"), (512, "icon_256x256@2x"), (512, "icon_512x512"),
                     (1024, "icon_512x512@2x")):
        mac(px).save(work / f"{name}.png")
    subprocess.run(["iconutil", "-c", "icns", str(work), "-o", str(ASSETS / "icon.icns")],
                   check=True)
    shutil.rmtree(work)
    print("icon.png, icon.icns, icon.ico and tray.png written.")


if __name__ == "__main__":
    main()
