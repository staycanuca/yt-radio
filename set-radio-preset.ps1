param(
  [Parameter(Mandatory = $true)]
  [string]$Preset,
  [ValidateSet("safe", "hq")]
  [string]$Profile,
  [string]$StateFile = "radio-process.json",
  [int]$Port
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

function Find-RadioPort {
  param(
    [string]$StateFilePath,
    [int]$ExplicitPort
  )

  $candidates = New-Object System.Collections.Generic.List[int]

  if ($ExplicitPort) {
    $candidates.Add([int]$ExplicitPort)
  }

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

$Port = Find-RadioPort -StateFilePath $StateFile -ExplicitPort $Port

if (-not $Port) {
  throw "Could not determine target port. Start the managed radio first or pass -Port explicitly."
}

$body = @{
  preset = $Preset
}

if ($Profile) {
  $body.profile = $Profile
}

$response = Invoke-RestMethod `
  -Uri "http://127.0.0.1:$Port/preset" `
  -Method POST `
  -ContentType "application/json" `
  -Body ($body | ConvertTo-Json) `
  -TimeoutSec 5

Write-Host "Preset change queued." -ForegroundColor Green
if ($response.pending_preset_change) {
  $pending = $response.pending_preset_change
  Write-Host ("  Next preset: {0} > {1} > {2}" -f $pending.group, $pending.label, $pending.profile)
}
Write-Host "  It will apply on the next song."
