"""Regenerate Chisel's brand assets from the Sickle mark.

The Sickle is four separate flat triangles along one arc, shrinking from a thick base to an oxide tip.
Its geometry lives here and nowhere else; every asset is drawn from it:

    public/mark.svg            #mark symbol for the app (base triangles currentColor, tip --accent)
    public/favicon.svg         follows the tab bar's light/dark scheme
    public/favicon.ico         16, 32, 48 px tiles
    public/icon-192.png, icon-512.png, apple-touch-icon.png
    docs/og-dark.png, docs/og-light.png   1200x630 cards (rendered with chromium for the type)

    python3 scripts/brand.py   # needs only Python and, for the cards, chromium (or CHROMIUM=...)
"""
import math
import os
import struct
import subprocess
import tempfile
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GRAPHITE, MARBLE, OXIDE = "#24272a", "#eceeec", "#c86a45"


def triangle(cx, cy, length, width, angle):
    """An isosceles triangle centred at (cx, cy), its apex pointing along angle (degrees)."""
    a = math.radians(angle)
    dx, dy, px, py = math.cos(a), math.sin(a), -math.sin(a), math.cos(a)
    back = (cx - dx * length / 2, cy - dy * length / 2)
    return [(cx + dx * length / 2, cy + dy * length / 2),
            (back[0] + px * width / 2, back[1] + py * width / 2),
            (back[0] - px * width / 2, back[1] - py * width / 2)]


def sickle():
    """The mark in a 48 box: workshop round 8 option 7c. The last triangle is the oxide tip."""
    tris = []
    for i in range(4):
        k = i / 3
        a = 160 + 160 * k
        tris.append(triangle(28 + 14 * math.cos(math.radians(a)), 30 + 14 * math.sin(math.radians(a)),
                             14 - 7 * k, 12 - 8 * k, a + 90))
    xs = [x for t in tris for x, _ in t]
    ys = [y for t in tris for _, y in t]
    s = 44 / max(max(xs) - min(xs), max(ys) - min(ys))
    ox, oy = 24 - (min(xs) + max(xs)) / 2 * s, 24 - (min(ys) + max(ys)) / 2 * s
    return [[(x * s + ox, y * s + oy) for x, y in t] for t in tris]


TRIS = sickle()


def points(t):
    return " ".join(f"{x:.2f},{y:.2f}" for x, y in t)


def svg_body(base, tip):
    return "".join(f'<polygon points="{points(t)}" {tip if i == 3 else base}/>' for i, t in enumerate(TRIS))


# ── raster: the mark is only triangles, so a supersampled edge-function fill is all PNGs need ──

def hex_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (1, 3, 5))


def raster(size, background, mark_scale):
    """RGBA pixels of the mark on a solid square (background None = transparent), mark_scale of the tile."""
    px = [list(hex_rgb(background)) + [255] if background else [0, 0, 0, 0] for _ in range(size * size)]
    k = size / 48 * mark_scale
    off = size * (1 - mark_scale) / 2
    ss = 4
    for i, tri in enumerate(TRIS):
        colour = hex_rgb(OXIDE if i == 3 else MARBLE)
        (x0, y0), (x1, y1), (x2, y2) = [(x * k + off, y * k + off) for x, y in tri]
        area = (x1 - x0) * (y2 - y0) - (x2 - x0) * (y1 - y0)
        for py in range(max(0, int(min(y0, y1, y2))), min(size, int(max(y0, y1, y2)) + 1)):
            for pxl in range(max(0, int(min(x0, x1, x2))), min(size, int(max(x0, x1, x2)) + 1)):
                hits = 0
                for sy in range(ss):
                    for sx in range(ss):
                        x, y = pxl + (sx + 0.5) / ss, py + (sy + 0.5) / ss
                        w0 = (x1 - x) * (y2 - y) - (x2 - x) * (y1 - y)
                        w1 = (x2 - x) * (y0 - y) - (x0 - x) * (y2 - y)
                        w2 = (x0 - x) * (y1 - y) - (x1 - x) * (y0 - y)
                        if (w0 >= 0 and w1 >= 0 and w2 >= 0) if area > 0 else (w0 <= 0 and w1 <= 0 and w2 <= 0):
                            hits += 1
                if hits:
                    a = hits / ss ** 2
                    p = px[py * size + pxl]
                    out_a = a + p[3] / 255 * (1 - a)
                    for c in range(3):
                        p[c] = round((colour[c] * a + p[c] * p[3] / 255 * (1 - a)) / out_a)
                    p[3] = round(out_a * 255)
    return px


def png(size, pixels):
    rows = b"".join(b"\0" + bytes(v for p in pixels[y * size:(y + 1) * size] for v in p) for y in range(size))
    chunk = lambda kind, data: struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def ico(images):
    """An ICO holding PNG payloads, one per size."""
    head = struct.pack("<HHH", 0, 1, len(images))
    offset = 6 + 16 * len(images)
    entries, data = b"", b""
    for size, payload in images:
        entries += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(payload), offset + len(data))
        data += payload
    return head + entries + data


def tile(size, scale=0.78):
    return raster(size, GRAPHITE, scale)


# ── cards: type needs a real browser, so these go through headless chromium ──

def og_card(theme, out):
    bg, ink = (GRAPHITE, MARBLE) if theme == "dark" else (MARBLE, GRAPHITE)
    dim = "#9aa4a9" if theme == "dark" else "#59636a"
    fonts = ROOT / "node_modules/@fontsource"
    mark = svg_body(f'fill="{ink}"', f'fill="{OXIDE}"')
    html = f"""<!doctype html><meta charset="utf-8"><style>
@font-face {{ font-family: Geist; font-weight: 600; src: url("{(fonts / 'geist/files/geist-latin-600-normal.woff2').as_uri()}"); }}
@font-face {{ font-family: JBM; src: url("{(fonts / 'jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2').as_uri()}"); }}
html, body {{ margin: 0; width: 1200px; height: 630px; background: {bg}; color: {ink}; overflow: hidden; }}
main {{ height: 100%; display: flex; align-items: center; gap: 56px; padding: 0 112px; box-sizing: border-box; }}
svg {{ width: 260px; height: 260px; flex: none; }}
h1 {{ font: 600 132px/1 Geist; letter-spacing: -0.04em; margin: 0; }}
p {{ font: 400 30px/1.4 JBM; color: {dim}; margin: 20px 0 0; }}
</style><main><svg viewBox="0 0 48 48">{mark}</svg><div><h1>chisel</h1>
<p>Sketch the blocks.<br>An agent carves the code.</p></div></main>"""
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html)
    try:
        subprocess.run([os.environ.get("CHROMIUM", "chromium"), "--headless", "--disable-gpu", "--hide-scrollbars",
                        "--window-size=1200,630", f"--screenshot={out}", f.name],
                       check=True, capture_output=True)
    finally:
        os.unlink(f.name)


def main():
    pub, docs = ROOT / "public", ROOT / "docs"
    symbol = svg_body('fill="currentColor"', 'style="fill: var(--accent)"')
    (pub / "mark.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="0" height="0" style="position:absolute" aria-hidden="true">'
        f'<symbol id="mark" viewBox="0 0 48 48">{symbol}</symbol></svg>\n')
    favicon = svg_body('class="b"', f'fill="{OXIDE}"')
    (pub / "favicon.svg").write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48">'
        f"<style>.b{{fill:{GRAPHITE}}}@media (prefers-color-scheme:dark){{.b{{fill:{MARBLE}}}}}</style>"
        f"{favicon}</svg>\n")
    (pub / "favicon.ico").write_bytes(ico([(s, png(s, tile(s, 0.9))) for s in (16, 32, 48)]))
    (pub / "apple-touch-icon.png").write_bytes(png(180, tile(180)))
    for s in (192, 512):  # maskable: the mark stays inside the 80% safe zone
        (pub / f"icon-{s}.png").write_bytes(png(s, tile(s, 0.7)))
    for theme in ("dark", "light"):
        og_card(theme, docs / f"og-{theme}.png")


# The tip must come out oxide and the corners stay background, or the raster is wrong.
_check = raster(48, GRAPHITE, 1)
_tip = [sum(c) / 3 for c in zip(*TRIS[3])]
assert _check[int(_tip[1]) * 48 + int(_tip[0])][:3] == list(hex_rgb(OXIDE)), "tip is not oxide"
assert _check[0][:3] == list(hex_rgb(GRAPHITE)), "corner is not background"

if __name__ == "__main__":
    main()
