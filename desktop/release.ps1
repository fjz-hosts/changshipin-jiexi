<#
长视频解析 · 一键发版（本地打包 → 发布 GitHub Releases → 校验国内加速源）

设计思路（和「新师慧成」一致）：
- 安装包和 latest.yml 放在 GitHub Releases（免费、可回滚、可匿名下载）；
- 国内直连 github.com 经常超时，客户端按顺序尝试 gh.monlor.com / gh-proxy.com /
  ghfile.geekertao.top / hk.gh-proxy.com / GitHub 直连；
- 本脚本负责：改版本号 → 构建 → 发布 → 打 tag 并推送到 GitHub → 校验镜像清单。

用法（在项目根目录）：
  powershell -ExecutionPolicy Bypass -File desktop\release.ps1 -Version 1.0.1
  powershell -ExecutionPolicy Bypass -File desktop\release.ps1 -SkipBuild     # 只上传现有产物
  powershell -ExecutionPolicy Bypass -File desktop\release.ps1 -SkipPublish   # 只打包
  powershell -ExecutionPolicy Bypass -File desktop\release.ps1 -NoPush        # 不发 git commit/tag

常用参数：
  -Version x.y.z   修改 desktop\electron\package.json 版本号后重新打包发布
  -Repo owner/repo 覆盖 GitHub 仓库（默认 fjz-hosts/changshipin-jiexi）
  -NoPush          不自动 commit / tag / push
#>
param(
    [string]$Version = "",
    [switch]$SkipBuild,
    [switch]$SkipPublish,
    [switch]$NoPush,
    [string]$Repo = "fjz-hosts/changshipin-jiexi"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pkgPath = Join-Path $root "desktop\electron\package.json"
$utf8 = New-Object System.Text.UTF8Encoding($false)
$feedUrl = "https://gh.monlor.com/https://github.com/$Repo/releases/latest/download/"
$cdnPrefix = "https://gh.monlor.com/https://github.com/$Repo/releases/download/"

Set-Location $root
Write-Host "=============================================="
Write-Host " 长视频解析 · 发版  $Repo"
Write-Host "=============================================="

# ---- 1. 版本号 / 更新源 ----
$text = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8)
$original = $text
if ($Version) {
    $text = [regex]::Replace($text, '("version"\s*:\s*")[^"]*(")', ('${1}' + $Version + '${2}'), 1)
}
$text = [regex]::Replace(
    $text,
    '"publish"\s*:\s*\[.*?\]',
    ('"publish": [' + "`n      {`n        `"provider`": `"generic`",`n        `"url`": `"$feedUrl`"`n      }`n    ]"),
    [System.Text.RegularExpressions.RegexOptions]::Singleline)
if ($text -ne $original) {
    [System.IO.File]::WriteAllText($pkgPath, $text, $utf8)
    Write-Host "已更新 package.json（version / publish.url）"
}

$pkg = [System.IO.File]::ReadAllText($pkgPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$pkgVersion = $pkg.version
Write-Host "当前版本：v$pkgVersion"

# ---- 2. 打包 ----
if (-not $SkipBuild) {
    Write-Host ""
    Write-Host ">>> 开始打包..."
    & powershell -ExecutionPolicy Bypass -File (Join-Path $root "desktop\build.ps1")
    if ($LASTEXITCODE -ne 0) { throw "打包失败，未发布。" }
}
else {
    Write-Host "跳过打包（-SkipBuild）。"
}

# ---- 3. 自检 ----
$setup = Join-Path $root "release\changshipin-Setup-$pkgVersion.exe"
$latest = Join-Path $root "release\latest.yml"
if (-not (Test-Path $setup)) { throw "找不到安装包：$setup" }
if (-not (Test-Path $latest)) { throw "找不到更新清单：$latest" }

$yml = [System.IO.File]::ReadAllText($latest, [System.Text.Encoding]::UTF8)
if ($yml -notmatch "version:\s*$([regex]::Escape($pkgVersion))") {
    throw "latest.yml 版本号与 package.json 不一致。"
}
$appUpdatePath = Join-Path $root "release\win-unpacked\resources\app-update.yml"
$appUpdate = [System.IO.File]::ReadAllText($appUpdatePath, [System.Text.Encoding]::UTF8)
if ($appUpdate -notmatch "provider:\s*generic" -or $appUpdate -notmatch [regex]::Escape("github.com/$Repo")) {
    throw "app-update.yml 的更新源不对：`n$appUpdate"
}

$sizeMb = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Host ""
Write-Host ">>> 自检通过"
Write-Host "  安装包    : release\changshipin-Setup-$pkgVersion.exe ($sizeMb MB)"
Write-Host "  更新清单  : latest.yml version=$pkgVersion"
Write-Host "  更新源    : $feedUrl"

if ($SkipPublish) {
    Write-Host ""
    Write-Host "已完成打包（未发布）。"
    exit 0
}

# ---- 4. 发布到 GitHub Releases ----
Write-Host ""
Write-Host ">>> 发布到 GitHub Releases..."
& powershell -ExecutionPolicy Bypass -File (Join-Path $root "desktop\publish.ps1") -Repo $Repo
if ($LASTEXITCODE -ne 0) { throw "发布失败。" }

# ---- 5. 版本号提交 / 打 tag / 推送 ----
if (-not $NoPush) {
    Write-Host ""
    Write-Host ">>> 提交版本号并打 tag..."
    try {
        # 有的机器全局配了失效的 127.0.0.1 代理，这里显式绕过，直连 github
        function Invoke-Git { & git -C $root -c http.proxy= -c https.proxy= @args }
        Invoke-Git add "desktop/electron/package.json"
        $dirty = Invoke-Git status --porcelain -- "desktop/electron/package.json"
        if ($dirty) {
            Invoke-Git commit -m "chore: release v$pkgVersion" | Out-Null
        }
        Invoke-Git rev-parse -q --verify "refs/tags/v$pkgVersion" *> $null
        if ($LASTEXITCODE -ne 0) {
            Invoke-Git tag "v$pkgVersion"
        }
        Invoke-Git push origin HEAD
        if ($LASTEXITCODE -ne 0) { throw "git push main 失败（可稍后手动推送）" }
        Invoke-Git push origin "v$pkgVersion"
        if ($LASTEXITCODE -ne 0) { throw "git push tag 失败（可稍后手动推送）" }
        Write-Host "已推送 tag v$pkgVersion"
    }
    catch {
        Write-Warning "git 推送失败（Release 已经发布成功，可稍后手动推送）：$($_.Exception.Message)"
    }
}

# ---- 6. 校验国内加速源 ----
Write-Host ""
Write-Host ">>> 校验镜像 $feedUrl"
$probe = $null
foreach ($i in 1..6) {
    try {
        $resp = Invoke-WebRequest "$($feedUrl)latest.yml" -UseBasicParsing -TimeoutSec 20
        $probe = if ($resp.Content -is [byte[]]) { [System.Text.Encoding]::UTF8.GetString($resp.Content) } else { [string]$resp.Content }
        break
    }
    catch {
        Start-Sleep -Seconds 4
    }
}
if (-not $probe) {
    Write-Warning "镜像暂时取不到 latest.yml（GitHub 已发布成功，稍后镜像会跟上）。"
}
elseif ($probe -notmatch "version:\s*$([regex]::Escape($pkgVersion))") {
    Write-Warning "镜像上的 latest.yml 还不是 v$pkgVersion（可能有缓存），客户端会回退到其它源。"
}
else {
    Write-Host "  镜像已同步：version=$pkgVersion"
}

Write-Host ""
Write-Host "全部完成："
Write-Host "  Release   : https://github.com/$Repo/releases/tag/v$pkgVersion"
Write-Host "  国内加速  : $($feedUrl)latest.yml"
Write-Host "  已装旧版的用户下次启动会自动更新。"
exit 0
