"""采集图文教程截图（原始 PNG + 标注元数据）。

前置：先跑 .tmp/guide/make_poster.py 生成演示画面。
用法：python .tmp/guide/capture.py
输出：.tmp/guide/raw/*.png + .tmp/guide/shots.json
之后运行 .tmp/guide/annotate.py 生成带红框的 webp。
"""

import http.server
import json
import os
import re
import shutil
import subprocess
import threading
import time
import base64
from urllib.parse import unquote

import requests
import websocket

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ELECTRON_DIR = os.path.join(ROOT, 'desktop', 'electron')
EXE = os.path.join(ELECTRON_DIR, 'node_modules', 'electron', 'dist', 'electron.exe')
GUIDE_DIR = os.path.join(ROOT, '.tmp', 'guide')
WWW = os.path.join(GUIDE_DIR, 'www')
USERDATA = os.path.join(GUIDE_DIR, 'userdata')
RAW = os.path.join(GUIDE_DIR, 'raw')
PORT = 9351

EPISODES = []
for n in range(1, 17):
    url = f'https://www.mgtv.com/b/817372/247739{n:02d}.html'
    EPISODES.append({'label': f'第{n}集', 'title': f'今天是太阳雨 第{n}集', 'url': url, 'index': n, 'vip': n > 12})
EP5 = EPISODES[4]['url']
SERIES = {'platform': 'mgtv', 'title': '今天是太阳雨', 'seriesKey': 'demo:sunrain', 'episodes': EPISODES}

HISTORY = [
    # (url, title, episode, progress, duration)
    ('https://www.iqiyi.com/v_b13ju3xx7s.html', '庆余年 第二季 第18集', '第18集', 2500, 2700),
    ('https://v.qq.com/x/cover/mzc00200mp8vo9b/x4102olnagg.html', '漫长的季节 第6集', '第6集', 300, 3000),
    ('https://v.qq.com/x/cover/mzc002001w361jz/x4102olnagg.html', '尚公主 第2集', '第2集', 2100, 2764),
    ('https://v.youku.com/v_show/id_XNjU3MzkyOTA0NA==.html', '嫁金钗 第1集', '第1集', 600, 2700),
    ('https://www.iqiyi.com/v_1pwgh2hpp98.html', '折月亮 第11集', '第11集', 800, 2695),
    ('https://www.mgtv.com/b/817372/24773905.html', '今天是太阳雨 第5集', '第5集', 1600, 2727),
]


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _resolve(self):
        path = unquote(self.path.split('?')[0]).lstrip('/') or 'index.html'
        full = os.path.realpath(os.path.join(WWW, path))
        if not full.startswith(os.path.realpath(WWW)) or not os.path.isfile(full):
            return None
        return full

    def _serve(self, head=False):
        full = self._resolve()
        if not full:
            self.send_error(404)
            return
        data = b'' if head else open(full, 'rb').read()
        size = os.path.getsize(full)
        ctype = 'video/mp4' if full.endswith('.mp4') else 'text/html; charset=utf-8'
        range_header = self.headers.get('Range')
        if range_header and not head:
            m = re.match(r'bytes=(\d+)-(\d*)', range_header)
            start = int(m.group(1)) if m else 0
            end = int(m.group(2)) if (m and m.group(2)) else size - 1
            start = max(0, min(start, size - 1))
            end = max(start, min(end, size - 1))
            chunk = data[start:end + 1]
            self.send_response(206)
            self.send_header('Content-Type', ctype)
            self.send_header('Accept-Ranges', 'bytes')
            self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
            self.send_header('Content-Length', str(len(chunk)))
            self.end_headers()
            self.wfile.write(chunk)
            return
        self.send_response(200)
        self.send_header('Content-Type', ctype)
        self.send_header('Accept-Ranges', 'bytes')
        self.send_header('Content-Length', str(size))
        self.end_headers()
        if not head:
            self.wfile.write(data)

    def do_GET(self):
        self._serve(False)

    def do_HEAD(self):
        self._serve(True)


class CDP:
    def __init__(self, url):
        self.ws = websocket.create_connection(url, timeout=40)
        self.i = 0

    def send(self, method, params=None):
        self.i += 1
        i = self.i
        self.ws.send(json.dumps({'id': i, 'method': method, 'params': params or {}}))
        while True:
            m = json.loads(self.ws.recv())
            if m.get('id') == i:
                if m.get('error'):
                    raise RuntimeError(f'{method}: {json.dumps(m["error"], ensure_ascii=False)}')
                return m

    def ev(self, expr):
        r = self.send('Runtime.evaluate', {'expression': expr, 'returnByValue': True, 'awaitPromise': True})
        if 'exceptionDetails' in r.get('result', {}):
            raise RuntimeError(json.dumps(r['result']['exceptionDetails'], ensure_ascii=False)[:900])
        return r['result']['result'].get('value')

    def close(self):
        self.ws.close()


def wait_cdp(timeout=30):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            data = requests.get(f'http://127.0.0.1:{PORT}/json/list', timeout=1).json()
            page = [x for x in data if x.get('type') == 'page' and 'index.html' in x.get('url', '')]
            if page:
                return page[0]
        except Exception:
            pass
        time.sleep(0.3)
    return None


def launch(userdata):
    env = dict(os.environ)
    env.pop('ELECTRON_RUN_AS_NODE', None)
    env['CHANGSPIN_USERDATA'] = userdata
    return subprocess.Popen(
        [EXE, '.', f'--remote-debugging-port={PORT}', '--remote-allow-origins=*', '--no-sandbox', '--disable-gpu'],
        cwd=ELECTRON_DIR,
        env=env,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )


def stop(proc):
    try:
        proc.terminate()
    except Exception:
        pass
    time.sleep(1.5)


def rect(c, selector):
    return c.ev(f"""(() => {{
      const el = document.querySelector({json.dumps(selector)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {{ x: r.x, y: r.y, w: r.width, h: r.height }};
    }})()""")


def capture(c, name):
    vw, vh = c.ev('[innerWidth, innerHeight]')
    c.send('Emulation.setDeviceMetricsOverride', {'width': int(vw), 'height': int(vh), 'deviceScaleFactor': 2, 'mobile': False})
    time.sleep(0.55)
    result = c.send('Page.captureScreenshot', {'format': 'png', 'fromSurface': True})
    data = base64.b64decode(result['result']['data'])
    path = os.path.join(RAW, f'{name}.png')
    with open(path, 'wb') as f:
        f.write(data)
    c.send('Emulation.clearDeviceMetricsOverride')
    time.sleep(0.35)
    print('  captured', name, len(data), 'bytes', vw, vh)
    return path


def box(c, selector, label, badge='auto'):
    r = rect(c, selector)
    if not r:
        print('  ! no rect for', selector)
        return None
    return {'selector': selector, 'rect': r, 'label': label, 'badge': badge}


def union(rects, pad=0):
    xs = [r['x'] for r in rects]
    ys = [r['y'] for r in rects]
    xe = [r['x'] + r['w'] for r in rects]
    ye = [r['y'] + r['h'] for r in rects]
    return {
        'x': max(0, min(xs) - pad),
        'y': max(0, min(ys) - pad),
        'w': max(xe) - min(xs) + pad * 2,
        'h': max(ye) - min(ys) + pad * 2,
    }


def clamp_crop(crop, vw, vh):
    x = max(0, crop['x'])
    y = max(0, crop['y'])
    w = min(vw - x, crop['w'])
    h = min(vh - y, crop['h'])
    return {'x': round(x, 1), 'y': round(y, 1), 'w': round(w, 1), 'h': round(h, 1)}


def seed(c):
    c.ev("""window.desktop.saveSettings({
      autoUpdate: false, autoLineTest: false, autoFallback: true, closeToTray: false,
      lineHealth: {
        'builtin-789': { ok: true, ms: 812, note: '页面可访问（解析效果以实际播放为准）', at: Date.now() },
        'builtin-playm3u8': { ok: true, ms: 640, note: '页面可访问（解析效果以实际播放为准）', at: Date.now() },
        'builtin-pangu': { ok: true, ms: 700, note: '页面可访问（解析效果以实际播放为准）', at: Date.now() },
        'builtin-mgtv-native': { ok: true, ms: 1200, note: '已解析出芒果TV 播放地址', at: Date.now() },
        'builtin-77flv': { ok: false, ms: 6000, note: 'HTTP 502', at: Date.now() },
        'builtin-xmflv': { ok: false, ms: 6000, note: '连接超时', at: Date.now() },
        'builtin-2s0': { ok: false, ms: 6000, note: 'HTTP 404', at: Date.now() },
      }
    })""")
    for url, title, episode, progress, duration in HISTORY:
        c.ev(f"""window.desktop.addHistory({{url: {json.dumps(url)}, title: {json.dumps(title, ensure_ascii=False)},
          episode: {json.dumps(episode, ensure_ascii=False)}, progress: {progress}, duration: {duration}}})""")
    print('  seeded history')


def fix_config():
    path = os.path.join(USERDATA, 'config.json')
    with open(path, encoding='utf-8') as f:
        cfg = json.load(f)
    now = int(time.time() * 1000)
    offsets = [12 * 60, 55 * 60, 2 * 3600, 3 * 3600, 26 * 3600, 50 * 3600]
    for item, off in zip(cfg['history'], offsets):
        item['at'] = now - off * 1000
    cfg['lastUrl'] = ''
    cfg['autoUpdate'] = False
    cfg['autoLineTest'] = False
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)
    print('  config fixed:', len(cfg['history']), 'history entries')


def setup_video(c, http_port):
    c.ev(f"""(() => {{
      const s = window.__app.getState();
      const v = document.querySelector('#video');
      ['empty', 'loading', 'error', 'webview'].forEach((id) => {{ document.querySelector('#view-' + id).hidden = true }});
      document.querySelector('#view-video').hidden = false;
      document.querySelector('#stage').classList.add('stage-playing');
      document.body.classList.remove('cinema');
      document.body.classList.add('page-scroll');
      s.fullscreen = false;
      v.muted = true;
      if (v.getAttribute('src') !== 'http://127.0.0.1:{http_port}/poster.mp4') {{
        v.src = 'http://127.0.0.1:{http_port}/poster.mp4';
      }}
      v.play().catch(() => {{}});
      s.currentVideoUrl = {json.dumps(EP5)};
      s.currentTitle = '今天是太阳雨 第5集';
      s.currentEpisode = '第5集';
      s.lastResult = {{ kind: 'stream', playUrl: 'http://127.0.0.1:{http_port}/poster.mp4' }};
      document.querySelector('#stage-title-text').textContent = '今天是太阳雨 · 第5集';
      document.querySelector('#stage-line').textContent = '芒果TV 原生解析';
      document.querySelector('#source-url').textContent = {json.dumps(EP5)};
      document.querySelector('#live-dot').classList.add('playing');
      document.querySelector('#status-text').textContent = '解析成功：芒果TV 原生解析';
      window.__app.showSeries({json.dumps(SERIES, ensure_ascii=False)});
      window.__app.setDownloadButton();
      return true;
    }})()""")
    time.sleep(2)


def scroll_stage(c):
    c.ev("""(() => {
      const stage = document.querySelector('#stage');
      const top = stage.getBoundingClientRect().top + window.scrollY - 6;
      window.scrollTo(0, Math.max(0, top));
      return window.scrollY;
    })()""")
    time.sleep(0.6)


def hover_video(c):
    r = rect(c, '#video')
    if not r:
        return
    x = r['x'] + r['w'] * 0.5
    y = r['y'] + r['h'] * 0.5
    c.send('Input.dispatchMouseEvent', {'type': 'mouseMoved', 'x': x, 'y': y})
    time.sleep(0.4)


def open_browser(c):
    c.ev("window.__app.openBrowser('mgtv'); true")
    for _ in range(40):
        time.sleep(0.5)
        try:
            ready = c.ev("""(() => {
              const s = window.__app.getState();
              const rec = s.browsers.get('mgtv');
              if (!rec) return 'no-record';
              try { const w = rec.webview; if (!w.getURL()) return 'no-url'; } catch (e) { return 'err'; }
              return 'ok';
            })()""")
            if ready == 'ok':
                break
        except Exception:
            pass
    time.sleep(3)
    try:
        c.ev("""(() => {
          const rec = window.__app.getState().browsers.get('mgtv');
          if (!rec) return 'no';
          rec.webview.executeJavaScript(`(() => {
            const btns = [...document.querySelectorAll('button,div,span,a')];
            const ok = btns.find((e) => (e.textContent || '').trim() === '我同意');
            if (ok) { ok.click(); return 'clicked' }
            return 'none'
          })()`).catch(() => {});
          return 'sent';
        })()""")
    except Exception:
        pass
    # 首页轮播偶尔会切到广告页：等到「今天是太阳雨」的推荐位再截图
    for _ in range(24):
        time.sleep(1)
        try:
            text = c.ev("""(() => {
              const rec = window.__app.getState().browsers.get('mgtv');
              if (!rec) return '';
              return rec.webview.executeJavaScript('document.body ? document.body.innerText.slice(0, 4000) : ""').catch(() => '');
            })()""")
        except Exception:
            text = ''
        if text and '今天是太阳雨' in text and '扫码抽入场券' not in text:
            break
    c.ev("document.querySelector('#status-text').textContent = '内置浏览器 · 芒果TV'; true")
    time.sleep(0.8)


def main():
    os.makedirs(RAW, exist_ok=True)
    shutil.rmtree(USERDATA, ignore_errors=True)
    for _ in range(5):
        if not os.path.exists(USERDATA):
            break
        time.sleep(1)
        shutil.rmtree(USERDATA, ignore_errors=True)
    os.makedirs(USERDATA, exist_ok=True)

    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    http_port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print('server', http_port)

    subprocess.run(['taskkill', '/F', '/IM', 'electron.exe'], capture_output=True)
    time.sleep(1)

    # ---------- 第一次启动：写入演示历史 / 线路体检 ----------
    proc = launch(USERDATA)
    page = wait_cdp()
    if not page:
        print('NO CDP')
        return
    c = CDP(page['webSocketDebuggerUrl'])
    time.sleep(2)
    seed(c)
    c.close()
    stop(proc)
    fix_config()

    # ---------- 第二次启动：采集截图 ----------
    proc = launch(USERDATA)
    page = wait_cdp()
    if not page:
        print('NO CDP 2')
        return
    c = CDP(page['webSocketDebuggerUrl'])
    shots = {}
    try:
        time.sleep(2)
        c.ev('window.resizeTo(1290, 830); window.moveTo(0, 0); true')
        time.sleep(1.2)
        c.ev('window.scrollTo(0, 0); true')
        vw, vh = c.ev('[innerWidth, innerHeight]')
        print('viewport', vw, vh)

        # 1. 主界面
        c.ev("""(() => {
          const input = document.querySelector('#url-input');
          input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
          ['empty','loading','error','video','webview'].forEach((id) => {
            document.querySelector('#view-' + id).hidden = id !== 'empty';
          });
          document.body.classList.remove('page-scroll');
          document.querySelector('#stage').classList.remove('stage-playing');
          document.querySelector('#episode-bar').hidden = true;
          document.querySelector('#stage-title-text').textContent = '等待解析';
          document.querySelector('#stage-line').textContent = '未选择线路';
          document.querySelector('#source-url').textContent = '尚未解析';
          document.querySelector('#status-text').textContent = '就绪 · 共 4 条可用线路';
          return true;
        })()""")
        time.sleep(0.6)
        capture(c, '01-main')
        shots['main'] = {
            'raw': '01-main.png',
            'dim': 0.44,
            'boxes': [b for b in [
                box(c, '.platform-grid', 1),
                box(c, '#url-box', 2),
                box(c, '#btn-parse', 3),
                box(c, '.side', 4),
            ] if b],
        }

        # 2. 粘贴链接
        c.ev(f"""(() => {{
          const input = document.querySelector('#url-input');
          input.value = {json.dumps(EP5)};
          input.dispatchEvent(new Event('input', {{ bubbles: true }}));
          return document.querySelector('#platform-badge').textContent;
        }})()""")
        time.sleep(0.5)
        paste_boxes = [b for b in [
            box(c, '#url-box', 1),
            box(c, '#line-select', 2),
            box(c, '#btn-parse', 3),
        ] if b]
        crop = None
        if paste_boxes:
            u = union([b['rect'] for b in paste_boxes], 26)
            quick = rect(c, '.quick-row')
            top = quick['y'] - 8 if quick else u['y'] - 96
            crop = clamp_crop({'x': 0, 'y': top, 'w': vw, 'h': (u['y'] + u['h'] + 26) - top}, vw, vh)
        capture(c, '02-paste')
        shots['paste'] = {'raw': '02-paste.png', 'boxes': paste_boxes, 'crop': crop, 'dim': 0.42}

        # 3. 内置浏览器
        open_browser(c)
        capture(c, '03-browser')
        prepared = os.path.join(RAW, 'browser-clean.png')
        if os.path.exists(prepared):
            shutil.copyfile(prepared, os.path.join(RAW, '03-browser.png'))
            print('  browser screenshot replaced with clean hero')
        shots['browser'] = {
            'raw': '03-browser.png',
            'dim': 0.34,
            'crop': {'x': 0, 'y': 0, 'w': vw, 'h': vh - 32},
            'boxes': [b for b in [
                box(c, '.browser-tabs', 1),
                box(c, '.browser-address', 2),
                box(c, '.browser-auto', 3),
                box(c, '#browser-parse', 4),
            ] if b],
        }
        c.ev('window.__app.hideBrowser(); true')
        time.sleep(0.8)

        # 4. 选集与连播
        setup_video(c, http_port)
        scroll_stage(c)
        hover_video(c)
        capture(c, '04-episodes')
        bar = rect(c, '#episode-bar')
        ep_crop = clamp_crop({'x': 0, 'y': 0, 'w': vw, 'h': (bar['y'] + bar['h'] + 18) if bar else vh}, vw, vh)
        shots['episodes'] = {
            'raw': '04-episodes.png',
            'dim': 0.34,
            'crop': ep_crop,
            'boxes': [b for b in [
                box(c, '.stage-body', 0),
                box(c, '#episode-bar', 0),
                box(c, '.episode-auto-next', 1, badge='top'),
                box(c, '#episode-list .episode-item.active', 2),
                box(c, '#episode-next', 3, badge='top'),
                box(c, '.stage-tools', 4),
            ] if b],
        }

        # 5. 观看历史
        c.ev("document.body.classList.remove('page-scroll'); window.scrollTo(0, 0); true")
        time.sleep(0.8)
        hist = rect(c, '.history-panel')
        hist_boxes = [b for b in [
            box(c, '.history-panel', 0),
            box(c, '#history-list .history-item', 1),
            box(c, '#history-search-input', 2, badge='right'),
            box(c, '#history-sort', 3, badge='right'),
        ] if b]
        hist_crop = clamp_crop({'x': hist['x'] - 130, 'y': hist['y'] - 10, 'w': vw - (hist['x'] - 130), 'h': hist['h'] + 14}, vw, vh) if hist else None
        capture(c, '05-history')
        shots['history'] = {'raw': '05-history.png', 'boxes': hist_boxes, 'crop': hist_crop, 'dim': 0.46}

        # 6. 线路
        line_panel = rect(c, '.side .panel:first-child')
        line_boxes = [b for b in [
            box(c, '#line-list', 1),
            box(c, '.panel-actions', 2),
        ] if b]
        line_crop = clamp_crop({'x': line_panel['x'] - 120, 'y': line_panel['y'] - 10, 'w': vw - (line_panel['x'] - 120), 'h': line_panel['h'] + 20}, vw, vh) if line_panel else None
        capture(c, '06-lines')
        shots['lines'] = {'raw': '06-lines.png', 'boxes': line_boxes, 'crop': line_crop, 'dim': 0.46}

        # 7. 下载
        scroll_stage(c)
        c.ev("""(() => {
          const s = window.__app.getState();
          s.downloadRunning = true;
          s.downloadPercent = 42;
          window.__app.setDownloadButton();
          return true;
        })()""")
        hover_video(c)
        download_boxes = [b for b in [
            box(c, '.stage-head', 0),
            box(c, '#btn-download', 1, badge='top'),
        ] if b]
        stage_head = rect(c, '.stage-head')
        download_crop = clamp_crop({'x': max(0, stage_head['x'] - 10), 'y': stage_head['y'] - 60, 'w': min(vw - stage_head['x'] + 10, stage_head['w'] + 20), 'h': 170}, vw, vh) if stage_head else None
        capture(c, '07-download')
        shots['download'] = {'raw': '07-download.png', 'boxes': download_boxes, 'crop': download_crop, 'dim': 0.4}

        # 8. 全屏
        c.ev("""(() => {
          const s = window.__app.getState();
          s.downloadRunning = false;
          s.downloadPercent = 0;
          window.__app.setDownloadButton();
          window.scrollTo(0, 0);
          return true;
        })()""")
        time.sleep(0.4)
        c.ev('window.__app.toggleFullscreen(); true')
        time.sleep(7)
        hover_video(c)
        time.sleep(0.5)
        fs_boxes = [b for b in [
            box(c, '.stage-head', 0),
            box(c, '#episode-bar', 0),
            box(c, '.episode-auto-next', 1, badge='top'),
        ] if b]
        capture(c, '08-fullscreen')
        shots['fullscreen'] = {'raw': '08-fullscreen.png', 'boxes': fs_boxes, 'legend': True, 'dim': 0.3}
        c.ev('window.__app.toggleFullscreen(); true')
        time.sleep(1.2)

        # 9. 设置
        c.ev("document.querySelector('#btn-settings').click(); true")
        time.sleep(0.7)
        c.ev("document.querySelector('#modal-tabs button[data-tab=\"play\"]').click(); true")
        time.sleep(0.7)
        set_boxes = [b for b in [
            box(c, 'label.switch-row:has(#set-auto-fallback)', 1, badge='right'),
            box(c, 'label.switch-row:has(#set-auto-line-test)', 2, badge='right'),
            box(c, '#btn-open-downloads', 3),
        ] if b]
        capture(c, '09-settings')
        shots['settings'] = {'raw': '09-settings.png', 'boxes': set_boxes, 'dim': 0.2}

        with open(os.path.join(GUIDE_DIR, 'shots.json'), 'w', encoding='utf-8') as f:
            json.dump({'viewport': [vw, vh], 'shots': shots}, f, ensure_ascii=False, indent=2)
        print('shots.json written')
    finally:
        c.close()
        stop(proc)
        httpd.shutdown()


if __name__ == '__main__':
    main()
