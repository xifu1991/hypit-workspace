# Final render for the 30s Xian Ni ep.161 teaser sample.
# Run from anywhere:  pwsh -File render-final.ps1
#
# Pipeline
#   0:v  letterboxed 1920x1080 bed -> libass overlay (narration subtitles + callout cards)
#   0:a  original show audio (dialogue + score) ducked to 15%
#   1:8  nine offline SAPI narration clips, delayed onto the timeline
#   mix -> limiter -> loudness normalise -> H.264 High + AAC
#
# Working directory is the overlay folder so the filter graph can use relative
# paths (no "C:" colon escaping inside the filter string).
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$overlayDir = Join-Path $here "overlay"
$ffmpeg = "C:\HYPIT_MIGRATION\tools\ffmpeg\bin\ffmpeg.exe"
$bed = Join-Path $here "overlay-assets-base-30s.mp4"
$output = Join-Path $here "xianni_ep161_teaser_30s_final.mp4"

if (-not (Test-Path $ffmpeg)) { throw "ffmpeg not found: $ffmpeg" }
if (-not (Test-Path $bed)) { throw "base bed not found: $bed" }

# narration clip -> start time on the 30s timeline (milliseconds)
$schedule = [ordered]@{
  n02 = 1900
  n03 = 7100
  n04 = 10450
  n05 = 13720
  n06 = 18050
  n07 = 20000
  n08 = 23950
  n09 = 26600
  n10 = 28300
}

$bgVolume = 0.15   # original show mix sits under the narration
$voVolume = 3.2    # SAPI clips are around -22 dB mean; lift them to speech level

$args = @()
$args += @("-hide_banner", "-y")
$args += @("-i", $bed)
foreach ($id in $schedule.Keys) {
  $args += @("-i", (Join-Path $here ("audio\{0}.wav" -f $id)))
}

$graph = @()
$graph += "[0:v]ass=ep161-overlay.ass:fontsdir=assets/fonts[vout]"
$graph += ("[0:a]aresample=44100,aformat=channel_layouts=stereo,volume={0}[bg]" -f $bgVolume)

$mixLabels = @("[bg]")
$index = 1
foreach ($id in $schedule.Keys) {
  $delay = $schedule[$id]
  $graph += ("[{0}:a]aresample=44100,aformat=channel_layouts=stereo,volume={1},adelay={2}:all=1[{3}]" -f $index, $voVolume, $delay, $id)
  $mixLabels += ("[{0}]" -f $id)
  $index += 1
}

$graph += ("{0}amix=inputs={1}:duration=first:normalize=0,alimiter=limit=0.95,loudnorm=I=-14:TP=-1.0:LRA=11[aout]" -f ($mixLabels -join ""), $mixLabels.Count)
$filter = $graph -join ";"

$args += @(
  "-filter_complex", $filter,
  "-map", "[vout]",
  "-map", "[aout]",
  "-c:v", "libx264", "-preset", "slow", "-crf", "18",
  "-profile:v", "high", "-level", "4.0", "-pix_fmt", "yuv420p", "-r", "30",
  "-c:a", "aac", "-b:a", "192k", "-ar", "44100", "-ac", "2",
  "-movflags", "+faststart",
  "-t", "30",
  $output
)

Push-Location $overlayDir
try {
  & $ffmpeg @args
  if ($LASTEXITCODE -ne 0) { throw "ffmpeg exited with code $LASTEXITCODE" }
} finally {
  Pop-Location
}

Get-Item $output | Select-Object FullName, Length
