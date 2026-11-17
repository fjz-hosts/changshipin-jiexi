<#
把已构建的安装包发布到 GitHub Releases（自动更新依赖它）。

前置：安装 GitHub CLI 并登录一次
  winget install GitHub.cli
  gh auth login

用法（在项目根目录）：
  powershell -ExecutionPolicy Bypass -File desktop\publish.ps1
  powershell -ExecutionPolicy Bypass -File desktop\publish.ps1 -Repo fjz-hosts/changshipin-jiexi -Notes "修复..."

只上传安装包、latest.yml 和 .blockmap；仓库必须公开，自动更新才能匿名下载。
#>
param(
    [string]$Repo = "fjz-hosts/changshipin-jiexi",
    [string]$Notes = "",
    [switch]$Draft,
    [switch]$Prerelease
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$electronDir = Join-Path $root "desktop\electron"
Set-Location $root

$pkg = [System.IO.File]::ReadAllText((Join-Path $electronDir "package.json"), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
$version = $pkg.version
$tag = "v$version"
$setup = "release\changshipin-Setup-$version.exe"
$latest = "release\latest.yml"
$blockmap = "$setup.blockmap"

if (-not (Test-Path $setup)) { throw "找不到安装包：$setup（先运行 desktop\build.ps1）" }
if (-not (Test-Path $latest)) { throw "找不到更新清单：$latest" }
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "未找到 gh。请先安装 GitHub CLI 并执行 gh auth login。" }

$files = @($setup, $latest)
if (Test-Path $blockmap) { $files += $blockmap }
if (-not $Notes) {
    $Notes = @"
长视频解析 v$version

- 支持爱奇艺 / 腾讯视频 / 优酷 / 芒果TV 链接解析播放
- 四个平台快捷入口，内置浏览器可登录会员
- 多线路解析，失败自动换线
- 启动时自动检查更新（GitHub Releases + 国内加速镜像）

安装后程序会在启动时自动检查更新。
"@
}

# gh 在 release 不存在时会把 "release not found" 写到 stderr，
# 在 Stop 模式下会被当成终止错误，这里临时放宽并显式检查退出码。
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& gh release view $tag --repo $Repo *> $null
$releaseExists = ($LASTEXITCODE -eq 0)
if ($releaseExists) {
    Write-Host "发布已存在，追加/覆盖资源：$tag"
    & gh release upload $tag @files --repo $Repo --clobber
}
else {
    $extra = @()
    if ($Draft) { $extra += "--draft" }
    if ($Prerelease) { $extra += "--prerelease" }
    & gh release create $tag @files --repo $Repo --title "长视频解析 $version" --notes $Notes @extra
}
$code = $LASTEXITCODE
$ErrorActionPreference = $prevEap
if ($code -ne 0) { throw "发布失败（gh 退出码 $code）" }

Write-Host ""
Write-Host "已发布 $tag：https://github.com/$Repo/releases/tag/$tag"
Write-Host "已安装旧版本的用户下次启动会自动检测并下载这个版本。"
