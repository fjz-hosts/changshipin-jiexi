# 长视频解析 · 项目规则

本文件是**本项目的开发/发版约定**，优先级高于临时口头说明；新对话先读本文件。

## 1. 构建 / 发版：统一走 GitHub Actions

**不要在本机跑 NSIS 打包**（`desktop\build.ps1` / `release.ps1` 的本地打包部分）。
本机 electron-builder 在生成卸载器时会执行刚打出来的安装器，受系统安全软件 / SmartScreen / 临时目录注入影响，
会出现 `NSIS Error: Error writing temporary file`，导致安装包只留下 315KB 的坏 stub。
同一提交在 GitHub Actions 的干净 `windows-latest` 上可以正常构建并发布。

**手机端已移除**：不再构建 Android APK / iOS IPA，不再发布手机下载页或 `latest-mobile.json`。
不要恢复 `mobile/`、`docs/mobile/`、`release-all` 或任何手机端入口。

标准发版流程：

```powershell
cd F:\Desktop\长视频解析

# 1. 只改 desktop\electron\package.json 的 version
# 2. 提交并推送（GitHub git 通道不稳，失败重试 3–6 次）
git add -A
git commit -m "feat: vX.Y.Z <简要说明>"
git -c http.proxy= -c https.proxy= push origin main

# 3. 触发 Windows CI 构建 + 发布（workflow 文件：.github/workflows/release.yml）
gh workflow run release-windows --ref main -f version=X.Y.Z

# 4. 看进度 / 结果
gh run list --workflow release-windows --limit 3
gh run watch <run-id> --exit-status
gh release view vX.Y.Z --json tagName,assets --jq '{tag:.tagName,assets:[.assets[]|{name,size,state}]}'
```

CI 成功后 Release 只会包含：

```text
changshipin-Setup-X.Y.Z.exe
changshipin-Setup-X.Y.Z.exe.blockmap
latest.yml
```

### 下载安装包

`gh release download` 可能很慢（本机实测 8MB/5min）。优先用镜像，只下载到 `release\` 供隔离验证，
**不要执行安装，也不要覆盖正式版**：

```powershell
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

## 3. 其它约定

- 不要在本机对测试安装执行卸载（会删正式版快捷方式）；验证安装包用 `release\win-unpacked` 或独立虚拟机。
- GitHub push 一律带 `-c http.proxy= -c https.proxy=` 绕过失效代理，失败重试。
- 不要用 PowerShell 5.1 无 BOM 写 `.ps1` / `使用说明.txt`；README 不带 BOM。
- 版本号只改 `desktop\electron\package.json` 的 `version`；CI 会按 workflow 输入的版本号重新设置。
- 发版记录同步更新：`README.md` 的更新记录、`项目开发交接文档.md` 的版本历史/安装路径/Release 链接。
- **不要再加入手机端**：用户已明确不要手机版，也不再需要扫码下载。

## 4. 本机环境已知问题

- `desktop\electron\node_modules\builder-util\out\util.js` 的 Windows 分支会把子进程环境替换成只剩 `__COMPAT_LAYER`，
  导致 NSIS 安装器没有 `TEMP`/`PATH`，报临时文件错误。该补丁只作为本地诊断，**不是发版依赖**；
  重装 node_modules 会丢，别再为它反复折腾本机打包，直接用 CI。
- 本机出现过 `2tX9W8.exe` / `XPSPLOG.dll` 反复崩溃、SmartScreen 卡住未签名安装器的情况；遇到就改用 CI 产物或隔离目录验证。
