param(
  [int[]]$Ports = @(18080, 18081),
  [string]$StateFile = "radio-process.json",
  [switch]$NoStop
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

function Get-ManagedState {
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

    $state = $content | ConvertFrom-Json
    $state | Add-Member -NotePropertyName stateFilePath -NotePropertyValue $resolvedPath -Force
    return $state
  } catch {
    Write-Host "Failed to read managed state file: $resolvedPath" -ForegroundColor Yellow
    return $null
  }
}

function Remove-StateFileIfPresent {
  param([string]$PathValue)

  $resolvedPath = Get-ProjectFilePath $PathValue
  if ($resolvedPath -and (Test-Path -LiteralPath $resolvedPath)) {
    Remove-Item -LiteralPath $resolvedPath -Force -ErrorAction SilentlyContinue
  }
}

function Stop-ManagedRadio {
  param([object]$State)

  if (-not $State) {
    return $false
  }

  if ($State.pid) {
    try {
      $proc = Get-Process -Id ([int]$State.pid) -ErrorAction Stop
      Write-Host "Found managed process $($proc.Id): $($proc.ProcessName)" -ForegroundColor Cyan
    } catch {
      Write-Host "Managed state exists, but PID $($State.pid) is not running." -ForegroundColor Yellow
      Remove-StateFileIfPresent $State.stateFilePath
      return $true
    }
  }

  if ($NoStop) {
    return $true
  }

  $shutdownPort = if ($State.port) { [int]$State.port } else { $null }
  if ($shutdownPort) {
    $shutdownUri = "http://127.0.0.1:$shutdownPort/shutdown"
    try {
      Invoke-WebRequest -Uri $shutdownUri -Method POST -UseBasicParsing -TimeoutSec 5 | Out-Null
      Write-Host "Requested graceful shutdown on port $shutdownPort" -ForegroundColor Green

      if ($State.pid) {
        $deadline = (Get-Date).AddSeconds(8)
        do {
          Start-Sleep -Milliseconds 250
          try {
            Get-Process -Id ([int]$State.pid) -ErrorAction Stop | Out-Null
            $running = $true
          } catch {
            $running = $false
          }
        } while ($running -and (Get-Date) -lt $deadline)
      } else {
        $running = $false
      }

      if (-not $running) {
        Remove-StateFileIfPresent $State.stateFilePath
        Write-Host "Managed radio stopped cleanly." -ForegroundColor Green
        return $true
      }
    } catch {
      Write-Host ("Graceful shutdown request failed on port {0}: {1}" -f $shutdownPort, $_.Exception.Message) -ForegroundColor Yellow
    }
  }

  if ($State.pid) {
    try {
      Stop-Process -Id ([int]$State.pid) -Force -ErrorAction Stop
      Write-Host "Stopped managed process $($State.pid) by PID fallback." -ForegroundColor Green
      Remove-StateFileIfPresent $State.stateFilePath
      return $true
    } catch {
      Write-Host "Failed to stop managed PID $($State.pid): $($_.Exception.Message)" -ForegroundColor Red
    }
  }

  return $false
}

$managedState = Get-ManagedState $StateFile
if ($managedState) {
  $handled = Stop-ManagedRadio $managedState
  if ($handled) {
    exit 0
  }
}

$listeners = @()
foreach ($port in $Ports) {
  try {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop
    if ($conn) {
      $listeners += $conn
    }
  } catch {
  }
}

if (-not $listeners) {
  Write-Host "No listening processes found on ports: $($Ports -join ', ')" -ForegroundColor Yellow
  exit 0
}

$uniquePids = $listeners | Select-Object -ExpandProperty OwningProcess -Unique

foreach ($pidValue in $uniquePids) {
  try {
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" | Select-Object ProcessId, Name, CommandLine
  } catch {
    $proc = $null
  }

  if ($proc) {
    Write-Host "Found process $($proc.ProcessId): $($proc.Name)" -ForegroundColor Cyan
    if ($proc.CommandLine) {
      Write-Host "  $($proc.CommandLine)"
    }
  } else {
    Write-Host "Found process $pidValue" -ForegroundColor Cyan
  }

  if ($NoStop) {
    continue
  }

  try {
    Stop-Process -Id $pidValue -Force -ErrorAction Stop
    Write-Host "Stopped process $pidValue" -ForegroundColor Green
  } catch {
    Write-Host ("Failed to stop process {0}: {1}" -f $pidValue, $_.Exception.Message) -ForegroundColor Red
  }
}
