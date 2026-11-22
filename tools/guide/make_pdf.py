"""把应用内的「使用教程 · 图文版」导出为 A4 PDF。

用法：python tools/guide/make_pdf.py
产物：docs/长视频解析-图文使用教程.pdf
中间文件：.tmp/guide/print.html（由 print_pdf.js 用 Electron 打印）
"""

import html as html_lib
import json
import os
import re
import subprocess
import sys
from datetime import date

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
INDEX = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'index.html')
ASSETS = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'assets', 'guide')
WORK = os.path.join(ROOT, '.tmp', 'guide')
PRINT_HTML = os.path.join(WORK, 'print.html')
OUT_PDF = os.path.join(ROOT, 'docs', '长视频解析-图文使用教程.pdf')
ELECTRON = os.path.join(ROOT, 'desktop', 'electron', 'node_modules', 'electron', 'dist', 'electron.exe')
PRINT_JS = os.path.join(ROOT, 'tools', 'guide', 'print_pdf.js')
PKG = os.path.join(ROOT, 'desktop', 'electron', 'package.json')

TITLE = '音视频解析 · 图文使用教程'
SUBTITLE = '从安装、粘贴链接到下载、投屏和音乐，一步一步来'


def app_version():
    try:
        with open(PKG, encoding='utf-8') as f:
            return json.load(f).get('version', '1.3.4')
    except Exception:
        return '1.3.4'


def strip_tags(text):
    text = re.sub(r'<[^>]+>', '', text)
    return re.sub(r'\s+', ' ', html_lib.unescape(text)).strip()


def build():
    with open(INDEX, encoding='utf-8') as f:
        source = f.read()
    sections = re.findall(r'<section class="guide-section".*?</section>', source, re.S)
    if len(sections) < 9:
        raise SystemExit(f'只找到 {len(sections)} 个教程章节，页面结构可能变了')

    # 把截图地址改成绝对 file://，打印器直接读本地文件
    for name in sorted(os.listdir(ASSETS)):
        if not name.endswith('.webp'):
            continue
        uri = (os.path.join(ASSETS, name)).replace('\\', '/')
        uri = 'file:///' + uri.lstrip('/')
        sections = [section.replace(f'src="assets/guide/{name}"', f'src="{uri}"') for section in sections]

    toc = []
    for section in sections:
        m = re.search(r'<section class="guide-section" id="([^"]+)"', section)
        h3 = re.search(r'<h3>(.*?)</h3>', section, re.S)
        if not m or not h3:
            continue
        raw = h3.group(1)
        step = re.search(r'<span class="guide-step">(.*?)</span>', raw)
        number = strip_tags(step.group(1)) if step else ''
        rest = re.sub(r'<span class="guide-step">.*?</span>', '', raw)
        toc.append((m.group(1), number, strip_tags(rest)))

    today = date.today().strftime('%Y-%m-%d')
    version = app_version()
    figures = sum(section.count('<figure class="guide-figure">') for section in sections)
    hero = os.path.join(ASSETS, 'guide-08-full.webp').replace('\\', '/')
    hero_uri = 'file:///' + hero.lstrip('/')

    toc_html = '\n'.join(
        f'<li><a href="#{anchor}"><span class="toc-num">{html_lib.escape(number)}</span>'
        f'<span class="toc-title">{html_lib.escape(title)}</span></a></li>'
        for anchor, number, title in toc
    )

    body = '\n'.join(sections)
    doc = f'''<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<title>{html_lib.escape(TITLE)}</title>
<style>
  @page {{ size: A4; margin: 17mm 16mm 18mm; }}
  * {{ box-sizing: border-box; }}
  html, body {{ margin: 0; padding: 0; }}
  body {{
    font-family: 'Microsoft YaHei UI', 'Microsoft YaHei', 'PingFang SC', 'Segoe UI', sans-serif;
    color: #1c2633; background: #ffffff; font-size: 10.5pt; line-height: 1.9;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }}
  a {{ color: inherit; text-decoration: none; }}

  /* ---------- 封面 ---------- */
  .cover {{
    height: 252mm; display: flex; flex-direction: column; page-break-after: always;
  }}
  .cover-mark {{
    display: inline-block; padding: 3px 10px; border-radius: 999px;
    background: #e9f8ef; color: #128a4d; font-size: 9pt; font-weight: 700;
    letter-spacing: .5px;
  }}
  .cover h1 {{ margin: 14mm 0 4mm; font-size: 30pt; line-height: 1.25; letter-spacing: 1px; }}
  .cover .sub {{ margin: 0; color: #5a6a7d; font-size: 12.5pt; }}
  .cover .meta {{ margin-top: 5mm; color: #8a97a8; font-size: 9.5pt; }}
  .cover-line {{ width: 34mm; height: 3.5mm; background: #17b06b; border-radius: 999px; margin-top: 8mm; }}
  .cover-facts {{
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; margin-top: 11mm;
  }}
  .cover-facts div {{
    padding: 4mm 4mm 4.5mm; border: 1px solid #e1e8f0; border-radius: 3mm; background: #f8fafc;
  }}
  .cover-facts b {{ display: block; color: #128a4d; font-size: 9pt; letter-spacing: .4px; margin-bottom: 1.2mm; }}
  .cover-facts span {{ color: #5d6c7f; font-size: 9pt; line-height: 1.65; }}
  .cover-hero {{ margin-top: 12mm; }}
  .cover-hero img {{
    width: 100%; display: block; border-radius: 5mm; border: 1px solid #d8e1eb;
    box-shadow: 0 6mm 12mm -6mm rgba(20, 40, 70, .35);
  }}
  .cover-hero .cap {{ margin-top: 3mm; color: #98a4b3; font-size: 8.5pt; }}

  /* ---------- 目录 ---------- */
  .toc {{ page-break-after: always; }}
  .toc h2 {{ margin: 0 0 8mm; font-size: 19pt; }}
  .toc ol {{ list-style: none; margin: 0; padding: 0; border-top: 1px solid #e4eaf1; }}
  .toc li {{ border-bottom: 1px solid #eef2f7; }}
  .toc a {{ display: flex; align-items: center; gap: 6mm; padding: 4.2mm 1mm; }}
  .toc-num {{
    flex: none; width: 8mm; height: 8mm; border-radius: 2.4mm; background: #e9f8ef;
    color: #128a4d; font-weight: 800; font-size: 10pt; display: flex; align-items: center; justify-content: center;
  }}
  .toc-title {{ font-size: 11.5pt; }}
  .toc-note {{ margin-top: 8mm; color: #8a97a8; font-size: 9pt; line-height: 1.8; }}

  /* ---------- 正文 ---------- */
  .guide-section {{ page-break-before: always; }}
  .guide-section:first-of-type {{ page-break-before: auto; }}
  .guide-section h3 {{
    display: flex; align-items: center; gap: 3.2mm; margin: 0 0 4mm;
    font-size: 17pt; line-height: 1.35; letter-spacing: .3px;
  }}
  .guide-step {{
    flex: none; width: 8.6mm; height: 8.6mm; border-radius: 2.6mm;
    background: #17b06b; color: #ffffff; font-size: 11pt; font-weight: 800;
    display: flex; align-items: center; justify-content: center;
  }}
  .guide-section p {{ margin: 0 0 4mm; color: #465568; }}
  .guide-section p strong, .guide-points strong {{ color: #172130; }}
  .guide-quick {{
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 3mm; margin: 0 0 5mm;
  }}
  .guide-quick div {{
    display: flex; align-items: center; gap: 2.5mm; padding: 3mm 3.5mm;
    border: 1px solid #e1e8f0; border-radius: 2.5mm; background: #f8fafc; font-size: 9.5pt;
  }}
  .guide-quick b {{
    flex: none; width: 6mm; height: 6mm; border-radius: 50%; background: #e9f8ef; color: #128a4d;
    display: flex; align-items: center; justify-content: center; font-size: 9pt;
  }}

  .guide-figure {{
    margin: 0 0 5mm; padding: 2.2mm; border: 1px solid #dfe7f0; border-radius: 3.5mm;
    background: #f6f9fc; page-break-inside: avoid;
  }}
  .guide-figure img {{ display: block; width: 100%; height: auto; border-radius: 2.2mm; }}
  .guide-figure figcaption {{
    padding: 3mm 1mm 1mm; color: #5d6c7f; font-size: 9pt; line-height: 1.8;
  }}
  .guide-figure figcaption b {{ color: #e03131; }}

  .guide-points {{ margin: 0 0 4mm; padding: 0; list-style: none; }}
  .guide-points li {{
    position: relative; padding-left: 5.5mm; margin-bottom: 2.2mm; color: #465568;
  }}
  .guide-points li::before {{
    content: ''; position: absolute; left: 1mm; top: 2.7mm; width: 1.6mm; height: 1.6mm;
    border-radius: 50%; background: #17b06b;
  }}
  .guide-points b {{ color: #e05555; }}

  .guide-tip {{
    margin: 3mm 0 0; padding: 3mm 4mm; border: 1px solid #f0dfbc; border-left: 1.2mm solid #e2a63c;
    border-radius: 2mm; background: #fdf8ee; color: #7a5a1f; font-size: 9.5pt; line-height: 1.85;
  }}

  kbd {{
    display: inline-block; min-width: 4mm; padding: 0 1.6mm; border: 1px solid #cdd6e1;
    border-bottom-width: 2px; border-radius: 1.2mm; background: #f2f6fa; color: #26313f;
    font-family: inherit; font-size: 9pt; line-height: 1.55; text-align: center;
  }}
  .keymap {{ display: flex; flex-wrap: wrap; gap: 2mm; margin: 0 0 4mm; }}
  .keymap span {{
    display: inline-flex; align-items: center; gap: 1.6mm; padding: 2mm 3mm;
    border: 1px solid #e1e8f0; border-radius: 2.4mm; background: #f8fafc; color: #465568; font-size: 9pt;
  }}

  .faq {{ margin-top: 4mm; padding: 4mm 4.5mm; border: 1px solid #e1e8f0; border-radius: 3mm; background: #f9fbfd; page-break-inside: avoid; }}
  .faq h4 {{ margin: 0 0 3mm; font-size: 11.5pt; }}
  .faq dl {{ margin: 0; }}
  .faq dt {{ margin-top: 3mm; font-weight: 700; color: #172130; }}
  .faq dt:first-child {{ margin-top: 0; }}
  .faq dd {{ margin: 1mm 0 0; color: #526173; font-size: 9.5pt; }}

  .doc-help {{
    margin-top: 5mm; padding: 4mm 4.5mm; border: 1px solid #e1e8f0; border-radius: 3mm; background: #f4f8fb;
  }}
  .doc-help h4 {{ margin: 0 0 2.5mm; font-size: 11.5pt; color: #172130; }}
  .doc-help p {{ margin: 0 0 2mm; color: #526173; font-size: 9.5pt; line-height: 1.8; }}
  .doc-help p:last-child {{ margin-bottom: 0; }}

  .doc-foot {{
    margin-top: 8mm; padding-top: 3mm; border-top: 1px solid #e8eef5;
    color: #98a4b3; font-size: 8.5pt; text-align: right;
  }}
</style>
</head>
<body>
  <section class="cover">
    <div><span class="cover-mark">音视频解析 · v{version}</span></div>
    <h1>{html_lib.escape(TITLE)}</h1>
    <p class="sub">{html_lib.escape(SUBTITLE)}</p>
    <p class="meta">Windows 10 / 11 · 爱奇艺 · 腾讯视频 · 优酷 · 芒果TV · 酷我 / 酷狗 / QQ音乐 / 网易云 / 汽水　|　{html_lib.escape(today)}</p>
    <div class="cover-line"></div>
    <div class="cover-facts">
      <div><b>{len(sections)} 个章节</b><span>安装、主界面、粘贴链接、找剧、选集、历史、线路、下载、全屏、投屏、设置、教程、短视频、音乐、常见问题</span></div>
      <div><b>{figures} 张实拍截图</b><span>红框 + 编号标出每一个按钮和注意事项</span></div>
      <div><b>常见问题速查</b><span>线路失效、地区限制、下载、更新都有说明</span></div>
    </div>
    <div class="cover-hero">
      <img src="{hero_uri}" alt="全屏播放示意" />
      <div class="cap">图里的红框就是这一步要重点看的地方；每节都可以单独看。</div>
    </div>
  </section>

  <section class="toc">
    <h2>目录</h2>
    <ol>{toc_html}</ol>
    <p class="toc-note">说明：本 PDF 与软件里的「使用教程 · 图文版」内容一致。截图来自真实运行界面，用红框、编号和聚光灯标出重点；演示剧集名称仅用于截图。</p>
  </section>

  {body}

  <div class="doc-help">
    <h4>还有问题？</h4>
    <p>项目主页：<b>github.com/fjz-hosts/changshipin-jiexi</b>　可以查看更新记录、提交 Issue，或下载最新版本。</p>
    <p>软件内：「设置 → 关于」可以打开配置目录、日志目录和项目主页；遇到解析失败时，先换线路，再试「在线更新线路」。</p>
  </div>

  <div class="doc-foot">音视频解析 · 图文使用教程 · v{version} · 共 {len(sections)} 节 / {figures} 张截图</div>
</body>
</html>'''

    os.makedirs(WORK, exist_ok=True)
    with open(PRINT_HTML, 'w', encoding='utf-8') as f:
        f.write(doc)
    print('print.html', PRINT_HTML, len(doc), 'chars', len(sections), 'sections')
    return PRINT_HTML


def main():
    html_path = build()
    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    os.makedirs(os.path.join(WORK, 'pdf-userdata'), exist_ok=True)
    env['CHANGSPIN_USERDATA'] = os.path.join(WORK, 'pdf-userdata')
    cmd = [ELECTRON, '--no-sandbox', PRINT_JS, html_path, OUT_PDF]
    print('running', ' '.join(cmd))
    result = subprocess.run(cmd, cwd=ROOT, env=env)
    if result.returncode != 0:
        raise SystemExit(f'print_pdf 失败，退出码 {result.returncode}')
    print('pdf', OUT_PDF, os.path.getsize(OUT_PDF), 'bytes')


if __name__ == '__main__':
    main()
