param(
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$SourceInstallDir,
  [Parameter(Mandatory = $true)][string]$TargetInstallDir,
  [Parameter(Mandatory = $true)][int]$OriginalInstallerPid,
  [Parameter(Mandatory = $true)][int]$LegacyHelperPid,
  [Parameter(Mandatory = $true)][string]$ExpectedVersion,
  [string]$InstalledVersion = '',
  [Parameter(Mandatory = $true)][ValidateSet('Silent', 'Interactive')][string]$InstallerMode,
  [Parameter(Mandatory = $true)][ValidateSet('0', '1')][string]$ReopenAfterInstall,
  [Parameter(Mandatory = $true)][string]$ReadyPath,
  [Parameter(Mandatory = $true)][string]$WorkDir,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [string]$TargetUserDataPathOverride = '',
  [string]$TargetRuntimeHomePathOverride = '',
  [string]$LegacyRuntimeHomePathOverride = '',
  [string]$MigrationStatePathOverride = '',
  [string]$MigrationLogPathOverride = '',
  [string]$InstallationRecordPathOverride = ''
)

$ErrorActionPreference = 'Stop'
$normalizedSourceInstallDir = [System.IO.Path]::GetFullPath($SourceInstallDir).TrimEnd('\')
$normalizedTargetInstallDir = [System.IO.Path]::GetFullPath($TargetInstallDir).TrimEnd('\')
$dataPath = Join-Path $normalizedSourceInstallDir 'data'
$backupParent = "$normalizedSourceInstallDir.memmy-upgrade-backup"
$backupRoot = Join-Path $backupParent (Split-Path -Leaf $WorkDir)
$backupPath = Join-Path $backupRoot 'data-backup'
$installerDataPath = Join-Path $backupRoot 'installer-created-data'
$stagingRoot = Split-Path -Parent $WorkDir
$lockPath = Join-Path $stagingRoot 'active.lock'
$lockStatePath = Join-Path $stagingRoot 'active.lock\state.json'
$sourceAppExe = Join-Path $normalizedSourceInstallDir 'Memmy.exe'
$appExe = Join-Path $normalizedTargetInstallDir 'Memmy.exe'
$migrationScriptPath = Join-Path $WorkDir 'MemmyWindowsDataMigration.ps1'
$targetUserDataPath = if ($TargetUserDataPathOverride) { $TargetUserDataPathOverride } else { Join-Path $env:APPDATA 'Memmy' }
$dataPointerPath = Join-Path $targetUserDataPath 'data-root.txt'
$migrationStatePath = if ($MigrationStatePathOverride) { $MigrationStatePathOverride } else { Join-Path $env:LOCALAPPDATA 'Memmy\data-migration\state.json' }
$migrationLogPath = if ($MigrationLogPathOverride) { $MigrationLogPathOverride } else { Join-Path $env:LOCALAPPDATA 'Memmy\upgrade-logs\data-migration.log' }
$installationRecordPath = if ($InstallationRecordPathOverride) { $InstallationRecordPathOverride } else { Join-Path $env:LOCALAPPDATA 'Memmy\data-layout\last-install.json' }
$legacyRuntimeHomePath = if ($LegacyRuntimeHomePathOverride) { $LegacyRuntimeHomePathOverride } else { Join-Path $env:USERPROFILE '.memmy' }
$installDriveRoot = [System.IO.Path]::GetPathRoot($normalizedTargetInstallDir)
$targetRuntimeHomePath = if ($TargetRuntimeHomePathOverride) {
  $TargetRuntimeHomePathOverride
} elseif ([string]::Equals($installDriveRoot, 'C:\', [System.StringComparison]::OrdinalIgnoreCase)) {
  $legacyRuntimeHomePath
} else {
  Join-Path $installDriveRoot 'MemmyData\.memmy'
}
$normalizedInstallerPath = [System.IO.Path]::GetFullPath($InstallerPath)
$installerExit = 1
$installerProcess = $null
$dataMoved = $false
$dataRestored = $false
$lockAcquired = $false
$migrationPrepared = $false
$migrationCompleted = $false
$migrationRolledBack = $false
$migrationSkipped = $false
$migrationFailure = ''
$upgradeVerified = $false
$relayPhase = 'relay-ready'
$resolvedReopenAfterInstall = $ReopenAfterInstall
$relayStartedAtUtc = (Get-Process -Id $PID -ErrorAction Stop).StartTime.ToUniversalTime().ToString('O')
$verifiedInstalledVersion = ''

function Write-MemmyUpgradeLog([string]$Message) {
  $logDirectory = Split-Path -Parent $LogPath
  if ($logDirectory) {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  }
  Add-Content -LiteralPath $LogPath -Value ('[{0:O}] {1}' -f (Get-Date), $Message)
}

function Test-MemmySamePath([string]$Left, [string]$Right) {
  return [string]::Equals(
    [System.IO.Path]::GetFullPath($Left).TrimEnd('\'),
    [System.IO.Path]::GetFullPath($Right).TrimEnd('\'),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Test-MemmySameOrDescendantPath([string]$Candidate, [string]$Parent) {
  $normalizedCandidate = [System.IO.Path]::GetFullPath($Candidate).TrimEnd('\')
  $normalizedParent = [System.IO.Path]::GetFullPath($Parent).TrimEnd('\')
  return (Test-MemmySamePath $normalizedCandidate $normalizedParent) -or
    $normalizedCandidate.StartsWith("$normalizedParent\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-MemmyNoReparsePath([string]$Path, [string]$Description) {
  $currentPath = [System.IO.Path]::GetFullPath($Path)
  while (-not (Test-Path -LiteralPath $currentPath)) {
    $parentPath = [System.IO.Path]::GetDirectoryName($currentPath)
    if (-not $parentPath -or (Test-MemmySamePath $parentPath $currentPath)) {
      throw "$Description has no existing trusted ancestor"
    }
    $currentPath = $parentPath
  }

  while ($currentPath) {
    $item = Get-Item -LiteralPath $currentPath -Force -ErrorAction Stop
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "$Description crosses a reparse point: $($item.FullName)"
    }
    if ($item -is [System.IO.FileInfo]) {
      $currentPath = $item.DirectoryName
    } elseif ($item.Parent) {
      $currentPath = $item.Parent.FullName
    } else {
      $currentPath = $null
    }
  }
}

function Test-MemmyDirectoryContainsData([string]$Path, [string[]]$ExcludedTopLevelNames = @()) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
  foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)) {
    if ($ExcludedTopLevelNames -contains $item.Name) { continue }
    if (-not $item.PSIsContainer) { return $true }
    if ($null -ne (Get-ChildItem -LiteralPath $item.FullName -Recurse -Force -File -ErrorAction Stop |
        Select-Object -First 1)) {
      return $true
    }
  }
  return $false
}

function Test-MemmyPreparedMigrationTarget {
  if (-not (Test-Path -LiteralPath $migrationStatePath -PathType Leaf)) { return $false }
  try {
    $migrationState = Get-Content -LiteralPath $migrationStatePath -Raw -Encoding UTF8 |
      ConvertFrom-Json -ErrorAction Stop
    return [int]$migrationState.schemaVersion -eq 2 -and
      [string]$migrationState.owner -eq 'relay' -and
      [string]$migrationState.phase -eq 'prepared' -and
      $migrationState.targetInstallDir -and
      $migrationState.targetUserDataPath -and
      $migrationState.targetRuntimeHomePath -and
      (Test-MemmySamePath ([string]$migrationState.targetInstallDir) $normalizedTargetInstallDir) -and
      (Test-MemmySamePath ([string]$migrationState.targetUserDataPath) $targetUserDataPath) -and
      (Test-MemmySamePath ([string]$migrationState.targetRuntimeHomePath) $targetRuntimeHomePath)
  } catch {
    return $false
  }
}

function Assert-MemmyRelocationTargetIsSafe([switch]$AllowPreparedMigrationTarget) {
  if (Test-MemmySamePath $normalizedSourceInstallDir $normalizedTargetInstallDir) { return }
  Assert-MemmyNoReparsePath $normalizedTargetInstallDir 'target installDir'
  Assert-MemmyNoReparsePath $targetRuntimeHomePath 'target runtimeHomePath'
  if ((Test-MemmySameOrDescendantPath $normalizedTargetInstallDir $normalizedSourceInstallDir) -or
      (Test-MemmySameOrDescendantPath $normalizedSourceInstallDir $normalizedTargetInstallDir)) {
    throw 'selected target overlaps the source installation directory'
  }
  if (Test-Path -LiteralPath (Join-Path $normalizedTargetInstallDir 'Memmy.exe') -PathType Leaf) {
    throw 'selected target already contains Memmy.exe'
  }
  if (Test-MemmyDirectoryContainsData (Join-Path $normalizedTargetInstallDir 'data')) {
    throw 'selected target already contains install-local Memmy data'
  }

  if (Test-MemmyDirectoryContainsData $targetRuntimeHomePath @('updates')) {
    $targetRuntimeIsRecordedSource = $AllowPreparedMigrationTarget -and
      (Test-MemmyPreparedMigrationTarget)
    try {
      if (-not $targetRuntimeIsRecordedSource -and
          (Test-Path -LiteralPath $installationRecordPath -PathType Leaf)) {
        $record = Get-Content -LiteralPath $installationRecordPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
        if ([int]$record.schemaVersion -eq 1 -and
            [string]$record.dataLayoutGeneration -eq 'external-v1' -and
            $record.installDir -and $record.userDataPath -and $record.runtimeHomePath) {
          $targetRuntimeIsRecordedSource =
            (Test-MemmySamePath ([string]$record.installDir) $normalizedSourceInstallDir) -and
            (Test-MemmySamePath ([string]$record.userDataPath) $targetUserDataPath) -and
            (Test-MemmySamePath ([string]$record.runtimeHomePath) $targetRuntimeHomePath)
        }
      }
    } catch {
      $targetRuntimeIsRecordedSource = $false
    }
    if (-not $targetRuntimeIsRecordedSource) {
      throw 'selected installation drive already contains Memmy runtime data'
    }
  }
}

function Assert-MemmyRelaySourceIsSafe {
  Assert-MemmyNoReparsePath $normalizedSourceInstallDir 'source installDir'
  Assert-MemmyNoReparsePath $dataPath 'source data path'
  Assert-MemmyNoReparsePath $backupParent 'upgrade backup parent'
  Assert-MemmyNoReparsePath $backupRoot 'upgrade backup root'
  Assert-MemmyNoReparsePath $stagingRoot 'upgrade staging root'
  Assert-MemmyNoReparsePath $WorkDir 'upgrade workDir'
  Assert-MemmyNoReparsePath $normalizedInstallerPath 'staged installer path'
}

function Invoke-MemmyDataMigration([ValidateSet('Prepare', 'Complete', 'Rollback', 'RequireRecovery')][string]$Mode) {
  if (-not (Test-Path -LiteralPath $migrationScriptPath -PathType Leaf)) {
    throw "data migration helper is missing: $migrationScriptPath"
  }
  $powershellPath = Join-Path $PSHOME 'powershell.exe'
  $migrationSourcePath = if (Test-Path -LiteralPath $backupPath -PathType Container) { $backupPath } else { $dataPath }
  $migrationSourceAuthority = if (Test-Path -LiteralPath $backupPath -PathType Container) {
    'relay-backup-authority'
  } elseif (Test-Path -LiteralPath $sourceAppExe -PathType Leaf) {
    'current-install-authority'
  } else {
    'untrusted-residual'
  }
  $arguments = @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', $migrationScriptPath,
    '-Mode', $Mode,
    '-SourceDataPath', $migrationSourcePath,
    '-SourceAuthority', $migrationSourceAuthority,
    '-SourceInstallDir', $normalizedSourceInstallDir,
    '-TargetInstallDir', $normalizedTargetInstallDir,
    '-InstallationRecordPath', $installationRecordPath,
    '-LegacyRuntimeHomePath', $legacyRuntimeHomePath,
    '-TargetUserDataPath', $targetUserDataPath,
    '-TargetRuntimeHomePath', $targetRuntimeHomePath,
    '-PointerPath', $dataPointerPath,
    '-StatePath', $migrationStatePath,
    '-LockPath', $lockPath,
    '-LogPath', $migrationLogPath,
    '-Owner', 'relay'
  )
  if ($InstalledVersion) {
    $arguments += @('-SourceInstalledVersion', $InstalledVersion)
  }
  $migrationOutput = @(& $powershellPath @arguments 2>&1)
  $migrationExitCode = $LASTEXITCODE
  if ($migrationExitCode -ne 0) {
    $migrationDetail = @($migrationOutput | ForEach-Object { [string]$_ } | Where-Object { $_ }) -join ' | '
    if ($migrationDetail) {
      Write-MemmyUpgradeLog "data migration $Mode output: $migrationDetail"
    }
    throw "data migration $Mode failed with exit code $migrationExitCode"
  }
  Write-MemmyUpgradeLog "data migration $Mode completed targetRuntimeHome=$targetRuntimeHomePath"
}

function Resolve-MemmyLegacyHelperReopenIntent([int]$HelperPid, [string]$MarkerPath, [string]$Fallback) {
  try {
    $helper = Get-CimInstance -ClassName Win32_Process -Filter ("ProcessId = {0}" -f $HelperPid) -ErrorAction Stop
    $commandLine = [string]$helper.CommandLine
    if (-not $commandLine) {
      throw "legacy helper command line is unavailable"
    }
    $pattern = '(?:^|\s)"?(?<intent>[01])"?\s+"?' + [Regex]::Escape($MarkerPath) + '"?(?:\s|$)'
    $match = [Regex]::Match($commandLine, $pattern, [Text.RegularExpressions.RegexOptions]::IgnoreCase)
    if (-not $match.Success) {
      throw "legacy helper reopen argument is unavailable for marker $MarkerPath"
    }
    $intent = $match.Groups['intent'].Value
    Write-MemmyUpgradeLog "reopen intent resolved from legacy helper pid ${HelperPid}: $intent"
    return $intent
  } catch {
    Write-MemmyUpgradeLog "reopen intent fallback=$Fallback legacyHelperPid=$HelperPid reason=$($_.Exception.Message)"
    return $Fallback
  }
}

function Wait-MemmyProcessExit([int]$ProcessId, [int]$TimeoutSeconds) {
  $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return
  }
  Write-MemmyUpgradeLog "waiting for original installer pid $ProcessId"
  if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
    throw "original installer pid $ProcessId did not exit"
  }
}

function Get-MemmyInstallProcesses {
  $expectedPaths = @($sourceAppExe, $appExe) |
    ForEach-Object { [System.IO.Path]::GetFullPath($_) } |
    Select-Object -Unique
  foreach ($process in @(Get-Process -Name 'Memmy' -ErrorAction SilentlyContinue)) {
    try {
      $processPath = [System.IO.Path]::GetFullPath($process.Path)
      if ($expectedPaths | Where-Object {
          [string]::Equals($_, $processPath, [System.StringComparison]::OrdinalIgnoreCase)
        }) {
        $process
      }
    } catch {
      continue
    }
  }
}

function Wait-MemmyInstallProcessesExit([int]$TimeoutSeconds) {
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $remaining = @(Get-MemmyInstallProcesses)
  while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-MemmyInstallProcesses)
  }
  if ($remaining.Count -eq 0) {
    return
  }

  $remainingIds = @($remaining | ForEach-Object { $_.Id })
  Write-MemmyUpgradeLog "forcing remaining installed app processes to exit after timeout: $($remainingIds -join ',')"
  foreach ($process in $remaining) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
  }
  $forceDeadline = [DateTime]::UtcNow.AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $remaining = @(Get-MemmyInstallProcesses)
  } while ($remaining.Count -gt 0 -and [DateTime]::UtcNow -lt $forceDeadline)
  if ($remaining.Count -gt 0) {
    throw "installed Memmy processes did not exit: $(@($remaining | ForEach-Object { $_.Id }) -join ',')"
  }
}

function Assert-MemmySameVolume([string]$Source, [string]$Destination) {
  $sourceRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Source))
  $destinationRoot = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($Destination))
  if (-not [string]::Equals($sourceRoot, $destinationRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing cross-volume directory move: $Source -> $Destination"
  }
}

function Move-MemmyDirectory([string]$Source, [string]$Destination) {
  Assert-MemmySameVolume -Source $Source -Destination $Destination
  Assert-MemmyNoReparsePath $Source 'directory move source'
  Assert-MemmyNoReparsePath $Destination 'directory move destination'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  for ($attempt = 1; $attempt -le 120; $attempt++) {
    try {
      Assert-MemmyNoReparsePath $Source 'directory move source'
      Assert-MemmyNoReparsePath $Destination 'directory move destination'
      [System.IO.Directory]::Move($Source, $Destination)
      return
    } catch {
      if ($attempt -eq 120) {
        throw
      }
      Start-Sleep -Milliseconds 500
    }
  }
}

function Write-MemmyRelayState {
  $installerPid = $null
  $installerStartedAtUtc = $null
  if ($null -ne $installerProcess) {
    $installerPid = $installerProcess.Id
    try {
      $installerStartedAtUtc = $installerProcess.StartTime.ToUniversalTime().ToString('O')
    } catch {
      $installerStartedAtUtc = $null
    }
  }
  $state = [ordered]@{
    schemaVersion = 4
    phase = $relayPhase
    stateUpdatedAtUtc = [DateTime]::UtcNow.ToString('O')
    relayPid = $PID
    relayStartedAtUtc = $relayStartedAtUtc
    installerPid = $installerPid
    installerStartedAtUtc = $installerStartedAtUtc
    installerPath = $normalizedInstallerPath
    installDir = $normalizedSourceInstallDir
    sourceInstallDir = $normalizedSourceInstallDir
    targetInstallDir = $normalizedTargetInstallDir
    workDir = [System.IO.Path]::GetFullPath($WorkDir).TrimEnd('\')
    backupRoot = $backupRoot
    migrationStatePath = $migrationStatePath
    migrationLogPath = $migrationLogPath
    legacyRuntimeHomePath = $legacyRuntimeHomePath
    targetUserDataPath = $targetUserDataPath
    targetRuntimeHomePath = $targetRuntimeHomePath
    migrationSkipped = $migrationSkipped
    migrationFailure = $migrationFailure
  }
  $temporaryStatePath = "$lockStatePath.tmp"
  [System.IO.File]::WriteAllText($temporaryStatePath, ($state | ConvertTo-Json -Compress))
  Move-Item -LiteralPath $temporaryStatePath -Destination $lockStatePath -Force
}

function Restore-MemmyData {
  if (-not $dataMoved) {
    $script:dataRestored = $true
    return
  }
  if (-not (Test-Path -LiteralPath $backupPath -PathType Container)) {
    if (Test-Path -LiteralPath $dataPath -PathType Container) {
      $script:dataRestored = $true
      Write-MemmyUpgradeLog "data restore verified by child installer $dataPath"
      return
    }
    throw "data backup is missing: $backupPath"
  }
  if (Test-Path -LiteralPath $dataPath) {
    if (Test-Path -LiteralPath $installerDataPath) {
      throw "installer-created data backup already exists: $installerDataPath"
    }
    Move-MemmyDirectory -Source $dataPath -Destination $installerDataPath
    Write-MemmyUpgradeLog "preserved installer-created data at $installerDataPath"
  }
  New-Item -ItemType Directory -Force -Path $normalizedSourceInstallDir | Out-Null
  Move-MemmyDirectory -Source $backupPath -Destination $dataPath
  if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
    throw "restored data directory is unavailable: $dataPath"
  }
  $script:dataRestored = $true
  Write-MemmyUpgradeLog "data restore verified $dataPath"
}

function Get-MemmyInstalledVersion {
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    return ''
  }
  $versionInfo = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($appExe)
  foreach ($value in @($versionInfo.ProductVersion, $versionInfo.FileVersion)) {
    if ($value) {
      return $value
    }
  }
  return ''
}

function Clear-MemmyUpdateMarkers {
  $roamingMarkerPath = Join-Path $targetUserDataPath 'prepared-required-update.json'
  $legacyMarkerPath = Join-Path $dataPath 'Memmy\prepared-required-update.json'
  $markerPath = if (Test-Path -LiteralPath $roamingMarkerPath -PathType Leaf) { $roamingMarkerPath } else { $legacyMarkerPath }
  foreach ($path in @($markerPath, "$markerPath.lock", "$markerPath.prompt", "$markerPath.attempt")) {
    Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
  }
}

function Start-MemmyInstalledApp {
  if (-not (Test-Path -LiteralPath $appExe -PathType Leaf)) {
    Write-MemmyUpgradeLog "app executable is unavailable for reopen: $appExe"
    return
  }
  Start-Process -FilePath $appExe -WorkingDirectory $normalizedTargetInstallDir -WindowStyle Normal
  Write-MemmyUpgradeLog "started app $appExe"
}

function Test-MemmyInstalledAppRunning {
  $expectedPath = [System.IO.Path]::GetFullPath($appExe)
  foreach ($process in @(Get-Process -Name 'Memmy' -ErrorAction SilentlyContinue)) {
    try {
      if ([string]::Equals([System.IO.Path]::GetFullPath($process.Path), $expectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    } catch {
      continue
    }
  }
  return $false
}

function Ensure-MemmyInstalledAppStarted {
  for ($attempt = 1; $attempt -le 4; $attempt++) {
    if (Test-MemmyInstalledAppRunning) {
      Write-MemmyUpgradeLog "app already started by child installer $appExe"
      return
    }
    if ($attempt -lt 4) {
      Start-Sleep -Milliseconds 100
    }
  }
  Start-MemmyInstalledApp
}

function Schedule-MemmyStagingCleanup {
  $cleanupScriptPath = Join-Path $WorkDir 'MemmyWindowsUpgradeCleanup.ps1'
  if (-not (Test-Path -LiteralPath $cleanupScriptPath -PathType Leaf)) {
    return
  }
  $powershellPath = Join-Path $PSHOME 'powershell.exe'
  $cleanupArguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$cleanupScriptPath`" -WorkDir `"$WorkDir`""
  Start-Process -FilePath $powershellPath -ArgumentList $cleanupArguments -WorkingDirectory $stagingRoot -WindowStyle Hidden
}

try {
  New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
  Write-MemmyUpgradeLog "relay starting installer=$InstallerPath sourceInstallDir=$SourceInstallDir targetInstallDir=$TargetInstallDir mode=$InstallerMode expected=$ExpectedVersion reopenFallback=$ReopenAfterInstall"
  Assert-MemmyRelaySourceIsSafe
  Assert-MemmyRelocationTargetIsSafe
  if ((Test-MemmySameOrDescendantPath $normalizedInstallerPath $normalizedSourceInstallDir) -or
      (Test-MemmySameOrDescendantPath $normalizedInstallerPath $normalizedTargetInstallDir)) {
    throw 'staged installer must be outside both source and target installation directories'
  }
  $roamingMarkerPath = Join-Path $targetUserDataPath 'prepared-required-update.json'
  $legacyMarkerPath = Join-Path $dataPath 'Memmy\prepared-required-update.json'
  $markerPath = if (Test-Path -LiteralPath $roamingMarkerPath -PathType Leaf) { $roamingMarkerPath } else { $legacyMarkerPath }
  $resolvedReopenAfterInstall = Resolve-MemmyLegacyHelperReopenIntent -HelperPid $LegacyHelperPid -MarkerPath $markerPath -Fallback $ReopenAfterInstall
  New-Item -ItemType Directory -Path $lockPath -ErrorAction Stop | Out-Null
  $lockAcquired = $true
  Write-MemmyRelayState
  [System.IO.File]::WriteAllText($ReadyPath, $resolvedReopenAfterInstall)
  Write-MemmyUpgradeLog "relay ready reopen=$resolvedReopenAfterInstall"
  Wait-MemmyProcessExit -ProcessId $OriginalInstallerPid -TimeoutSeconds 120
  Wait-MemmyInstallProcessesExit -TimeoutSeconds 20
  Assert-MemmyRelaySourceIsSafe

  if (Test-Path -LiteralPath $dataPath -PathType Container) {
    if (Test-Path -LiteralPath $backupRoot) {
      throw "refusing to overwrite existing upgrade backup root: $backupRoot"
    }
    Move-MemmyDirectory -Source $dataPath -Destination $backupPath
    $dataMoved = $true
    $relayPhase = 'data-moved'
    Write-MemmyRelayState
    Write-MemmyUpgradeLog "data moved to $backupPath"
  }

  try {
    Invoke-MemmyDataMigration -Mode Prepare
    $migrationPrepared = $true
    $relayPhase = 'migration-prepared'
    Write-MemmyRelayState
  } catch {
    $migrationSkipped = $true
    $migrationFailure = $_.Exception.Message
    $relayPhase = 'migration-skipped'
    Write-MemmyRelayState
    Write-MemmyUpgradeLog "data migration Prepare failed safely; continuing installation without migration: $migrationFailure"
  }

  # Both visible and silent relay children are upgrades. Keeping --updated for the visible child
  # makes electron-builder preserve the existing shortcuts and launch proxy while the old
  # installation is removed. /S controls visibility independently.
  $arguments = @('--updated', '--memmy-upgrade-relayed', '/currentuser', ('/D=' + $normalizedTargetInstallDir))
  if ($InstallerMode -eq 'Silent') {
    $arguments = @('/S') + $arguments
  }
  $env:MEMMY_UPGRADE_WORK_DIR = $WorkDir
  $env:MEMMY_UPGRADE_BACKUP_ROOT = $backupRoot
  $env:MEMMY_UPGRADE_REOPEN_AFTER_INSTALL = $resolvedReopenAfterInstall
  $env:MEMMY_UPGRADE_SOURCE_INSTALL_DIR = $normalizedSourceInstallDir
  $env:MEMMY_UPGRADE_TARGET_INSTALL_DIR = $normalizedTargetInstallDir
  Write-MemmyUpgradeLog "child installer context workDir=$env:MEMMY_UPGRADE_WORK_DIR backupRoot=$env:MEMMY_UPGRADE_BACKUP_ROOT source=$env:MEMMY_UPGRADE_SOURCE_INSTALL_DIR target=$env:MEMMY_UPGRADE_TARGET_INSTALL_DIR reopen=$env:MEMMY_UPGRADE_REOPEN_AFTER_INSTALL mode=$InstallerMode"
  $relayPhase = 'installer-starting'
  Write-MemmyRelayState
  Assert-MemmyRelocationTargetIsSafe -AllowPreparedMigrationTarget:$migrationPrepared
  if ($InstallerMode -eq 'Interactive') {
    $installerProcess = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -PassThru -WindowStyle Normal
  } else {
    $installerProcess = Start-Process -FilePath $InstallerPath -ArgumentList $arguments -PassThru -WindowStyle Hidden
  }
  $installerProcess.WaitForExit()
  $installerExit = if ($null -eq $installerProcess.ExitCode) { 1 } else { $installerProcess.ExitCode }
  Write-MemmyUpgradeLog "installer exit $installerExit"
  $verifiedInstalledVersion = Get-MemmyInstalledVersion
  $upgradeVerified = $installerExit -eq 0 -and $verifiedInstalledVersion.StartsWith($ExpectedVersion, [System.StringComparison]::OrdinalIgnoreCase)
  if (-not $upgradeVerified) {
    throw "upgrade verification failed installedVersion=$verifiedInstalledVersion installerExit=$installerExit"
  }

  if ($migrationPrepared) {
    try {
      Invoke-MemmyDataMigration -Mode Complete
      $migrationCompleted = $true
      $relayPhase = 'migration-completed'
      Write-MemmyRelayState
    } catch {
      $migrationFailure = $_.Exception.Message
      Write-MemmyUpgradeLog "data migration Complete failed; rolling back migration while retaining the installed app: $migrationFailure"
      for ($rollbackAttempt = 1; $rollbackAttempt -le 2 -and -not $migrationRolledBack; $rollbackAttempt++) {
        try {
          Invoke-MemmyDataMigration -Mode Rollback
          $migrationRolledBack = $true
        } catch {
          Write-MemmyUpgradeLog "data migration rollback attempt $rollbackAttempt after completion failure failed: $($_.Exception.Message)"
        }
      }
      $migrationSkipped = $true
      if ($migrationRolledBack) {
        $relayPhase = 'migration-skipped'
        Write-MemmyRelayState
      } else {
        # Keep the installed application usable and leave the prepared transaction for startup
        # recovery. The lock is released below so a helper failure never permanently blocks launch.
        $migrationCompleted = $false
        try {
          Invoke-MemmyDataMigration -Mode RequireRecovery
        } catch {
          # Startup also treats any state left in `prepared` as recovery-required, so a failure
          # to update the explicit phase still fails open without accepting the mixed target.
          Write-MemmyUpgradeLog "unable to mark explicit migration recovery phase; prepared state remains recoverable: $($_.Exception.Message)"
        }
        $relayPhase = 'migration-recovery-required'
        Write-MemmyRelayState
        Write-MemmyUpgradeLog "retaining prepared migration state for startup recovery"
      }
    }
  }
} catch {
  Write-MemmyUpgradeLog ('relay error: ' + ($_ | Out-String))
  if ($installerExit -eq 0) {
    $installerExit = 1
  }
} finally {
  if (-not $upgradeVerified) {
    if ($migrationPrepared -and -not $migrationCompleted) {
      try {
        Invoke-MemmyDataMigration -Mode Rollback
        $migrationRolledBack = $true
      } catch {
        Write-MemmyUpgradeLog ('data migration rollback failed: ' + ($_ | Out-String))
        $migrationRolledBack = $false
      }
    }
    try {
      Restore-MemmyData
    } catch {
      Write-MemmyUpgradeLog ('data restore failed: ' + ($_ | Out-String))
      $dataRestored = $false
    }
  }
  $migrationSafe = (-not $migrationPrepared) -or $migrationCompleted -or $migrationRolledBack
  if ($lockAcquired -and (($upgradeVerified -and ($migrationCompleted -or $migrationSkipped)) -or ($dataRestored -and $migrationSafe))) {
    Remove-Item -LiteralPath $lockPath -Recurse -Force -ErrorAction SilentlyContinue
  } elseif ($lockAcquired) {
    Write-MemmyUpgradeLog "active lock retained for automatic recovery $lockPath"
  }
}

if ($upgradeVerified -and ($migrationCompleted -or $migrationSkipped)) {
  if ($migrationSkipped -and $dataMoved) {
    Write-MemmyUpgradeLog "upgrade verified without migration; original data retained for manual recovery at $backupPath"
  } else {
    Write-MemmyUpgradeLog "upgrade verified installedVersion=$verifiedInstalledVersion"
  }
  if ($resolvedReopenAfterInstall -eq '1') {
    Ensure-MemmyInstalledAppStarted
  }
  Schedule-MemmyStagingCleanup
  exit 0
}

Write-MemmyUpgradeLog "upgrade not verified installedVersion=$verifiedInstalledVersion installerExit=$installerExit"
if (-not $dataRestored) {
  Write-MemmyUpgradeLog "upgrade stopped with recoverable data backup $backupPath"
  exit 3
}
if ($resolvedReopenAfterInstall -eq '1') {
  Start-MemmyInstalledApp
}
exit $(if ($installerExit -ne 0) { $installerExit } else { 4 })
