# Boot/logon launcher for the Hypit Studio session on port 4320.
# Calls the shared DSC_5862 launcher, which is idempotent: if the port is
# already listening it exits immediately without starting a second process.

param(
    [int]$Port = 4320,
    [int]$DelaySeconds = 25
)

$ErrorActionPreference = "Stop"

# Give the desktop session, disk and network a moment to settle after logon.
if ($DelaySeconds -gt 0) {
    Start-Sleep -Seconds $DelaySeconds
}

$launcher = Join-Path $PSScriptRoot "start_studio_4319_dsc5862.ps1"
if (-not (Test-Path -LiteralPath $launcher)) {
    throw "Launcher not found: $launcher"
}

& $launcher -Port $Port
