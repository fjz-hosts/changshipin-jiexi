#!/usr/bin/env python3
"""生成手机端图标与启动图：与桌面端同一张 brand-assets/icon.png。"""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICON = ROOT.parent / "brand-assets" / "icon.png"
BG = (5, 8, 14, 255)
ANDROID_RES = ROOT / "android" / "app" / "src" / "main" / "res"
IOS_ASSETS = ROOT / "ios" / "App" / "App" / "Assets.xcassets"
RESOURCES = ROOT / "resources"


def load_icon() -> Image.Image:
    image = Image.open(ICON).convert("RGBA")
    return image.resize((1024, 1024), Image.LANCZOS)


def flatten(icon: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), BG)
    canvas.alpha_composite(icon.resize((size, size), Image.LANCZOS))
    return canvas.convert("RGB")


def round_icon(icon: Image.Image, size: int) -> Image.Image:
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    layer.alpha_composite(icon.resize((size, size), Image.LANCZOS))
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    layer.putalpha(mask)
    return layer


def foreground(icon: Image.Image, size: int) -> Image.Image:
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    inner = int(size * 0.62)
    scaled = icon.resize((inner, inner), Image.LANCZOS)
    offset = (size - inner) // 2
    canvas.alpha_composite(scaled, (offset, offset))
    return canvas


def splash(icon: Image.Image, width: int, height: int) -> Image.Image:
    canvas = Image.new("RGB", (width, height), BG[:3])
    mark = icon.resize((int(min(width, height) * 0.30), int(min(width, height) * 0.30)), Image.LANCZOS)
    x = (width - mark.width) // 2
    y = (height - mark.height) // 2
    canvas.paste(mark, (x, y), mark)
    return canvas


def main() -> None:
    icon = load_icon()
    RESOURCES.mkdir(parents=True, exist_ok=True)
    icon.resize((1024, 1024), Image.LANCZOS).save(RESOURCES / "icon.png")

    # ---------- Android ----------
    legacy = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
    adaptive = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
    for density, size in legacy.items():
        folder = ANDROID_RES / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        icon.resize((size, size), Image.LANCZOS).save(folder / "ic_launcher.png")
        round_icon(icon, size).save(folder / "ic_launcher_round.png")
        foreground(icon, adaptive[density]).save(folder / "ic_launcher_foreground.png")

    values = ANDROID_RES / "values"
    values.mkdir(parents=True, exist_ok=True)
    (values / "ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n    <color name="ic_launcher_background">#05080E</color>\n</resources>\n',
        encoding="utf-8",
    )

    # 启动图：按 Capacitor 模板的密度目录覆盖
    sizes = {
        "mdpi": (320, 480),
        "hdpi": (480, 800),
        "xhdpi": (720, 1280),
        "xxhdpi": (1080, 1920),
        "xxxhdpi": (1440, 2560),
    }
    for density, (w, h) in sizes.items():
        (ANDROID_RES / f"drawable-port-{density}").mkdir(parents=True, exist_ok=True)
        (ANDROID_RES / f"drawable-land-{density}").mkdir(parents=True, exist_ok=True)
        splash(icon, w, h).save(ANDROID_RES / f"drawable-port-{density}" / "splash.png", optimize=True)
        splash(icon, h, w).save(ANDROID_RES / f"drawable-land-{density}" / "splash.png", optimize=True)
    splash(icon, 480, 800).save(ANDROID_RES / "drawable" / "splash.png", optimize=True)

    # ---------- iOS ----------
    appicon = IOS_ASSETS / "AppIcon.appiconset"
    appicon.mkdir(parents=True, exist_ok=True)
    flatten(icon, 1024).save(appicon / "AppIcon-512@2x.png", optimize=True)

    splashset = IOS_ASSETS / "Splash.imageset"
    if splashset.exists():
        for name in ("splash-2732x2732.png", "splash-2732x2732-1.png", "splash-2732x2732-2.png"):
            splash(icon, 2732, 2732).save(splashset / name, optimize=True)

    print("icons + splash written")


if __name__ == "__main__":
    main()
