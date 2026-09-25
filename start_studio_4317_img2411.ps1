param([int]$Port = 4317)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root "hypit-local-demo"
$example = Join-Path $project "examples\style-clone-20260828-img2411"
$run = Join-Path $example "edit.svrun"
$runtime = Join-Path $example "runtime.json"
$outLog = Join-Path $root "studio-4317-img2411.out.log"
$errLog = Join-Path $root "studio-4317-img2411.err.log"
$ffmpegDirectory = "C:\Users\admin\.codex\plugins\cache\openai-curated-remote\mandarin-talking-head-rough-cut\1.1.0\skills\rough-cut\.tools\ffmpeg\bin"
$preload = Join-Path $root "hypit_node_preload.cjs"

if (-not (Test-Path -LiteralPath (Join-Path $ffmpegDirectory "ffprobe.exe"))) {
    throw "The configured ffprobe executable is unavailable."
}

$existing = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($existing) {
    exit 0
}

$node = "C:\Users\admin\AppData\Local\hermes\node\node.exe"
if (-not (Test-Path -LiteralPath $node)) {
    $node = "C:\Users\admin\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
}
if (-not (Test-Path -LiteralPath $node)) {
    $node = (Get-Command node -ErrorAction Stop).Source
}

$previousPath = $env:PATH
$previousFfmpeg = $env:HYPERFRAMES_FFMPEG_PATH
$previousFfprobe = $env:HYPERFRAMES_FFPROBE_PATH
$previousNodeOptions = $env:NODE_OPTIONS
try {
    $env:PATH = "$ffmpegDirectory;$previousPath"
    $env:HYPERFRAMES_FFMPEG_PATH = Join-Path $ffmpegDirectory "ffmpeg.exe"
    $env:HYPERFRAMES_FFPROBE_PATH = Join-Path $ffmpegDirectory "ffprobe.exe"
    $env:NODE_OPTIONS = "--require=$preload"
    Start-Process `
        -FilePath $node `
        -ArgumentList @(
            "bin/hypit.mjs",
            "studio",
            "--run", $run,
            "--workspace", $root,
            "--package-root", $project,
            "--runtime", $runtime,
            "--port", "$port"
        ) `
        -WorkingDirectory $project `
        -WindowStyle Hidden `
        -RedirectStandardOutput $outLog `
        -RedirectStandardError $errLog
} finally {
    $env:PATH = $previousPath
    $env:HYPERFRAMES_FFMPEG_PATH = $previousFfmpeg
    $env:HYPERFRAMES_FFPROBE_PATH = $previousFfprobe
    $env:NODE_OPTIONS = $previousNodeOptions
}

$deadline = (Get-Date).AddSeconds(90)
while ((Get-Date) -lt $deadline) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        exit 0
    }
    Start-Sleep -Milliseconds 500
}

exit 1
