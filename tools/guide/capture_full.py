"""完整版图文教程截图采集（与 18 分钟视频教程、155 句解说一一对应）。

和旧版 capture.py 的区别：capture.py 只采 12 张「一章一张」的截图；
本脚本按视频教程的分镜采 ~40 张，覆盖每个按钮、每个注意事项，
输出 `.tmp/guide/raw/*.png` + `.tmp/guide/shots.json`，交给 annotate.py 加红框。

用法：
    python tools/guide/capture_full.py                  # 采全部（跳过 11-guide / 11-faq）
    python tools/guide/capture_full.py 11-guide 11-faq   # 教程页面改完后单独补这两张
前置：.tmp/guide/www 里有 poster.mp4 / short-poster.mp4 / demo.mp3。
"""

import base64
import http.server
import io
import json
import os
import subprocess
import sys
import threading
import time

import qrcode
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import capture as cp  # noqa: E402
from capture import (  # noqa: E402
    CDP,
    EP5,
    GUIDE_DIR,
    RAW,
    SERIES,
    USERDATA,
    box,
    capture,
    clamp_crop,
    fix_config,
    hover_video,
    launch,
    open_browser,
    rect,
    scroll_stage,
    seed,
    setup_video,
    stop,
    wait_cdp,
)

ROOT = cp.ROOT
ASSETS = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'assets', 'guide')
SLIDES = os.path.join(ROOT, '.tmp', 'video2', 'install-slides')
SHOTS = {}

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
    'note': 'B站 1080P 是音视频分离流，下载时会自动合并成一个 MP4。',
}

SHORT_SERIES = ['第%d集' % n for n in range(1, 13)]

MUSIC_SONG = {
    'platform': 'netease', 'platformName': '网易云音乐', 'id': 'demo-qingtian',
    'title': '晴天', 'artist': '周杰伦', 'album': '叶惠美',
    'cover': 'assets/app-icon.png', 'duration': 269, 'vip': False,
}
MUSIC_LYRIC = '\n'.join(
    '[00:%02d.00]%s' % (index * 6, text)
    for index, text in enumerate([
        '故事的小黄花', '从出生那年就飘着', '童年的荡秋千', '随记忆一直晃到现在',
        '吹着前奏望着天空', '我想起花瓣试着掉落', '为你翘课的那一天', '花落的那一天',
        '教室的那一间', '我怎么看不见', '消失的下雨天', '我好想再淋一遍',
        '没想到失去的勇气我还留着', '好想再问一遍', '你会等待还是离开',
        '刮风这天我试过握着你手', '但偏偏雨渐渐大到我看你不见', '还要多久我才能在你身边',
        '等到放晴的那天也许我会比较好一点', '从前从前有个人爱你很久',
    ])
)
MUSIC_RESULT = {
    'ok': True, 'platform': 'netease', 'platformName': '网易云音乐',
    'title': '晴天', 'artist': '周杰伦', 'album': '叶惠美', 'cover': 'assets/app-icon.png',
    'duration': 269, 'format': 'flac', 'bitrate': 2000000, 'lyric': MUSIC_LYRIC,
    'via': 'hi', 'viaName': '无损音乐下载', 'note': '已通过公开无损音乐源取到同名单曲（FLAC）',
    'qualities': [
        {'key': '128', 'label': '标准 128K', 'format': 'mp3', 'available': True},
        {'key': '320', 'label': '高品 320K', 'format': 'mp3', 'available': True},
        {'key': 'flac', 'label': '无损 FLAC', 'format': 'flac', 'available': True},
    ],
}
MUSIC_RESULTS = [
    MUSIC_SONG,
    {**MUSIC_SONG, 'id': 'demo-2', 'title': '稻香', 'album': '魔杰座', 'duration': 223},
    {**MUSIC_SONG, 'id': 'demo-3', 'title': '七里香', 'album': '七里香', 'duration': 299},
    {**MUSIC_SONG, 'id': 'demo-4', 'title': '夜曲', 'album': '十一月的萧邦', 'duration': 226},
]


# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------

def js(c, code, wait=0.45):
    c.ev(code)
    time.sleep(wait)


def click(c, sel, wait=0.7):
    c.ev('(() => { const el = document.querySelector(%s); if (el) el.click(); return true; })()' % json.dumps(sel))
    time.sleep(wait)


def modal_crop(c, mask):
    r = rect(c, mask + ' > .modal')
    if not r or r['w'] < 80 or r['h'] < 80:
        print('  ! modal not visible', mask, r, flush=True)
        return None
    pad = 16
    return {'x': r['x'] - pad, 'y': r['y'] - pad, 'w': r['w'] + pad * 2, 'h': r['h'] + pad * 2}


def panel_shot(c, sel, width=800, pad=8):
    """按某个面板的矩形做裁剪，返回可直接 ** 展开给 snap() 的参数。"""
    r = rect(c, sel)
    if not r or r['w'] < 60 or r['h'] < 60:
        print('  ! panel missing', sel, r, flush=True)
        return {}
    return {
        'crop': {'x': r['x'] - pad, 'y': r['y'] - pad, 'w': r['w'] + pad * 2, 'h': r['h'] + pad * 2},
        'width': width,
    }


def snap(c, key, name, boxes, dim=0.36, crop=None, legend=False, width=None):
    capture(c, key)
    vw, vh = c.ev('[innerWidth, innerHeight]')
    meta = {
        'raw': key + '.png',
        'name': name,
        'boxes': [b for b in boxes if b],
        'dim': dim,
    }
    if width:
        meta['width'] = width
    if crop:
        if crop['w'] < 120 or crop['h'] < 60:
            print('  ! crop too small, ignored', crop, flush=True)
        else:
            meta['crop'] = clamp_crop(crop, vw, vh)
    if legend:
        meta['legend'] = True
    SHOTS[key] = meta
    with open(os.path.join(GUIDE_DIR, 'shots.json'), 'w', encoding='utf-8') as f:
        json.dump({'viewport': [vw, vh], 'shots': SHOTS}, f, ensure_ascii=False, indent=2)
    print('  shot %-16s -> %-24s %d boxes' % (key, name, len(meta['boxes'])), flush=True)


def reset_long_empty(c):
    js(c, """(() => {
      document.querySelectorAll('.modal-mask').forEach((m) => { m.hidden = true });
      try { window.__app.hideBrowser(); } catch (e) {}
      try { window.__app.switchMode('long', { force: true }); } catch (e) {}
      document.body.classList.remove('cinema', 'page-scroll', 'short-scroll');
      window.scrollTo(0, 0);
      const v = document.querySelector('#video');
      if (v) { try { v.pause(); } catch (e) {} }
      ['empty','loading','error','video','webview'].forEach((id) => {
        const el = document.querySelector('#view-' + id);
        if (el) el.hidden = id !== 'empty';
      });
      document.querySelector('#stage').classList.remove('stage-playing');
      document.querySelector('#episode-bar').hidden = true;
      document.querySelector('#stage-title-text').textContent = '等待解析';
      document.querySelector('#stage-line').textContent = '未选择线路';
      document.querySelector('#source-url').textContent = '尚未解析';
      const input = document.querySelector('#url-input');
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('#status-text').textContent = '就绪 · 共 5 条可用线路';
      return true;
    })()""", 0.9)


# ---------------------------------------------------------------------------
# A. 长视频空状态
# ---------------------------------------------------------------------------

def capture_empty(c):
    reset_long_empty(c)
    scroll_stage(c)

    snap(c, 'g-overview', 'guide-01-overview',
         [box(c, '#mode-switch', 1, badge='inside'),
          box(c, '.platform-grid', 2),
          box(c, '#url-box', 3),
          box(c, '.stage-body', 4),
          box(c, '.side', 5),
          box(c, '.statusbar', 6, badge='top')],
         dim=0.4)

    snap(c, 'g-header', 'guide-01-header',
         [box(c, '#mode-switch', 1, badge='inside'),
          box(c, '#btn-search', 2, badge='top'),
          box(c, '#btn-guide', 3, badge='top'),
          box(c, '#btn-auth', 4, badge='top'),
          box(c, '#btn-lines', 5, badge='top'),
          box(c, '#btn-settings', 6, badge='top')],
         dim=0.22, crop={'x': 0, 'y': 0, 'w': 1290, 'h': 180})

    js(c, """(() => {
      const input = document.querySelector('#url-input');
      input.value = %s;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const badge = document.querySelector('#platform-badge');
      return badge.textContent;
    })()""" % json.dumps(EP5), 0.8)
    snap(c, 'g-paste', 'guide-02-paste',
         [box(c, '#url-box', 1),
          box(c, '#line-select', 2),
          box(c, '#btn-parse', 3)],
         dim=0.42, crop={'x': 0, 'y': 236, 'w': 1290, 'h': 148})

    js(c, """(() => {
      ['empty','error','video','webview'].forEach((id) => { document.querySelector('#view-' + id).hidden = true });
      document.querySelector('#view-loading').hidden = false;
      document.querySelector('#loading-title').textContent = '正在连接解析线路…';
      document.querySelector('#loading-detail').textContent = '首次加载可能稍慢，长时间无画面请点击「换线路」。';
      document.querySelector('#status-text').textContent = '正在解析：今天是太阳雨 第5集 ……';
      document.querySelector('#stage-title-text').textContent = '正在解析';
      document.querySelector('#stage-line').textContent = '789解析';
      return true;
    })()""", 0.8)
    snap(c, 'g-loading', 'guide-02-loading',
         [box(c, '#view-loading', 0),
          box(c, '.statusbar', 1, badge='top')],
         dim=0.3, crop={'x': 0, 'y': 300, 'w': 1290, 'h': 470})

    js(c, """(() => {
      ['empty','loading','video','webview'].forEach((id) => { document.querySelector('#view-' + id).hidden = true });
      document.querySelector('#view-error').hidden = false;
      document.querySelector('#error-title').textContent = '这条线路没有解析成功';
      document.querySelector('#error-detail').textContent = '可能是线路失效，或者当前地区不可用。可以重试、换一条线路，或者用官网观看。';
      document.querySelector('#error-night').hidden = true;
      document.querySelector('#status-text').textContent = '解析失败：789解析';
      document.querySelector('#stage-title-text').textContent = '解析失败';
      document.querySelector('#stage-line').textContent = '789解析';
      return true;
    })()""", 0.8)
    snap(c, 'g-error', 'guide-02-error',
         [box(c, '#btn-error-retry', 1),
          box(c, '#btn-error-next', 2),
          box(c, '#btn-error-official', 3),
          box(c, '#btn-error-lines', 4),
          box(c, '#stage-line', 0)],
         dim=0.24, crop={'x': 0, 'y': 300, 'w': 1290, 'h': 470})

    js(c, """(() => {
      document.querySelector('#error-title').textContent = '解析失败 · 夜间提示';
      document.querySelector('#error-detail').textContent = '第三方解析平台在晚上十点半以后基本会停止工作。';
      const night = document.querySelector('#error-night');
      night.hidden = false;
      night.textContent = '夜间解析平台不再工作，明天再来试试吧';
      return true;
    })()""", 0.8)
    snap(c, 'g-night', 'guide-11-night',
         [box(c, '#error-night', 1), box(c, '#view-error', 0)],
         dim=0.24, crop={'x': 0, 'y': 300, 'w': 1290, 'h': 470})
    reset_long_empty(c)


# ---------------------------------------------------------------------------
# B. 长视频播放中
# ---------------------------------------------------------------------------

def capture_playing(c, http_port):
    setup_video(c, http_port)
    scroll_stage(c)
    hover_video(c)
    time.sleep(0.6)

    snap(c, 'g-tools', 'guide-01-tools',
         [box(c, '#btn-reload', 1, badge='top'),
          box(c, '#btn-next-line', 2, badge='top'),
          box(c, '#btn-download', 3, badge='top'),
          box(c, '#btn-cast', 4, badge='top'),
          box(c, '#btn-open-web', 5, badge='top'),
          box(c, '#btn-fullscreen', 6, badge='top')],
         dim=0.3, crop={'x': 0, 'y': 30, 'w': 1290, 'h': 150})

    bar = rect(c, '#episode-bar')
    ep_crop = {'x': 0, 'y': 0, 'w': 1290, 'h': (bar['y'] + bar['h'] + 16) if bar else 860}
    snap(c, 'g-episodes', 'guide-04-episodes',
         [box(c, '#episode-bar', 0),
          box(c, '.episode-auto-next', 1, badge='top'),
          box(c, '#episode-list .episode-item.active', 2),
          box(c, '#episode-prev', 3, badge='top'),
          box(c, '#episode-next', 4, badge='top'),
          box(c, '#episode-order', 5, badge='top'),
          box(c, '#episode-toggle', 6, badge='top')],
         dim=0.34, crop=ep_crop)

    js(c, "const l=document.querySelector('#history-list'); if (l) l.scrollTop = 0; true", 0.4)
    hist = rect(c, '.history-panel')
    hist_crop = None
    if hist:
        hist_crop = {'x': hist['x'] - 8, 'y': hist['y'] - 6, 'w': 1290 - hist['x'] + 8, 'h': hist['h'] + 12}
    snap(c, 'g-history', 'guide-05-history',
         [box(c, '.history-panel', 0),
          box(c, '#history-list .history-item', 1),
          box(c, '#history-list .history-item .history-cover', 2),
          box(c, '#history-list .history-item .history-meta', 3, badge='right'),
          box(c, '#history-list .history-item .history-progress', 4, badge='right')],
         dim=0.42, crop=hist_crop, width=800)

    snap(c, 'g-history-tools', 'guide-05-tools',
         [box(c, '#history-search-input', 1),
          box(c, '#history-sort', 2, badge='top'),
          box(c, '#btn-clear-history', 3, badge='top'),
          box(c, '#history-list .history-item .history-del', 4, badge='right')],
         dim=0.28, crop=hist_crop, width=800)

    line_panel = rect(c, '.side .panel:first-child')
    line_crop = None
    if line_panel:
        # 顶部留一点空，别把面板标题切掉
        line_crop = {'x': line_panel['x'] - 8, 'y': max(0, line_panel['y'] - 18), 'w': 1290 - line_panel['x'] + 8,
                     'h': line_panel['h'] + 26}
    snap(c, 'g-lines', 'guide-06-lines',
         [box(c, '#line-list', 1),
          box(c, '#line-list .line-item.disabled', 2, badge='right'),
          box(c, '#line-list .line-item.dead', 3, badge='right')],
         dim=0.44, crop=line_crop, width=800)

    js(c, """(() => {
      const s = window.__app.getState();
      s.downloadRunning = true;
      s.downloadPercent = 42;
      window.__app.setDownloadButton();
      return true;
    })()""", 0.7)
    hover_video(c)
    time.sleep(0.4)
    stage_head = rect(c, '.stage-head')
    head_crop = None
    if stage_head:
        head_crop = {'x': 0, 'y': stage_head['y'] - 46, 'w': 1290, 'h': 132}
    snap(c, 'g-download', 'guide-07-download',
         [box(c, '#btn-download', 1, badge='top'),
          box(c, '#btn-reload', 2, badge='top'),
          box(c, '#btn-open-web', 3, badge='top')],
         dim=0.3, crop=head_crop)

    js(c, """(() => {
      const s = window.__app.getState();
      s.downloadRunning = false;
      s.downloadPercent = 0;
      window.__app.setDownloadButton();
      window.scrollTo(0, 0);
      return true;
    })()""", 0.5)
    click(c, '#btn-fullscreen', 6.5)
    hover_video(c)
    time.sleep(0.6)
    snap(c, 'g-full', 'guide-08-full',
         [box(c, '.stage-head', 0),
          box(c, '#episode-bar', 0),
          box(c, '.episode-auto-next', 1, badge='top')],
         dim=0.3, legend=True)
    click(c, '#btn-fullscreen', 1.5)

    # 设置：解析线路页（= 线路管理）
    click(c, '#btn-settings', 0.9)
    click(c, '#modal-tabs button[data-tab="lines"]', 0.8)
    snap(c, 'g-lines-manage', 'guide-06-manage',
         [box(c, '#line-editor', 1),
          box(c, '#btn-add-line', 2, badge='top'),
          box(c, '#btn-online-lines', 3, badge='top'),
          box(c, '#btn-clean-lines', 4, badge='top'),
          box(c, '#btn-reset-lines', 5, badge='top'),
          box(c, '#btn-save-lines', 6, badge='top')],
         dim=0.24, crop=modal_crop(c, '#modal'))

    # 设置：播放页 / 更新页 / 关于页
    click(c, '#modal-tabs button[data-tab="play"]', 0.8)
    snap(c, 'g-settings-play', 'guide-10-play',
         [box(c, 'label.switch-row:has(#set-auto-fallback)', 1, badge='right'),
          box(c, 'label.switch-row:has(#set-close-tray)', 2, badge='right'),
          box(c, 'label.switch-row:has(#set-auto-line-test)', 3, badge='right'),
          box(c, '#btn-open-downloads', 4)],
         dim=0.2, crop=modal_crop(c, '#modal'))

    click(c, '#modal-tabs button[data-tab="update"]', 0.8)
    snap(c, 'g-settings-update', 'guide-10-update',
         [box(c, '#set-version', 1, badge='right'),
          box(c, 'label.switch-row:has(#set-auto-update)', 2, badge='right'),
          box(c, '#btn-check-update', 3, badge='top'),
          box(c, '#update-status', 4, badge='right')],
         dim=0.2, crop=modal_crop(c, '#modal'))

    click(c, '#modal-tabs button[data-tab="about"]', 0.8)
    snap(c, 'g-settings-about', 'guide-10-about',
         [box(c, '#btn-about-guide', 1, badge='top'),
          box(c, '#btn-open-changelog', 2, badge='top'),
          box(c, '#btn-admin-panel', 3, badge='top'),
          box(c, '#btn-open-repo', 4, badge='top'),
          box(c, '#btn-open-userdata', 5, badge='top'),
          box(c, '#btn-open-logs', 6, badge='top'),
          box(c, '#btn-create-shortcut', 7, badge='top')],
         dim=0.2, crop=modal_crop(c, '#modal'))
    click(c, '#modal-close', 0.6)

    # 登录闸门 + 反馈页签（v1.5.0 新增）
    js(c, """(() => {
      document.querySelectorAll('.modal-mask').forEach((m) => { m.hidden = true });
      const gate = document.querySelector('#account-gate');
      gate.hidden = false;
      document.querySelector('#gate-msg').textContent = '';
      return true;
    })()""", 0.9)
    snap(c, 'g-gate', 'guide-14-login',
         [box(c, '#gate-tabs', 1, badge='top'),
          box(c, '#gate-account', 2),
          box(c, '#gate-password', 3),
          box(c, '#gate-password-form button[type="submit"]', 4, badge='right'),
          box(c, '#gate-tabs button[data-gate-tab="register"]', 5, badge='top')],
         dim=0.16, crop=panel_shot(c, '.gate-shell', width=900).get('crop'))
    js(c, "document.querySelector('#account-gate').hidden = true; true", 0.6)

    # 反馈页新版布局比旧版高（通栏字段 + 底部提交行），默认窗口高度装不下「我的反馈」，
    # 截这张之前临时把视口加高，保证 ①–⑤ 都在同一张图里；capture() 结束时会清掉覆盖，后面恢复原尺寸。
    c.send('Emulation.setDeviceMetricsOverride', {'width': 1440, 'height': 1000, 'deviceScaleFactor': 2, 'mobile': False})
    time.sleep(0.8)
    click(c, '#btn-settings', 0.8)
    click(c, '#modal-tabs button[data-tab="feedback"]', 0.9)
    js(c, """(() => {
      const box = document.querySelector('#fb-mine');
      if (box) {
        box.innerHTML = '<div class="fb-item">' +
          '<header><span class="fb-tag replied">已回复</span><span class="fb-tag">功能建议</span><span>★ 5</span><span>2026/11/24 12:40</span></header>' +
          '<div class="content">希望增加一个「按平台筛选历史」的开关。</div>' +
          '<div class="reply"><b>作者回复</b> · 2026/11/24 13:05<br>已记录，下个版本加上。</div>' +
          '</div>';
      }
      return true;
    })()""", 0.5)
    snap(c, 'g-feedback', 'guide-14-feedback',
         [box(c, '#fb-type', 1, badge='right'),
          box(c, '#fb-rating', 2, badge='right'),
          box(c, '#fb-content', 3),
          box(c, '#fb-form button[type="submit"]', 4, badge='top'),
          box(c, '#fb-mine', 5)],
         dim=0.2, crop=modal_crop(c, '#modal'))
    click(c, '#modal-close', 0.6)

    # 下载目录（播放页的下载 / 离线分组）
    click(c, '#btn-settings', 0.8)
    click(c, '#modal-tabs button[data-tab="play"]', 0.7)
    js(c, """(() => {
      const note = [...document.querySelectorAll('.tab-pane[data-pane="play"] .settings-note')].pop();
      if (note) note.scrollIntoView({ block: 'center' });
      return true;
    })()""", 0.7)
    pane = rect(c, '.tab-pane[data-pane="play"]')
    dir_crop = {'x': pane['x'] - 20, 'y': pane['y'] + 300, 'w': pane['w'] + 40, 'h': 240} if pane else None
    snap(c, 'g-dir', 'guide-07-dir',
         [box(c, '#btn-open-downloads', 1, badge='top')],
         dim=0.18, crop=dir_crop)
    click(c, '#modal-close', 0.6)

    # 登录与限制
    click(c, '#btn-auth', 1.4)
    snap(c, 'g-auth', 'guide-10-auth',
         [box(c, '#auth-long-list', 1),
          box(c, '#auth-long-list .auth-row .auth-login-btn', 2, badge='right'),
          box(c, '#auth-modal .auth-limits', 3),
          box(c, '#auth-modal .auth-sub', 4, badge='right')],
         dim=0.18, crop=modal_crop(c, '#auth-modal'))
    click(c, '#auth-close', 0.6)


# ---------------------------------------------------------------------------
# C. 投屏
# ---------------------------------------------------------------------------

def capture_cast(c, http_port):
    js(c, """(() => {
      const s = window.__app.getState();
      s.lastResult = { kind: 'stream', title: '今天是太阳雨 第5集', playUrl: 'http://127.0.0.1:%d/poster.mp4' };
      s.currentTitle = '今天是太阳雨 第5集';
      s.currentEpisode = '第5集';
      s.cast.devices = [
        { id: 'demo-tv', name: '客厅电视', model: 'Smart TV', manufacturer: 'Demo', host: '192.168.1.23' },
        { id: 'demo-projector', name: '投影仪', model: 'Projector', manufacturer: 'Demo', host: '192.168.1.24' },
      ];
      s.cast.casting = false;
      s.cast.scanning = false;
      s.cast.deviceId = '';
      s.cast.deviceName = '';
      s.cast.error = '';
      s.cast.pageOnly = false;
      document.querySelector('#btn-cast').click();
      return document.querySelector('#cast-modal').hidden;
    })()""" % http_port, 1.4)
    js(c, """(() => {
      document.querySelector('#cast-scan-status').textContent = '找到 2 个设备，点一下开始投屏';
      const active = document.querySelector('#cast-active');
      active.hidden = true;
      return true;
    })()""", 0.6)
    snap(c, 'g-cast-devices', 'guide-09-cast-devices',
         [box(c, '#cast-scan', 1, badge='top'),
          box(c, '#cast-devices', 2)],
         dim=0.2, crop=modal_crop(c, '#cast-modal'))

    js(c, """(() => {
      const s = window.__app.getState();
      s.cast.casting = true;
      s.cast.deviceId = 'demo-tv';
      s.cast.deviceName = '客厅电视';
      s.cast.transportState = 'PLAYING';
      s.cast.position = 640;
      s.cast.duration = 2764;
      const active = document.querySelector('#cast-active');
      active.hidden = false;
      document.querySelector('#cast-active-name').textContent = '客厅电视';
      document.querySelector('#cast-active-state').textContent = '正在播放';
      document.querySelector('#cast-progress-bar').style.width = '23.2%';
      document.querySelector('#cast-time-now').textContent = '10:40';
      document.querySelector('#cast-time-total').textContent = '46:04';
      document.querySelector('#cast-toggle').textContent = '暂停';
      return true;
    })()""", 0.8)
    active = rect(c, '#cast-active')
    active_crop = None
    if active:
        active_crop = {'x': active['x'] - 14, 'y': active['y'] - 14, 'w': active['w'] + 28, 'h': active['h'] + 34}
    snap(c, 'g-cast-active', 'guide-09-cast-active',
         [box(c, '#cast-active', 0),
          box(c, '#cast-back', 1, badge='top'),
          box(c, '#cast-toggle', 2, badge='top'),
          box(c, '#cast-forward', 3, badge='top'),
          box(c, '#cast-stop', 4, badge='top')],
         dim=0.18, crop=active_crop)

    qr_img = qrcode.make('http://192.168.1.23:65432/mirror?t=demo&ty=hls&n=演示视频')
    buf = io.BytesIO()
    qr_img.save(buf, format='PNG')
    qr_b64 = base64.b64encode(buf.getvalue()).decode('ascii')
    js(c, """(() => {
      const input = document.querySelector('#cast-url');
      input.value = 'http://192.168.1.23:65432/mirror?t=demo&ty=hls&n=演示视频';
      const img = document.querySelector('#cast-qr');
      img.src = 'data:image/png;base64,%s';
      img.hidden = false;
      document.querySelector('#cast-qr-row').hidden = false;
      const body = document.querySelector('#cast-modal .cast-body');
      if (body) body.scrollTop = body.scrollHeight;
      return true;
    })()""" % qr_b64, 0.9)
    modal = rect(c, '#cast-modal > .modal')
    qr_crop = None
    if modal and modal['h'] > 80:
        qr_crop = {'x': modal['x'] - 16, 'y': modal['y'] + modal['h'] * 0.30,
                   'w': modal['w'] + 32, 'h': modal['h'] * 0.70}
    snap(c, 'g-cast-qr', 'guide-09-cast-qr',
         [box(c, '#cast-qr-row', 1),
          box(c, '#cast-url', 2, badge='top'),
          box(c, '#cast-copy-url', 3, badge='top')],
         dim=0.16, crop=qr_crop)

    js(c, """(() => {
      const hint = document.querySelector('#cast-hint');
      hint.textContent = '789 等网页线路：先在网页里点播放，等画面出来再点投屏，程序会抓真实 m3u8 / mp4 再推给电视；抓不到时，二维码可以直接打开当前解析页。投屏期间电脑端不要退出软件。';
      const body = document.querySelector('#cast-modal .cast-body');
      if (body) body.scrollTop = body.scrollHeight;
      return true;
    })()""", 0.9)
    modal = rect(c, '#cast-modal > .modal')
    hint_crop = None
    if modal and modal['h'] > 80:
        hint_crop = {'x': modal['x'] - 16, 'y': modal['y'] + modal['h'] * 0.52,
                     'w': modal['w'] + 32, 'h': modal['h'] * 0.48 + 16}
    snap(c, 'g-cast-hint', 'guide-09-cast-hint',
         [box(c, '#cast-hint', 1),
          box(c, '#cast-url', 2, badge='top')],
         dim=0.18, crop=hint_crop)
    click(c, '#cast-close', 0.6)


# ---------------------------------------------------------------------------
# D. 内置浏览器 + 找剧
# ---------------------------------------------------------------------------

def capture_browser(c):
    open_browser(c)
    panel = rect(c, '#browser-panel')
    panel_crop = {'x': panel['x'], 'y': panel['y'], 'w': panel['w'], 'h': panel['h']} if panel else None
    snap(c, 'g-browser', 'guide-03-browser',
         [box(c, '#browser-tabs', 1, badge='top'),
          box(c, '.browser-address', 2, badge='top'),
          box(c, '.browser-auto', 3, badge='top'),
          box(c, '#browser-parse', 4, badge='top')],
         dim=0.3, crop=panel_crop)

    bar = rect(c, '.browser-bar')
    bar_crop = {'x': 0, 'y': bar['y'] - 34, 'w': 1290, 'h': bar['h'] + 44} if bar else None
    snap(c, 'g-browser-addr', 'guide-03-addr',
         [box(c, '#browser-back', 1, badge='top'),
          box(c, '#browser-forward', 2, badge='top'),
          box(c, '#browser-reload', 3, badge='top'),
          box(c, '#browser-address', 4, badge='top'),
          box(c, '.browser-auto', 5, badge='top'),
          box(c, '#browser-parse', 6, badge='top')],
         dim=0.16, crop=bar_crop)

    js(c, """(() => { try { window.__app.hideBrowser(); } catch (e) {} return true; })()""", 0.7)

    # 找剧：注入演示结果（不联网），结构和 renderSearchResults 一致
    click(c, '#btn-search', 0.8)
    js(c, """(() => {
      const input = document.querySelector('#search-input');
      input.value = '庆余年';
      const box = document.querySelector('#search-results');
      box.hidden = false;
      const groups = [
        { key: 'iqiyi', name: '爱奇艺', icon: 'assets/platform-iqiyi.png',
          items: [['庆余年 第二季 第18集', 1], ['庆余年 第一季 第1集', 1], ['庆余年 第二季（剧集页）', 0]] },
        { key: 'qq', name: '腾讯视频', icon: 'assets/platform-qq.png',
          items: [['庆余年 第二季 第18集', 1], ['庆余年 第二季 · 特别版', 0]] },
        { key: 'mgtv', name: '芒果TV', icon: 'assets/platform-mgtv.png', items: [] },
      ];
      box.innerHTML = groups.map((g) => `
        <div class="search-group">
          <div class="search-group-head"><img src="${g.icon}" alt="" /><b>${g.name}</b>
            <span>${g.items.length ? g.items.length + ' 条' : '未获取到'}</span>
            <button class="search-open-page">打开平台页</button>
          </div>
          <div class="search-group-items">
            ${g.items.length
              ? g.items.map(([title, ep]) => `<button class="search-result">${title}<small>${ep ? '单集 · 点击直接解析' : '剧集页 · 点击打开选集'}</small></button>`).join('')
              : '<div class="search-error">没有找到相关结果</div>'}
          </div>
        </div>`).join('');
      const status = document.querySelector('#search-status');
      status.hidden = false;
      status.textContent = '共找到 5 条结果 · 点击结果直接播放或打开剧集页';
      return true;
    })()""", 0.9)
    snap(c, 'g-find', 'guide-03-find',
         [box(c, '.search-input-row', 1, badge='top'),
          box(c, '#platform-picks', 2),
          box(c, '#search-results .search-group:first-child .search-result', 3, badge='right'),
          box(c, '.search-open-page', 4, badge='top')],
         dim=0.14, crop=modal_crop(c, '#search-modal'))
    click(c, '#search-close', 0.6)


# ---------------------------------------------------------------------------
# E. 短视频
# ---------------------------------------------------------------------------

def short_state(c, http_port):
    js(c, """(() => {
      document.querySelectorAll('.modal-mask').forEach((m) => { m.hidden = true });
      window.__app.switchMode('short', { force: true });
      window.scrollTo(0, 0);
      return true;
    })()""", 0.9)

    # 1) 空状态：五个平台
    snap(c, 'g-short', 'guide-12-short',
         [box(c, '#short-platform-grid', 1),
          box(c, '.short-parse-row', 2)],
         dim=0.3, crop={'x': 0, 'y': 20, 'w': 1290, 'h': 330})

    # 2) 解析结果
    js(c, """(() => {
      const demo = %s;
      const s = window.__app.getState();
      s.shortResult = demo;
      s.shortQualityIndex = 0;
      s.shortSelected = new Set([0, 1, 2, 3, 4, 5]);
      document.querySelector('#short-empty').hidden = true;
      document.querySelector('#short-loading').hidden = true;
      document.querySelector('#short-error').hidden = true;
      document.querySelector('#short-result').hidden = false;
      document.querySelector('#short-reparse').hidden = false;
      const input = document.querySelector('#short-url-input');
      input.value = 'https://b23.tv/BV1y7411Q7Eq';
      const badge = document.querySelector('#short-platform-badge');
      badge.textContent = '哔哩哔哩';
      badge.classList.add('known');
      badge.style.setProperty('--brand', '#fb7299');
      document.querySelector('#short-title').textContent = demo.title;
      document.querySelector('#short-meta').textContent = '哔哩哔哩 · Minecraft明沫 · 4:05';
      const sel = document.querySelector('#short-quality');
      sel.innerHTML = '';
      demo.qualities.forEach((q, i) => {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = q.label;
        sel.appendChild(option);
      });
      const note = document.querySelector('#short-note');
      note.textContent = demo.note;
      note.hidden = false;
      const v = document.querySelector('#short-video');
      v.muted = true;
      v.src = 'http://127.0.0.1:%d/short-poster.mp4';
      v.pause();
      document.querySelector('#short-cover').hidden = true;
      document.body.classList.add('short-scroll');
      return true;
    })()""" % (json.dumps(SHORT_DEMO, ensure_ascii=False), http_port), 2.0)
    js(c, """(() => { const v = document.querySelector('#short-video'); try { v.currentTime = 20; v.pause(); } catch (e) {} return true })()""", 0.8)
    js(c, """(() => {
      const actions = document.querySelector('.short-actions');
      if (actions) actions.scrollIntoView({ block: 'center' });
      return true;
    })()""", 0.9)
    player = rect(c, '#short-player')
    actions = rect(c, '.short-actions')
    note = rect(c, '#short-note')
    result_crop = None
    if player and actions:
        top = max(0, player['y'] - 10)
        bottom = actions['y'] + actions['h']
        if note and note['h'] > 4:
            bottom = max(bottom, note['y'] + note['h'])
        result_crop = {'x': 0, 'y': top, 'w': 1290, 'h': (bottom + 16) - top}
    snap(c, 'g-short-result', 'guide-12-result',
         [box(c, '.short-actions', 1, badge='top'),
          box(c, '#short-player', 2),
          box(c, '#short-note', 3, badge='right')],
         dim=0.3, crop=result_crop)

    # 3) 分集 + 全选 + 一键下载全集
    js(c, """(() => {
      const box = document.querySelector('#short-series');
      box.hidden = false;
      document.querySelector('#short-series-title').textContent = '铃芽之旅';
      document.querySelector('#short-series-count').textContent = '12 集';
      const list = document.querySelector('#short-episodes');
      const names = %s;
      list.innerHTML = names.map((label, i) => `
        <button class="short-episode${i < 6 ? ' on' : ''}" data-index="${i}" title="铃芽之旅 ${label}">
          <span class="ep-check">${i < 6 ? '✓' : ''}</span>
          <span class="ep-label">${label}</span>
        </button>`).join('');
      window.__app.scrollTo?.(0);
      return true;
    })()""" % json.dumps(SHORT_SERIES, ensure_ascii=False), 0.9)
    js(c, "(() => { const el = document.querySelector('#short-series'); if (el) el.scrollIntoView({ block: 'center' }); return true })()", 0.8)
    series = rect(c, '#short-series')
    series_crop = None
    if series:
        series_crop = {'x': series['x'] - 12, 'y': series['y'] - 12, 'w': series['w'] + 24, 'h': series['h'] + 24}
    snap(c, 'g-short-series', 'guide-12-series',
         [box(c, '#short-select-all', 1, badge='top'),
          box(c, '#short-download-all', 2, badge='top'),
          box(c, '#short-episodes', 3),
          box(c, '#short-series-count', 4, badge='right')],
         dim=0.24, crop=series_crop)

    # 4) 下载队列（2 条：已完成 + 已中断，正好一屏放得下）
    js(c, """(() => {
      const s = window.__app.getState();
      s.shortQueue = [
        { id: 'sq1', title: '铃芽之旅 第1集', platform: '哔哩哔哩', status: 'done', percent: 100,
          savedPath: 'D:\\\\音视频解析下载\\\\铃芽之旅\\\\第1集.mp4', at: Date.now() },
        { id: 'sq3', title: '铃芽之旅 第3集', platform: '哔哩哔哩', status: 'interrupted', percent: 37,
          savedPath: '', at: Date.now() - 90000 },
      ];
      window.__app.renderShortQueue();
      return true;
    })()""", 0.9)
    js(c, "(() => { const el = document.querySelector('.short-queue-panel'); if (el) el.scrollIntoView({ block: 'center' }); return true })()", 0.8)
    queue = rect(c, '.short-queue-panel')
    queue_crop = None
    if queue:
        queue_crop = {'x': queue['x'] - 8, 'y': queue['y'] - 8, 'w': 1290 - queue['x'] + 8, 'h': queue['h'] + 20}
    snap(c, 'g-short-queue', 'guide-12-queue',
         [box(c, '.short-queue-item.done .q-btn[data-qaction="reveal"]', 1, badge='right'),
          box(c, '.short-queue-item.done .q-btn.danger', 2, badge='right'),
          box(c, '#short-queue-clear', 3, badge='top'),
          box(c, '#short-open-folder', 4, badge='top'),
          box(c, '.short-queue-item.interrupted', 5, badge='right')],
         dim=0.24, crop=queue_crop, width=800)

    # 5) 短视频历史
    js(c, """(() => {
      const list = document.querySelector('#short-history-list');
      const rows = [
        ['为了解《我相信》的最低音，做了全曲音高标注', '哔哩哔哩', '4:05'],
        ['铃芽之旅 第1集', '哔哩哔哩', '0:58'],
        ['海边日落延时摄影', '抖音', '0:21'],
      ];
      list.innerHTML = rows.map(([title, platform, time]) => `
        <li class="short-history-item">
          <span class="short-history-cover ph">▶</span>
          <span class="short-history-main"><b>${title}</b><small>${platform} · ${time}</small></span>
          <button class="short-history-del" title="删除这条记录">×</button>
        </li>`).join('');
      document.querySelector('#short-history-legend').textContent = '3 条';
      return true;
    })()""", 0.9)
    js(c, "(() => { const el = document.querySelector('.short-history-panel'); if (el) el.scrollIntoView({ block: 'center' }); return true })()", 0.8)
    hist = rect(c, '.short-history-panel')
    hist_crop = None
    if hist:
        hist_crop = {'x': hist['x'] - 8, 'y': hist['y'] - 8, 'w': 1290 - hist['x'] + 8, 'h': hist['h'] + 20}
    snap(c, 'g-short-history', 'guide-12-history',
         [box(c, '.short-history-item', 1),
          box(c, '.short-history-del', 2, badge='right'),
          box(c, '#short-history-clear', 3, badge='top'),
          box(c, '#short-history-legend', 4, badge='right')],
         dim=0.24, crop=hist_crop, width=800)


# ---------------------------------------------------------------------------
# F. 音乐
# ---------------------------------------------------------------------------

def capture_music(c, http_port):
    js(c, "document.querySelectorAll('.modal-mask').forEach((m) => { m.hidden = true }); window.scrollTo(0, 0); window.__app.switchMode('music', { force: true }); true", 1.0)
    snap(c, 'g-music', 'guide-13-music',
         [box(c, '#music-platform-grid', 1),
          box(c, '.music-search-row', 2),
          box(c, '#music-list', 3, badge='right')],
         dim=0.3, crop={'x': 0, 'y': 20, 'w': 1290, 'h': 300})

    js(c, """(async () => {
      const ok = window.MusicUI.renderDemo({
        song: %s,
        result: %s,
        results: %s,
      });
      const audio = document.querySelector('#music-audio');
      await new Promise((resolve) => {
        if (audio.readyState >= 1) { resolve(); return; }
        audio.addEventListener('loadedmetadata', resolve, { once: true });
        setTimeout(resolve, 2500);
      });
      audio.pause();
      audio.muted = true;
      try { audio.currentTime = 48; } catch (e) {}
      await new Promise((resolve) => setTimeout(resolve, 500));
      document.querySelector('#music-toggle').textContent = '⏸';
      document.querySelector('#music-pos').textContent = '00:48';
      document.querySelector('#music-dur').textContent = '04:29';
      document.querySelector('#music-seek').value = '178';
      window.MusicUI.setActiveLyric(8);
      document.querySelector('#music-panel').scrollTop = 0;
      const note = document.querySelector('#music-note');
      if (note) note.hidden = true;
      window.scrollTo(0, 210);
      document.querySelector('#status-text').textContent = '正在播放：晴天 - 周杰伦';
      await new Promise((resolve) => setTimeout(resolve, 700));
      return ok;
    })()""" % (json.dumps(MUSIC_SONG, ensure_ascii=False),
               json.dumps(MUSIC_RESULT, ensure_ascii=False),
               json.dumps(MUSIC_RESULTS, ensure_ascii=False)), 1.6)

    js(c, "const note = document.querySelector('#music-note'); if (note) note.style.display = 'none'; window.scrollTo(0, 210); true", 0.6)

    snap(c, 'g-music-player', 'guide-13-player',
         [box(c, '#music-player', 1),
          box(c, '.music-cover-box', 2),
          box(c, '#music-lyrics', 3),
          box(c, '.music-controls', 4, badge='top'),
          box(c, '.music-actions', 5, badge='top')],
         dim=0.26, crop={'x': 0, 'y': 0, 'w': 1278, 'h': 779})

    snap(c, 'g-music-tabs', 'guide-13-tabs',
         [box(c, '#music-tabs', 1, badge='top'),
          box(c, '#music-list-head', 2, badge='top'),
          box(c, '#music-list .music-row', 3)],
         dim=0.24, **panel_shot(c, '.music-list-panel', 800))

    # 下载记录
    js(c, """(() => {
      const st = window.MusicUI.state;
      st.downloads = [
        { id: 'm1', title: '晴天', platformName: '网易云音乐', format: 'flac', status: 'done', percent: 100,
          savedPath: 'D:\\\\音视频解析下载\\\\音乐\\\\网易云音乐\\\\晴天 - 周杰伦.flac', at: Date.now() },
        { id: 'm2', title: '稻香', platformName: '网易云音乐', format: 'mp3', status: 'done', percent: 100,
          savedPath: 'D:\\\\音视频解析下载\\\\音乐\\\\网易云音乐\\\\稻香 - 周杰伦.mp3', at: Date.now() - 60000 },
        { id: 'm3', title: '七里香', platformName: '网易云音乐', format: 'mp3', status: 'interrupted', percent: 42,
          savedPath: '', at: Date.now() - 120000 },
      ];
      const tab = document.querySelector('#music-tabs button[data-mtab="downloads"]');
      if (tab) tab.click();
      return true;
    })()""", 1.0)
    snap(c, 'g-music-downloads', 'guide-13-downloads',
         [box(c, '.music-download-row.done .music-row-btn[data-action="reveal"]', 1, badge='right'),
          box(c, '.music-download-row.done .music-row-btn.danger', 2, badge='right'),
          box(c, '#music-list-head .mini-btn', 3, badge='top'),
          box(c, '.music-download-row.interrupted', 4, badge='right')],
         dim=0.22, **panel_shot(c, '.music-list-panel', 800))

    # 换源标记（正常播放时不显示黄色提示，只有播放失败才出现）
    js(c, """(() => {
      const tab = document.querySelector('#music-tabs button[data-mtab="results"]');
      if (tab) tab.click();
      const via = document.querySelector('#music-via');
      if (via) {
        via.hidden = false;
        via.textContent = '换源 · 无损音乐源';
        via.classList.add('on');
      }
      const note = document.querySelector('#music-note');
      if (note) note.hidden = true;
      return true;
    })()""", 1.0)
    source = rect(c, '.music-source-row')
    via_crop = None
    if source:
        via_crop = {'x': source['x'] - 20, 'y': source['y'] - 14, 'w': 660, 'h': 96}
    snap(c, 'g-music-via', 'guide-13-via',
         [box(c, '#music-via', 1, badge='top')],
         dim=0.16, crop=via_crop)


# ---------------------------------------------------------------------------
# G. 教程本身（页面改完后单独跑）
# ---------------------------------------------------------------------------

def capture_guide(c):
    js(c, "document.querySelectorAll('.modal-mask').forEach((m) => { m.hidden = true }); try { window.__app.hideBrowser() } catch (e) {} window.__app.switchMode('long', { force: true }); true", 0.9)
    click(c, '#btn-guide', 1.2)
    js(c, """(() => {
      const content = document.querySelector('#guide-content');
      if (content) { content.style.scrollBehavior = 'auto'; content.scrollTop = 0; }
      return true;
    })()""", 0.6)
    snap(c, 'g-guide', 'guide-11-guide',
         [box(c, '#guide-mode-switch', 1, badge='top'),
          box(c, '#guide-nav', 2, badge='right'),
          box(c, '#guide-main .guide-figure', 3),
          box(c, '#guide-main .guide-points', 4, badge='right')],
         dim=0.16, crop=modal_crop(c, '#guide-modal'))

    # 视频教程页签：视频按章节拆开，左侧目录 + 播放器
    js(c, """(() => {
      document.querySelector('#guide-mode-switch button[data-guide-mode="video"]')?.click();
      return true;
    })()""", 1.2)
    js(c, """(() => {
      const poster = document.querySelector('#guide-video-poster');
      if (poster) poster.hidden = false;
      const video = document.querySelector('#guide-video');
      if (video) { try { video.pause(); video.currentTime = 0; } catch (e) {} }
      return true;
    })()""", 0.5)
    snap(c, 'g-video', 'guide-11-video',
         [box(c, '#guide-mode-switch', 1, badge='top'),
          box(c, '#guide-video-nav', 2, badge='right'),
          box(c, '.guide-video-box', 3),
          box(c, '.guide-video-actions', 4, badge='top')],
         dim=0.16, crop=modal_crop(c, '#guide-modal'))
    js(c, "document.querySelector('#guide-mode-switch button[data-guide-mode=\"image\"]')?.click(); true", 0.8)

    js(c, """(() => {
      const content = document.querySelector('#guide-content');
      if (content) content.style.scrollBehavior = 'auto';
      document.querySelector('#guide-nav button[data-guide="settings"]')?.click();
      return true;
    })()""", 1.0)
    js(c, """(() => {
      const content = document.querySelector('#guide-content');
      if (content) content.style.scrollBehavior = 'auto';
      const faq = document.querySelector('#guide-settings .faq');
      if (faq) faq.scrollIntoView({ block: 'center', behavior: 'instant' });
      return true;
    })()""", 1.2)
    snap(c, 'g-faq', 'guide-11-faq',
         [box(c, '#guide-settings .faq', 1),
          box(c, '#guide-nav button.active', 2, badge='right')],
         dim=0.16, crop=modal_crop(c, '#guide-modal'))
    js(c, "const content = document.querySelector('#guide-content'); if (content) content.style.scrollBehavior = ''; true", 0.3)
    click(c, '#guide-close', 0.5)


# ---------------------------------------------------------------------------
# 安装示意图：直接转 webp（不再截图）
# ---------------------------------------------------------------------------

def slides_to_webp():
    os.makedirs(ASSETS, exist_ok=True)
    for index in range(1, 7):
        src = os.path.join(SLIDES, 'slide%d.png' % index)
        if not os.path.exists(src):
            print('  ! missing slide', src)
            continue
        img = Image.open(src).convert('RGB')
        out = os.path.join(ASSETS, 'guide-00-install-%d.webp' % index)
        img.save(out, 'WEBP', quality=90, method=6)
        print('  slide', index, '->', os.path.basename(out), os.path.getsize(out), 'bytes')


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------

def main():
    only = {arg for arg in sys.argv[1:] if not arg.startswith('-')}
    os.makedirs(RAW, exist_ok=True)
    shots_path = os.path.join(GUIDE_DIR, 'shots.json')
    if os.path.exists(shots_path) and only:
        with open(shots_path, encoding='utf-8') as f:
            SHOTS.update(json.load(f).get('shots', {}))
    else:
        SHOTS.clear()

    if not only:
        slides_to_webp()

    demo_audio = os.path.join(cp.WWW, 'demo.mp3')
    if not os.path.exists(demo_audio):
        subprocess.run(['ffmpeg', '-y', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo', '-t', '269', '-q:a', '9', demo_audio],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), cp.Handler)
    http_port = httpd.server_address[1]
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    print('server', http_port, flush=True)

    subprocess.run(['taskkill', '/F', '/IM', 'electron.exe'], capture_output=True)
    time.sleep(1)
    if not os.path.exists(os.path.join(USERDATA, 'config.json')):
        proc = launch(USERDATA)
        page = wait_cdp()
        if not page:
            print('NO CDP seed')
            return
        c = CDP(page['webSocketDebuggerUrl'])
        time.sleep(2)
        seed(c)
        c.close()
        stop(proc)
        fix_config()

    proc = launch(USERDATA)
    page = wait_cdp()
    if not page:
        print('NO CDP 2')
        return
    c = CDP(page['webSocketDebuggerUrl'])
    try:
        time.sleep(2)
        c.ev('window.resizeTo(1290, 830); window.moveTo(0, 0); true')
        time.sleep(1.2)
        print('viewport', c.ev('[innerWidth, innerHeight]'), flush=True)

        def want(key):
            return not only or key in only

        if want('g-overview'):
            print('== 空状态 / 粘贴 / 失败页', flush=True)
            capture_empty(c)
        if want('g-tools') or want('g-episodes'):
            print('== 播放中 / 选集 / 历史 / 线路 / 下载 / 设置', flush=True)
            capture_playing(c, http_port)
        if want('g-cast-devices'):
            print('== 投屏', flush=True)
            capture_cast(c, http_port)
        if want('g-browser'):
            print('== 内置浏览器 / 找剧', flush=True)
            capture_browser(c)
        if want('g-short'):
            print('== 短视频', flush=True)
            short_state(c, http_port)
        if want('g-music'):
            print('== 音乐', flush=True)
            capture_music(c, http_port)
        if want('g-guide'):
            print('== 图文教程（本页）', flush=True)
            capture_guide(c)
        print('shots.json ->', shots_path, len(SHOTS), 'shots', flush=True)
    finally:
        c.close()
        stop(proc)
        httpd.shutdown()


if __name__ == '__main__':
    main()
