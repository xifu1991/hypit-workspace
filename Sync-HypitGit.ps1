param(
    [ValidateSet("Pull", "Push", "Status")]
    [string]$Action = "Status",
    [string]$Message = "",
    [string]$CodeRepo = "",
    [string]$WorkspaceRepo = ""
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($CodeRepo)) {
    $CodeRepo = Join-Path $PSScriptRoot "hypit-local-demo"
}
if ([string]::IsNullOrWhiteSpace($WorkspaceRepo)) {
    $WorkspaceRepo = $PSScriptRoot
}

$repositories = @(
    [pscustomobject]@{ Name = "code"; Path = $CodeRepo },
    [pscustomobject]@{ Name = "workspace"; Path = $WorkspaceRepo }
)

function Invoke-Git {
    param(
        [string]$Repository,
        [string[]]$Arguments
    )
    & git -C $Repository @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git failed in ${Repository}: git $($Arguments -join ' ')"
    }
}

function Test-GitRepository {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) {
        return $false
    }
    & git -C $Path rev-parse --is-inside-work-tree *> $null
    return $LASTEXITCODE -eq 0
}

foreach ($repository in $repositories) {
    Write-Host ""
    Write-Host "[$($repository.Name)] $($repository.Path)"

    if (-not (Test-GitRepository -Path $repository.Path)) {
        if ($Action -eq "Status") {
            Write-Host "  Not a Git repository yet."
            continue
        }
        throw "Not a Git repository: $($repository.Path)"
    }

    $branch = (& git -C $repository.Path branch --show-current).Trim()
    $remote = (& git -C $repository.Path remote get-url origin 2>$null)
    $dirty = @(& git -C $repository.Path status --porcelain)
    Write-Host "  Branch: $branch"
    Write-Host "  Origin: $(if ($remote) { $remote } else { 'not configured' })"
    Write-Host "  Changes: $($dirty.Count)"

    if ($Action -eq "Status") {
        if ($dirty.Count -gt 0) {
            Write-Host "  Pending files:"
            $dirty | Select-Object -First 20 | ForEach-Object { Write-Host "    $_" }
        }
        continue
    }

    if (-not $remote) {
        throw "Origin is not configured for $($repository.Path)"
    }

    if ($Action -eq "Pull") {
        Write-Host "  Pulling..."
        Invoke-Git -Repository $repository.Path -Arguments @("pull", "--rebase")
        continue
    }

    if ($dirty.Count -gt 0) {
        if ([string]::IsNullOrWhiteSpace($Message)) {
            throw "Pending changes exist. Supply -Message to commit and push."
        }
        Write-Host "  Committing..."
        Invoke-Git -Repository $repository.Path -Arguments @("add", "-A")
        Invoke-Git -Repository $repository.Path -Arguments @("commit", "-m", $Message)
    }

    Write-Host "  Pushing..."
    Invoke-Git -Repository $repository.Path -Arguments @("push")
}

Write-Host ""
Write-Host "Git sync action '$Action' complete."
