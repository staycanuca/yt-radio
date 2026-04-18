param(
  [string]$StateFile = "radio-process.json",
  [int]$Tail = 20
)

$ErrorActionPreference = "Stop"

function Get-ProjectFilePath {
  param([string]$PathValue)

  if ([string]::IsNullOrWhiteSpace($PathValue)) {
    return $null
  }

  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return $PathValue
  }

  return Join-Path $PSScriptRoot $PathValue
}

function Read-JsonFile {
  param([string]$PathValue)

  $resolvedPath = Get-ProjectFilePath $PathValue
  if (-not $resolvedPath -or -not (Test-Path -LiteralPath $resolvedPath)) {
    return $null
  }

  try {
    $content = Get-Content -LiteralPath $resolvedPath -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($content)) {
      return $null
    }

    return $content | ConvertFrom-Json
  } catch {
    Write-Host "Failed to read JSON file: $resolvedPath" -ForegroundColor Yellow
    return $null
  }
}

function Find-RadioPort {
  param(
    [string]$StateFilePath
  )

  $candidates = New-Object System.Collections.Generic.List[int]

  $statePath = Get-ProjectFilePath $StateFilePath
  if ($statePath -and (Test-Path -LiteralPath $statePath)) {
    try {
      $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
      if ($state.port) {
        $candidates.Add([int]$state.port)
      }
    } catch {
    }
  }

  foreach ($defaultPort in @(18080, 8080)) {
    $candidates.Add($defaultPort)
  }

  try {
    $listeningPorts = Get-NetTCPConnection -State Listen -ErrorAction Stop |
      Select-Object -ExpandProperty LocalPort -Unique

    foreach ($listeningPort in $listeningPorts) {
      if ($listeningPort) {
        $candidates.Add([int]$listeningPort)
      }
    }
  } catch {
  }

  $orderedCandidates = $candidates | Select-Object -Unique

  foreach ($candidate in $orderedCandidates) {
    try {
      $health = Invoke-RestMethod -Uri "http://127.0.0.1:$candidate/health" -Method GET -TimeoutSec 2
      if ($health -and $null -ne $health.client_ready) {
        return [int]$candidate
      }
    } catch {
    }
  }

  return $null
}

function Test-ProcessRunning {
  param([int]$PidValue)

  try {
    return [bool](Get-Process -Id $PidValue -ErrorAction Stop)
  } catch {
    return $false
  }
}

function Show-LogTail {
  param(
    [string]$Label,
    [string]$PathValue,
    [int]$TailLines
  )

  Write-Host ""
  Write-Host "$Label" -ForegroundColor Cyan

  $resolvedPath = Get-ProjectFilePath $PathValue
  if (-not $resolvedPath -or -not (Test-Path -LiteralPath $resolvedPath)) {
    Write-Host "  missing"
    return
  }

  Get-Content -LiteralPath $resolvedPath -Tail $TailLines | ForEach-Object {
    Write-Host "  $_"
  }
}

$statePath = Get-ProjectFilePath $StateFile
$state = Read-JsonFile $StateFile

$pidValue = 0
if ($state -and $state.pid) {
  $pidValue = [int]$state.pid
}

$isRunning = $false
if ($pidValue -gt 0) {
  $isRunning = Test-ProcessRunning $pidValue
}

$port = if ($state -and $state.port) { [int]$state.port } else { Find-RadioPort $StateFile }
$health = $null
$stats = $null

if ($port) {
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -Method GET -TimeoutSec 5
  } catch {
  }

  try {
    $stats = Invoke-RestMethod -Uri "http://127.0.0.1:$port/stats" -Method GET -TimeoutSec 5
  } catch {
  }
}

Write-Host "Managed radio status" -ForegroundColor Green
Write-Host "  State file: $statePath"
Write-Host "  State file present: $([bool]$state)"
Write-Host "  PID: $pidValue"
Write-Host "  Running: $isRunning"
Write-Host "  Preset: $($state.preset)"
Write-Host "  Profile: $($state.profile)"
Write-Host "  Port: $port"
Write-Host "  GopherPort: $($state.gopherPort)"
Write-Host "  StartedAt: $($state.startedAt)"

if ($health) {
  Write-Host "  Health.ok: $($health.ok)"
  Write-Host "  Health.playing: $($health.playing)"
  Write-Host "  Health.shutting_down: $($health.shutting_down)"
  Write-Host "  Health.consecutive_failures: $($health.consecutive_failures)"
} else {
  Write-Host "  Health: unavailable" -ForegroundColor Yellow
}

if ($stats) {
  $currentDisplay = if ($stats.current -and $stats.current.display) { $stats.current.display } else { "" }
  $nextDisplay = if ($stats.next) { "$($stats.next.author) - $($stats.next.title)" } else { "" }
  Write-Host "  Current: $currentDisplay"
  Write-Host "  Next: $nextDisplay"
  Write-Host "  SongsStarted: $($stats.songs_started)"
  Write-Host "  SongsCompleted: $($stats.songs_completed)"
  Write-Host "  LastBackend: $($stats.last_playback_backend)"
} else {
  Write-Host "  Stats: unavailable" -ForegroundColor Yellow
}

Show-LogTail "Stdout tail" $state.stdoutLog $Tail
Show-LogTail "Stderr tail" $state.stderrLog $Tail
