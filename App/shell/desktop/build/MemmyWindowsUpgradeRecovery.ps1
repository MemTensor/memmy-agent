param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$LockPath,
  [Parameter(Mandatory = $true)][string]$LogPath,
  [string]$DirectMigrationStatePath = '',
  [string]$DirectMigrationScriptPath = '',
  [string]$DirectMigrationLogPath = '',
  [string]$TargetUserDataPathOverride = '',
  [string]$TargetRuntimeHomePathOverride = '',
  [string]$LegacyRuntimeHomePathOverride = '',
  [string]$MigrationStatePathOverride = ''
)

$ErrorActionPreference = 'Stop'
$normalizedInstallDir = [System.IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$dataPath = Join-Path $normalizedInstallDir 'data'
$expectedBackupParent = "$normalizedInstallDir.memmy-upgrade-backup"
$normalizedLockPath = [System.IO.Path]::GetFullPath($LockPath).TrimEnd('\')
$expectedStagingRoot = Split-Path -Parent $normalizedLockPath
$statePath = Join-Path $LockPath 'state.json'
$expectedTargetUserDataPath = if ($TargetUserDataPathOverride) {
  [System.IO.Path]::GetFullPath($TargetUserDataPathOverride).TrimEnd('\')
} else {
  Join-Path $env:APPDATA 'Memmy'
}
$expectedTargetUserDataPath = [System.IO.Path]::GetFullPath([string]$expectedTargetUserDataPath).TrimEnd('\')
$expectedLegacyRuntimeHomePath = if ($LegacyRuntimeHomePathOverride) {
  [System.IO.Path]::GetFullPath($LegacyRuntimeHomePathOverride).TrimEnd('\')
} else {
  [System.IO.Path]::GetFullPath((Join-Path $env:USERPROFILE '.memmy')).TrimEnd('\')
}
$installDriveRoot = [System.IO.Path]::GetPathRoot($normalizedInstallDir)
$expectedTargetRuntimeHomePath = if ($TargetRuntimeHomePathOverride) {
  [System.IO.Path]::GetFullPath($TargetRuntimeHomePathOverride).TrimEnd('\')
} elseif ([string]::Equals($installDriveRoot, 'C:\', [System.StringComparison]::OrdinalIgnoreCase)) {
  $expectedLegacyRuntimeHomePath
} else {
  [System.IO.Path]::GetFullPath((Join-Path $installDriveRoot 'MemmyData\.memmy')).TrimEnd('\')
}
$expectedPointerPath = Join-Path $expectedTargetUserDataPath 'data-root.txt'
$expectedMigrationStatePath = if ($MigrationStatePathOverride) {
  [System.IO.Path]::GetFullPath($MigrationStatePathOverride).TrimEnd('\')
} else {
  [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Memmy\data-migration\state.json')).TrimEnd('\')
}
$resolvedDirectMigrationStatePath = if ($DirectMigrationStatePath) {
  [System.IO.Path]::GetFullPath($DirectMigrationStatePath).TrimEnd('\')
} else {
  $expectedMigrationStatePath
}
$resolvedDirectMigrationScriptPath = if ($DirectMigrationScriptPath) {
  $DirectMigrationScriptPath
} else {
  Join-Path $PSScriptRoot 'MemmyWindowsDataMigration.ps1'
}
$resolvedDirectMigrationLogPath = if ($DirectMigrationLogPath) {
  $DirectMigrationLogPath
} else {
  Join-Path $env:LOCALAPPDATA 'Memmy\upgrade-logs\data-migration.log'
}

function Write-MemmyUpgradeRecoveryLog([string]$Message) {
  $logDirectory = Split-Path -Parent $LogPath
  if ($logDirectory) {
    New-Item -ItemType Directory -Force -Path $logDirectory | Out-Null
  }
  Add-Content -LiteralPath $LogPath -Value ('[{0:O}] recovery: {1}' -f (Get-Date), $Message)
}

function Resolve-MemmyNormalizedPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
}

function Assert-MemmySamePath([string]$Actual, [string]$Expected, [string]$Description) {
  if (-not $Actual -or
      -not [string]::Equals(
        (Resolve-MemmyNormalizedPath $Actual),
        (Resolve-MemmyNormalizedPath $Expected),
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
    throw "$Description does not match the trusted recovery path"
  }
}

function Test-MemmyUpgradeProcessRunning($ProcessId, $StartedAtUtc, [string]$ExpectedPath = '') {
  $parsedProcessId = 0
  if (-not [int]::TryParse([string]$ProcessId, [ref]$parsedProcessId) -or $parsedProcessId -le 0) {
    return $false
  }
  $process = Get-Process -Id $parsedProcessId -ErrorAction SilentlyContinue
  if ($null -eq $process) {
    return $false
  }
  try {
    if ($ExpectedPath) {
      $actualPath = Resolve-MemmyNormalizedPath $process.Path
      $normalizedExpectedPath = Resolve-MemmyNormalizedPath $ExpectedPath
      if (-not [string]::Equals($actualPath, $normalizedExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $false
      }
    }
    if (-not $StartedAtUtc) {
      return $true
    }
    $expectedStart = [DateTime]::Parse([string]$StartedAtUtc).ToUniversalTime()
    $actualStart = $process.StartTime.ToUniversalTime()
    return [Math]::Abs(($actualStart - $expectedStart).TotalSeconds) -lt 5
  } catch {
    return $true
  }
}

function Test-MemmyInstallerPathRunning([string]$InstallerPath) {
  if (-not $InstallerPath) {
    return $false
  }
  $normalizedExpectedPath = Resolve-MemmyNormalizedPath $InstallerPath
  try {
    $processes = @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
  } catch {
    Write-MemmyUpgradeRecoveryLog "unable to enumerate installer processes; leaving recovery locked: $($_.Exception.Message)"
    return $true
  }
  foreach ($process in $processes) {
    if (-not $process.ExecutablePath) {
      continue
    }
    try {
      $actualPath = Resolve-MemmyNormalizedPath ([string]$process.ExecutablePath)
      if ([string]::Equals($actualPath, $normalizedExpectedPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
      }
    } catch {
      continue
    }
  }
  return $false
}

function Assert-MemmySameVolume([string]$Source, [string]$Destination) {
  $sourceRoot = [System.IO.Path]::GetPathRoot((Resolve-MemmyNormalizedPath $Source))
  $destinationRoot = [System.IO.Path]::GetPathRoot((Resolve-MemmyNormalizedPath $Destination))
  if (-not [string]::Equals($sourceRoot, $destinationRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "refusing cross-volume directory move: $Source -> $Destination"
  }
}

function Move-MemmyRecoveryDirectory([string]$Source, [string]$Destination) {
  Assert-MemmySameVolume -Source $Source -Destination $Destination
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  for ($attempt = 1; $attempt -le 120; $attempt++) {
    try {
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

function Clear-MemmyRecoveryTransientMarkers {
  $markerPaths = @(
    (Join-Path $dataPath 'Memmy\prepared-required-update.json'),
    (Join-Path $expectedTargetUserDataPath 'prepared-required-update.json')
  )
  foreach ($markerPath in $markerPaths) {
    foreach ($path in @("$markerPath.lock", "$markerPath.prompt")) {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue
    }
  }
  Write-MemmyUpgradeRecoveryLog "cleared transient prepared-update lock and prompt markers"
}

function Read-MemmyMigrationState([string]$MigrationStatePath) {
  if (-not $MigrationStatePath -or -not (Test-Path -LiteralPath $MigrationStatePath -PathType Leaf)) {
    return $null
  }
  return Get-Content -LiteralPath $MigrationStatePath -Raw -Encoding UTF8 | ConvertFrom-Json
}

function Invoke-MemmyMigrationRecovery(
  [ValidateSet('Rollback', 'Recover')][string]$Mode,
  [string]$MigrationStatePath,
  [string]$MigrationScriptPath,
  [string]$MigrationLogPath,
  [ValidateSet('relay', 'installer')][string]$ExpectedOwner,
  [string]$ExpectedSourceDataPath = ''
) {
  $migrationState = Read-MemmyMigrationState -MigrationStatePath $MigrationStatePath
  if ($null -eq $migrationState) {
    throw "migration state is unavailable: $MigrationStatePath"
  }
  if ([string]$migrationState.owner -ne $ExpectedOwner) {
    throw "migration state owner does not match recovery owner $ExpectedOwner"
  }
  if (-not (Test-Path -LiteralPath $MigrationScriptPath -PathType Leaf)) {
    throw "migration recovery helper is unavailable: $MigrationScriptPath"
  }

  $migrationSourcePath = [string]$migrationState.sourceDataPath
  if (-not $migrationSourcePath -or -not $migrationState.targetUserDataPath -or
      -not $migrationState.targetRuntimeHomePath -or -not $migrationState.pointerPath) {
    throw "migration state is missing required recovery paths"
  }
  Assert-MemmySamePath -Actual ([string]$migrationState.targetUserDataPath) -Expected $expectedTargetUserDataPath -Description 'migration user-data target'
  Assert-MemmySamePath -Actual ([string]$migrationState.targetRuntimeHomePath) -Expected $expectedTargetRuntimeHomePath -Description 'migration runtime target'
  Assert-MemmySamePath -Actual ([string]$migrationState.pointerPath) -Expected $expectedPointerPath -Description 'migration data-root pointer'
  if ($ExpectedSourceDataPath) {
    Assert-MemmySamePath -Actual $migrationSourcePath -Expected $ExpectedSourceDataPath -Description 'migration source'
  }

  $migrationSourceAuthority = if ($migrationState.sourceAuthority) {
    [string]$migrationState.sourceAuthority
  } elseif ($ExpectedOwner -eq 'relay') {
    'relay-backup-authority'
  } else {
    'current-install-authority'
  }
  $migrationSourceInstallDir = if ($migrationState.sourceInstallDir) {
    [string]$migrationState.sourceInstallDir
  } elseif ($ExpectedOwner -eq 'relay') {
    $normalizedInstallDir
  } else {
    Split-Path -Parent $migrationSourcePath
  }

  $powershellPath = Join-Path $PSHOME 'powershell.exe'
  & $powershellPath @(
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-File', $MigrationScriptPath,
    '-Mode', $Mode,
    '-SourceDataPath', $migrationSourcePath,
    '-SourceAuthority', $migrationSourceAuthority,
    '-SourceInstallDir', $migrationSourceInstallDir,
    '-LegacyRuntimeHomePath', $expectedLegacyRuntimeHomePath,
    '-TargetUserDataPath', $expectedTargetUserDataPath,
    '-TargetRuntimeHomePath', $expectedTargetRuntimeHomePath,
    '-PointerPath', $expectedPointerPath,
    '-StatePath', $MigrationStatePath,
    '-LockPath', $LockPath,
    '-LogPath', $MigrationLogPath,
    '-Owner', $ExpectedOwner
  )
  if ($LASTEXITCODE -ne 0) {
    throw "migration $Mode recovery failed with exit code $LASTEXITCODE"
  }
  Write-MemmyUpgradeRecoveryLog "migration $Mode recovery completed for $ExpectedOwner"
}

function Recover-MemmyDirectMigration {
  Assert-MemmySamePath -Actual $resolvedDirectMigrationStatePath -Expected $expectedMigrationStatePath -Description 'direct migration state'
  $migrationState = Read-MemmyMigrationState -MigrationStatePath $resolvedDirectMigrationStatePath
  if ($null -eq $migrationState) {
    return $false
  }
  if ([string]$migrationState.owner -ne 'installer') {
    return $false
  }

  $migrationPhase = [string]$migrationState.phase
  if (@('prepared', 'recovery-required') -contains $migrationPhase) {
    Invoke-MemmyMigrationRecovery `
      -Mode Recover `
      -MigrationStatePath $resolvedDirectMigrationStatePath `
      -MigrationScriptPath $resolvedDirectMigrationScriptPath `
      -MigrationLogPath $resolvedDirectMigrationLogPath `
      -ExpectedOwner installer
  }
  elseif (@('prepared-for-retry', 'awaiting-app-verification', 'app-verified') -notcontains $migrationPhase) {
    throw "direct migration state has an unsupported phase: $migrationPhase"
  }

  Write-MemmyUpgradeRecoveryLog "stale direct-install migration recovered in phase $migrationPhase"
  return $true
}

if (-not (Test-Path -LiteralPath $LockPath -PathType Container)) {
  exit 0
}

try {
  if (-not (Test-Path -LiteralPath $statePath -PathType Leaf)) {
    $lockAge = (Get-Date) - (Get-Item -LiteralPath $LockPath).LastWriteTime
    if ($lockAge.TotalMinutes -lt 2) {
      Write-MemmyUpgradeRecoveryLog "active lock has no recovery state; leaving it in place"
      exit 2
    }
    if (Recover-MemmyDirectMigration) {
      Clear-MemmyRecoveryTransientMarkers
      Remove-Item -LiteralPath $LockPath -Recurse -Force
      Write-MemmyUpgradeRecoveryLog "cleared stale direct-install lock after migration recovery"
      exit 0
    }
    if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
      Remove-Item -LiteralPath $LockPath -Recurse -Force
      Write-MemmyUpgradeRecoveryLog "cleared stale state-less lock without installed data so installation can be retried"
      exit 0
    }
    Clear-MemmyRecoveryTransientMarkers
    Remove-Item -LiteralPath $LockPath -Recurse -Force
    Write-MemmyUpgradeRecoveryLog "cleared stale state-less lock because installed data is present"
    exit 0
  }

  $state = Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json
  $phase = [string]$state.phase
  if ([string]$state.owner -eq 'installer') {
    if ($phase -ne 'direct-migration-running') {
      throw "direct installer recovery state has an unsupported phase: $phase"
    }
    if (-not $state.installDir -or -not $state.installerPath -or -not $state.installerPid) {
      throw "direct installer recovery state is missing process identity"
    }
    if (Test-MemmyUpgradeProcessRunning $state.installerPid $null ([string]$state.installerPath)) {
      Write-MemmyUpgradeRecoveryLog "direct installer is still running; leaving active lock in place"
      exit 2
    }

    $directInstallDir = Resolve-MemmyNormalizedPath ([string]$state.installDir)
    $directInstallRoot = [System.IO.Path]::GetPathRoot($directInstallDir)
    $directExpectedRuntimeHomePath = if ($TargetRuntimeHomePathOverride) {
      $expectedTargetRuntimeHomePath
    } elseif ([string]::Equals($directInstallRoot, 'C:\', [System.StringComparison]::OrdinalIgnoreCase)) {
      $expectedLegacyRuntimeHomePath
    } else {
      Resolve-MemmyNormalizedPath (Join-Path $directInstallRoot 'MemmyData\.memmy')
    }
    Assert-MemmySamePath -Actual ([string]$state.targetUserDataPath) -Expected $expectedTargetUserDataPath -Description 'direct-lock user-data target'
    Assert-MemmySamePath -Actual ([string]$state.targetRuntimeHomePath) -Expected $directExpectedRuntimeHomePath -Description 'direct-lock runtime target'
    $expectedTargetRuntimeHomePath = $directExpectedRuntimeHomePath
    $dataPath = Join-Path $directInstallDir 'data'

    if (Recover-MemmyDirectMigration) {
      Clear-MemmyRecoveryTransientMarkers
      Remove-Item -LiteralPath $LockPath -Recurse -Force
      Write-MemmyUpgradeRecoveryLog "cleared direct-install lock after the installer exited and migration recovery completed"
      exit 0
    }
    if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
      Remove-Item -LiteralPath $LockPath -Recurse -Force
      Write-MemmyUpgradeRecoveryLog "cleared direct-install lock after the installer exited without migrated data"
      exit 0
    }
    Clear-MemmyRecoveryTransientMarkers
    Remove-Item -LiteralPath $LockPath -Recurse -Force
    Write-MemmyUpgradeRecoveryLog "cleared direct-install lock after the installer exited with installed data present"
    exit 0
  }
  if (@('relay-ready', 'data-moved', 'migration-prepared', 'migration-skipped', 'installer-starting', 'installer-running', 'installer-exited', 'migration-completed', 'migration-recovery-required') -notcontains $phase) {
    throw "recovery state has an unsupported phase: $phase"
  }
  $stateInstallDir = Resolve-MemmyNormalizedPath ([string]$state.installDir)
  $stateWorkDir = Resolve-MemmyNormalizedPath ([string]$state.workDir)
  $stateInstallerPath = Resolve-MemmyNormalizedPath ([string]$state.installerPath)
  $backupRoot = Resolve-MemmyNormalizedPath ([string]$state.backupRoot)
  if (-not [string]::Equals($stateInstallDir, $normalizedInstallDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "recovery state install directory does not match launcher install directory"
  }
  if ([int]$state.schemaVersion -ge 3) {
    Assert-MemmySamePath -Actual ([string]$state.migrationStatePath) -Expected $expectedMigrationStatePath -Description 'relay migration state'
    Assert-MemmySamePath -Actual ([string]$state.targetUserDataPath) -Expected $expectedTargetUserDataPath -Description 'relay user-data target'
    Assert-MemmySamePath -Actual ([string]$state.targetRuntimeHomePath) -Expected $expectedTargetRuntimeHomePath -Description 'relay runtime target'
    Assert-MemmySamePath -Actual ([string]$state.legacyRuntimeHomePath) -Expected $expectedLegacyRuntimeHomePath -Description 'relay legacy runtime root'
  }
  if (-not [string]::Equals((Split-Path -Parent $stateWorkDir), $expectedStagingRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "recovery state work directory is outside the expected staging directory"
  }
  $workLeaf = Split-Path -Leaf $stateWorkDir
  if (-not $workLeaf -or [string]::Equals($workLeaf, 'active.lock', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "recovery state work directory has an invalid leaf"
  }
  if (-not [string]::Equals((Split-Path -Parent $stateInstallerPath), $stateWorkDir, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "recovery state installer path is outside its work directory"
  }
  $expectedBackupRoot = Resolve-MemmyNormalizedPath (Join-Path $expectedBackupParent $workLeaf)
  if (-not [string]::Equals($backupRoot, $expectedBackupRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "recovery state backup root does not match the expected install-local sibling"
  }
  if ((Test-MemmyUpgradeProcessRunning $state.relayPid $state.relayStartedAtUtc) -or
      (Test-MemmyUpgradeProcessRunning $state.installerPid $state.installerStartedAtUtc $stateInstallerPath) -or
      ($phase -eq 'installer-starting' -and (Test-MemmyInstallerPathRunning $stateInstallerPath))) {
    Write-MemmyUpgradeRecoveryLog "upgrade process is still running; leaving active lock in place"
    exit 2
  }

  $relayMigrationStatePath = if ([int]$state.schemaVersion -ge 3) { $expectedMigrationStatePath } else { '' }
  $relayMigrationState = Read-MemmyMigrationState -MigrationStatePath $relayMigrationStatePath
  $relayMigrationPhase = if ($null -ne $relayMigrationState) { [string]$relayMigrationState.phase } else { '' }
  if ($phase -eq 'migration-completed' -or
      @('awaiting-app-verification', 'app-verified') -contains $relayMigrationPhase) {
    Remove-Item -LiteralPath $LockPath -Recurse -Force
    Write-MemmyUpgradeRecoveryLog "completed migration lock cleared without restoring install-local data"
    if (Test-Path -LiteralPath $stateWorkDir -PathType Container) {
      Remove-Item -LiteralPath $stateWorkDir -Recurse -Force -ErrorAction SilentlyContinue
    }
    exit 0
  }

  $backupPath = Join-Path $backupRoot 'data-backup'
  $installerDataPath = Join-Path $backupRoot 'installer-created-data'
  if (Test-Path -LiteralPath $backupPath -PathType Container) {
    if (Test-Path -LiteralPath $dataPath) {
      if (Test-Path -LiteralPath $installerDataPath) {
        throw "installer-created data backup already exists: $installerDataPath"
      }
      Move-MemmyRecoveryDirectory -Source $dataPath -Destination $installerDataPath
      Write-MemmyUpgradeRecoveryLog "preserved installer-created data at $installerDataPath"
    }
    Move-MemmyRecoveryDirectory -Source $backupPath -Destination $dataPath
    if (-not (Test-Path -LiteralPath $dataPath -PathType Container)) {
      throw "restored data directory is unavailable: $dataPath"
    }
    Write-MemmyUpgradeRecoveryLog "stale upgrade data restored from $backupPath"
  } elseif (Test-Path -LiteralPath $dataPath -PathType Container) {
    Write-MemmyUpgradeRecoveryLog "stale upgrade already has installed data; clearing lock"
  } else {
    throw "both installed data and upgrade backup are missing"
  }

  if (@('prepared', 'recovery-required') -contains $relayMigrationPhase) {
    $relayMigrationLogPath = if ($state.migrationLogPath) {
      [string]$state.migrationLogPath
    } else {
      $resolvedDirectMigrationLogPath
    }
    Invoke-MemmyMigrationRecovery `
      -Mode Rollback `
      -MigrationStatePath $relayMigrationStatePath `
      -MigrationScriptPath (Join-Path $stateWorkDir 'MemmyWindowsDataMigration.ps1') `
      -MigrationLogPath $relayMigrationLogPath `
      -ExpectedOwner relay `
      -ExpectedSourceDataPath $backupPath
  }
  elseif ([int]$state.schemaVersion -ge 3 -and
      @('migration-prepared', 'installer-starting', 'installer-running', 'installer-exited', 'migration-recovery-required') -contains $phase -and
      -not $relayMigrationPhase) {
    if ((Test-Path -LiteralPath $dataPath -PathType Container) -and
        -not (Test-Path -LiteralPath $backupPath)) {
      Write-MemmyUpgradeRecoveryLog "prepared relay migration rollback was already completed before lock cleanup"
    } else {
      throw "prepared relay migration state is unavailable"
    }
  }

  Clear-MemmyRecoveryTransientMarkers
  Remove-Item -LiteralPath $LockPath -Recurse -Force
  Write-MemmyUpgradeRecoveryLog "stale active lock cleared"
  if (Test-Path -LiteralPath $stateWorkDir -PathType Container) {
    try {
      Remove-Item -LiteralPath $stateWorkDir -Recurse -Force -ErrorAction Stop
      Write-MemmyUpgradeRecoveryLog "stale staging work directory removed: $stateWorkDir"
    } catch {
      Write-MemmyUpgradeRecoveryLog "unable to remove stale staging work directory ${stateWorkDir}: $($_.Exception.Message)"
    }
  }
  exit 0
} catch {
  Write-MemmyUpgradeRecoveryLog ('automatic recovery failed: ' + ($_ | Out-String))
  $lockAge = if (Test-Path -LiteralPath $LockPath -PathType Container) {
    (Get-Date) - (Get-Item -LiteralPath $LockPath).LastWriteTime
  } else {
    [TimeSpan]::Zero
  }
  if ($lockAge.TotalMinutes -ge 2) {
    $quarantinePath = "$LockPath.recovery-failed-$([DateTime]::UtcNow.ToString('yyyyMMddHHmmss'))"
    try {
      Move-Item -LiteralPath $LockPath -Destination $quarantinePath -Force -ErrorAction Stop
      Write-MemmyUpgradeRecoveryLog "quarantined unrecoverable stale lock at $quarantinePath; application launch is no longer blocked"
      exit 0
    } catch {
      Write-MemmyUpgradeRecoveryLog "unable to quarantine stale lock: $($_.Exception.Message)"
    }
  }
  exit 3
}
