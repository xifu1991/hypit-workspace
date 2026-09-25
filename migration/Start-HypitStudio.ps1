param(
    [string]$RunPath = "",
    [int]$Port = 4317
)

$ErrorActionPreference = "Stop"

$bundleRoot = $PSScriptRoot
$workspace = Join-Path $bundleRoot "workspace"
$app = Join-Path $workspace "hypit-local-demo"
$defaultRun = Join-Path $app "examples\style-clone-20260828-img2411\edit.svrun"
$run = if ([string]::IsNullOrWhiteSpace($RunPath)) {
    $defaultRun
} elseif ([System.IO.Path]::IsPathRooted($RunPath)) {
    $RunPath
} else {
    Join-Path (Get-Location) $RunPath
}
$runtime = Join-Path (Split-Path -Parent $run) "runtime.json"
$ffmpegDirectory = Join-Path $bundleRoot "tools\ffmpeg\bin"
$preload = Join-Path $workspace "hypit_node_preload.cjs"
$browserCache = Join-Path $bundleRoot "tools\browser-cache"

if (-not (Test-Path -LiteralPath $run)) {
    throw "Run source was not found: $run"
}
if (-not (Test-Path -LiteralPath $runtime)) {
    throw "Runtime Profile was not found: $runtime"
}

$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
try {
    $listener.Start()
} catch {
    throw "Port $Port is already in use. Choose another port with -Port."
} finally {
    $listener.Stop()
}

$node = (Get-Command node -ErrorAction Stop).Source
$env:PATH = "$ffmpegDirectory;$env:PATH"
$env:HYPERFRAMES_FFMPEG_PATH = Join-Path $ffmpegDirectory "ffmpeg.exe"
$env:HYPERFRAMES_FFPROBE_PATH = Join-Path $ffmpegDirectory "ffprobe.exe"
$env:NODE_OPTIONS = "--require=$preload"
if (Test-Path -LiteralPath $browserCache) {
    $env:PUPPETEER_CACHE_DIR = $browserCache
    $env:HYPERFRAMES_CACHE_DIR = $browserCache
}

$outLog = Join-Path $bundleRoot "studio-$Port.out.log"
$errLog = Join-Path $bundleRoot "studio-$Port.err.log"
Start-Process `
    -FilePath $node `
    -ArgumentList @(
        "bin/hypit.mjs",
        "studio",
        "--run", $run,
        "--workspace", $workspace,
        "--package-root", $app,
        "--runtime", $runtime,
        "--port", "$Port"
    ) `
    -WorkingDirectory $app `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog

$url = "http://localhost:$Port/__studio#studio"
$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing $url -TimeoutSec 3
        if ($response.StatusCode -eq 200) {
            Write-Host "Hypit Studio is ready: $url"
            exit 0
        }
    } catch {
        Start-Sleep -Milliseconds 500
    }
}

throw "Studio did not become ready. Check $errLog and $outLog."
