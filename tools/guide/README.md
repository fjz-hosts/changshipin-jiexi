# 图文教程截图生成

应用里的「使用教程 · 图文版」用到的 10 张截图（01–09 长视频 + 10 短视频），都从这个目录的脚本生成。
截图是真实运行开发版后抓的，再用 Pillow 加红框 / 聚光灯 / 编号。

**界面改了就一定要重新跑一遍**（这是项目规则 AGENTS.md 第 6 节）：布局、按钮、平台卡片、弹窗、提示条变了，
教程里还是旧界面，用户会当成 bug。

## 产物

- 应用内图片：`desktop/electron/src/renderer/assets/guide/guide-0*.webp`（10 张，含 guide-10-short）
- 原始截图 / 中间产物：`.tmp/guide/`（不进 git）
- 预览图：`.tmp/guide/out/*.png`

## 依赖

- Python 3.11+
- `Pillow`、`requests`、`websocket-client`
- `ffmpeg` 在 PATH 里（生成演示画面用）
- Windows（截图脚本用 Electron 的 CDP 抓窗口，按 1278×779 布局）
- 能访问芒果TV 首页（内置浏览器那张图需要；如果已经有 `.tmp/guide/raw/browser-clean.png`，会直接复用）

## 生成步骤

```powershell
cd F:\Desktop\长视频解析

# 1. 生成教程用的演示画面（海报 + 90 秒视频）
python tools\guide\make_poster.py

# 2. 启动开发版，写入演示历史 / 线路状态，逐张截图
#    会输出 .tmp/guide/raw/*.png 和 .tmp/guide/shots.json
python tools\guide\capture.py

# 3. 加红框、编号、聚光灯，输出 webp 到 assets/guide
python tools\guide\annotate.py
```

检查 `.tmp/guide/out/` 里的预览图；确认后重新跑一遍 `desktop\verify.ps1`（自检会检查
教程章节和 9 张图片都能加载）。

## 导出 PDF

```powershell
python tools\guide\make_pdf.py
```

产物：`docs/长视频解析-图文使用教程.pdf`（A4，13 页，封面 + 目录 + 10 节）。

原理：`make_pdf.py` 从应用内教程页面提取章节，换成打印版式；`print_pdf.js` 用 Electron 的
`printToPDF` 输出，图片和中文字体都会嵌入。

## 说明

- 演示数据（今天是太阳雨 / 折月亮等）只用于截图，不会出现在用户数据里。
- `shots.json` 记录了每张图的框选坐标；改完页面布局后重新跑 `capture.py` 即可更新。
- 每张图的重点区域在 `capture.py` 里用 `box(c, 选择器, 编号)` 指定；编号和正文里的
  ①②③ 对应。`label=0` 表示只保留亮度、不画红框。
- `browser-clean.png` 是为了避开芒果TV 首页轮播广告而保留的一张干净截图；没有它时会
  用实时抓到的页面。
