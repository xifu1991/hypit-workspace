# Generate the narration WAVs with the offline Windows SAPI voice defined in narration.json.
# ASCII-only source: all Chinese copy lives in narration.json so the encoding is unambiguous.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Split-Path -Parent $here
$configPath = Join-Path $here "narration.json"
$audioDir = Join-Path $projectRoot "audio"

$config = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8) | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $audioDir | Out-Null

$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$synth.SelectVoice($config.voice)
$synth.Rate = [int]$config.rate
$synth.Volume = [int]$config.volume

$rows = @()
foreach ($line in $config.lines) {
  $path = Join-Path $audioDir ("{0}.wav" -f $line.id)
  $synth.SetOutputToWaveFile($path)
  $synth.Speak($line.text)
  $synth.SetOutputToNull()
  $info = New-Object System.IO.FileInfo($path)
  # 22050 Hz / 16-bit / mono PCM -> 44100 bytes per second
  $seconds = [math]::Round(($info.Length - 44) / 44100.0, 3)
  $rows += [pscustomobject]@{ id = $line.id; seconds = $seconds; bytes = $info.Length; text = $line.text }
}
$synth.Dispose()

$rows | Format-Table -AutoSize
$total = ($rows | Measure-Object -Property seconds -Sum).Sum
Write-Output ("total narration seconds: {0}" -f [math]::Round($total, 3))
