#!/usr/bin/env python3
"""
Cuts a mark off its background and gives it an alpha channel.

    python3 tools/cutout.py <image> <destination.png>

For the artwork this project is given: a dark, saturated mark sitting on a pale
flat background. It keys on ink rather than on distance from the background
colour, which is what drops a light bezel ring or a drop shadow instead of baking
them into the file.

Two details that are the whole difference between this and a threshold:

Edges are decided at 4x and averaged down. Deciding in or out at final size gives
a stair-stepped edge, and these files end up scaled to 16 pixels where that reads
as a smudge rather than a mark.

Transparent pixels take their colour from the nearest solid neighbour. A feathered
edge blends whatever is underneath it, and underneath here is a pale background, so
without this every cutout carries a light halo that only becomes visible once it is
placed on something dark, which is exactly where these are going.
"""

import pathlib
import sys

try:
    import numpy as np
    from PIL import Image
    from scipy import ndimage
except ImportError as missing:
    sys.exit(f"{missing}. This is a maintenance script: pip install pillow numpy scipy")

SS = 4


def cutout(src, pad=6):
    im = Image.open(src).convert("RGB")
    big = np.asarray(im.resize((im.width * SS, im.height * SS), Image.LANCZOS)).astype(np.float32)

    lum = big @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    sat = big.max(axis=2) - big.min(axis=2)
    mask = (lum < 165) | (sat > 38)

    mask = ndimage.binary_closing(mask, np.ones((SS * 2, SS * 2)))
    mask = ndimage.binary_fill_holes(mask)
    labels, count = ndimage.label(mask)
    if count > 1:
        sizes = ndimage.sum(mask, labels, range(1, count + 1))
        mask = labels == (int(np.argmax(sizes)) + 1)
    mask = ndimage.binary_opening(mask, np.ones((SS, SS)))

    alpha = np.asarray(
        Image.fromarray((mask * 255).astype(np.uint8)).resize(im.size, Image.BOX)
    ).astype(np.float32) / 255.0

    rgb = np.asarray(im).astype(np.float32)
    solid = alpha > 0.85
    if solid.any():
        _, (iy, ix) = ndimage.distance_transform_edt(~solid, return_indices=True)
        rgb = rgb[iy, ix]

    ys, xs = np.where(alpha > 0.04)
    y0, y1 = max(0, ys.min() - pad), min(alpha.shape[0], ys.max() + 1 + pad)
    x0, x1 = max(0, xs.min() - pad), min(alpha.shape[1], xs.max() + 1 + pad)

    out = np.dstack([rgb[y0:y1, x0:x1], alpha[y0:y1, x0:x1] * 255]).astype(np.uint8)
    return Image.fromarray(out, "RGBA")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__.strip())
    result = cutout(pathlib.Path(sys.argv[1]))
    destination = pathlib.Path(sys.argv[2])
    destination.parent.mkdir(parents=True, exist_ok=True)
    result.save(destination)
    print(f"  {destination}  {result.size[0]}x{result.size[1]}")
