#!/usr/bin/env python3
"""Generate Memmy DMG installer backgrounds (1x + @2x for Retina)."""

from __future__ import annotations

import urllib.request
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# Logical installer layout (points) — icon positions in electron-builder dmg.contents
# use this coordinate space. Background image is larger so resized Finder windows
# still show gradient instead of white, but all UI elements stay in W×H.
W, H = 540, 380
BG_W, BG_H = 2000, 1400
BUILD_DIR = Path(__file__).resolve().parents[2] / "App/shell/desktop/build"
NUNITO_FONT = BUILD_DIR / "fonts" / "Nunito-Variable.ttf"
NUNITO_FONT_URL = (
    "https://raw.githubusercontent.com/google/fonts/main/ofl/nunito/Nunito%5Bwght%5D.ttf"
)

# Render text/arrow at higher resolution, then downscale for crisp edges on Retina.
SUPERSAMPLE = 4
# Welcome brand subtitle: margin-top = space-2 * 1.2 (styles.css .welcome-brand-subtitle).
TITLE_SUBTITLE_GAP = 9.6
TITLE_SIZE = 22
SUBTITLE_SIZE = 12  # text-base(16px) scaled to dmg title(22pt): 16/30*22 ≈ 12

# Memmy brand palette (DESIGN.md / tokens.css)
CANVAS = (241, 248, 247)       # #f1f8f7
TEXT_INK = (17, 29, 28)        # #111d1c — tokens --color-text-ink
MINT = (200, 240, 224)         # #c8f0e0
LAVENDER = (224, 223, 252)     # #e0dffc
PEACH = (255, 226, 201)        # #ffe2c9
ACTION = (92, 191, 174)        # #5cbfae — brand teal
ACTION_DEEP = (58, 168, 147)   # #3aa893
ORANGE = (245, 158, 107)       # #f59e6b — Memmy app icon
FOLDER_BLUE = (124, 194, 234)   # #7CC2EA — macOS Applications folder blue
TITLE = (32, 37, 34)           # #202522

# Welcome login subtitle: text-text-ink/50 composited on canvas.
LOGIN_SUBTITLE_GRAY = (
    int((CANVAS[0] + TEXT_INK[0]) / 2),
    int((CANVAS[1] + TEXT_INK[1]) / 2),
    int((CANVAS[2] + TEXT_INK[2]) / 2),
)

# Arrow span (logical points): shorter shaft, more breathing room from icons.
ARROW_X1 = 224
ARROW_X2 = 316


def lerp(a: float, b: float, t: float) -> float:
    return a + (b - a) * t


def lerp_color(c1: tuple[int, int, int], c2: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return (
        int(lerp(c1[0], c2[0], t)),
        int(lerp(c1[1], c2[1], t)),
        int(lerp(c1[2], c2[2], t)),
    )


def scale(value: float, factor: int) -> float:
    return value * factor


def ensure_nunito_font() -> None:
    if NUNITO_FONT.exists():
        return
    NUNITO_FONT.parent.mkdir(parents=True, exist_ok=True)
    print(f"Downloading Nunito → {NUNITO_FONT}")
    urllib.request.urlretrieve(NUNITO_FONT_URL, NUNITO_FONT)


def load_nunito(size: int, weight: int = 400) -> ImageFont.FreeTypeFont:
    ensure_nunito_font()
    font = ImageFont.truetype(str(NUNITO_FONT), size)
    font.set_variation_by_axes([weight])
    return font


def load_subtitle_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    """PingFang SC Regular — matches welcome page CJK fallback in --font-sans."""
    candidates: list[tuple[str, int]] = [
        ("/Library/Fonts/PingFang-SC-Regular.ttf", 0),
        ("/Library/Fonts/PingFang SC Regular.ttf", 0),
        ("/System/Library/Fonts/PingFang.ttc", 0),
        ("/System/Library/Fonts/Hiragino Sans GB.ttc", 2),
        ("/System/Library/Fonts/STHeiti Light.ttc", 0),
    ]
    for path, index in candidates:
        if not Path(path).exists():
            continue
        try:
            kwargs = {"index": index} if path.endswith(".ttc") else {}
            return ImageFont.truetype(path, size, **kwargs)
        except OSError:
            continue
    return ImageFont.load_default()


def make_gradient(width: int, height: int) -> Image.Image:
    img = Image.new("RGB", (width, height))
    px = img.load()
    for y in range(height):
        ty = y / (height - 1)
        for x in range(width):
            tx = x / (width - 1)
            top = lerp_color(CANVAS, MINT, (1 - ty) * 0.55 + tx * 0.25)
            bottom = lerp_color(LAVENDER, PEACH, tx * 0.4 + ty * 0.35)
            blend = ty * 0.42 + (1 - tx) * 0.28
            px[x, y] = lerp_color(top, bottom, min(1.0, blend))
    return img


def arrow_color(t: float) -> tuple[int, int, int]:
    """Orange (app) → teal (brand) → blue (Applications folder)."""
    if t < 0.5:
        return lerp_color(ORANGE, ACTION, t / 0.5)
    return lerp_color(ACTION, FOLDER_BLUE, (t - 0.5) / 0.5)


def draw_arrow(draw: ImageDraw.ImageDraw, factor: int) -> None:
    # Icon centers at (130, 200) and (410, 200) — y from bottom in Finder.
    y = scale(200, factor)
    x1, x2 = scale(ARROW_X1, factor), scale(ARROW_X2, factor)
    shaft_h = scale(6, factor)
    head_half = scale(11, factor)
    top_shaft = y - shaft_h / 2
    bottom_shaft = y + shaft_h / 2

# Left tail: segmented bars fading into orange.
    tail_count = 4
    bar_w = scale(2.5, factor)
    gap = scale(3, factor)
    tail_right = x1 - scale(3, factor)
    tail_left = tail_right - tail_count * bar_w - (tail_count - 1) * gap
    for i in range(tail_count):
        bx = tail_left + i * (bar_w + gap)
        fade = (i + 1) / (tail_count + 0.35)
        color = lerp_color(lerp_color(CANVAS, ORANGE, 0.2), ORANGE, fade)
        draw.rectangle((bx, top_shaft, bx + bar_w, bottom_shaft), fill=color)

    # Main shaft: orange → teal → blue.
    steps = 120
    for i in range(steps):
        t0 = i / steps
        t1 = (i + 1) / steps
        tm = (t0 + t1) / 2
        color = arrow_color(tm)
        seg_x1 = lerp(x1, x2, t0)
        seg_x2 = lerp(x1, x2, t1)
        draw.rectangle((seg_x1, top_shaft, seg_x2, bottom_shaft), fill=color)

    # Block arrowhead (wider than shaft, reference style).
    tip_x = x2 + scale(10, factor)
    draw.polygon(
        [
            (tip_x, y),
            (x2 - scale(1, factor), y - head_half),
            (x2 - scale(1, factor), y + head_half),
        ],
        fill=FOLDER_BLUE,
    )


def draw_text(img: Image.Image, factor: int) -> None:
    draw = ImageDraw.Draw(img)
    # Center within the logical W×H layout region, not the full oversized canvas.
    content_width = scale(W, factor)
    title_size = scale(TITLE_SIZE, factor)
    subtitle_size = scale(SUBTITLE_SIZE, factor)
    title_bold = load_nunito(title_size, weight=700)
    title_light = load_nunito(title_size, weight=400)
    subtitle_font = load_subtitle_font(subtitle_size)

    title_main = "Memmy"
    title_suffix = " for Mac"
    subtitle = "拖动 Memmy 到文件夹，即可安装"

    main_w = draw.textlength(title_main, font=title_bold)
    total_w = main_w + draw.textlength(title_suffix, font=title_light)
    title_x = (content_width - total_w) / 2
    title_y = scale(48, factor)

    draw.text((title_x, title_y), title_main, font=title_bold, fill=ACTION_DEEP)
    suffix_x = title_x + main_w
    draw.text((suffix_x, title_y), title_suffix, font=title_light, fill=TITLE)

    main_bbox = draw.textbbox((title_x, title_y), title_main, font=title_bold)
    suffix_bbox = draw.textbbox((suffix_x, title_y), title_suffix, font=title_light)
    title_bottom = max(main_bbox[3], suffix_bbox[3])

    sub_w = draw.textlength(subtitle, font=subtitle_font)
    subtitle_y = title_bottom + scale(TITLE_SUBTITLE_GAP, factor)
    draw.text(
        ((content_width - sub_w) / 2, subtitle_y),
        subtitle,
        font=subtitle_font,
        fill=LOGIN_SUBTITLE_GRAY,
    )


def render_background(output_factor: int, canvas_w: int = W, canvas_h: int = H) -> Image.Image:
    render_factor = output_factor * SUPERSAMPLE

    if canvas_w > W or canvas_h > H:
        base = render_background(output_factor, W, H)
        grad_small = make_gradient(W, H)
        target = (canvas_w * output_factor, canvas_h * output_factor)
        large = grad_small.resize(target, Image.Resampling.LANCZOS)
        large.paste(base, (0, 0))
        return large

    width, height = canvas_w * render_factor, canvas_h * render_factor
    img = make_gradient(width, height)
    draw = ImageDraw.Draw(img)
    draw_arrow(draw, render_factor)
    draw_text(img, render_factor)
    target = (canvas_w * output_factor, canvas_h * output_factor)
    return img.resize(target, Image.Resampling.LANCZOS)


def main() -> None:
    BUILD_DIR.mkdir(parents=True, exist_ok=True)
    ensure_nunito_font()

    outputs: list[tuple[int, int, int, Path]] = [
        (1, W, H, BUILD_DIR / "dmg-background.png"),
        (2, W, H, BUILD_DIR / "dmg-background@2x.png"),
        (1, BG_W, BG_H, BUILD_DIR / "dmg-background-large.png"),
        (2, BG_W, BG_H, BUILD_DIR / "dmg-background-large@2x.png"),
    ]
    for factor, canvas_w, canvas_h, path in outputs:
        img = render_background(factor, canvas_w, canvas_h)
        img.save(path, "PNG", optimize=False)
        print(f"Wrote {path} ({img.width}x{img.height})")


if __name__ == "__main__":
    main()
