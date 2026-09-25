param(
    [Parameter(Mandatory = $true)]
    [string]$Destination,
    [switch]$IncludeBrowserCache,
    [switch]$IncludeCredentials
)

$ErrorActionPreference = "Stop"

$workspace = Split-Path -Parent $PSScriptRoot
$sourceApp = Join-Path $workspace "hypit-local-demo"
$bundleRoot = Join-Path $Destination "HYPIT_MIGRATION"
$bundleWorkspace = Join-Path $bundleRoot "workspace"
$bundleApp = Join-Path $bundleWorkspace "hypit-local-demo"
$bundleTools = Join-Path $bundleRoot "tools"
$bundleFfmpeg = Join-Path $bundleTools "ffmpeg\bin"
$sourceFfmpeg = "C:\Users\admin\.codex\plugins\cache\openai-curated-remote\mandarin-talking-head-rough-cut\1.1.0\skills\rough-cut\.tools\ffmpeg\bin"

if (-not (Test-Path -LiteralPath (Join-Path $sourceApp "package.json"))) {
    throw "Hypit source was not found: $sourceApp"
}
if (-not (Test-Path -LiteralPath (Join-Path $sourceFfmpeg "ffmpeg.exe"))) {
    throw "FFmpeg was not found: $sourceFfmpeg"
}

New-Item -ItemType Directory -Force -Path $bundleApp, $bundleWorkspace, $bundleFfmpeg | Out-Null

function Copy-Tree {
    param(
        [Parameter(Mandatory = $true)][string]$SourcePath,
        [Parameter(Mandatory = $true)][string]$DestinationRoot
    )
    $sourceItem = Get-Item -LiteralPath $SourcePath -Force
    if ($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        return
    }
    $target = Join-Path $DestinationRoot $sourceItem.Name
    if ($sourceItem.PSIsContainer) {
        New-Item -ItemType Directory -Force -Path $target | Out-Null
        foreach ($child in Get-ChildItem -LiteralPath $SourcePath -Force) {
            if ($child.PSIsContainer -and $child.Name -in @("node_modules", ".hypit")) {
                continue
            }
            Copy-Tree -SourcePath $child.FullName -DestinationRoot $target
        }
    } else {
        Copy-Item -LiteralPath $SourcePath -Destination $target -Force
    }
}

Write-Host "Copying Hypit source tree..."
foreach ($item in Get-ChildItem -LiteralPath $sourceApp -Force) {
    if ($item.Name -in @("node_modules", ".hypit")) {
        continue
    }
    Copy-Tree -SourcePath $item.FullName -DestinationRoot $bundleApp
}

Write-Host "Copying workspace, styles and settings..."
foreach ($name in @("style-library", "HYPIT_EDITING_PROTOCOL.md", "HYPIT_STYLE_LIBRARY_DISCOVERY.md",
        "HYPIT_STYLE_SELECTION.json", "hypit_node_preload.cjs", "hypit.runtime.json")) {
    $source = Join-Path $workspace $name
    if (Test-Path -LiteralPath $source) {
        Copy-Tree -SourcePath $source -DestinationRoot $bundleWorkspace
    }
}

foreach ($script in Get-ChildItem -LiteralPath $workspace -Filter "start_studio*.ps1" -File -ErrorAction SilentlyContinue) {
    Copy-Item -LiteralPath $script.FullName -Destination $bundleWorkspace -Force
}

Write-Host "Copying FFmpeg..."
Copy-Item -LiteralPath (Join-Path $sourceFfmpeg "ffmpeg.exe") -Destination $bundleFfmpeg -Force
Copy-Item -LiteralPath (Join-Path $sourceFfmpeg "ffprobe.exe") -Destination $bundleFfmpeg -Force

if ($IncludeCredentials) {
    $credentials = Join-Path $workspace "config.json"
    if (Test-Path -LiteralPath $credentials) {
        Write-Host "Copying Volcengine credentials..."
        Copy-Item -LiteralPath $credentials -Destination $bundleWorkspace -Force
    } else {
        Write-Warning "config.json was not found; Volcengine ASR credentials were not copied."
    }
}

if ($IncludeBrowserCache) {
    Write-Host "Copying browser cache..."
    $browserDestination = Join-Path $bundleTools "browser-cache"
    New-Item -ItemType Directory -Force -Path $browserDestination | Out-Null
    $hyperframesCache = Join-Path $env:USERPROFILE ".cache\hyperframes"
    if (Test-Path -LiteralPath $hyperframesCache) {
        $hyperframesDestination = Join-Path $browserDestination "hyperframes"
        New-Item -ItemType Directory -Force -Path $hyperframesDestination | Out-Null
        foreach ($item in Get-ChildItem -LiteralPath $hyperframesCache -Force) {
            Copy-Tree -SourcePath $item.FullName -DestinationRoot $hyperframesDestination
        }
    }
    $puppeteerCache = Join-Path $env:USERPROFILE ".cache\puppeteer"
    if (Test-Path -LiteralPath $puppeteerCache) {
        $puppeteerDestination = Join-Path $browserDestination "puppeteer"
        New-Item -ItemType Directory -Force -Path $puppeteerDestination | Out-Null
        foreach ($item in Get-ChildItem -LiteralPath $puppeteerCache -Force) {
            Copy-Tree -SourcePath $item.FullName -DestinationRoot $puppeteerDestination
        }
    }
}

Write-Host "Writing migration metadata..."
foreach ($file in @(
        "Bootstrap-Hypit.ps1",
        "Start-HypitStudio.ps1",
        "quality-lock.json",
        "README.md"
    )) {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $file) -Destination $bundleRoot -Force
}

$manifest = [ordered]@{
    format = "hypit.migration-bundle@1"
    createdAt = (Get-Date).ToUniversalTime().ToString("o")
    sourceWorkspace = $workspace
    includesBrowserCache = [bool]$IncludeBrowserCache
    includesCredentials = [bool]$IncludeCredentials
    qualityLock = (Get-Content -Raw (Join-Path $PSScriptRoot "quality-lock.json") | ConvertFrom-Json)
}
$manifestPath = Join-Path $bundleRoot "migration-manifest.json"
[System.IO.File]::WriteAllText(
    $manifestPath,
    ($manifest | ConvertTo-Json -Depth 20),
    [System.Text.UTF8Encoding]::new($false)
)

Write-Host ""
Write-Host "Migration bundle created:"
Write-Host "  $bundleRoot"
Write-Host ""
Write-Host "Copy this folder to the new PC, then run Bootstrap-Hypit.ps1."
if ($IncludeCredentials) {
    Write-Warning "The bundle contains Volcengine credentials. Transfer it only through a trusted private channel."
}
