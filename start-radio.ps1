param(
  [string]$Preset,
  [ValidateSet("safe", "hq")]
  [string]$Profile = "safe",
  [string]$SeedUrl,
  [switch]$Managed,
  [switch]$QueuePresetChange,
  [string]$PresetsFile = "radio-presets.json",
  [string]$StateFile = "radio-process.json",
  [string]$StdoutLog = "radio.out.log",
  [string]$StderrLog = "radio.err.log",
  [int]$Port = 18080,
  [int]$GopherPort = 18081,
  [int]$RadioBitrate = 256,
  [string]$PlaybackBackend = "auto",
  [string]$PlaybackClient = "ANDROID",
  [string]$PlaybackType = "video+audio",
  [string]$PlaybackFormat = "mp4",
  [string]$PlaybackQuality = "best",
  [string]$RadioFormat = "mp3",
  [string]$RadioCodec = "mp3",
  [string]$LogLevel = "info",
  [string]$CorsOrigin = "*",
  [string]$Geolocation = "US",
  [string]$YtDlpPath = "yt-dlp",
  [string]$YtDlpFormat = "bestaudio/best",
  [string]$YtUrlFile = "yturl.txt",
  [switch]$ListPresets,
  [switch]$NoStart
)

$ErrorActionPreference = "Stop"

function Get-PresetFilePath {
  param([string]$PathValue)

  if ([System.IO.Path]::IsPathRooted($PathValue)) {
    return $PathValue
  }

  return Join-Path $PSScriptRoot $PathValue
}

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

function Load-Presets {
  param([string]$PathValue)

  $resolvedPath = Get-PresetFilePath $PathValue
  if (-not (Test-Path -LiteralPath $resolvedPath)) {
    return @()
  }

  $raw = Get-Content -LiteralPath $resolvedPath -Raw -Encoding UTF8
  if ([string]::IsNullOrWhiteSpace($raw)) {
    return @()
  }

  $parsed = $raw | ConvertFrom-Json
  if ($parsed -is [System.Array]) {
    return $parsed
  }

  return @($parsed)
}

function Show-Presets {
  param([object[]]$PresetItems)

  Write-Host "Available presets" -ForegroundColor Cyan
  Write-Host "  file     - Uses the current seed URL from the configured file"
  Write-Host "Available profiles: safe, hq"

  $groups = $PresetItems |
    Group-Object { if ($_.group) { [string]$_.group } else { "Other" } } |
    Sort-Object Name

  foreach ($group in $groups) {
    Write-Host ""
    Write-Host ("[{0}]" -f $group.Name) -ForegroundColor DarkCyan

    foreach ($item in ($group.Group | Sort-Object name)) {
      $label = if ($item.label) { $item.label } else { $item.name }
      $description = if ($item.description) { $item.description } else { "" }
      Write-Host ("  {0,-14} - {1}" -f $item.name, $label)
      if ($description) {
        Write-Host ("                 {0}" -f $description)
      }
    }
  }
}

function Get-PresetGroups {
  param([object[]]$PresetItems)

  return $PresetItems |
    Group-Object { if ($_.group) { [string]$_.group } else { "Other" } } |
    Sort-Object Name
}

function Select-PresetInteractively {
  param([object[]]$PresetItems)

  $groups = Get-PresetGroups $PresetItems
  if (-not $groups -or $groups.Count -eq 0) {
    return $null
  }

  Write-Host ""
  Write-Host "Choose category" -ForegroundColor Cyan
  Write-Host "  0) file"

  for ($i = 0; $i -lt $groups.Count; $i++) {
    Write-Host ("  {0}) {1}" -f ($i + 1), $groups[$i].Name)
  }

  $groupSelection = (Read-Host "Category number (Enter for file)").Trim()
  if ([string]::IsNullOrWhiteSpace($groupSelection) -or $groupSelection -eq "0") {
    return "file"
  }

  $groupIndex = 0
  if (-not [int]::TryParse($groupSelection, [ref]$groupIndex)) {
    throw "Invalid category selection '$groupSelection'."
  }

  if ($groupIndex -lt 1 -or $groupIndex -gt $groups.Count) {
    throw "Category selection out of range: $groupIndex."
  }

  $selectedGroup = $groups[$groupIndex - 1]
  $groupPresets = $selectedGroup.Group | Sort-Object name

  Write-Host ""
  Write-Host ("Choose preset from [{0}]" -f $selectedGroup.Name) -ForegroundColor Cyan

  for ($i = 0; $i -lt $groupPresets.Count; $i++) {
    $item = $groupPresets[$i]
    $label = if ($item.label) { $item.label } else { $item.name }
    Write-Host ("  {0}) {1} - {2}" -f ($i + 1), $item.name, $label)
  }

  $presetSelection = (Read-Host "Preset number").Trim()
  $presetIndex = 0
  if (-not [int]::TryParse($presetSelection, [ref]$presetIndex)) {
    throw "Invalid preset selection '$presetSelection'."
  }

  if ($presetIndex -lt 1 -or $presetIndex -gt $groupPresets.Count) {
    throw "Preset selection out of range: $presetIndex."
  }

  return [string]$groupPresets[$presetIndex - 1].name
}

function Select-ProfileInteractively {
  Write-Host ""
  Write-Host "Choose profile" -ForegroundColor Cyan
  Write-Host "  1) safe - stabilitate maxima, 192 kbps, native, 360p"
  Write-Host "  2) hq   - calitate maxima, 320 kbps, auto, best"

  $profileSelection = (Read-Host "Profile number (Enter for safe)").Trim()
  if ([string]::IsNullOrWhiteSpace($profileSelection) -or $profileSelection -eq "1") {
    return "safe"
  }

  if ($profileSelection -eq "2") {
    return "hq"
  }

  throw "Invalid profile selection '$profileSelection'."
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

  $resolvedStatePath = Get-ProjectFilePath $StateFilePath
  if ($resolvedStatePath -and (Test-Path -LiteralPath $resolvedStatePath)) {
    try {
      $state = Get-Content -LiteralPath $resolvedStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
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

function Invoke-QueuedPresetChange {
  param(
    [string]$PresetName,
    [string]$ProfileName,
    [string]$StateFilePath,
    [int]$PortValue
  )

  if ($PresetName -eq "file") {
    throw "Preset 'file' is not supported for queued preset changes."
  }

  $PortValue = Find-RadioPort -StateFilePath $StateFilePath -ExplicitPort $PortValue

  if (-not $PortValue) {
    throw "Could not determine target port. Start the managed radio first or pass -Port explicitly."
  }

  $body = @{
    preset = $PresetName
  }

  if ($ProfileName) {
    $body.profile = $ProfileName
  }

  $response = Invoke-RestMethod `
    -Uri "http://127.0.0.1:$PortValue/preset" `
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
}

function Apply-PresetSetting {
  param(
    [string]$ParameterName,
    [object]$Value,
    [scriptblock]$Setter
  )

  if ($null -eq $Value) {
    return
  }

  if (-not $PSBoundParameters.ContainsKey($ParameterName)) {
    & $Setter $Value
  }
}

function Apply-SettingsObject {
  param([object]$Settings)

  if (-not $Settings) {
    return
  }

  Apply-PresetSetting "RadioBitrate" $Settings.radioBitrate { param($v) $script:RadioBitrate = [int]$v }
  Apply-PresetSetting "PlaybackBackend" $Settings.playbackBackend { param($v) $script:PlaybackBackend = [string]$v }
  Apply-PresetSetting "PlaybackClient" $Settings.playbackClient { param($v) $script:PlaybackClient = [string]$v }
  Apply-PresetSetting "PlaybackType" $Settings.playbackType { param($v) $script:PlaybackType = [string]$v }
  Apply-PresetSetting "PlaybackFormat" $Settings.playbackFormat { param($v) $script:PlaybackFormat = [string]$v }
  Apply-PresetSetting "PlaybackQuality" $Settings.playbackQuality { param($v) $script:PlaybackQuality = [string]$v }
  Apply-PresetSetting "RadioFormat" $Settings.radioFormat { param($v) $script:RadioFormat = [string]$v }
  Apply-PresetSetting "RadioCodec" $Settings.radioCodec { param($v) $script:RadioCodec = [string]$v }
  Apply-PresetSetting "Geolocation" $Settings.geolocation { param($v) $script:Geolocation = [string]$v }
}

function Get-ProfileSettings {
  param([string]$ProfileName)

  switch ($ProfileName) {
    "hq" {
      return @{
        radioBitrate = 320
        playbackBackend = "auto"
        playbackClient = "ANDROID"
        playbackType = "video+audio"
        playbackFormat = "mp4"
        playbackQuality = "best"
      }
    }
    default {
      return @{
        radioBitrate = 192
        playbackBackend = "native"
        playbackClient = "ANDROID"
        playbackType = "video+audio"
        playbackFormat = "mp4"
        playbackQuality = "360p"
      }
    }
  }
}

$presets = Load-Presets $PresetsFile

if ($ListPresets) {
  Show-Presets $presets
  exit 0
}

if ($QueuePresetChange -and -not $Preset) {
  Show-Presets $presets
  $selection = Select-PresetInteractively $presets
  if (-not [string]::IsNullOrWhiteSpace($selection)) {
    $Preset = $selection.Trim()
  }

  if (-not $PSBoundParameters.ContainsKey("Profile")) {
    $Profile = Select-ProfileInteractively
  }
}

if (-not $QueuePresetChange -and -not $SeedUrl -and -not $Preset -and -not $NoStart) {
  Show-Presets $presets
  $selection = Select-PresetInteractively $presets
  if (-not [string]::IsNullOrWhiteSpace($selection)) {
    $Preset = $selection.Trim()
  }

  if (-not $PSBoundParameters.ContainsKey("Profile")) {
    $Profile = Select-ProfileInteractively
  }
}

if ($QueuePresetChange) {
  if (-not $Preset) {
    throw "Preset is required when using -QueuePresetChange."
  }

  if ($Preset -ne "file") {
    $queuedPreset = $presets | Where-Object { $_.name -eq $Preset } | Select-Object -First 1
    if (-not $queuedPreset) {
      throw "Unknown preset '$Preset'. Use -ListPresets to see the available presets."
    }

    $queuedLabel = if ($queuedPreset.label) { $queuedPreset.label } else { $queuedPreset.name }
    $queuedGroup = if ($queuedPreset.group) { [string]$queuedPreset.group } else { "Other" }
    Write-Host ("Queued selection: {0} > {1} > {2}" -f $queuedGroup, $queuedLabel, $Profile) -ForegroundColor Cyan
  }

  Invoke-QueuedPresetChange -PresetName $Preset -ProfileName $Profile -StateFilePath $StateFile
  exit 0
}

Apply-SettingsObject (Get-ProfileSettings $Profile)

if ($Preset) {
  if ($Preset -eq "file") {
    Write-Host "Preset 'file' selected. Using seed URL from file configuration." -ForegroundColor Green
  } else {
    $selectedPreset = $presets | Where-Object { $_.name -eq $Preset } | Select-Object -First 1
    if (-not $selectedPreset) {
      throw "Unknown preset '$Preset'. Use -ListPresets to see the available presets."
    }

    $profilePreset = $null
    if ($selectedPreset.profiles) {
      $profilePreset = $selectedPreset.profiles.$Profile
    }

    if (-not $SeedUrl) {
      if ($profilePreset -and $profilePreset.seedUrl) {
        $SeedUrl = [string]$profilePreset.seedUrl
      } elseif ($selectedPreset.seedUrl) {
        $SeedUrl = [string]$selectedPreset.seedUrl
      }
    }

    Apply-SettingsObject $selectedPreset.settings
    if ($profilePreset) {
      Apply-SettingsObject $profilePreset.settings
    }

    $selectedLabel = if ($selectedPreset.label) { $selectedPreset.label } else { $selectedPreset.name }
    Write-Host "Preset selected: $selectedLabel [$Profile]" -ForegroundColor Green
    $selectedGroup = if ($selectedPreset.group) { [string]$selectedPreset.group } else { "Other" }
    Write-Host ("Selection summary: {0} > {1} > {2}" -f $selectedGroup, $selectedLabel, $Profile) -ForegroundColor Cyan
  }
}

$env:PORT = [string]$Port
$env:GOPHER_PORT = [string]$GopherPort
$env:RADIO_BITRATE = [string]$RadioBitrate
$env:PLAYBACK_BACKEND = $PlaybackBackend
$env:PLAYBACK_CLIENT = $PlaybackClient
$env:PLAYBACK_TYPE = $PlaybackType
$env:PLAYBACK_FORMAT = $PlaybackFormat
$env:PLAYBACK_QUALITY = $PlaybackQuality
$env:RADIO_FORMAT = $RadioFormat
$env:RADIO_CODEC = $RadioCodec
$env:LOG_LEVEL = $LogLevel
$env:CORS_ORIGIN = $CorsOrigin
$env:GEOLOCATION = $Geolocation
$env:YT_DLP_PATH = $YtDlpPath
$env:YT_DLP_FORMAT = $YtDlpFormat
$env:YT_URL_FILE = $YtUrlFile
$env:YTRADIO_STATE_FILE = Get-ProjectFilePath $StateFile
$env:YTRADIO_ACTIVE_PRESET = if ($Preset) { $Preset } else { "" }
$env:YTRADIO_ACTIVE_PROFILE = if ($Profile) { $Profile } else { "" }

Write-Host "ytradio startup configuration" -ForegroundColor Cyan
if ($Preset) {
  Write-Host "  PRESET=$Preset"
}
Write-Host "  PROFILE=$Profile"
Write-Host "  MANAGED=$Managed"
Write-Host "  PORT=$env:PORT"
Write-Host "  GOPHER_PORT=$env:GOPHER_PORT"
Write-Host "  RADIO_BITRATE=$env:RADIO_BITRATE"
Write-Host "  RADIO_FORMAT=$env:RADIO_FORMAT"
Write-Host "  RADIO_CODEC=$env:RADIO_CODEC"
Write-Host "  PLAYBACK_BACKEND=$env:PLAYBACK_BACKEND"
Write-Host "  PLAYBACK_CLIENT=$env:PLAYBACK_CLIENT"
Write-Host "  PLAYBACK_TYPE=$env:PLAYBACK_TYPE"
Write-Host "  PLAYBACK_FORMAT=$env:PLAYBACK_FORMAT"
Write-Host "  PLAYBACK_QUALITY=$env:PLAYBACK_QUALITY"
Write-Host "  YT_DLP_PATH=$env:YT_DLP_PATH"
Write-Host "  YT_DLP_FORMAT=$env:YT_DLP_FORMAT"
Write-Host "  LOG_LEVEL=$env:LOG_LEVEL"
Write-Host "  CORS_ORIGIN=$env:CORS_ORIGIN"
Write-Host "  GEOLOCATION=$env:GEOLOCATION"
Write-Host "  PRESETS_FILE=$(Get-PresetFilePath $PresetsFile)"
Write-Host "  YT_URL_FILE=$env:YT_URL_FILE"
Write-Host "  STATE_FILE=$env:YTRADIO_STATE_FILE"

if ($NoStart) {
  Write-Host "NoStart requested. Environment prepared, app not launched." -ForegroundColor Yellow
  exit 0
}

if ($Managed) {
  $stateFilePath = Get-ProjectFilePath $StateFile
  $stdoutPath = Get-ProjectFilePath $StdoutLog
  $stderrPath = Get-ProjectFilePath $StderrLog

  if (Test-Path -LiteralPath $stateFilePath) {
    try {
      $existing = Get-Content -LiteralPath $stateFilePath -Raw -Encoding UTF8 | ConvertFrom-Json
    } catch {
      $existing = $null
    }

    if ($existing -and $existing.pid) {
      try {
        $running = Get-Process -Id ([int]$existing.pid) -ErrorAction Stop
      } catch {
        $running = $null
      }

      if ($running) {
        throw "Managed radio is already running with PID $($existing.pid). Use stop-radio.cmd first."
      }
    }

    Remove-Item -LiteralPath $stateFilePath -Force -ErrorAction SilentlyContinue
  }

  $nodePath = (Get-Command node -ErrorAction Stop).Source
  $nodeArgs = @(".")
  if ($SeedUrl) {
    $nodeArgs += $SeedUrl
    Write-Host "Starting managed radio with explicit seed URL: $SeedUrl" -ForegroundColor Green
  } else {
    Write-Host "Starting managed radio with seed URL from file/env configuration." -ForegroundColor Green
  }

  $child = Start-Process `
    -FilePath $nodePath `
    -ArgumentList $nodeArgs `
    -WorkingDirectory $PSScriptRoot `
    -RedirectStandardOutput $stdoutPath `
    -RedirectStandardError $stderrPath `
    -PassThru `
    -WindowStyle Hidden

  $runtimeState = [ordered]@{
    pid = $child.Id
    port = $Port
    gopherPort = $GopherPort
    preset = $Preset
    profile = $Profile
    managed = $true
    startedAt = [DateTime]::UtcNow.ToString("o")
    stdoutLog = $stdoutPath
    stderrLog = $stderrPath
  }

  $runtimeState | ConvertTo-Json | Set-Content -LiteralPath $stateFilePath -Encoding UTF8

  Write-Host "Managed radio started in background." -ForegroundColor Green
  Write-Host "  PID: $($child.Id)"
  Write-Host "  HTTP: http://127.0.0.1:$Port/"
  Write-Host "  Gopher: gopher://127.0.0.1:$GopherPort/stream"
  Write-Host "  Stop with: .\stop-radio.cmd" -ForegroundColor Cyan
  exit 0
}

$nodePath = (Get-Command node -ErrorAction Stop).Source
if ($SeedUrl) {
  Write-Host "Starting with explicit seed URL: $SeedUrl" -ForegroundColor Green
  & $nodePath . $SeedUrl
} else {
  Write-Host "Starting with seed URL from file/env configuration." -ForegroundColor Green
  & $nodePath .
}

exit $LASTEXITCODE
