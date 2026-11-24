# -*- coding: utf-8 -*-
"""补截「设置 · 更新 / 关于」两页（完整跑 capture_full 时会卡在其它步骤，单独补）。"""
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


def rect(sel):
    return c.ev(f"""(() => {{
      const el = document.querySelector({json.dumps(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {{ x: r.x, y: r.y, w: r.width, h: r.height }};
    }})()""")


def snap(key, name, specs):
    vw, vh = c.ev('[innerWidth, innerHeight]')
    modal = rect('#modal > .modal')
    crop = {'x': max(0, modal['x'] - 16), 'y': max(0, modal['y'] - 16), 'w': modal['w'] + 32, 'h': modal['h'] + 32}
    crop['w'] = min(crop['w'], vw - crop['x'])
    crop['h'] = min(crop['h'], vh - crop['y'])
    boxes = []
    for sel, label, badge in specs:
        r = rect(sel)
        if r:
            boxes.append({'selector': sel, 'rect': r, 'label': label, 'badge': badge})
    meta = {'raw': key + '.png', 'name': name, 'boxes': boxes, 'dim': 0.2, 'crop': crop}
    cp.capture(c, key)
    shots_path = os.path.join(GUIDE_DIR, 'shots.json')
    data = json.load(open(shots_path, encoding='utf-8')) if os.path.exists(shots_path) else {'viewport': [vw, vh], 'shots': {}}
    data.setdefault('shots', {})[key] = meta
    data['viewport'] = [vw, vh]
    json.dump(data, open(shots_path, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    img = an.annotate(key, os.path.join(RAW, key + '.png'), meta)
    os.makedirs(OUT, exist_ok=True)
    img.save(os.path.join(OUT, name + '.png'))
    img.save(os.path.join(ASSETS, name + '.webp'), 'WEBP', quality=88, method=6)
    print('shot', key, '->', name, img.size)


try:
    for _ in range(80):
        if c.ev('Boolean(window.__app && document.querySelector("#btn-settings"))'):
            break
        time.sleep(0.3)
    c.ev("document.querySelector('#account-gate').hidden = true; true")
    c.ev("document.querySelector('#btn-settings').click(); true")
    time.sleep(0.8)
    c.ev("document.querySelector('#modal-tabs button[data-tab=\"update\"]').click(); true")
    time.sleep(1.0)
    snap('g-settings-update', 'guide-10-update', [
        ('#set-version', 1, 'right'),
        ('label.switch-row:has(#set-auto-update)', 2, 'right'),
        ('#btn-check-update', 3, 'top'),
        ('#update-status', 4, 'right'),
    ])
    c.ev("document.querySelector('#modal-tabs button[data-tab=\"about\"]').click(); true")
    time.sleep(0.8)
    snap('g-settings-about', 'guide-10-about', [
        ('#btn-about-guide', 1, 'top'),
        ('#btn-open-changelog', 2, 'top'),
        ('#btn-admin-panel', 3, 'top'),
        ('#btn-open-repo', 4, 'top'),
        ('#btn-open-userdata', 5, 'top'),
        ('#btn-open-logs', 6, 'top'),
        ('#btn-create-shortcut', 7, 'top'),
    ])
finally:
    c.close()
    cp.stop(proc)
