# 长视频解析 · 项目规则

本文件是**本项目的开发/发版约定**，优先级高于临时口头说明；新对话先读本文件。

## 1. 构建 / 发版：统一走 GitHub Actions

**不要在本机跑 NSIS 打包**（`desktop\build.ps1` / `release.ps1` 的本地打包部分）。
本机 electron-builder 在生成卸载器时会执行刚打出来的安装器，受系统安全软件 / SmartScreen / 临时目录注入影响，
会出现 `NSIS Error: Error writing temporary file`，导致安装包只留下 315KB 的坏 stub。
代码本身没问题：同一提交在 GitHub Actions 的干净 `windows-latest` 上构建成功并已发布 v1.0.10。

标准发版流程：

```powershell
cd F:\Desktop\长视频解析

# 1. 改版本号（只改 package.json 的 version）
# 2. 提交并推送（GitHub git 通道不稳，失败重试 3–6 次）
git add -A
git commit -m "feat: vX.Y.Z <简要说明>"
git -c http.proxy= -c https.proxy= push origin main

# 3. 触发 CI 构建 + 发布（workflow 文件：.github/workflows/release.yml）
gh workflow run release-windows --ref main -f version=X.Y.Z

# 4. 看进度 / 结果
gh run list --workflow release-windows --limit 3
gh run watch <run-id> --exit-status
gh release view vX.Y.Z --json tagName,assets --jq '{tag:.tagName,assets:[.assets[]|{name,size,state}]}'
```

CI 成功后 Release 会包含：

```text
changshipin-Setup-X.Y.Z.exe
changshipin-Setup-X.Y.Z.exe.blockmap
latest.yml
```

### 下载安装包

`gh release download` 可能很慢（本机实测 8MB/5min）。优先用镜像：

```powershell
# 镜像下载（支持断点续传 -C -）
curl.exe -L --max-time 300 -C - -o release\changshipin-Setup-X.Y.Z.exe `
  "https://gh.monlor.com/https://github.com/fjz-hosts/changshipin-jiexi/releases/download/vX.Y.Z/changshipin-Setup-X.Y.Z.exe"
```

安装前先解除 Mark of the Web，避免 SmartScreen 卡住静默安装：

```powershell
Unblock-File -Path 'F:\Desktop\长视频解析\release\changshipin-Setup-X.Y.Z.exe'
Remove-Item -Path 'F:\Desktop\长视频解析\release\changshipin-Setup-X.Y.Z.exe:Zone.Identifier' -ErrorAction SilentlyContinue
```

### 本机安装

```powershell
Get-Process '长视频解析' -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Process -FilePath 'F:\Desktop\长视频解析\release\changshipin-Setup-X.Y.Z.exe' `
  -ArgumentList '/S','/D=D:\长视频解析\changshipin-jiexi' -Wait
(Get-Item 'D:\长视频解析\changshipin-jiexi\长视频解析.exe').VersionInfo.ProductVersion
```

如果本机安装器仍被 SmartScreen / NSIS 临时文件问题挡住，用**免安装覆盖**（已验证可用）：

```powershell
Get-Process '长视频解析' -ErrorAction SilentlyContinue | Stop-Process -Force
robocopy "F:\Desktop\长视频解析\release\win-unpacked" "D:\长视频解析\changshipin-jiexi" /E /IS /IT /R:1 /W:1
```

## 2. 发版前测试

```powershell
# 无头自检（30 项）
powershell -ExecutionPolicy Bypass -File desktop\verify.ps1

# 界面回归（需要先启动开发版并开 9345 调试端口）
node tools\cdp-test8.mjs
node tools\cdp-test9.mjs
```

安装完成后可以再跑一次已安装程序的 smoke：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:CHANGSPIN_USERDATA='F:\Desktop\长视频解析\.tmp\installed-smoke'
Start-Process -FilePath 'D:\长视频解析\changshipin-jiexi\长视频解析.exe' `
  -ArgumentList '--smoke-test','--no-sandbox','--disable-gpu' -Wait `
  -RedirectStandardOutput 'F:\Desktop\长视频解析\.tmp\installed-smoke.txt'
```

## 3. 其它约定（沿用交接文档）

- 不要在本机对测试安装执行卸载（会删正式版快捷方式）；验证安装包用 `release\win-unpacked` 或独立虚拟机。
- GitHub push 一律带 `-c http.proxy= -c https.proxy=` 绕过失效代理，失败重试。
- 不要用 PowerShell 5.1 无 BOM 写 `.ps1` / `使用说明.txt`；README 不带 BOM。
- 版本号只改 `desktop\electron\package.json` 的 `version`；CI 会按 workflow 输入的版本号重新设置。
- 发版记录同步更新：`README.md` 的更新记录、`项目开发交接文档.md` 的版本历史/安装路径/Release 链接。

## 4. 本机环境已知问题

- `desktop\electron\node_modules\builder-util\out\util.js` 的 Windows 分支会把子进程环境替换成只剩 `__COMPAT_LAYER`，
  导致 NSIS 安装器没有 `TEMP`/`PATH`，报临时文件错误。该补丁只作为本地诊断，**不是发版依赖**；
  重装 node_modules 会丢，别再为它反复折腾本机打包，直接用 CI。
- 本机出现过 `2tX9W8.exe` / `XPSPLOG.dll` 反复崩溃、SmartScreen 卡住未签名安装器的情况；遇到就改用免安装覆盖或 CI 产物。
