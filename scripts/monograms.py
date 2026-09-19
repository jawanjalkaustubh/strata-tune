"""
Strata family monogram logos drawn from scratch (no typeface): Sc (Strata Code, indigo), Sp (Strata Photo, gold),
Ss (StrataSnap, gold), St (Strata Tune, emerald). The big S is a stepped "strata" S - three layered bars joined by
two risers - and the small letter is simple geometry (ring, stem + ring, small stepped s, stem + crossbar + hook).
Everything is original vector construction rendered with PIL at 4x and downsampled, so there is nothing to license.

This copy only writes the St assets into this repo (assets/ and src/assets/logo.ts); the other three letters are
kept so the construction stays identical across the family.
"""
import base64, io, math, os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SIZES = [(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (24, 24), (16, 16)]


def luminance(rgb):
    r, g, b = [c / 255 for c in rgb]
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def stroke_path(d: ImageDraw.ImageDraw, pts, w: int, ink):
    """Polyline with round joints and round caps."""
    d.line(pts, fill=ink, width=w, joint="curve")
    r = w / 2
    for (x, y) in (pts[0], pts[-1]):
        d.ellipse([x - r, y - r, x + r, y + r], fill=ink)


def stepped_s(d, x0, x1, y_top, y_mid, y_bot, w, ink):
    """Geometric S from two stacked arcs: the upper one runs from the centre up the left, over the top and
    down the right to ~20 deg; the lower one from the centre down the right, under the bottom and up the
    left to ~200 deg (PIL angles: 0 = 3 o'clock, clockwise; arcs are split at 360 so nothing wraps)."""
    cx = (x0 + x1) / 2
    r = (y_mid - y_top)
    rc = r - w / 2
    cap = lambda c_x, c_y, ang: d.ellipse([c_x + rc * math.cos(math.radians(ang)) - w / 2, c_y + rc * math.sin(math.radians(ang)) - w / 2,
                                          c_x + rc * math.cos(math.radians(ang)) + w / 2, c_y + rc * math.sin(math.radians(ang)) + w / 2], fill=ink)
    uy = y_top + r
    d.arc([cx - r, uy - r, cx + r, uy + r], start=90, end=330, fill=ink, width=w)   # 240 deg: ends at 2 o'clock
    cap(cx, uy, 90); cap(cx, uy, 330)
    ly = y_mid + r
    d.arc([cx - r, ly - r, cx + r, ly + r], start=270, end=360, fill=ink, width=w)
    d.arc([cx - r, ly - r, cx + r, ly + r], start=0, end=150, fill=ink, width=w)    # 240 deg: ends at 8 o'clock
    cap(cx, ly, 270); cap(cx, ly, 150)


def ring(d, cx, cy, r, w, ink, start=0, end=360):
    d.arc([cx - r, cy - r, cx + r, cy + r], start=start, end=end, fill=ink, width=w)
    # round the arc ends
    for ang in (start, end):
        if (end - start) % 360 == 0:
            break
        a = math.radians(ang % 360)
        px, py = cx + (r - w / 2) * math.cos(a), cy + (r - w / 2) * math.sin(a)
        d.ellipse([px - w / 2, py - w / 2, px + w / 2, py + w / 2], fill=ink)


def monogram(small: str, accent: tuple, size: int = 1024) -> Image.Image:
    S = size * 4
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=accent + (255,))
    ink = (15, 15, 16, 255) if luminance(accent) > 0.45 else (245, 245, 247, 255)
    u = S  # unit
    # Big stepped S: occupies x 0.17..0.55, y 0.26..0.74
    w = int(u * 0.09)
    stepped_s(d, u * 0.17, u * 0.55, u * 0.29, u * 0.50, u * 0.71, w, ink)
    # Small letter: x-height box x 0.62..0.84, y 0.50..0.72 (baseline shared with the S)
    w2 = int(u * 0.085)
    cx, cy, r = u * 0.735, u * 0.605, u * 0.105
    if small == "c":
        ring(d, cx, cy, r, w2, ink, start=35, end=325)
    elif small == "p":
        sx = u * 0.635
        stroke_path(d, [(sx, u * 0.50), (sx, u * 0.85)], w2, ink)            # stem with descender
        ring(d, sx + r * 0.98, cy, r * 0.98, w2, ink)                          # bowl
    elif small == "s":
        stepped_s(d, u * 0.635, u * 0.835, u * 0.505, u * 0.605, u * 0.705, int(u * 0.062), ink)
    elif small == "t":
        sx, base, rh = u * 0.715, u * 0.71, u * 0.075                           # stem x, baseline, hook radius (centre-line)
        stroke_path(d, [(sx, u * 0.40), (sx, base - rh)], w2, ink)              # ascender stem, shorter than the S
        ring(d, sx + rh, base - rh, rh + w2 / 2, w2, ink, start=90, end=180)    # hook: stem curls right onto the baseline
        stroke_path(d, [(u * 0.625, u * 0.50), (u * 0.815, u * 0.50)], w2, ink)  # crossbar at x-height
    else:
        raise ValueError(small)
    return img.resize((size, size), Image.LANCZOS)


def data_url(img: Image.Image, px: int) -> str:
    buf = io.BytesIO()
    img.resize((px, px), Image.LANCZOS).save(buf, "PNG", optimize=True)
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def ico(img: Image.Image, path: str) -> None:
    img.resize((256, 256), Image.LANCZOS).save(path, sizes=SIZES)


GOLD = (226, 178, 60)
INDIGO = (99, 102, 241)
EMERALD = (16, 185, 129)

if __name__ == "__main__":
    st = monogram("t", EMERALD)
    assets = os.path.join(ROOT, "assets")
    os.makedirs(assets, exist_ok=True)
    st.save(os.path.join(assets, "strata-tune-st.png"))
    ico(st, os.path.join(assets, "strata-tune-st.ico"))
    # Contact sheet with the rest of the family so the new mark can be judged beside them.
    family = [monogram("c", INDIGO), monogram("p", GOLD), monogram("s", GOLD), st]
    sheet = Image.new("RGBA", (4 * 300 + 40, 380), (15, 15, 16, 255))
    for i, im in enumerate(family):
        big = im.resize((256, 256), Image.LANCZOS)
        sheet.paste(big, (20 + i * 300 + 2, 22), big)
        tiny = im.resize((32, 32), Image.LANCZOS)
        sheet.paste(tiny, (20 + i * 300 + 2, 300), tiny)
        mid = im.resize((64, 64), Image.LANCZOS)
        sheet.paste(mid, (20 + i * 300 + 60, 290), mid)
    sheet.save(os.path.join(assets, "monogram-family-sheet.png"))
    logo_ts = os.path.join(ROOT, "src", "assets", "logo.ts")
    os.makedirs(os.path.dirname(logo_ts), exist_ok=True)
    with open(logo_ts, "w", encoding="utf-8") as f:
        f.write("// Generated by scripts/monograms.py - the St monogram as a 256 px PNG data URL.\n")
        f.write("export const LOGO_DATA_URL = '" + data_url(st, 256) + "'\n")
        f.write("export const ACCENT = '#10b981'\n")
    print("wrote", assets, "and", logo_ts)
