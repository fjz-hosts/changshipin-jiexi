"""生成长视频解析的应用图标（build/icon.ico + brand-assets/icon.png）。

设计：深色圆角方块 + 霓虹绿/青渐变播放键，可在 16px 托盘尺寸下辨认。
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
SIZE = 1024
RADIUS = int(SIZE * 0.225)


def rounded_mask(size: int, radius: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    return mask


def gradient_background() -> Image.Image:
    """深蓝黑底 + 左上绿光 + 右下青光。"""
    y, x = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32) / SIZE
    # 对角线性渐变
    base = np.zeros((SIZE, SIZE, 3), dtype=np.float32)
    for channel, (top, bottom) in enumerate(zip((16, 30, 48), (4, 8, 15))):
        base[..., channel] = (top * (1 - y * 0.9) + bottom * (y * 0.9)) / 255.0

    def glow(cx: float, cy: float, radius: float, color: tuple[float, float, float], strength: float) -> np.ndarray:
        dist = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / radius
        falloff = np.clip(1.0 - dist, 0.0, 1.0) ** 2.2
        tint = np.zeros_like(base)
        for channel, value in enumerate(color):
            tint[..., channel] = value
        return tint * (falloff * strength)[..., None]

    # 绿光在左上、蓝光在右下，叠成霓虹感
    base += glow(0.22, 0.16, 0.85, (0.16, 1.0, 0.52), 0.32)
    base += glow(0.84, 0.88, 0.8, (0.16, 0.68, 1.0), 0.28)
    base += glow(0.5, 0.5, 0.72, (0.10, 0.55, 0.95), 0.10)

    rgb = np.clip(base, 0, 1) * 255
    return Image.fromarray(rgb.astype(np.uint8), "RGB").convert("RGBA")


def play_triangle(size: int) -> Image.Image:
    """霓虹渐变播放三角形（带一点圆角）。"""
    scale = 4
    big = size * scale
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)
    # 指向右侧的三角形，视觉重心略向右
    cx, cy = big * 0.52, big * 0.5
    r = big * 0.28
    points = []
    for angle in (0, 120, 240):
        rad = math.radians(angle)
        points.append((cx + r * math.cos(rad), cy + r * math.sin(rad)))
    draw.polygon(points, fill=(255, 255, 255, 255))

    layer = layer.resize((size, size), Image.LANCZOS)
    # 用绿→青的横向渐变给三角形上色
    gradient = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(gradient)
    for px in range(size):
        t = px / max(1, size - 1)
        r = int(70 + (30 - 70) * t)
        g = int(240 + (196 - 240) * t)
        b = int(156 + (255 - 156) * t)
        gdraw.line([(px, 0), (px, size)], fill=(r, g, b, 255))
    gradient.putalpha(layer.getchannel("A"))
    return gradient


def main() -> None:
    bg = gradient_background()

    # 屏幕内框：细描边，营造"播放器"感
    frame = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    fdraw = ImageDraw.Draw(frame)
    inset = int(SIZE * 0.135)
    fdraw.rounded_rectangle(
        (inset, inset, SIZE - inset, SIZE - inset),
        radius=int(SIZE * 0.145),
        outline=(174, 255, 219, 44),
        width=int(SIZE * 0.018),
    )

    # 播放键阴影
    glow_layer = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    gdraw = ImageDraw.Draw(glow_layer)
    gdraw.ellipse(
        (int(SIZE * 0.24), int(SIZE * 0.2), int(SIZE * 0.8), int(SIZE * 0.8)),
        fill=(55, 224, 139, 70),
    )
    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(int(SIZE * 0.09)))

    triangle = play_triangle(int(SIZE * 0.52))
    tri_offset = ((SIZE - triangle.width) // 2, (SIZE - triangle.height) // 2)
    triangle = triangle.filter(ImageFilter.GaussianBlur(0.6))

    icon = Image.alpha_composite(bg, frame)
    icon = Image.alpha_composite(icon, glow_layer)
    icon.alpha_composite(triangle, dest=tri_offset)

    # 底部一条霓虹装饰线
    line = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    ldraw = ImageDraw.Draw(line)
    ldraw.rounded_rectangle(
        (int(SIZE * 0.34), int(SIZE * 0.815), int(SIZE * 0.66), int(SIZE * 0.838)),
        radius=int(SIZE * 0.012),
        fill=(55, 224, 139, 160),
    )
    icon = Image.alpha_composite(icon, line)

    # 圆角裁切
    icon.putalpha(rounded_mask(SIZE, RADIUS))

    BUILD.mkdir(parents=True, exist_ok=True)
    ASSETS.mkdir(parents=True, exist_ok=True)

    icon.resize((512, 512), Image.LANCZOS).save(ASSETS / "icon.png")
    icon.resize((256, 256), Image.LANCZOS).save(
        BUILD / "icon.ico",
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print("icon written:", BUILD / "icon.ico", (BUILD / "icon.ico").stat().st_size, "bytes")


if __name__ == "__main__":
    main()
