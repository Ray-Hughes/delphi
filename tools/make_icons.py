#!/usr/bin/env python3
"""
Builds every icon the app ships from the source artwork in build/source.

Run this when the artwork changes, not on every build. The generated files are
committed, because a release built on a CI runner must not depend on Pillow, on
this script, or on anything else being installed there.

    python3 tools/make_icons.py

What comes out, and why each one exists:

    build/icon.png          1024, the mac app icon. The mark is inset to 824 on a
                            transparent canvas because that is the proportion
                            Apple's icon grid uses; a squircle drawn edge to edge
                            sits visibly larger than every neighbour in the Dock.
    build/icon.ico          Windows, which has no such inset convention and looks
                            underweight at the mac proportion, so it fills more.
    build/icon.icns         The Desktop launcher built by install/desktop.sh for
                            people running from a checkout.
    assets/trayTemplate.png The menu bar mark, black on alpha at 1x, 2x and 3x.
                            macOS inverts a template image for a dark menu bar; a
                            coloured tray icon is why some apps show a dark blob
                            on a dark menu bar.
    assets/tray-win-*.png   Windows draws the tray icon as given and its taskbar
                            follows the system theme, so there is one for each.
    assets/mark-32.png      The mark in the app's own sidebar.
    docs/favicon.png        The round mark, for the download page.

build/ is consumed by the installer and never copied into the app. assets/ ships
inside it, because those two are needed while the app is running.
"""

import math
import pathlib
import sys

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter
    from scipy import ndimage
except ImportError as missing:
    sys.exit(f"{missing}. This is a maintenance script: pip install pillow numpy scipy")

ROOT = pathlib.Path(__file__).resolve().parent.parent
SOURCE = ROOT / "build" / "source"
BUILD = ROOT / "build"
DOCS = ROOT / "docs"
# Two destinations, and the difference matters. build/ holds what the installer
# consumes and is never copied into the app. assets/ is shipped inside the app,
# because the tray icon and the sidebar mark are needed at runtime.
ASSETS = ROOT / "assets"


def load(name):
    path = SOURCE / name
    if not path.exists():
        sys.exit(f"missing artwork: {path}")
    return Image.open(path).convert("RGBA")


def fit(img, box):
    """Scales to fit a square box, keeping the aspect ratio and the alpha."""
    scale = min(box / img.width, box / img.height)
    return img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)


def canvas(img, size, inset):
    """Centres a mark on a transparent square canvas at the given inset."""
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    mark = fit(img, round(size * inset))
    out.paste(mark, ((size - mark.width) // 2, (size - mark.height) // 2), mark)
    return out


# ---------------------------------------------------------------------------
# The menu bar mark
#
# Not the full flame. That drawing is around forty strokes, and at 16 pixels each
# one covers a third of a pixel and they average into a grey lump. The silhouette
# with the star knocked out of it is the same mark reduced to what survives.
# ---------------------------------------------------------------------------

def silhouette(art):
    # Reduced to a fixed working size first. The steps below close gaps between
    # strokes with a kernel measured in pixels, so running them on the artwork as
    # given ties the result to whatever resolution that happens to be: the same
    # source at 1024 leaves every gap open, the fill finds no enclosed body, and
    # what comes out is a few surviving strokes rather than a silhouette.
    art = fit(art, 192)

    a = np.asarray(art).astype(np.float32)
    lum = a[..., :3] @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    strokes = (lum > 88) & (a[..., 3] > 128)

    # Gaps in the drawing are closed before filling, or the fill leaks out through
    # them and floods the whole square.
    body = ndimage.binary_closing(strokes, np.ones((7, 7)))
    body = ndimage.binary_fill_holes(body)
    body = ndimage.binary_opening(body, np.ones((5, 5)))
    labels, count = ndimage.label(body)
    sizes = ndimage.sum(body, labels, range(1, count + 1))
    body = labels == (int(np.argmax(sizes)) + 1)

    ys, xs = np.where(body)
    body = body[ys.min():ys.max() + 1, xs.min():xs.max() + 1]

    ss = 8
    glyph = Image.fromarray((body * 255).astype(np.uint8), "L")
    glyph = glyph.resize((glyph.width * ss, glyph.height * ss), Image.LANCZOS)
    # Smoothed then re-thresholded, which pulls the ragged edge left by the stroke
    # ends into one clean contour.
    glyph = glyph.filter(ImageFilter.GaussianBlur(ss * 0.55)).point(lambda v: 255 if v > 132 else 0)

    draw = ImageDraw.Draw(glyph)
    points = []
    for i in range(8):
        angle = math.pi / 2 * (i / 2) - math.pi / 2
        r = glyph.width * (0.20 if i % 2 == 0 else 0.055)
        points.append((glyph.width * 0.5 + r * math.cos(angle), glyph.height * 0.52 + r * math.sin(angle)))
    draw.polygon(points, fill=0)
    return glyph


def tray_image(glyph, size, colour):
    height = size
    width = max(1, round(glyph.width / glyph.height * height))
    mask = glyph.resize((width, height), Image.LANCZOS)
    layer = Image.new("RGBA", (width, height), colour + (0,))
    layer.putalpha(mask)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(layer, ((size - width) // 2, 0), layer)
    return out


def icns(art):
    """
    The macOS icon bundle.

    electron-builder makes its own from icon.png, so this is not for the installer.
    It is for the Desktop launcher that install/desktop.sh builds for people running
    from a checkout, which needs a real .icns file or the Finder shows the blank
    generic application icon.

    Skipped off macOS, where iconutil does not exist. The committed file covers it.
    """
    if sys.platform != "darwin":
        return
    import shutil
    import subprocess

    iconset = BUILD / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir(parents=True)

    for size in (16, 32, 64, 128, 256, 512):
        canvas(art, size, 824 / 1024).save(iconset / f"icon_{size}x{size}.png")
        canvas(art, size * 2, 824 / 1024).save(iconset / f"icon_{size}x{size}@2x.png")

    result = subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(BUILD / "icon.icns")],
                            capture_output=True, text=True)
    shutil.rmtree(iconset)
    if result.returncode != 0:
        print(f"  iconutil failed: {result.stderr.strip()}")


def main():
    BUILD.mkdir(parents=True, exist_ok=True)
    DOCS.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    squircle = load("mac-squircle.png")
    disc = load("app-disc.png")
    square = load("tray-active.png")

    canvas(squircle, 1024, 824 / 1024).save(BUILD / "icon.png")
    canvas(squircle, 512, 824 / 1024).save(BUILD / "icon-512.png")

    # Windows: closer to the edge, and every size stored in the one file so the
    # shell picks the right one instead of scaling 256 down to 16 itself.
    ico = canvas(squircle, 256, 0.96)
    ico.save(BUILD / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

    glyph = silhouette(squircle)
    tray_image(glyph, 16, (0, 0, 0)).save(ASSETS / "trayTemplate.png")
    tray_image(glyph, 32, (0, 0, 0)).save(ASSETS / "trayTemplate@2x.png")
    tray_image(glyph, 48, (0, 0, 0)).save(ASSETS / "trayTemplate@3x.png")

    # Windows draws the tray icon exactly as given, and its taskbar follows the
    # system theme, so one colour is legible on one theme and nearly invisible on
    # the other. Both are shipped and the app swaps them; see main.js.
    #
    # PNG rather than ICO on purpose. Electron reads .ico only on Windows, so an
    # .ico cannot be checked anywhere else, and a tray icon that silently fails to
    # decode is an app with no tray icon at all.
    for name, colour in [("on-dark", (79, 216, 224)), ("on-light", (74, 99, 216))]:
        tray_image(glyph, 16, colour).save(ASSETS / f"tray-win-{name}.png")
        tray_image(glyph, 32, colour).save(ASSETS / f"tray-win-{name}@2x.png")

    # The mark in the sidebar, at 1x and 2x.
    canvas(squircle, 32, 1.0).save(ASSETS / "mark-32.png")
    canvas(squircle, 64, 1.0).save(ASSETS / "mark-64.png")

    canvas(disc, 512, 1.0).save(DOCS / "favicon.png")
    canvas(squircle, 512, 1.0).save(DOCS / "icon.png")
    canvas(square, 512, 1.0).save(BUILD / "tray-active.png")

    icns(squircle)

    for path in sorted(list(BUILD.glob("*.png")) + list(BUILD.glob("*.ico")) + list(BUILD.glob("*.icns"))
                       + list(ASSETS.glob("*")) + list(DOCS.glob("*.png"))):
        print(f"  {path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
