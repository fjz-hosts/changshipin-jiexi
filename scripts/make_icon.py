"""生成长视频解析的应用图标（build/icon.ico + brand-assets/icon.png）。

设计：深色圆角方块 + 四段平台色光环（绿/蓝/橙/紫）+ 中央播放键。
四段环分别呼应爱奇艺、腾讯视频、优酷、芒果TV。
用法：python scripts/make_icon.py
"""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "desktop" / "electron" / "build"
ASSETS = ROOT / "brand-assets"
RENDERER_ASSETS = ROOT / "desktop" / "electron" / "src" / "renderer" / "assets"
SIZE = 1024
SS = 2  # 超采样
S = SIZE * SS
RADIUS = int(S * 0.225)

COLORS = {
    "green": (0x35, 0xE0, 0x8B),
    "blue": (0x2B, 0x8C, 0xFF),
    "orange": (0xFF, 0x9A, 0x3D),
    "purple": (0xA0, 0x6B, 0xFF),
}


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def background() -> Image.Image:
    y, x = np.mgrid[0:S, 0:S].astype(np.float32) / S
    base = np.zeros((S, S, 3), dtype=np.float32)
    for channel, (top, bottom) in enumerate(zip((14, 26, 44), (3, 6, 11))):
        base[..., channel] = (top * (1 - y * 0.85) + bottom * (y * 0.85)) / 255.0

    def glow(cx, cy, radius, color, strength):
        dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / radius
        falloff = np.clip(1 - dist, 0, 1) ** 2.4
        tint = np.zeros_like(base)
        for i, value in enumerate(color):
            tint[..., i] = value / 255.0
        return tint * (falloff * strength)[..., None]

    base += glow(0.18, 0.14, 0.75, COLORS["green"], 0.22)
    base += glow(0.84, 0.16, 0.72, COLORS["blue"], 0.20)
    base += glow(0.9, 0.88, 0.72, COLORS["orange"], 0.20)
    base += glow(0.12, 0.9, 0.72, COLORS["purple"], 0.18)
    return Image.fromarray((np.clip(base, 0, 1) * 255).astype(np.uint8), "RGB").convert("RGBA")


def ring_layer() -> Image.Image:
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    cx = cy = S / 2
    r = S * 0.31
    width = int(S * 0.052)
    gap = 9  # 角度间隙
    segments = [
        (-45, 45, COLORS["green"]),
        (45, 135, COLORS["blue"]),
        (135, 225, COLORS["orange"]),
        (225, 315, COLORS["purple"]),
    ]
    for start, end, color in segments:
        a0 = start + gap
        a1 = end - gap
        draw.arc((cx - r, cy - r, cx + r, cy + r), a0, a1, fill=color + (255,), width=width)
        # 圆角端点
        for angle in (a0, a1):
            rad = math.radians(angle)
            px = cx + r * math.cos(rad)
            py = cy + r * math.sin(rad)
            draw.ellipse((px - width / 2, py - width / 2, px + width / 2, py + width / 2), fill=color + (255,))
    return layer


def play_layer() -> Image.Image:
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    cx, cy = S * 0.515, S * 0.5
    r = S * 0.155
    pts = []
    for angle in (0, 120, 240):
        rad = math.radians(angle)
        pts.append((cx + r * math.cos(rad), cy + r * math.sin(rad)))
    draw.polygon(pts, fill=(255, 255, 255, 255))
    layer = layer.filter(ImageFilter.GaussianBlur(S * 0.002))
    # 给播放键加一点从白到浅青的渐变
    grad = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    for px in range(0, S, 2):
        t = px / S
        color = (
            int(255 - 10 * t),
            int(255 - 4 * t),
            int(255),
            255,
        )
        gd.rectangle((px, 0, px + 2, S), fill=color)
    grad.putalpha(layer.getchannel("A"))
    return grad


def main() -> None:
    bg = background()
    ring = ring_layer()
    # 光环的柔光
    halo = ring.filter(ImageFilter.GaussianBlur(S * 0.028))
    halo.putalpha(halo.getchannel("A").point(lambda v: int(v * 0.55)))

    # 内圈：让播放键更聚焦
    inner = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ImageDraw.Draw(inner).ellipse(
        (S * 0.235, S * 0.235, S * 0.765, S * 0.765),
        fill=(6, 12, 20, 60),
        outline=(255, 255, 255, 18),
        width=int(S * 0.004),
    )

    icon = Image.alpha_composite(bg, halo)
    icon = Image.alpha_composite(icon, inner)
    icon = Image.alpha_composite(icon, ring)
    icon.alpha_composite(play_layer())

    # 轻微高光：左上角一道弧形反光
    sheen = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    sd = ImageDraw.Draw(sheen)
    sd.arc((S * 0.07, S * 0.05, S * 0.93, S * 0.55), 200, 320, fill=(255, 255, 255, 26), width=int(S * 0.012))
    sheen = sheen.filter(ImageFilter.GaussianBlur(S * 0.012))
    icon = Image.alpha_composite(icon, sheen)

    icon.putalpha(rounded_mask(S, RADIUS))
    icon = icon.resize((SIZE, SIZE), Image.LANCZOS)

    BUILD.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)
    RENDERER_ASSETS.mkdir(parents=True, exist_ok=True)

    icon.resize((512, 512), Image.LANCZOS).save(ASSETS / "icon.png")
    icon.resize((128, 128), Image.LANCZOS).save(RENDERER_ASSETS / "app-icon.png")
    icon.resize((256, 256), Image.LANCZOS).save(
        BUILD / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("icon written:", BUILD / "icon.ico", (BUILD / "icon.ico").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
