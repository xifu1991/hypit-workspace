param([int]$Port = 4323)
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$project = Join-Path $root "hypit-local-demo"
$run = Join-Path $project "examples\lamer-unboxing-shipin\edit.svrun"
$outLog = Join-Path $root "studio-$Port.out.log"
$errLog = Join-Path $root "studio-$Port.err.log"
$ffmpegDirectory = Join-Path $root "tools\ffmpeg"
$preload = Join-Path $root "hypit_node_preload.cjs"

if (-not (Test-Path -LiteralPath (Join-Path $ffmpegDirectory "ffprobe.exe"))) {
    throw "The configured ffprobe executable is unavailable."
}

$existing = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
if ($existing) { exit 0 }

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

$deadline = (Get-Date).AddSeconds(120)
while ((Get-Date) -lt $deadline) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) { exit 0 }
    Start-Sleep -Milliseconds 500
}

exit 1
