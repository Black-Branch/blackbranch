#!/usr/bin/env python3
"""The Terminal app's icon: a `>_` prompt on the site's dark blue. Writes public/terminal-icon-{192,512,maskable-512,apple}.png.

    python3 scripts/terminal-icon.py

Pillow and a JetBrains Mono bold face (any monospace bold works; the glyphs are drawn, not typed,
when no font is found)."""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent / "public"
BG = (12, 16, 32, 255)          # the site's theme colour, #0c1020
GREEN = (158, 206, 106, 255)    # the prompt's `>`
WHITE = (236, 239, 244, 255)    # the cursor's `_`
FONTS = [
    "/usr/share/fonts/TTF/JetBrainsMonoNerdFontMono-Bold.ttf",
    "/usr/share/fonts/TTF/JetBrainsMono-Bold.ttf",
    "/usr/share/fonts/TTF/DejaVuSansMono-Bold.ttf",
]


def font(px: int) -> ImageFont.FreeTypeFont | None:
    for f in FONTS:
        if Path(f).exists():
            return ImageFont.truetype(f, px)
    return None


def tile(size: int, *, bleed: bool, radius_frac: float = 0.22) -> Image.Image:
    """`bleed`: the maskable icon fills the whole square (the platform cuts its own shape);
    otherwise a rounded square with transparent corners, like the site's own icon."""
    im = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if bleed:
        d.rectangle((0, 0, size, size), fill=BG)
        inset = 0.1 * size   # the safe zone is the middle 80 %
    else:
        d.rounded_rectangle((0, 0, size - 1, size - 1), radius=int(size * radius_frac), fill=BG)
        inset = 0.04 * size
    box = size - 2 * inset
    f = font(int(box * 0.62))
    if f:
        # `>` and `_` as two runs, the prompt a touch above the baseline so the underscore reads as a cursor.
        gt = d.textbbox((0, 0), ">", font=f)
        us = d.textbbox((0, 0), "_", font=f)
        gap = int(box * 0.04)
        w = (gt[2] - gt[0]) + gap + (us[2] - us[0])
        x = inset + (box - w) / 2
        y = inset + (box - (gt[3] - gt[1])) / 2 - gt[1]
        d.text((x - gt[0], y), ">", font=f, fill=GREEN)
        d.text((x - gt[0] + (gt[2] - gt[0]) + gap - us[0], y), "_", font=f, fill=WHITE)
    else:
        # No font: the same two marks as strokes.
        t = max(2, int(box * 0.11))
        cx, cy = size / 2, size / 2
        a = box * 0.22
        d.line([(cx - a, cy - a), (cx - a * 0.2, cy), (cx - a, cy + a)], fill=GREEN, width=t, joint="curve")
        d.rectangle((cx + a * 0.05, cy + a * 0.75, cx + a * 0.95, cy + a * 0.75 + t), fill=WHITE)
    return im


def main() -> None:
    big = tile(1024, bleed=False)
    big.resize((512, 512), Image.LANCZOS).save(ROOT / "terminal-icon-512.png")
    big.resize((192, 192), Image.LANCZOS).save(ROOT / "terminal-icon-192.png")
    tile(1024, bleed=True).resize((512, 512), Image.LANCZOS).save(ROOT / "terminal-icon-maskable-512.png")
    # Apple ignores transparency and rounds the corners itself: give it the full tile.
    tile(1024, bleed=True).resize((180, 180), Image.LANCZOS).save(ROOT / "terminal-icon-apple.png")


if __name__ == "__main__":
    main()
