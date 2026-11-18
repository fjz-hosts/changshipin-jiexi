"""生成图文教程里用到的演示画面（不依赖网络 / 版权素材）。

用法：python .tmp/guide/make_poster.py
输出：.tmp/guide/www/poster.mp4（90 秒，1280x720，无声音）
"""

import math
import os
import random
import subprocess

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
OUT_DIR = os.path.join(ROOT, '.tmp', 'guide', 'www')
FONT_BD = r'C:\Windows\Fonts\msyhbd.ttc'
FONT = r'C:\Windows\Fonts\msyh.ttc'
W, H = 1280, 720


def gradient():
    img = Image.new('RGB', (W, H), (8, 18, 26))
    px = img.load()
    for y in range(H):
        for x in range(W):
            t = y / H
            r = int(7 + 10 * t)
            g = int(18 + 20 * t)
            b = int(27 + 28 * t)
            px[x, y] = (r, g, b)
    return img


def glow(img, cx, cy, radius, color, alpha=120):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    steps = 26
    for i in range(steps, 0, -1):
        rr = radius * i / steps
        a = int(alpha * (1 - i / steps) ** 1.6)
        d.ellipse((cx - rr, cy - rr, cx + rr, cy + rr), fill=color + (a,))
    layer = layer.filter(ImageFilter.GaussianBlur(18))
    return Image.alpha_composite(img.convert('RGBA'), layer)


def rain(img):
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    random.seed(7)
    for _ in range(140):
        x = random.randint(-100, W)
        y = random.randint(-40, H)
        length = random.randint(18, 60)
        a = random.randint(10, 38)
        d.line((x, y, x - length * 0.28, y + length), fill=(200, 230, 255, a), width=1)
    return Image.alpha_composite(img.convert('RGBA'), layer)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    img = gradient()
    img = glow(img, 980, 210, 330, (60, 180, 255), 95)
    img = glow(img, 260, 560, 400, (255, 150, 90), 60)
    img = glow(img, 640, 330, 260, (120, 220, 190), 45)
    img = rain(img).convert('RGB')

    d = ImageDraw.Draw(img, 'RGBA')
    # 底部渐暗，给标题留出对比
    for y in range(H - 260, H):
        a = int(210 * ((y - (H - 260)) / 260) ** 1.2)
        d.rectangle((0, y, W, y + 1), fill=(3, 8, 12, a))

    title_font = ImageFont.truetype(FONT_BD, 104)
    sub_font = ImageFont.truetype(FONT, 34)
    tag_font = ImageFont.truetype(FONT, 22)
    small_font = ImageFont.truetype(FONT, 18)

    title = '今天是太阳雨'
    x, y = 92, H - 250
    for dx, dy in ((0, 4), (0, 8)):
        d.text((x + dx, y + dy), title, font=title_font, fill=(0, 0, 0, 90))
    d.text((x, y), title, font=title_font, fill=(240, 248, 255))

    # 集数胶囊
    pill_x, pill_y = x + 4, y + 132
    label = '第 5 集'
    tw = d.textlength(label, font=sub_font)
    d.rounded_rectangle((pill_x, pill_y, pill_x + tw + 44, pill_y + 54), radius=27, fill=(38, 196, 128, 235))
    d.text((pill_x + 22, pill_y + 8), label, font=sub_font, fill=(4, 24, 14))

    d.text((x + tw + 70, pill_y + 15), '演示画面 · 非真实剧集', font=tag_font, fill=(255, 255, 255, 150))

    # 右上角小标
    d.text((W - 260, 42), '长视频解析 · 使用教程', font=small_font, fill=(255, 255, 255, 120))

    # 左侧细竖线装饰
    d.rectangle((64, H - 252, 68, H - 116), fill=(55, 224, 139, 220))

    poster = os.path.join(OUT_DIR, 'poster.png')
    img.save(poster)
    mp4 = os.path.join(OUT_DIR, 'poster.mp4')
    cmd = [
        'ffmpeg', '-y', '-loop', '1', '-i', poster, '-t', '90', '-r', '25',
        '-vf', 'scale=1280:720:flags=lanczos', '-c:v', 'libx264', '-preset', 'medium',
        '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('poster', poster, os.path.getsize(poster))
    print('video', mp4, os.path.getsize(mp4))


if __name__ == '__main__':
    main()
