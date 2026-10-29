"""Draw the extension icons: a play triangle with danmaku pills streaming past.

Run: uv run --no-project --with pillow python tools/make-icons.py

Drawn on a 128-unit grid at 8x, then scaled down. The 128 px store icon keeps
16 px of transparent padding (Chrome Web Store guideline); toolbar sizes use
the whole square. 16 px gets a simpler layout so the shapes stay readable.
"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw

OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).resolve().parent.parent / "icons"
SS = 8
TOP = (67, 56, 202)      # indigo
BOTTOM = (124, 58, 237)  # violet
WHITE = (255, 255, 255, 255)
SOFT = (255, 255, 255, 200)
ACCENT = (253, 224, 71, 255)


def draw(size, pad, simple):
    n = size * SS
    img = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    box = n - 2 * pad * SS
    u = box / 128  # one grid unit in pixels
    o = pad * SS

    def p(x, y):
        return (o + x * u, o + y * u)

    # Background: rounded square with a vertical gradient.
    grad = Image.new('RGBA', (n, n))
    gd = ImageDraw.Draw(grad)
    for y in range(n):
        t = min(max((y - o) / box, 0), 1)
        gd.line([(0, y), (n, y)], fill=tuple(round(a + (b - a) * t) for a, b in zip(TOP, BOTTOM)) + (255,))
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).rounded_rectangle([p(0, 0), p(128, 128)], radius=28 * u, fill=255)
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)

    def pill(x0, x1, cy, h, fill):
        d.rounded_rectangle([p(x0, cy - h / 2), p(x1, cy + h / 2)], radius=h / 2 * u, fill=fill)

    if simple:
        d.polygon([p(20, 30), p(20, 98), p(60, 64)], fill=WHITE)
        pill(68, 106, 40, 20, ACCENT)
        pill(78, 116, 88, 20, SOFT)
    else:
        d.polygon([p(20, 40), p(20, 88), p(54, 64)], fill=WHITE)
        pill(70, 114, 36, 14, SOFT)
        pill(60, 100, 64, 14, ACCENT)
        pill(76, 114, 92, 14, SOFT)
    return img.resize((size, size), Image.LANCZOS)


OUT.mkdir(parents=True, exist_ok=True)
for size, pad, simple in [(16, 0, True), (32, 0, False), (48, 0, False), (128, 16, False)]:
    draw(size, pad, simple).save(OUT / f'icon-{size}.png', optimize=True)
    print(OUT / f'icon-{size}.png')
