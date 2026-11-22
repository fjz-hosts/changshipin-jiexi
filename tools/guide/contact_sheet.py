"""把 assets/guide 下的 webp 拼成一张联络表，方便一次性检查所有教程截图。"""
import os
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ASSETS = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'assets', 'guide')
OUT = os.path.join(ROOT, '.tmp', 'guide', 'sheet.png')
COLS = 4
CELL = 460
FONT = r'C:\Windows\Fonts\msyh.ttc'


def main():
    names = sorted(n for n in os.listdir(ASSETS) if n.startswith('guide-') and n.endswith('.webp'))
    if len(sys.argv) > 1:
        want = sys.argv[1:]
        names = [n for n in names if any(w in n for w in want)]
    thumbs = []
    for name in names:
        img = Image.open(os.path.join(ASSETS, name)).convert('RGB')
        ratio = min(CELL / img.width, CELL / img.height)
        thumbs.append((name, img.resize((max(1, int(img.width * ratio)), max(1, int(img.height * ratio))), Image.LANCZOS)))
    rows = (len(thumbs) + COLS - 1) // COLS
    sheet = Image.new('RGB', (COLS * CELL, rows * (CELL + 26)), (18, 22, 28))
    draw = ImageDraw.Draw(sheet)
    font = ImageFont.truetype(FONT, 14)
    for index, (name, img) in enumerate(thumbs):
        col, row = index % COLS, index // COLS
        x = col * CELL + (CELL - img.width) // 2
        y = row * (CELL + 26) + CELL - img.height
        sheet.paste(img, (x, y))
        draw.text((col * CELL + 6, row * (CELL + 26) + CELL + 4), name, font=font, fill=(210, 230, 220))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    sheet.save(OUT)
    print('sheet', OUT, sheet.size, len(thumbs), 'images')


if __name__ == '__main__':
    main()
