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
import io
from urllib.parse import unquote

import qrcode
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

# 短视频教程用的演示结果（不联网，视频用本地 poster.mp4）
SHORT_DEMO = {
    'platformKey': 'bilibili',
    'platformName': '哔哩哔哩',
    'title': '为了解《我相信》的最低音，做了全曲音高标注',
    'author': 'Minecraft明沫',
    'duration': 245,
    'qualities': [
        {'label': '1080P 高清 · 109.8 MB'},
        {'label': '720P 准高清 · 42.4 MB'},
        {'label': '360P 流畅 · 15.7 MB'},
    ],
    'note': '',
}

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

    # 教程里的音乐播放器用一个 269 秒的静音 MP3，保证进度条 / 时长和演示歌曲一致
    demo_audio = os.path.join(WWW, 'demo.mp3')
    if not os.path.exists(demo_audio):
        subprocess.run(
            ['ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
             '-t', '269', '-q:a', '9', demo_audio],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        print('demo audio', demo_audio, os.path.getsize(demo_audio))

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

        # 10. 短视频（演示结果，视频用本地 poster.mp4）
        c.ev("document.querySelector('#modal-close')?.click(); true")
        time.sleep(0.5)
        c.ev("window.__app.switchMode('short', { force: true }); true")
        time.sleep(0.8)
        c.ev(f"""(() => {{
          const demo = {json.dumps(SHORT_DEMO, ensure_ascii=False)};
          const s = window.__app.getState();
          s.shortResult = demo;
          document.querySelector('#short-empty').hidden = true;
          document.querySelector('#short-loading').hidden = true;
          document.querySelector('#short-error').hidden = true;
          document.querySelector('#short-result').hidden = false;
          document.querySelector('#short-reparse').hidden = false;
          const input = document.querySelector('#short-url-input');
          input.value = 'https://www.bilibili.com/video/BV1y7411Q7Eq';
          const badge = document.querySelector('#short-platform-badge');
          badge.textContent = '哔哩哔哩';
          badge.classList.add('known');
          badge.style.setProperty('--brand', '#fb7299');
          document.querySelector('#short-title').textContent = demo.title;
          document.querySelector('#short-meta').textContent = '哔哩哔哩 · Minecraft明沫 · 4:05';
          const sel = document.querySelector('#short-quality');
          sel.innerHTML = '';
          demo.qualities.forEach((q, i) => {{
            const option = document.createElement('option');
            option.value = String(i);
            option.textContent = q.label;
            sel.appendChild(option);
          }});
          const v = document.querySelector('#short-video');
          v.muted = true;
          v.src = 'http://127.0.0.1:{http_port}/poster.mp4';
          v.play().catch(() => {{}});
          document.querySelector('#short-cover').hidden = true;
          document.body.classList.add('short-scroll');
          window.scrollTo(0, 0);
          return true;
        }})()""")
        time.sleep(2.2)
        # 短视频结果是整页滚动的，往下滚一点让「清晰度 / 下载」那排也进画面
        c.ev('window.scrollTo(0, 48); true')
        time.sleep(0.6)
        short_boxes = [b for b in [
            box(c, '.short-platform-grid', 1),
            box(c, '.short-parse-row', 2),
            box(c, '.short-actions', 3),
            box(c, '.short-queue-panel', 4),
        ] if b]
        capture(c, '10-short')
        shots['short'] = {'raw': '10-short.png', 'boxes': short_boxes, 'dim': 0.36}

        # 11. 投屏（演示设备；真实扫描需要局域网里的电视）
        c.ev("""(() => {
          document.querySelector('#modal-close')?.click();
          window.__app.switchMode('long', { force: true });
          const s = window.__app.getState();
          s.lastResult = {
            kind: 'stream',
            title: '演示视频',
            original: 'https://example.com/demo.m3u8',
            playUrl: 'http://127.0.0.1:1/stream?t=demo',
          };
          s.currentTitle = '演示视频';
          s.cast.devices = [
            { id: 'demo-tv', name: '客厅电视', model: 'Smart TV', manufacturer: 'Demo', host: '192.168.1.23' },
            { id: 'demo-projector', name: '投影仪', model: 'Projector', manufacturer: 'Demo', host: '192.168.1.24' },
          ];
          s.cast.casting = true;
          s.cast.deviceId = 'demo-tv';
          s.cast.deviceName = '客厅电视';
          s.cast.transportState = 'PLAYING';
          s.cast.position = 640;
          s.cast.duration = 2764;
          s.cast.error = '';
          document.querySelector('#btn-cast').click();
          return true;
        })()""")
        time.sleep(0.8)
        c.ev("""(() => {
          const s = window.__app.getState();
          s.cast.casting = true;
          s.cast.deviceId = 'demo-tv';
          s.cast.deviceName = '客厅电视';
          s.cast.transportState = 'PLAYING';
          s.cast.position = 640;
          s.cast.duration = 2764;
          const input = document.querySelector('#cast-url');
          input.value = 'http://192.168.1.23:65432/mirror?t=demo&ty=hls&n=演示视频';
          document.querySelector('#cast-scan-status').textContent = '找到 2 个设备，点一下开始投屏';
          document.querySelector('#cast-active').hidden = false;
          document.querySelector('#cast-active-name').textContent = '客厅电视';
          document.querySelector('#cast-active-state').textContent = '正在播放';
          document.querySelector('#cast-progress-bar').style.width = '23.2%';
          document.querySelector('#cast-time-now').textContent = '10:40';
          document.querySelector('#cast-time-total').textContent = '46:04';
          return true;
        })()""")
        time.sleep(0.7)
        c.ev("""(() => {
          document.querySelector('#cast-hint').textContent = '电视端的画面来自电脑上的解析结果，投屏期间请不要关闭电脑端程序；Windows 第一次运行弹出防火墙提示时请选择「允许」，否则电视访问不到电脑。';
          return true;
        })()""")
        qr_img = qrcode.make('http://192.168.1.23:65432/mirror?t=demo&ty=hls&n=演示视频')
        qr_buf = io.BytesIO()
        qr_img.save(qr_buf, format='PNG')
        qr_b64 = base64.b64encode(qr_buf.getvalue()).decode('ascii')
        c.ev(f"""(() => {{
          const img = document.querySelector('#cast-qr');
          img.src = 'data:image/png;base64,{qr_b64}';
          img.hidden = false;
          document.querySelector('#cast-qr-row').hidden = false;
          return true;
        }})()""")
        time.sleep(0.3)
        cast_boxes = [b for b in [
            box(c, '#cast-scan', 1),
            box(c, '#cast-devices', 2),
            box(c, '#cast-active', 3),
            box(c, '#cast-url', 4),
        ] if b]
        cast_modal = rect(c, '.cast-modal')
        cast_crop = clamp_crop({'x': cast_modal['x'] - 18, 'y': cast_modal['y'] - 18, 'w': cast_modal['w'] + 36, 'h': cast_modal['h'] + 36}, vw, vh) if cast_modal else None
        capture(c, '11-cast')
        shots['cast'] = {'raw': '11-cast.png', 'boxes': cast_boxes, 'crop': cast_crop, 'dim': 0.26}
        c.ev("document.querySelector('#cast-close').click(); true")
        time.sleep(0.4)

        # 12. 音乐（演示播放器 + 歌词，不联网）
        music_song = {
            'platform': 'netease',
            'platformName': '网易云音乐',
            'id': 'demo-qingtian',
            'title': '晴天',
            'artist': '周杰伦',
            'album': '叶惠美',
            'cover': 'assets/app-icon.png',
            'duration': 269,
            'vip': False,
        }
        music_lyric = '\n'.join(
            f'[00:{index * 6:02d}.00]{text}'
            for index, text in enumerate([
                '故事的小黄花',
                '从出生那年就飘着',
                '童年的荡秋千',
                '随记忆一直晃到现在',
                '吹着前奏望着天空',
                '我想起花瓣试着掉落',
                '为你翘课的那一天',
                '花落的那一天',
                '教室的那一间',
                '我怎么看不见',
                '消失的下雨天',
                '我好想再淋一遍',
                '没想到失去的勇气我还留着',
                '好想再问一遍',
                '你会等待还是离开',
                '刮风这天我试过握着你手',
                '但偏偏雨渐渐大到我看你不见',
                '还要多久我才能在你身边',
                '等到放晴的那天也许我会比较好一点',
                '从前从前有个人爱你很久',
            ])
        )
        music_result = {
            'ok': True,
            'platform': 'netease',
            'platformName': '网易云音乐',
            'title': '晴天',
            'artist': '周杰伦',
            'album': '叶惠美',
            'cover': 'assets/app-icon.png',
            'duration': 269,
            'format': 'flac',
            'bitrate': 2000000,
            'playUrl': f'http://127.0.0.1:{http_port}/demo.mp3',
            'streamUrl': f'http://127.0.0.1:{http_port}/demo.mp3',
            'referer': '',
            'cookie': '',
            'lyric': music_lyric,
            'translation': '',
            'via': 'hi',
            'viaName': '无损音乐下载',
            'note': '已通过无损音乐下载源取到同名单曲（FLAC）',
            'qualities': [
                {'key': '128', 'label': '标准 128K', 'format': 'mp3', 'available': True},
                {'key': '320', 'label': '高品 320K', 'format': 'mp3', 'available': True},
                {'key': 'flac', 'label': '无损 FLAC', 'format': 'flac', 'available': True},
            ],
        }
        music_results = [
            music_song,
            {**music_song, 'id': 'demo-2', 'title': '稻香', 'album': '魔杰座', 'duration': 223},
            {**music_song, 'id': 'demo-3', 'title': '七里香', 'album': '七里香', 'duration': 299},
            {**music_song, 'id': 'demo-4', 'title': '夜曲', 'album': '十一月的萧邦', 'duration': 226},
        ]
        c.ev("window.scrollTo(0, 0); window.__app.switchMode('music', { force: true }); true")
        time.sleep(0.9)
        c.ev(f""" (async () => {{
          const ok = window.MusicUI.renderDemo({{
            song: {json.dumps(music_song, ensure_ascii=False)},
            result: {json.dumps(music_result, ensure_ascii=False)},
            results: {json.dumps(music_results, ensure_ascii=False)},
          }});
          const audio = document.querySelector('#music-audio');
          await new Promise((resolve) => {{
            if (audio.readyState >= 1) {{ resolve(); return; }}
            audio.addEventListener('loadedmetadata', resolve, {{ once: true }});
            setTimeout(resolve, 2500);
          }});
          audio.pause();
          audio.muted = true;
          try {{ audio.currentTime = 48; }} catch (e) {{}}
          await new Promise((resolve) => setTimeout(resolve, 500));
          document.querySelector('#music-toggle').textContent = '⏸';
          document.querySelector('#music-pos').textContent = '00:48';
          document.querySelector('#music-dur').textContent = '04:29';
          document.querySelector('#music-seek').value = '178';
          document.querySelector('#music-fav').textContent = '♥ 已收藏';
          document.querySelector('#music-fav').classList.add('on');
          window.MusicUI.setActiveLyric(8);
          document.querySelector('#music-panel').scrollTop = 0;
          window.scrollTo(0, 0);
          document.querySelector('#status-text').textContent = '正在播放：晴天 - 周杰伦';
          await new Promise((resolve) => setTimeout(resolve, 700));
          return ok;
        }})()""")
        time.sleep(1.2)
        music_boxes = [b for b in [
            box(c, '.music-platform-grid', 1),
            box(c, '.music-search-row', 2),
            box(c, '.music-actions', 3),
            box(c, '.music-tabs', 4, badge='right'),
        ] if b]
        capture(c, '12-music')
        shots['music'] = {'raw': '12-music.png', 'boxes': music_boxes, 'dim': 0.36}

        with open(os.path.join(GUIDE_DIR, 'shots.json'), 'w', encoding='utf-8') as f:
            json.dump({'viewport': [vw, vh], 'shots': shots}, f, ensure_ascii=False, indent=2)
        print('shots.json written')
    finally:
        c.close()
        stop(proc)
        httpd.shutdown()


if __name__ == '__main__':
    main()
