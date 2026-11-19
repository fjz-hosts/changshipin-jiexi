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

需要隔离验证的包只放 `release\`，**不要执行安装，也不要覆盖正式版**。
首选 `node scripts\sync-releases.mjs`（见下一节，它支持断点续传 + sha512 校验，放 `releases\`）。

本机用 curl 走镜像已经不通了：DSH 沙箱里 curl 的 schannel 直接报 `SEC_E_NO_CREDENTIALS (0x8009030E)`，
`gh release download` 又不支持续传（实测 121MB 下到 18MB 被连接重置）。所以大文件一律走那个 Node 脚本。

```powershell
# 只下载到 releases\ 存档（推荐，可续传、校验 sha512）
node scripts\sync-releases.mjs
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

## 2. 发版后：最新安装包放进 `releases\`，旧版本清掉

**用户明确规则：每次项目更新 / 发版后，`releases\` 里只保留最新一版的安装包，之前版本的安装包一律删除。**
每次发版收尾都要做这一步，不需要用户再提醒。

CI 发布成功（`gh release view` 里三个 asset 都是 `uploaded`）后，在项目根目录执行：

```powershell
node scripts\sync-releases.mjs
```

脚本会自动完成：

1. 用 GitHub API 取最新 Release 版本（需要指定时 `--version X.Y.Z`，要 `v` 前缀可省）；
2. 走镜像 + Range 断点续传，下载 `changshipin-Setup-X.Y.Z.exe` 到 `releases\`，
   按 `latest.yml` 的 `sha512` / `size` 校验通过后才原子改名落地；
3. 同时留一份 `latest.yml`（核对版本、测更新源用）；
4. 删除 `releases\` 里更早版本的 `changshipin-Setup-*.exe`、`*.blockmap` 和 `.part` 残留，只留当前版本。

```powershell
# 只体检，不下载不删除；版本落后 / 有旧版本时退出码为 1
node scripts\sync-releases.mjs --check

# 只下载新版，不动旧文件（一般不用）
node scripts\sync-releases.mjs --no-cleanup
```

- `releases\` 里**只放最新安装包，不进 git**：单个 116MB 已超过 GitHub 100MB 文件上限，`.gitignore` 已忽略；只有 `releases\README.md` 会提交。
- 这里下载的包是**存档 / 发给用户**用的：**不要执行安装，不要覆盖 `D:\长视频解析\changshipin-jiexi`**（见下一节）。
- **大文件不要用 curl / gh 下载**：DSH 沙箱里 curl 的 schannel 报 `SEC_E_NO_CREDENTIALS (0x8009030E)`；
  `gh release download` 不支持断点续传（实测 121MB 下到 18MB 就被连接重置）。脚本用 Node `fetch` + `Range` 续传 + 多镜像就是这个原因。

## 3. 发版前测试

```powershell
# 无头自检（32 项）
powershell -ExecutionPolicy Bypass -File desktop\verify.ps1

# 界面回归（需要先启动开发版并开 9345 调试端口）
node tools\cdp-test8.mjs
node tools\cdp-test9.mjs
```

## 4. 其它约定

- 不要在本机对测试安装执行卸载（会删正式版快捷方式）；验证安装包用 `release\win-unpacked` 或独立虚拟机。
- GitHub push 一律带 `-c http.proxy= -c https.proxy=` 绕过失效代理，失败重试。
- 不要用 PowerShell 5.1 无 BOM 写 `.ps1` / `使用说明.txt`；README 不带 BOM。
- 版本号只改 `desktop\electron\package.json` 的 `version`；CI 会按 workflow 输入的版本号重新设置。
- 发版记录同步更新：`README.md` 的更新记录、`项目开发交接文档.md` 的版本历史/安装路径/Release 链接。
- **不要再加入手机端**：用户已明确不要手机版，也不再需要扫码下载。

## 5. 本机环境已知问题

- **沙箱里 git push / curl 会挂在 schannel 上**（`SEC_E_NO_CREDENTIALS (0x8009030E)`），GCM 凭据助手还会报
  `couldn't create signal pipe, Win32 error 5`。可用的绕过写法（已验证）：

  ```powershell
  $tok = (gh auth token)
  $b64 = [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("x-access-token:$tok"))
  $env:GIT_TERMINAL_PROMPT = '0'
  git -c http.proxy= -c https.proxy= -c http.sslBackend=openssl `
      -c "http.extraheader=AUTHORIZATION: basic $b64" push origin main
  ```

  读操作（`ls-remote`、`gh api`）加 `-c http.sslBackend=openssl` 就行，不用 token。
  大白话：**TLS 用 openssl 后端，认证用 gh 的 token，别依赖凭据助手**。

- `desktop\electron\node_modules\builder-util\out\util.js` 的 Windows 分支会把子进程环境替换成只剩 `__COMPAT_LAYER`，
  导致 NSIS 安装器没有 `TEMP`/`PATH`，报临时文件错误。该补丁只作为本地诊断，**不是发版依赖**；
  重装 node_modules 会丢，别再为它反复折腾本机打包，直接用 CI。
- 本机出现过 `2tX9W8.exe` / `XPSPLOG.dll` 反复崩溃、SmartScreen 卡住未签名安装器的情况；遇到就改用 CI 产物或隔离目录验证。
