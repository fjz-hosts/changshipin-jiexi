# -*- coding: utf-8 -*-
"""把 18 分钟视频教程按章节切成应用内可单独播放的小节。

输入：视频教程/长视频解析-视频教程.mp4（render.py 合成的成片，带章节元数据）
输出：
  desktop/electron/src/renderer/assets/video-guide/guide-video-00.mp4 ...（1280x720，按章节）
  desktop/electron/src/renderer/assets/video-guide/guide-video-XX.jpg（每节封面，640x360）
  desktop/electron/src/renderer/assets/video-guide/manifest.json（应用内视频教程的章节数据）

成片只有约 51MB，转成 720p 后每节约 1–2MB，总共 20MB 左右，放进安装包不会太大。
用法：python tools/guide/split_video.py [--full]
  --full  同时把每节切一份 1080p 的到 视频教程/分章节/（默认不做）
"""

import json
import os
import re
import subprocess
import sys

try:
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
except Exception:
    pass

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FINAL = os.path.join(ROOT, '视频教程', '长视频解析-视频教程.mp4')
OUT = os.path.join(ROOT, 'desktop', 'electron', 'src', 'renderer', 'assets', 'video-guide')
FULL_OUT = os.path.join(ROOT, '视频教程', '分章节')
W, H = 1280, 720
POSTER_W, POSTER_H = 640, 360


def run(cmd):
    subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def ffmpeg_text(cmd):
    return subprocess.run(cmd, capture_output=True).stderr.decode('utf-8', 'replace')


def duration_of(path):
    text = ffmpeg_text(['ffmpeg', '-hide_banner', '-i', path])
    match = re.search(r'Duration: (\d+):(\d+):(\d+\.\d+)', text)
    if not match:
        raise SystemExit('无法读取视频时长：' + path)
    return int(match.group(1)) * 3600 + int(match.group(2)) * 60 + float(match.group(3))


def read_chapters(path):
    text = subprocess.run(
        ['ffmpeg', '-hide_banner', '-v', 'error', '-i', path, '-f', 'ffmetadata', '-'],
        capture_output=True,
    ).stdout.decode('utf-8', 'replace')
    chapters = []
    current = None
    for line in text.splitlines():
        if line.strip() == '[CHAPTER]':
            current = {}
            chapters.append(current)
            continue
        if current is None or '=' not in line:
            continue
        key, value = line.split('=', 1)
        if key == 'START':
            current['start'] = int(value) / 1000
        elif key == 'END':
            current['end'] = int(value) / 1000
        elif key == 'title':
            current['title'] = value.strip()
    return [chapter for chapter in chapters if 'start' in chapter and 'end' in chapter and chapter.get('title')]


def fmt_time(seconds):
    minutes, sec = divmod(int(round(seconds)), 60)
    return '%d:%02d' % (minutes, sec)


def main():
    if not os.path.exists(FINAL):
        raise SystemExit('找不到成片：' + FINAL)
    total = duration_of(FINAL)
    chapters = read_chapters(FINAL)
    if not chapters:
        raise SystemExit('成片里没有章节信息')
    # 片尾「感谢观看」没有章节标记，单独作为最后一节
    if total - chapters[-1]['end'] > 3:
        chapters.append({'start': chapters[-1]['end'], 'end': total, 'title': '14 结束语 · 感谢观看'})
    os.makedirs(OUT, exist_ok=True)
    if '--full' in sys.argv:
        os.makedirs(FULL_OUT, exist_ok=True)

    manifest = []
    for index, chapter in enumerate(chapters):
        ident = '%02d' % index
        name = 'guide-video-%s.mp4' % ident
        poster = 'guide-video-%s.jpg' % ident
        target = os.path.join(OUT, name)
        start, end = chapter['start'], chapter['end']
        title = chapter['title']
        print('cut %s  %6.1f–%6.1f  %s' % (name, start, end, title), flush=True)
        run([
            'ffmpeg', '-y', '-v', 'error',
            '-ss', '%.3f' % start, '-i', FINAL,
            '-t', '%.3f' % (end - start),
            '-vf', 'scale=%d:%d:flags=lanczos' % (W, H),
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '96k', '-ar', '48000', '-ac', '2',
            '-movflags', '+faststart', target,
        ])
        run([
            'ffmpeg', '-y', '-v', 'error',
            '-ss', '%.3f' % (start + min(1.0, (end - start) / 3)), '-i', FINAL,
            '-frames:v', '1', '-vf', 'scale=%d:%d:flags=lanczos' % (POSTER_W, POSTER_H),
            '-q:v', '3', os.path.join(OUT, poster),
        ])
        actual = duration_of(target)
        if abs(actual - (end - start)) > 0.6:
            raise SystemExit('%s 时长不对：期望 %.1fs，实际 %.1fs' % (name, end - start, actual))
        if '--full' in sys.argv:
            run([
                'ffmpeg', '-y', '-v', 'error',
                '-ss', '%.3f' % start, '-i', FINAL,
                '-t', '%.3f' % (end - start),
                '-c', 'copy', '-movflags', '+faststart', os.path.join(FULL_OUT, 'guide-video-%s.mp4' % ident),
            ])
        manifest.append({
            'id': ident,
            'title': title,
            'file': name,
            'poster': poster,
            'duration': round(end - start, 2),
            'durationText': fmt_time(end - start),
        })

    data = {
        'version': 1,
        'source': '视频教程/长视频解析-视频教程.mp4',
        'chapters': manifest,
    }
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
    print('manifest ->', os.path.join(OUT, 'manifest.json'), len(manifest), '节')


if __name__ == '__main__':
    main()
