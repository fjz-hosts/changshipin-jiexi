"""给图文教程截图加红框 / 聚光灯，输出 webp。

用法：python .tmp/guide/annotate.py
输入：.tmp/guide/raw/*.png + .tmp/guide/shots.json
输出：desktop/electron/src/renderer/assets/guide/*.webp
预览：.tmp/guide/out/*.png
"""

import json
import os

from PIL import Image, ImageDraw, ImageFilter, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
GUIDE_DIR = os.path.join(ROOT, '.tmp', 'guide')
RAW = os.path.join(GUIDE_DIR, 'raw')
OUT = os.path.join(GUIDE_DIR, 'out')
ASSETS = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'assets', 'guide')
FONT_BD = r'C:\Windows\Fonts\msyhbd.ttc'
FONT = r'C:\Windows\Fonts\msyh.ttc'
RED = (255, 64, 64)

SHOT_NAMES = {
    'main': 'guide-01-main',
    'paste': 'guide-02-paste',
    'browser': 'guide-03-browser',
    'episodes': 'guide-04-episodes',
    'history': 'guide-05-history',
    'lines': 'guide-06-lines',
    'download': 'guide-07-download',
    'fullscreen': 'guide-08-fullscreen',
    'settings': 'guide-09-settings',
}

TARGET_WIDTH = {
    'main': 1600,
    'paste': 1600,
    'browser': 1600,
    'episodes': 1600,
    'history': 1500,
    'lines': 1500,
    'download': 1600,
    'fullscreen': 1600,
    'settings': 1500,
}


def to_px(value, dsc):
    return int(round(value * dsc))


def annotate(shot_key, raw_path, meta, dsc=2):
    img = Image.open(raw_path).convert('RGBA')
    crop = meta.get('crop')
    origin = (0, 0)
    if crop:
        x, y, w, h = to_px(crop['x'], dsc), to_px(crop['y'], dsc), to_px(crop['w'], dsc), to_px(crop['h'], dsc)
        img = img.crop((x, y, x + w, y + h))
        origin = (x, y)

    width, height = img.size
    boxes = []
    for item in meta.get('boxes', []):
        r = item['rect']
        x0 = to_px(r['x'], dsc) - origin[0]
        y0 = to_px(r['y'], dsc) - origin[1]
        x1 = to_px(r['x'] + r['w'], dsc) - origin[0]
        y1 = to_px(r['y'] + r['h'], dsc) - origin[1]
        # 允许超出裁剪切一点点，但完全在外的框跳过
        if x1 < 0 or y1 < 0 or x0 > width or y0 > height:
            continue
        boxes.append({
            'x0': max(0, x0),
            'y0': max(0, y0),
            'x1': min(width - 1, x1),
            'y1': min(height - 1, y1),
            'label': item['label'],
            'badge': item.get('badge', 'auto'),
        })

    if boxes:
        # 聚光灯：框外压暗（label=0 的框只用来保留亮度，不画红框）
        pad = to_px(10, dsc)
        radius = to_px(12, dsc)
        mask = Image.new('L', img.size, 255)
        md = ImageDraw.Draw(mask)
        for b in boxes:
            md.rounded_rectangle(
                (b['x0'] - pad, b['y0'] - pad, b['x1'] + pad, b['y1'] + pad),
                radius=radius,
                fill=0,
            )
        mask = mask.filter(ImageFilter.GaussianBlur(to_px(7, dsc)))
        dim = float(meta.get('dim', 0.5))
        dark = Image.blend(img.convert('RGB'), Image.new('RGB', img.size, (2, 6, 12)), dim)
        img = Image.composite(dark, img.convert('RGB'), mask).convert('RGBA')

        marked = [b for b in boxes if b['label']]
        if marked:
            # 外发光 + 红色描边
            glow = Image.new('RGBA', img.size, (0, 0, 0, 0))
            gd = ImageDraw.Draw(glow)
            for b in marked:
                gd.rounded_rectangle(
                    (b['x0'] - pad, b['y0'] - pad, b['x1'] + pad, b['y1'] + pad),
                    radius=radius,
                    outline=(255, 70, 70, 170),
                    width=max(2, to_px(7, dsc)),
                )
            glow = glow.filter(ImageFilter.GaussianBlur(to_px(5, dsc)))
            img = Image.alpha_composite(img, glow)

            draw = ImageDraw.Draw(img)
            for b in marked:
                draw.rounded_rectangle(
                    (b['x0'] - pad, b['y0'] - pad, b['x1'] + pad, b['y1'] + pad),
                    radius=radius,
                    outline=RED,
                    width=max(3, to_px(3, dsc)),
                )

            # 徽标：默认在框外左侧，靠近边缘时放进框内；相邻徽标自动错开
            r = to_px(15, dsc)
            margin = to_px(4, dsc)
            placed = []
            for b in marked:
                side = b['badge']
                if side == 'right':
                    cx, cy = b['x1'] - r - margin, b['y0'] + r + margin
                elif side == 'inside':
                    cx, cy = b['x0'] + r + margin, b['y0'] + r + margin
                elif side == 'top':
                    cx, cy = b['x0'] + r + margin, b['y0'] - r - margin
                else:
                    if b['x0'] > r + margin:
                        cx, cy = b['x0'] - r - margin, b['y0'] + r + margin
                    else:
                        cx, cy = b['x0'] + r + margin, b['y0'] + r + margin
                cx = max(r + margin, min(width - r - margin, cx))
                cy = max(r + margin, min(height - r - margin, cy))
                for _ in range(6):
                    if all((cx - px) ** 2 + (cy - py) ** 2 > (r * 2 + margin) ** 2 for px, py, _ in placed):
                        break
                    cy += r * 2 + margin
                    if cy > height - r - margin:
                        cy = b['y0'] + r + margin
                        cx = min(width - r - margin, cx + r * 2 + margin)
                placed.append((cx, cy, b['label']))
                draw.ellipse((cx - r - to_px(2, dsc), cy - r - to_px(2, dsc), cx + r + to_px(2, dsc), cy + r + to_px(2, dsc)), fill=(255, 255, 255, 245))
                draw.ellipse((cx - r, cy - r, cx + r, cy + r), fill=(226, 40, 34))
                font = ImageFont.truetype(FONT_BD, to_px(19, dsc))
                draw.text((cx, cy + to_px(1, dsc)), str(b['label']), font=font, fill=(255, 255, 255), anchor='mm')

    if meta.get('legend'):
        img = draw_legend(img, dsc)

    target = TARGET_WIDTH.get(shot_key, 1600)
    if img.width > target:
        ratio = target / img.width
        img = img.resize((target, int(round(img.height * ratio))), Image.LANCZOS)
    elif img.width < 900:
        ratio = 900 / img.width
        img = img.resize((900, int(round(img.height * ratio))), Image.LANCZOS)
    return img.convert('RGB')


def draw_legend(img, dsc):
    rows = [
        ('空格', '暂停 / 播放'),
        ('← →', '快退 / 快进 10 秒'),
        ('↑ ↓', '音量'),
        ('M', '静音'),
        ('Esc', '退出全屏'),
    ]
    font = ImageFont.truetype(FONT, to_px(17, dsc))
    key_font = ImageFont.truetype(FONT_BD, to_px(16, dsc))
    title_font = ImageFont.truetype(FONT_BD, to_px(18, dsc))
    pad = to_px(18, dsc)
    row_h = to_px(38, dsc)
    key_h = to_px(28, dsc)
    margin = to_px(34, dsc)

    widths = []
    for key, text in rows:
        kw = int(font.getlength(key)) + to_px(26, dsc)
        tw = int(font.getlength(text))
        widths.append(kw + to_px(16, dsc) + tw)
    panel_w = max(widths) + pad * 2
    panel_h = pad * 2 + to_px(34, dsc) + row_h * len(rows)
    x, y = margin, margin + to_px(46, dsc)

    panel = Image.new('RGBA', img.size, (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    pd.rounded_rectangle((x, y, x + panel_w, y + panel_h), radius=to_px(14, dsc), fill=(6, 12, 20, 224), outline=(255, 255, 255, 38), width=max(1, to_px(1, dsc)))
    img = Image.alpha_composite(img, panel)

    draw = ImageDraw.Draw(img)
    draw.text((x + pad, y + pad - to_px(2, dsc)), '键盘快捷键', font=title_font, fill=(255, 255, 255))
    top = y + pad + to_px(30, dsc)
    for index, (key, text) in enumerate(rows):
        row_y = top + index * row_h
        kw = int(font.getlength(key)) + to_px(26, dsc)
        draw.rounded_rectangle(
            (x + pad, row_y, x + pad + kw, row_y + key_h),
            radius=to_px(6, dsc),
            fill=(30, 42, 58, 255),
            outline=(130, 150, 172, 220),
            width=max(1, to_px(1, dsc)),
        )
        draw.text((x + pad + kw / 2, row_y + key_h / 2 + to_px(1, dsc)), key, font=key_font, fill=(240, 246, 255), anchor='mm')
        draw.text((x + pad + kw + to_px(14, dsc), row_y + key_h / 2), text, font=font, fill=(220, 228, 240), anchor='lm')
    return img


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(ASSETS, exist_ok=True)
    with open(os.path.join(GUIDE_DIR, 'shots.json'), encoding='utf-8') as f:
        data = json.load(f)
    for key, meta in data['shots'].items():
        raw_path = os.path.join(RAW, meta['raw'])
        if not os.path.exists(raw_path):
            print('missing', raw_path)
            continue
        img = annotate(key, raw_path, meta)
        name = SHOT_NAMES.get(key, f'guide-{key}')
        preview = os.path.join(OUT, f'{name}.png')
        img.save(preview)
        webp = os.path.join(ASSETS, f'{name}.webp')
        img.save(webp, 'WEBP', quality=88, method=6)
        print(name, img.size, os.path.getsize(webp), 'bytes')


if __name__ == '__main__':
    main()
