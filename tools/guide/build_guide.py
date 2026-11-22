# -*- coding: utf-8 -*-
"""把 guide_content.py 渲染进 index.html 的「使用教程 · 图文版」弹窗。

用法：python tools/guide/build_guide.py
- 只替换 index.html 里 `#guide-modal` 弹窗（从 `<div class="modal-mask" id="guide-modal"` 到 toast-stack 之前）。
- 忘了先跑 capture_full.py / annotate.py 的话，这里会提示缺图。
"""

import html
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guide_content import SECTIONS  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
INDEX = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'index.html')
ASSETS = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'assets', 'guide')
START = '    <div class="modal-mask" id="guide-modal" hidden>'
END = '    <div class="toast-stack" id="toast-stack" aria-live="polite"></div>'
TITLE = '使用教程 · 图文版'
SUBTITLE = '从安装、粘贴链接到下载、投屏和音乐，一步一步来。图里的红框和编号就是重点。'


def strip_tags(text):
    return re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', '', text)).strip()


def nav_html():
    rows = []
    for section in SECTIONS:
        active = ' class="active"' if section is SECTIONS[0] else ''
        rows.append('<button data-guide="%s"%s>%s · %s</button>' % (
            section['id'], active, section['num'], html.escape(section.get('nav') or section['title'])))
    rows.append('<div class="guide-nav-foot">按 Esc 或点右上角关闭</div>')
    return '\n'.join('            ' + row for row in rows)


def section_html(section):
    out = ['            <section class="guide-section" id="guide-%s">' % section['id']]
    out.append('              <h3><span class="guide-step">%s</span>%s</h3>' % (
        section['num'], html.escape(section['title'])))
    for para in section.get('lead', []):
        out.append('              <p>%s</p>' % para)

    quick = section.get('quick')
    if quick:
        out.append('              <div class="guide-quick">')
        for index, text in enumerate(quick, 1):
            out.append('                <div><b>%d</b><span>%s</span></div>' % (index, text))
        out.append('              </div>')

    for name, caption in section.get('figures', []):
        path = os.path.join(ASSETS, name + '.webp')
        if not os.path.exists(path):
            print('  ! 缺图', name)
        alt = html.escape(strip_tags(caption)[:80], quote=True)
        out.append('              <figure class="guide-figure">')
        out.append('                <img src="assets/guide/%s.webp" alt="%s" />' % (name, alt))
        out.append('                <figcaption>%s</figcaption>' % caption)
        out.append('              </figure>')

    for sub in section.get('subs', []):
        out.append('              <h4>%s</h4>' % sub)

    points = section.get('points') or []
    if points:
        out.append('              <ul class="guide-points">')
        for point in points:
            out.append('                <li>%s</li>' % point)
        out.append('              </ul>')

    keymap = section.get('keymap')
    if keymap:
        out.append('              <div class="keymap">')
        for keys, text in keymap:
            parts = ''.join('<kbd>%s</kbd>' % html.escape(key) for key in keys.split(' '))
            out.append('                <span>%s %s</span>' % (parts, html.escape(text)))
        out.append('              </div>')

    faq = section.get('faq')
    if faq:
        out.append('              <div class="faq">')
        out.append('                <h4>常见问题</h4>')
        out.append('                <dl>')
        for question, answer in faq:
            out.append('                  <dt>%s</dt>' % question)
            out.append('                  <dd>%s</dd>' % answer)
        out.append('                </dl>')
        out.append('              </div>')

    for tip in section.get('tips', []):
        out.append('              <div class="guide-tip">%s</div>' % tip)

    out.append('            </section>')
    return '\n'.join(out)


def modal_html():
    figures = sum(len(s.get('figures', [])) for s in SECTIONS)
    parts = [
        START,
        '      <div class="modal guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">',
        '        <header class="modal-head guide-head">',
        '          <div>',
        '            <h2 id="guide-title">%s</h2>' % TITLE,
        '            <p>%s</p>' % SUBTITLE,
        '          </div>',
        '          <button class="icon-btn" id="guide-close" title="关闭（Esc）">✕</button>',
        '        </header>',
        '        <div class="guide-body">',
        '          <nav class="guide-nav" id="guide-nav" aria-label="教程目录">',
        nav_html(),
        '          </nav>',
        '          <div class="guide-content" id="guide-content">',
        '\n\n'.join(section_html(s) for s in SECTIONS),
        '          </div>',
        '        </div>',
        '      </div>',
        '    </div>',
        '',
    ]
    print('  %d 节 / %d 张图' % (len(SECTIONS), figures))
    return '\n'.join(parts)


def main():
    with open(INDEX, encoding='utf-8') as f:
        source = f.read()
    start = source.index(START)
    end = source.index(END)
    new = source[:start] + modal_html() + source[end:]
    with open(INDEX, 'w', encoding='utf-8') as f:
        f.write(new)
    print('  写回', INDEX, len(source), '->', len(new), 'chars')


if __name__ == '__main__':
    main()
