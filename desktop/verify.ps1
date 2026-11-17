param(
    [switch]$Online,
    [switch]$Browser
)

# 发版前自检：
#   默认跑无头 smoke（不联网）
#   -Online  再带上外网解析链路检查
#   -Browser 额外跑 tools/cdp-test8.mjs（内嵌浏览器/自动解析/历史，需要真实网络，约 40 秒）
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$electronDir = Join-Path $root "desktop\electron"
$exe = Join-Path $electronDir "node_modules\electron\dist\electron.exe"
if (-not (Test-Path $exe)) { throw "找不到 Electron：$exe（先在 desktop\electron 里 npm install）" }

$tmp = Join-Path $root ".tmp"
New-Item -ItemType Directory -Force $tmp | Out-Null
$userData = Join-Path $tmp "verify-userdata"
Remove-Item $userData -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
if ($Online) { $env:CHANGSPIN_SMOKE_ONLINE = "1" } else { Remove-Item Env:CHANGSPIN_SMOKE_ONLINE -ErrorAction SilentlyContinue }

$out = Join-Path $tmp "verify-smoke.txt"
# 用 cmd 清掉 ELECTRON_RUN_AS_NODE 再启动，避免 Electron 被当成 Node 跑
$cmdLine = 'set ELECTRON_RUN_AS_NODE=&& set CHANGSPIN_USERDATA=' + $userData + '&& "' + $exe + '" . --smoke-test --no-sandbox --disable-gpu > "' + $out + '" 2>&1'
Push-Location $electronDir
try {
    cmd /c $cmdLine
    $code = $LASTEXITCODE
}
finally {
    Pop-Location
}

$text = [System.IO.File]::ReadAllText($out, [System.Text.Encoding]::UTF8)
$passed = ([regex]::Matches($text, '"ok": true')).Count
$failed = ([regex]::Matches($text, '"ok": false')).Count
Write-Host "自检结果：passed=$passed failed=$failed exit=$code"
if ($code -ne 0 -or $failed -gt 0) {
    Get-Content $out -Encoding UTF8 | Select-Object -Last 50
    throw "自检未通过，已停止发版。"
}
Write-Host "自检通过（$passed 项）。"

if ($Browser) {
    Write-Host ">>> 启动界面回归（cdp-test8）..."
    $port = 9345
    $env:CHANGSPIN_USERDATA = Join-Path $tmp "verify-browser-userdata"
    Remove-Item $env:CHANGSPIN_USERDATA -Recurse -Force -ErrorAction SilentlyContinue
    $proc = Start-Process -FilePath $exe -ArgumentList ".", "--remote-debugging-port=$port", "--no-sandbox", "--disable-gpu" -WorkingDirectory $electronDir -PassThru -WindowStyle Hidden
    try {
        $ready = $false
        for ($i = 0; $i -lt 30; $i++) {
            Start-Sleep -Milliseconds 500
            try {
                $null = Invoke-WebRequest "http://127.0.0.1:$port/json/list" -UseBasicParsing -TimeoutSec 2
                $ready = $true
                break
            }
            catch { }
        }
        if (-not $ready) { throw "界面回归：应用没有在 15 秒内打开调试端口" }
        $env:CDP_ENDPOINT = "http://127.0.0.1:$port"
        & node (Join-Path $root "tools\cdp-test8.mjs")
        if ($LASTEXITCODE -ne 0) { throw "界面回归 cdp-test8 未通过" }
    }
    finally {
        Remove-Item Env:CDP_ENDPOINT -ErrorAction SilentlyContinue
        Remove-Item Env:CHANGSPIN_USERDATA -ErrorAction SilentlyContinue
        try { if ($proc -and -not $proc.HasExited) { Stop-Process -Id $proc.Id -Force } } catch { }
        Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Write-Host "界面回归通过。"
}

Write-Host "全部检查通过。"
