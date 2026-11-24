# -*- coding: utf-8 -*-
"""只重截「反馈」一张：新布局比旧版高，需要临时加高视口才能把 ①–⑤ 拍全。"""
import base64
import json
import os
import sys
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, os.path.join(ROOT, 'tools', 'guide'))

import capture as cp  # noqa: E402
import annotate as an  # noqa: E402

GUIDE_DIR = os.path.join(ROOT, '.tmp', 'guide')
RAW = os.path.join(GUIDE_DIR, 'raw')
USERDATA = os.path.join(GUIDE_DIR, 'userdata')
ASSETS = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'assets', 'guide')
OUT = os.path.join(GUIDE_DIR, 'out')

proc = cp.launch(USERDATA)
page = cp.wait_cdp()
if not page:
    raise SystemExit('no cdp')
c = cp.CDP(page['webSocketDebuggerUrl'])
try:
    for _ in range(80):
        if c.ev('Boolean(window.__app && document.querySelector("#btn-settings"))'):
            break
        time.sleep(0.3)
    c.ev("document.querySelector('#account-gate').hidden = true; true")
    c.send('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1040, 'deviceScaleFactor': 1, 'mobile': False})
    time.sleep(0.8)
    c.ev("document.querySelector('#btn-settings').click(); true")
    time.sleep(0.8)
    c.ev("document.querySelector('#modal-tabs button[data-tab=\"feedback\"]').click(); true")
    time.sleep(0.6)
    c.ev("""(() => {
      const box = document.querySelector('#fb-mine');
      if (box) {
        box.innerHTML = '<div class="fb-item">' +
          '<header><span class="fb-tag replied">已回复</span><span class="fb-tag">功能建议</span><span>★ 5</span><span>2026/11/24 12:40</span></header>' +
          '<div class="content">希望增加一个「按平台筛选历史」的开关。</div>' +
          '<div class="reply"><b>作者回复</b> · 2026/11/24 13:05<br>已记录，下个版本加上。</div>' +
          '</div>';
      }
      const pane = document.querySelector('.tab-panes');
      if (pane) pane.scrollTop = 0;
      return true;
    })()""")
    time.sleep(0.7)
    vw, vh = c.ev('[innerWidth, innerHeight]')
    print('viewport', vw, vh)
    pane_info = c.ev("(() => { const p = document.querySelector('.tab-panes'); return [p.scrollHeight, p.clientHeight]; })()")
    print('pane scroll/client', pane_info)

    def rect(sel):
        return c.ev(f"""(() => {{
          const el = document.querySelector({json.dumps(sel)});
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return {{ x: r.x, y: r.y, w: r.width, h: r.height }};
        }})()""")

    # 注意：必须在 cp.capture 之前取矩形——capture() 会临时设 DSF 再清掉覆盖，
    # 清掉之后窗口回到原始尺寸，再取矩形就和截图对不上了。
    modal = rect('#modal > .modal')
    crop = {'x': modal['x'] - 16, 'y': modal['y'] - 16, 'w': modal['w'] + 32, 'h': modal['h'] + 32}
    crop['x'] = max(0, crop['x'])
    crop['y'] = max(0, crop['y'])
    crop['w'] = min(crop['w'], vw - crop['x'])
    crop['h'] = min(crop['h'], vh - crop['y'])
    boxes = []
    for sel, label, badge in [
        ('#fb-type', 1, 'right'),
        ('#fb-rating', 2, 'right'),
        ('#fb-content', 3, 'auto'),
        ('#fb-form button[type="submit"]', 4, 'top'),
        ('#fb-mine', 5, 'auto'),
    ]:
        r = rect(sel)
        if r:
            boxes.append({'selector': sel, 'rect': r, 'label': label, 'badge': badge})
    meta = {
        'raw': 'g-feedback.png',
        'name': 'guide-14-feedback',
        'boxes': boxes,
        'dim': 0.2,
        'crop': crop,
    }
    cp.capture(c, 'g-feedback')
    shots_path = os.path.join(GUIDE_DIR, 'shots.json')
    data = json.load(open(shots_path, encoding='utf-8')) if os.path.exists(shots_path) else {'viewport': [vw, vh], 'shots': {}}
    data.setdefault('shots', {})['g-feedback'] = meta
    data['viewport'] = [vw, vh]
    json.dump(data, open(shots_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)

    img = an.annotate('g-feedback', os.path.join(RAW, 'g-feedback.png'), meta)
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(ASSETS, exist_ok=True)
    img.save(os.path.join(OUT, 'guide-14-feedback.png'))
    img.save(os.path.join(ASSETS, 'guide-14-feedback.webp'), 'WEBP', quality=88, method=6)
    print('feedback webp', img.size, os.path.getsize(os.path.join(ASSETS, 'guide-14-feedback.webp')))
finally:
    c.close()
    cp.stop(proc)
