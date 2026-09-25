param(
    [switch]$SkipInstall,
    [switch]$SkipBrowserInstall
)

$ErrorActionPreference = "Stop"

$bundleRoot = $PSScriptRoot
$workspace = Join-Path $bundleRoot "workspace"
$app = Join-Path $workspace "hypit-local-demo"
$ffmpegDirectory = Join-Path $bundleRoot "tools\ffmpeg\bin"
$ffmpeg = Join-Path $ffmpegDirectory "ffmpeg.exe"
$ffprobe = Join-Path $ffmpegDirectory "ffprobe.exe"
$browserCache = Join-Path $bundleRoot "tools\browser-cache"
$preload = Join-Path $workspace "hypit_node_preload.cjs"

if (-not (Test-Path -LiteralPath (Join-Path $app "package.json"))) {
    throw "Migration bundle is incomplete: $app\package.json is missing."
}
if (-not (Test-Path -LiteralPath $ffmpeg) -or -not (Test-Path -LiteralPath $ffprobe)) {
    throw "Bundled FFmpeg is missing: $ffmpegDirectory"
}

$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $node -p "process.versions.node").Trim()
$minimum = [version]"22.15.0"
if ([version]$nodeVersion -lt $minimum) {
    throw "Node $minimum or newer is required. Found $nodeVersion."
}

$previousPath = $env:PATH
$previousFfmpeg = $env:HYPERFRAMES_FFMPEG_PATH
$previousFfprobe = $env:HYPERFRAMES_FFPROBE_PATH
$previousNodeOptions = $env:NODE_OPTIONS
try {
    $env:PATH = "$ffmpegDirectory;$previousPath"
    $env:HYPERFRAMES_FFMPEG_PATH = $ffmpeg
    $env:HYPERFRAMES_FFPROBE_PATH = $ffprobe
    $env:NODE_OPTIONS = "--require=$preload"
    if (Test-Path -LiteralPath $browserCache) {
        $hyperframesCache = Join-Path $browserCache "hyperframes"
        $puppeteerCache = Join-Path $browserCache "puppeteer"
        if (Test-Path -LiteralPath $hyperframesCache) {
            $env:HYPERFRAMES_CACHE_DIR = $hyperframesCache
        }
        if (Test-Path -LiteralPath $puppeteerCache) {
            $env:PUPPETEER_CACHE_DIR = $puppeteerCache
        }
    }

    Push-Location $app
    try {
        if (-not $SkipInstall) {
            $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
            if ($null -ne $pnpm) {
                & $pnpm.Source install --frozen-lockfile
            } else {
                $corepack = Get-Command corepack -ErrorAction SilentlyContinue
                if ($null -eq $corepack) {
                    throw "pnpm or corepack is required. Install Node 24.14.1 and run 'corepack enable'."
                }
                & $corepack.Source pnpm install --frozen-lockfile
            }
            if ($LASTEXITCODE -ne 0) {
                throw "Dependency installation failed."
            }
        }

        if (-not $SkipBrowserInstall -and -not (Test-Path -LiteralPath $browserCache)) {
            & $node "bin/hypit.mjs" doctor
            if ($LASTEXITCODE -ne 0) {
                throw "Hypit Runtime doctor failed."
            }
        }

        function Set-JsonProperty {
            param(
                [Parameter(Mandatory = $true)][object]$Object,
                [Parameter(Mandatory = $true)][string]$Name,
                [Parameter(Mandatory = $true)][object]$Value
            )
            if ($null -eq $Object.PSObject.Properties[$Name]) {
                $Object | Add-Member -NotePropertyName $Name -NotePropertyValue $Value
            } else {
                $Object.$Name = $Value
            }
        }

        function Repair-RuntimeProfile {
            param([Parameter(Mandatory = $true)][string]$Path)
            $json = Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
            foreach ($endpointName in @("media.local", "hyperframes.local")) {
                if ($null -eq $json.endpoints.$endpointName) {
                    continue
                }
                if ($null -eq $json.endpoints.$endpointName.config) {
                    $json.endpoints.$endpointName | Add-Member -NotePropertyName config -NotePropertyValue ([pscustomobject]@{})
                }
                Set-JsonProperty -Object $json.endpoints.$endpointName.config -Name "ffmpegPath" -Value $ffmpeg
                Set-JsonProperty -Object $json.endpoints.$endpointName.config -Name "ffprobePath" -Value $ffprobe
            }

            if ($null -ne $json.endpoints."hyperframes.local".config) {
                Set-JsonProperty -Object $json.endpoints."hyperframes.local".config -Name "quality" -Value "standard"
                Set-JsonProperty -Object $json.endpoints."hyperframes.local".config -Name "workers" -Value 2
                Set-JsonProperty -Object $json.endpoints."hyperframes.local".config -Name "browserGpu" -Value "software"
            }

            $volc = $json.endpoints."volc-asr.default"
            if ($null -ne $volc -and $null -ne $volc.config) {
                $credentials = Join-Path $workspace "config.json"
                if (Test-Path -LiteralPath $credentials) {
                    Set-JsonProperty -Object $volc.config -Name "configPath" -Value $credentials
                }
            }

            $text = $json | ConvertTo-Json -Depth 30
            [System.IO.File]::WriteAllText($Path, $text, [System.Text.UTF8Encoding]::new($false))
        }

        Get-ChildItem -LiteralPath (Join-Path $app "examples") -Recurse -Filter "runtime.json" -File |
            Where-Object { $_.FullName -notmatch "[\\/]node_modules[\\/]" -and $_.FullName -notmatch "[\\/]\.hypit[\\/]" } |
            ForEach-Object { Repair-RuntimeProfile -Path $_.FullName }

        $rootRuntime = Join-Path $workspace "hypit.runtime.json"
        if (Test-Path -LiteralPath $rootRuntime) {
            Repair-RuntimeProfile -Path $rootRuntime
        }

        Write-Host ""
        Write-Host "Hypit migration bootstrap complete."
        Write-Host "  Node       $nodeVersion"
        Write-Host "  Workspace  $workspace"
        Write-Host "  FFmpeg     $ffmpeg"
        Write-Host ""
        Write-Host "Start Studio with:"
        Write-Host "  .\Start-HypitStudio.ps1 -Port 4317"
    } finally {
        Pop-Location
    }
} finally {
    $env:PATH = $previousPath
    $env:HYPERFRAMES_FFMPEG_PATH = $previousFfmpeg
    $env:HYPERFRAMES_FFPROBE_PATH = $previousFfprobe
    $env:NODE_OPTIONS = $previousNodeOptions
}
