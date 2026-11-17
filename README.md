# 长视频解析

Windows 桌面端的视频链接解析播放工具：把 **爱奇艺 / 腾讯视频 / 优酷 / 芒果TV** 的视频页链接粘进来，选一条解析线路，直接在内置播放器里观看。

程序本身不提供、不存储、不分发任何视频内容；解析能力来自互联网上公开的第三方解析接口，线路失效时可自行更换或添加。

> 开发/维护/交接说明：见 [项目开发交接文档.md](项目开发交接文档.md)（架构、数据、构建发版、测试、已知限制、下一步）。

![主界面](docs/screenshot-main.png)

![平台网页直接在主窗口内打开](docs/screenshot-browser.png)

## 功能

- **链接解析直连播放**：粘贴视频页链接 → 自动识别平台 → 解析 → 内嵌播放（页面播放器或 m3u8/mp4 原生播放）。
- **主窗口内置浏览器**：点平台卡片或「找剧」，平台网页直接在主窗口里打开，不再新开窗口；支持后退 / 前进 / 刷新 / 返回首页，点开剧集自动解析回主界面。
- **观看历史**：记录剧名、集数、平台、线路和观看进度，可继续观看或删除；旧记录会在后台自动补全剧名。
- **四个平台快捷入口**：使用各平台官方 App 图标，一键打开官网（内置浏览器窗口可登录会员）；视频页一键「填入解析」。
- **找剧 · 跨平台搜索**：输入剧名，勾选一个或多个平台，直接在各自的内置浏览器里打开搜索结果；点开任意剧集或某一集，程序自动解析到主界面播放。
- **自动解析 / 复制本集**：内置浏览器会识别剧集播放页，自动把「具体某一集」送给主界面；在非剧集页点「复制本集」会提示先进入具体某一集，避免复制成首页链接。
- **真·全屏**：一键把窗口铺满整个屏幕并进入影院模式（隐藏所有工具栏），再按 Esc / F11 退出。
- **芒果TV 原生解析**：内置芒果TV 官方取流接口（tk2 / getSource），不依赖第三方解析站；国内网络下优先使用，登录芒果会员后可解 VIP。
- **多线路 + 失败自动换线**：内置多条公开线路，可在「线路管理」里启停、排序、增删、测速、在线更新；灰色线路点一下即可启用。
- **本地取流代理**：第三方接口给的 m3u8/mp4 地址往往校验 Referer/UA，主进程用本地 `127.0.0.1` 代理补齐请求头并改写 HLS 播放列表（分片、密钥、子列表），解决防盗链导致的无法播放。
- **自动更新**：electron-updater + GitHub Releases，多加速镜像自动切换；启动时静默检查，后台下载，提示重启安装。

## 下载与安装

到 [Releases](https://github.com/fjz-hosts/changshipin-jiexi/releases/latest) 下载 `changshipin-Setup-<版本>.exe`，双击安装即可（不签名，SmartScreen 首次运行点「更多信息 → 仍要运行」）。

要求：Windows 10/11 x64。

## 使用

1. **快捷入口**：点顶部四个平台卡片，在内置浏览器里浏览视频；找到视频页后点「填入解析」，链接会自动回到主界面并开始解析。
2. **找剧**：点右上角「找剧」，输入剧名并勾选平台（可多选），会分别打开各平台搜索结果。点开任意剧集/某一集后，程序会自动解析并在主界面播放；平台窗口保持打开，方便继续选集。
3. **手动粘贴**：复制视频页链接（如 `https://www.iqiyi.com/v_xxx.html`、`https://v.qq.com/x/cover/.../xxx.html`、`https://v.youku.com/v_show/id_xxx.html`、`https://www.mgtv.com/b/xxx/xxx.html`），粘贴到输入框，回车或点「解析播放」。
4. **换线路**：解析页没有画面 / 白屏 / 报错时，点「换线路」；开启「失败自动换线」后程序会自动按顺序尝试下一条线路。
5. **会员内容**：已登录会员可把线路切到「官网页面（会员登录）」直接看原片，不走第三方解析。
6. **全屏**：点播放区右上角「全屏」（或 F11），窗口会铺满整块屏幕并隐藏工具栏；Esc 退出。

更多细节见 [使用说明.txt](desktop/使用说明.txt)。

## 解析线路

线路分三种：

| 类型 | 含义 | 典型地址 |
| --- | --- | --- |
| 网页 (`page`) | 在内置浏览器里打开第三方解析页，由解析页自己播放 | `https://jx.example.com/?url={url}` |
| 接口 (`api`) | 主进程请求接口，从 JSON/HTML 里提取 m3u8/mp4，再用内置播放器播放 | `https://api.example.com/parse?url={url}` |
| 直连 (`direct`) | 不解析，直接打开原片页面（适合已登录会员） | `direct://video` |
| 芒果内置 (`mgtv`) | 直接调用芒果TV 官方取流接口，仅用于芒果TV | `mgtv://auto` |

- `{url}` 会被替换为 `encodeURIComponent(视频链接)`；也支持 `{urlRaw}` 原样拼接。
- 接口线路会自动在返回内容里递归查找 `m3u8 / mp4 / flv` 地址（支持 JSON 字段、转义斜杠、URL 编码、HTML 内嵌地址）。
- 内置线路全部是公开接口，**随时可能失效**。默认启用的是实测能出画面的三条：789解析、PlayM3U8、盘古解析。可在「设置 → 解析线路」里：
  - 单条「测试」，看是否可访问；
  - 「在线更新线路」，从本仓库的 [`lines.json`](lines.json) 拉取最新清单（不会覆盖你自建的线路）；
  - 「恢复内置线路」，回到随程序发布的默认清单。
- 侧栏里灰色线路是「未启用」，点一下即可启用，启用后出现在线路下拉框。
- 想把线路经验分享给所有人：直接改 `lines.json` 提 PR 即可，客户端在线更新后生效。

> 解析线路来自第三方，程序无法保证任何一条线路的长期可用性，也不对第三方内容负责。

## 自动更新与发版

```
本地 release.ps1
   ├─ 改版本号（desktop/electron/package.json）
   ├─ electron-builder 打包 NSIS 安装包 + latest.yml + blockmap
   ├─ gh release create/upload → GitHub Releases
   └─ git commit / tag vX.Y.Z / push
                │
                ▼
GitHub Releases（安装包 + latest.yml）
                │  gh.monlor.com / gh-proxy.com / ghfile.geekertao.top / hk.gh-proxy.com / github.com
                ▼
客户端 electron-updater：启动 6 秒后检查 → 后台整包下载 → 提示重启安装
```

- 更新配置在 `desktop/electron/package.json` 的 `build.publish`（generic provider，指向 `gh.monlor.com` 镜像）。
- 客户端 `src/updater.js` 内置 5 个更新源，按顺序回退；镜像不可用时自动换下一个。
- 安装包与 `latest.yml` 同名同级，`latest.yml` 里的下载地址是相对路径，因此换哪个镜像都能下载。
- 发布新版本：`powershell -ExecutionPolicy Bypass -File desktop\release.ps1 -Version 1.0.4`
  - 只打包：`-SkipPublish`；只上传：`-SkipBuild`；不推 git：`-NoPush`。
  - 只打安装包：`desktop\build.ps1`；只上传：`desktop\publish.ps1`。

GitHub Actions（`.github/workflows/build.yml`）会在推送 `v*` tag 时做一次干净环境构建，产物上传为 workflow artifact，便于验证「别人 clone 下来能不能构建」。

## 目录结构

```
desktop/
  build.ps1                # 构建安装包
  publish.ps1              # 上传到 GitHub Releases
  release.ps1              # 一键发版（版本号 → 构建 → 发布 → 打 tag → 校验镜像）
  使用说明.txt
  electron/
    package.json           # appId / 版本 / electron-builder / publish
    src/
      main.js              # 主进程：窗口、菜单、托盘、IPC、官网窗口
      proxy.js             # 本地取流代理（m3u8 改写 / Referer / Range）
      lines.js             # 内置线路、解析、地址提取、在线线路清单
      store.js             # 配置 / 线路 / 历史（%APPDATA%\长视频解析\config.json）
      updater.js           # electron-updater + 多镜像回退
      preload.js           # 主界面 IPC 桥
      platform-preload.js  # 内置官网窗口 IPC 桥
      smoke.js             # 无头自检（--smoke-test）
      renderer/            # 主界面、内置官网页、官方平台图标、hls.js
    build/icon.ico
scripts/make_icon.py       # 生成应用图标
tools/webview-probe/       # 线路探针（开发用）
tools/cdp-test*.mjs        # 界面 / 全屏 / 找剧 / 关闭窗口的自动化验证
lines.json                 # 在线线路清单
```

## 开发

```powershell
cd desktop\electron
npm install          # 首次
npm start            # 开发运行

# 无头自检（代理改写 / 平台识别 / 渲染进程 / 配置）
node_modules\.bin\electron . --smoke-test
# 再带上外网链路检查
$env:CHANGSPIN_SMOKE_ONLINE="1"; node_modules\.bin\electron . --smoke-test
```

- 自检会输出 PASS/FAIL，并以非零退出码表示失败；可用 `CHANGSPIN_USERDATA` 指定独立配置目录，避免污染真实配置。
- 开发/调试时如果环境设置了 `ELECTRON_RUN_AS_NODE=1`，electron 会以纯 Node 模式启动，需要先 `Remove-Item Env:ELECTRON_RUN_AS_NODE`（构建脚本已处理）。
- 图标：`python scripts/make_icon.py`（需要 Pillow）。
- 界面验证：以 `--remote-debugging-port=9222` 启动后运行 `node tools/cdp-test2.mjs`（全屏/找剧/自动解析）和 `node tools/cdp-test3.mjs`（关闭平台窗口回归）。

## 数据与隐私

- 配置、历史记录、更新缓存：`%APPDATA%\长视频解析\`（菜单「文件 → 打开配置目录」）。
- 日志：`%APPDATA%\长视频解析\logs\desktop.log`。
- 登录状态按平台隔离在 Electron 的 `persist:platform-*` 分区里；程序不上传任何本地数据。
- 解析请求直接发往你选择的第三方接口；「官网页面」线路直接访问对应平台。

## 更新记录

- **1.0.9** — 平台网页改为在主窗口内打开（不再另开窗口），支持后退 / 前进 / 返回首页；新增观看历史（剧名、集数、进度、续播、删除）；解析按钮不再因为长时间解析被禁用。
- **1.0.8** — 关闭 hls.js 的 blob worker（打包后 worker 偶尔起不来导致清单一直不解析），提升安装版播放稳定性。
- **1.0.7** — 修复芒果TV 原生解析被误判为境外：getSource 改用国内客户端参数 `src=mgtv`（原来用的 `intelmgtv` 是国际客户端参数，会触发版权地区限制）；实测可解析并播放 720P。取流代理改写播放列表时统一沿用原始 Referer。
- **1.0.6** — 芒果TV 原生解析失败时直接显示真实原因（地区限制 / 需要会员），不再自动回退到空播放器；自动更新恢复静默覆盖安装：不再弹安装向导和“下一步”，不再额外弹“发现新版本”；配置、登录状态、桌面快捷方式都会保留，点一次“立即重启安装”即可。
- **1.0.5** — 芒果TV 新增「原生解析」线路（官方接口直连，国内网络优先，登录会员可解 VIP）；所有内置浏览器窗口统一带解析按钮；芒果TV 播放流会携带登录 Cookie。
- **1.0.4** — 修复安装/更新后桌面快捷方式丢失：NSIS 安装时强制重建桌面与开始菜单快捷方式；自动更新改为显示安装向导（不再静默卸载升级），并新增「文件 → 重新创建桌面快捷方式」和关于页按钮。
- **1.0.3** — 修复关闭平台内置浏览器（尤其正在播放/解析时）触发主进程 `Object has been destroyed` 报错的问题；主进程未捕获异常改为只写日志，不再弹错误框。
- **1.0.2** — 平台快捷入口换成官方 App 图标；新增「找剧」跨平台搜索、点集自动解析、复制本集校验；修复全屏不铺满屏幕；灰色线路点击即可启用；解析页弹窗改为当前内置窗口打开。
- **1.0.1** — 解析页加载超时放宽到 45 秒；全部线路失败时提示已尝试的线路数量与原因。
- **1.0.0** — 首个版本：四平台快捷入口、链接解析播放、多线路自动切换、本地取流代理、自动更新。

## 免责声明

本项目仅用于学习 Electron / 流媒体播放技术，以及个人合法范围内的观看。请遵守各视频平台的用户协议与当地法律法规，不要用于传播盗版内容或商业用途。解析线路由第三方提供，其可用性、安全性与合法性由提供方负责。
