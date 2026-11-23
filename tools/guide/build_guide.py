# -*- coding: utf-8 -*-
"""把 guide_content.py 渲染进 index.html 的「使用教程 · 图文版」弹窗。

用法：python tools/guide/build_guide.py
- 只替换 index.html 里 `#guide-modal` 弹窗（从 `<div class="modal-mask" id="guide-modal"` 到 toast-stack 之前）。
- 忘了先跑 capture_full.py / annotate.py 的话，这里会提示缺图。
"""

import html
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from guide_content import SECTIONS  # noqa: E402

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
INDEX = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'index.html')
ASSETS = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'assets', 'guide')
VIDEO_DIR = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'assets', 'video-guide')
VIDEO_MANIFEST = os.path.join(VIDEO_DIR, 'manifest.json')
START = '    <div class="modal-mask" id="guide-modal" hidden>'
END = '    <div class="toast-stack" id="toast-stack" aria-live="polite"></div>'
TITLE = '使用教程'
SUBTITLE = '图文 + 视频两个版本：左边目录按章节看，视频教程可以单独点播，每节 1–2 分钟。'

# 视频章节对应的图文章节（右侧「看对应图文」会跳过去）
VIDEO_GUIDE_IDS = [
    'intro', 'main', 'paste', 'browser', 'episodes', 'history', 'lines',
    'download', 'fullscreen', 'cast', 'settings', 'guide', 'short', 'music', 'faq',
]
VIDEO_DESCS = [
    '安装包、SmartScreen、第一次启动、主界面分区',
    '三个模式、平台卡片、链接框、播放区、侧栏',
    '复制某一集链接、自动识别平台、解析播放、换线路',
    '平台官网、标签页、自动解析、找剧',
    '选集条、上一集 / 下一集、正倒序、自动连播',
    '一部剧一条、继续观看、搜索、排序、清空',
    '启用 / 顺序、体检 / 隐藏失效、线路管理',
    '下载进度、取消、HLS 合并、下载目录、不能下载的情况',
    'F11、空格 / 方向键 / M / Esc、自动连播',
    'DLNA、同一 Wi-Fi、二维码、网页线路抓流',
    '播放选项、托盘、检查更新、关于、登录与限制',
    '图文教程 / 视频教程入口、红框标注、夜间提示',
    '五个平台、清晰度、一键下载全集、下载记录',
    '五个平台、滚动歌词、收藏、下载记录、换源',
    '结尾提醒：正版、更新、问题反馈',
]


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


def load_video_chapters():
    if not os.path.exists(VIDEO_MANIFEST):
        print('  ! 缺少视频清单', VIDEO_MANIFEST, '（先跑 tools/guide/split_video.py）')
        return []
    with open(VIDEO_MANIFEST, encoding='utf-8') as handle:
        data = json.load(handle)
    return data.get('chapters') or []


def video_nav_html(chapters):
    rows = ['<div class="guide-video-series">视频教程 · %d 节 · 点一节直接播放</div>' % len(chapters)]
    for index, chapter in enumerate(chapters):
        file = chapter.get('file') or ''
        poster = chapter.get('poster') or ''
        if file and not os.path.exists(os.path.join(VIDEO_DIR, file)):
            print('  ! 缺视频', file)
        guide_id = VIDEO_GUIDE_IDS[index] if index < len(VIDEO_GUIDE_IDS) else ''
        desc = VIDEO_DESCS[index] if index < len(VIDEO_DESCS) else ''
        rows.append(
            '<button data-video="%s" data-file="%s" data-poster="%s" data-title="%s" data-duration="%s" data-guide="%s" data-desc="%s">'
            '<span class="gv-title">%s</span><span class="gv-dur">%s</span></button>'
            % (
                chapter.get('id', '%02d' % index),
                html.escape(file, quote=True),
                html.escape(poster, quote=True),
                html.escape(chapter.get('title', ''), quote=True),
                html.escape(chapter.get('durationText', ''), quote=True),
                html.escape(guide_id, quote=True),
                html.escape(desc, quote=True),
                html.escape(chapter.get('title', '')),
                html.escape(chapter.get('durationText', '')),
            )
        )
    return '\n'.join('              ' + row for row in rows)


def modal_html():
    figures = sum(len(s.get('figures', [])) for s in SECTIONS)
    chapters = load_video_chapters()
    first = chapters[0] if chapters else {}
    first_file = first.get('file', '')
    first_poster = first.get('poster', '')
    first_title = first.get('title', '视频教程')
    first_desc = VIDEO_DESCS[0] if VIDEO_DESCS else ''
    first_guide = VIDEO_GUIDE_IDS[0] if VIDEO_GUIDE_IDS else ''
    first_duration = first.get('durationText', '')
    parts = [
        START,
        '      <div class="modal guide-modal" role="dialog" aria-modal="true" aria-labelledby="guide-title">',
        '        <header class="modal-head guide-head">',
        '          <div>',
        '            <h2 id="guide-title">%s</h2>' % TITLE,
        '            <p>%s</p>' % SUBTITLE,
        '          </div>',
        '          <div class="guide-mode-switch" id="guide-mode-switch" role="tablist" aria-label="切换图文 / 视频教程">',
        '            <button data-guide-mode="image" class="active" role="tab" aria-selected="true">图文教程</button>',
        '            <button data-guide-mode="video" role="tab" aria-selected="false">视频教程</button>',
        '          </div>',
        '          <button class="icon-btn" id="guide-close" title="关闭（Esc）">✕</button>',
        '        </header>',
        '        <div class="guide-body">',
        '          <div class="guide-pane" id="guide-image-pane">',
        '            <nav class="guide-nav" id="guide-nav" aria-label="图文教程目录">',
        nav_html(),
        '            </nav>',
        '            <div class="guide-content" id="guide-content">',
        '\n\n'.join(section_html(s) for s in SECTIONS),
        '            </div>',
        '          </div>',
        '          <div class="guide-pane" id="guide-video-pane" hidden>',
        '            <nav class="guide-nav guide-video-nav" id="guide-video-nav" aria-label="视频教程目录">',
        video_nav_html(chapters),
        '            </nav>',
        '            <div class="guide-content guide-video-content">',
        '              <div class="guide-video-box">',
        (
            '                <video id="guide-video" controls playsinline preload="metadata" poster="assets/video-guide/%s" src="assets/video-guide/%s"></video>'
            % (html.escape(first_poster, quote=True), html.escape(first_file, quote=True))
        ),
        (
            '                <div class="guide-video-poster" id="guide-video-poster" role="button" tabindex="0" title="点一下播放这一节">'
            '<img id="guide-video-poster-img" src="assets/video-guide/%s" alt="" /><span class="guide-video-play">▶</span></div>'
            % html.escape(first_poster, quote=True)
        ),
        '              </div>',
        '              <div class="guide-video-meta">',
        '                <h3><em>视频教程</em><span id="guide-video-title">%s</span></h3>' % html.escape(first_title),
        (
            '                <p id="guide-video-desc">第 1 / %d 节 · %s · %s</p>'
            % (len(chapters), html.escape(first_duration), html.escape(first_desc))
        ),
        '                <div class="guide-video-actions">',
        '                  <button class="ghost-sm" id="guide-video-prev" disabled>上一节</button>',
        '                  <button class="ghost-sm" id="guide-video-next">下一节</button>',
        (
            '                  <button class="ghost-sm" id="guide-video-to-image" data-guide="%s">看对应图文</button>'
            % html.escape(first_guide, quote=True)
        ),
        '                </div>',
        '              </div>',
        '              <div class="guide-tip">视频已按章节拆开，每节 1–2 分钟：忘了某个操作时，直接点左侧对应章节，不用从头拖 19 分钟的长视频。视频里的演示数据只用于展示，实际使用会按自己的记录生成。</div>',
        '            </div>',
        '          </div>',
        '        </div>',
        '      </div>',
        '    </div>',
        '',
    ]
    print('  %d 节图文 / %d 张图；视频 %d 节' % (len(SECTIONS), figures, len(chapters)))
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
