# 长视频解析 · 项目规则

本文件是**本项目的开发/发版约定**，优先级高于临时口头说明；新对话先读本文件。

## 1. 构建 / 发版：统一走 GitHub Actions

**不要在本机跑 NSIS 打包**（`desktop\build.ps1` / `release.ps1` 的本地打包部分）。
本机 electron-builder 在生成卸载器时会执行刚打出来的安装器，受系统安全软件 / SmartScreen / 临时目录注入影响，
会出现 `NSIS Error: Error writing temporary file`，导致安装包只留下 315KB 的坏 stub。
代码本身没问题：同一提交在 GitHub Actions 的干净 `windows-latest` 上构建成功并已发布。

**桌面端和手机端必须同版本一次发布**：`.github/workflows/release.yml` 的 `release-all` 一次产出
Windows NSIS + Android APK + iOS 免签名 IPA，并统一上传到同一个 Release。不要单独发桌面端或手机端。

标准发版流程：

```powershell
cd F:\Desktop\长视频解析

# 1. 统一改三端版本号（桌面 + 手机 + Android/iOS 原生工程 + latest.json）
node scripts\set-version.mjs 1.1.3

# 2. 提交并推送（GitHub git 通道不稳，失败重试 3–6 次）
git add -A
git commit -m "feat: v1.1.3 <简要说明>"
git -c http.proxy= -c https.proxy= push origin main

# 3. 触发三端 CI 构建 + 发布（workflow 文件：.github/workflows/release.yml）
gh workflow run release-all --ref main -f version=1.1.3

# 4. 看进度 / 结果
gh run list --workflow release-all --limit 3
gh run watch <run-id> --exit-status
gh release view v1.1.3 --json tagName,assets --jq '{tag:.tagName,assets:[.assets[]|{name,size,state}]}'
```

CI 成功后 Release 会包含：

```text
changshipin-Setup-1.1.3.exe
changshipin-Setup-1.1.3.exe.blockmap
latest.yml
changshipin-android-1.1.3.apk
changshipin-android.apk              # 固定文件名，手机更新/二维码用
changshipin-ios-unsigned-1.1.3.ipa
changshipin-ios-unsigned.ipa         # 固定文件名
latest-mobile.json                   # 手机端更新清单
```

### 下载安装包

`gh release download` 可能很慢（本机实测 8MB/5min）。优先用镜像：

```powershell
# 只下载到 release\ 供隔离验证；不要执行安装，也不要覆盖正式版
curl.exe -L --max-time 300 -C - -o release\changshipin-Setup-X.Y.Z.exe `
  "https://gh.monlor.com/https://github.com/fjz-hosts/changshipin-jiexi/releases/download/vX.Y.Z/changshipin-Setup-X.Y.Z.exe"
```

### 本机不要安装 / 覆盖正式版

**发版后不要在本机下载安装包、不要静默安装，也不要用 `robocopy` 覆盖 `D:\长视频解析\changshipin-jiexi`。**
用户会在下次双击启动时由客户端 `electron-updater` 自己检查、后台下载并提示安装；不需要 AI 代替用户更新本机正式版。

- 需要验证安装包时，只在隔离目录里跑：`release\win-unpacked`（`npx electron-builder --dir`）或独立虚拟机。
- 不要对 `D:\长视频解析\changshipin-jiexi` 做任何写入/删除/覆盖操作。
- 本机运行 smoke 时用独立配置目录和 `release\win-unpacked`，不要动正式安装目录。

```powershell
# 仅隔离验证示例（不要写 D:\长视频解析）
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:CHANGSPIN_USERDATA='F:\Desktop\长视频解析\.tmp\unpacked-smoke'
Start-Process -FilePath 'F:\Desktop\长视频解析\release\win-unpacked\长视频解析.exe' `
  -ArgumentList '--smoke-test','--no-sandbox','--disable-gpu' -Wait `
  -RedirectStandardOutput 'F:\Desktop\长视频解析\.tmp\unpacked-smoke.txt'
```

## 2. 发版前测试

```powershell
# 无头自检（32 项）
powershell -ExecutionPolicy Bypass -File desktop\verify.ps1

# 界面回归（需要先启动开发版并开 9345 调试端口）
node tools\cdp-test8.mjs
node tools\cdp-test9.mjs
```

手机端界面预览（不需要 Android SDK）：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
desktop\electron\node_modules\.bin\electron.cmd mobile\dev\main.js --width 390 --height 844 --out .tmp\mobile.png
```

手机端原生构建只在 CI（ubuntu-latest / macos-15）验证；本机没有 Android SDK、没有 Xcode，不要试图在本机出 APK / IPA。

**不要**为了「验证安装」去启动 `changshipin-Setup-X.Y.Z.exe` 或覆盖正式版；正式版的更新由用户下次启动时自动完成。

## 3. 其它约定（沿用交接文档）

- 不要在本机对测试安装执行卸载（会删正式版快捷方式）；验证安装包用 `release\win-unpacked` 或独立虚拟机。
- GitHub push 一律带 `-c http.proxy= -c https.proxy=` 绕过失效代理，失败重试。
- 不要用 PowerShell 5.1 无 BOM 写 `.ps1` / `使用说明.txt`；README 不带 BOM。
- 版本号统一用 `node scripts\set-version.mjs X.Y.Z` 修改，会同步桌面 `package.json`、手机 `package.json`、Android/iOS 原生工程和 `mobile/latest.json`；不要只改单个文件。
- 手机端原生工程已经提交在 `mobile/android` / `mobile/ios`；CI 在打 APK/IPA 前会先 `npx cap sync`，再跑 `mobile/scripts/patch-android.mjs` / `patch-ios.mjs`。不要手改生成出来的 `android/app/src/main/assets/public` 等临时产物。
- Android 使用仓库内固定 sideload 签名 `mobile/keystore/changshipin-release.keystore`（密码 `changshipin`）；更换签名会导致老用户无法覆盖安装。
- iOS 产物是 `CODE_SIGNING_ALLOWED=NO` 的免签名 IPA，本身不能直接安装，必须由用户用 Sideloadly / AltStore 自签；不要在文档里写成「直接安装」。
- 发版记录同步更新：`README.md` 的更新记录、`项目开发交接文档.md` 的版本历史/安装路径/Release 链接。

## 4. 本机环境已知问题

- `desktop\electron\node_modules\builder-util\out\util.js` 的 Windows 分支会把子进程环境替换成只剩 `__COMPAT_LAYER`，
  导致 NSIS 安装器没有 `TEMP`/`PATH`，报临时文件错误。该补丁只作为本地诊断，**不是发版依赖**；
  重装 node_modules 会丢，别再为它反复折腾本机打包，直接用 CI。
- 本机出现过 `2tX9W8.exe` / `XPSPLOG.dll` 反复崩溃、SmartScreen 卡住未签名安装器的情况；遇到就改用免安装覆盖或 CI 产物。
