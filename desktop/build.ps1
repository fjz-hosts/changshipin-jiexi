<#
长视频解析 · 构建 Windows 安装包（electron-builder / NSIS）

用法（在项目根目录，或直接右键「使用 PowerShell 运行」）：
  powershell -ExecutionPolicy Bypass -File desktop\build.ps1
  powershell -ExecutionPolicy Bypass -File desktop\build.ps1 -Clean

产物：
  release\changshipin-Setup-<version>.exe         安装包
  release\changshipin-Setup-<version>.exe.blockmap 增量更新用（可一并上传）
  release\latest.yml                              自动更新清单
  release\win-unpacked\                           免安装目录（调试用）

注意：
- 版本号来自 desktop\electron\package.json；
- 第一次构建前，先在 desktop\electron 里执行 npm install；
- 不签名（个人项目）；SmartScreen 首次运行提示「更多信息 → 仍要运行」即可。
#>
param(
    [switch]$Clean
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$electronDir = Join-Path $root "desktop\electron"
$releaseDir = Join-Path $root "release"
$utf8 = New-Object System.Text.UTF8Encoding($false)

# DSH / 某些 Node 环境会设置 ELECTRON_RUN_AS_NODE，导致 electron 以纯 Node 模式启动
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
$env:CSC_IDENTITY_AUTO_DISCOVERY = "false"
# 国内网络直连 GitHub 下载 electron / NSIS 工具链经常卡住，默认走 npmmirror 镜像
if (-not $env:ELECTRON_MIRROR) { $env:ELECTRON_MIRROR = "https://npmmirror.com/mirrors/electron/" }
if (-not $env:ELECTRON_BUILDER_BINARIES_MIRROR) {
    $env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
}

Set-Location $root
$pkg = [System.IO.File]::ReadAllText((Join-Path $electronDir "package.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$version = $pkg.version
Write-Host "=============================================="
Write-Host " 长视频解析 · 构建 v$version"
Write-Host "=============================================="

if (-not (Test-Path (Join-Path $electronDir "node_modules\electron\dist\electron.exe"))) {
    throw "依赖不完整：请先在 desktop\electron 目录执行 npm install"
}
if (-not (Test-Path (Join-Path $electronDir "node_modules\electron-builder\cli.js"))) {
    throw "找不到 electron-builder：请先在 desktop\electron 目录执行 npm install"
}

if ($Clean -and (Test-Path $releaseDir)) {
    Write-Host "清理旧产物：$releaseDir"
    Remove-Item $releaseDir -Recurse -Force
}
New-Item -ItemType Directory -Force $releaseDir | Out-Null

Write-Host ">>> 运行 electron-builder（NSIS x64，不签名，不发布）..."
Push-Location $electronDir
try {
    & node "node_modules\electron-builder\cli.js" --win nsis --x64 --publish never
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}
if ($code -ne 0) { throw "打包失败（electron-builder 退出码 $code）" }

$setup = Join-Path $releaseDir "changshipin-Setup-$version.exe"
$latest = Join-Path $releaseDir "latest.yml"
if (-not (Test-Path $setup)) { throw "找不到安装包：$setup" }
if (-not (Test-Path $latest)) { throw "找不到更新清单：$latest" }

$yml = [System.IO.File]::ReadAllText($latest, [System.Text.Encoding]::UTF8)
if ($yml -notmatch "version:\s*$([regex]::Escape($version))") {
    throw "latest.yml 的版本号与 package.json 不一致：`n$yml"
}
$appUpdate = Join-Path $releaseDir "win-unpacked\resources\app-update.yml"
if (-not (Test-Path $appUpdate)) { throw "找不到 app-update.yml，自动更新配置没有打进去" }
$appUpdateText = [System.IO.File]::ReadAllText($appUpdate, [System.Text.Encoding]::UTF8)
if ($appUpdateText -notmatch "provider:\s*generic") { throw "app-update.yml 的更新源不是 generic：`n$appUpdateText" }

$sizeMb = [math]::Round((Get-Item $setup).Length / 1MB, 1)
Write-Host ""
Write-Host "构建完成："
Write-Host "  安装包    : $setup  ($sizeMb MB)"
Write-Host "  更新清单  : $latest"
Write-Host "  免安装版  : $releaseDir\win-unpacked"
Write-Host "  更新源    : $(( $appUpdateText -split "`n" | Where-Object { $_ -match 'url:' } | Select-Object -First 1).Trim())"
Write-Host ""
Write-Host "下一步：powershell -ExecutionPolicy Bypass -File desktop\release.ps1 -Version $version"
