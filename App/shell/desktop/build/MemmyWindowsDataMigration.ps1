param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Prepare", "Complete", "Rollback", "Recover", "RequireRecovery")]
  [string]$Mode,

  [Parameter(Mandatory = $true)]
  [string]$SourceDataPath,

  [ValidateSet(
    "current-install-authority",
    "selected-install-authority",
    "relay-backup-authority",
    "persisted-install-authority",
    "untrusted-residual"
  )]
  [string]$SourceAuthority = "untrusted-residual",

  [string]$SourceInstallDir = "",

  [string]$SourceGeneration = "",

  [string]$SourceInstalledVersion = "",

  [string]$InstallationRecordPath = "",

  [string]$LegacyRuntimeHomePath = "",

  [string]$AllowedRememberedRuntimeHomePath = "",

  [Parameter(Mandatory = $true)]
  [string]$TargetUserDataPath,

  [Parameter(Mandatory = $true)]
  [string]$TargetRuntimeHomePath,

  [Parameter(Mandatory = $true)]
  [string]$PointerPath,

  [Parameter(Mandatory = $true)]
  [string]$StatePath,

  [Parameter(Mandatory = $true)]
  [string]$LockPath,

  [Parameter(Mandatory = $true)]
  [string]$LogPath,

  [Parameter(Mandatory = $true)]
  [ValidateSet("relay", "installer")]
  [string]$Owner,

  [int]$InstallerPid = 0,

  [string]$InstallerPath = "",

  [string]$InstallerInstallDir = "",

  [switch]$AcquireLock
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version 2.0
$lockAcquiredHere = $false
$effectiveSourceDataPath = $SourceDataPath
$effectiveSourceAuthority = $SourceAuthority
$effectiveSourceInstallDir = $SourceInstallDir
$effectiveSourceGeneration = $SourceGeneration
$effectiveSourceInstalledVersion = $SourceInstalledVersion

function Ensure-ParentDirectory {
  param([Parameter(Mandatory = $true)][string]$Path)

  $parent = Split-Path -Parent $Path
  if ($parent -and -not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
}

function Write-MigrationLog {
  param([Parameter(Mandatory = $true)][string]$Message)

  try {
    Ensure-ParentDirectory -Path $LogPath
    $line = "{0} {1}" -f ([DateTime]::UtcNow.ToString("o")), $Message
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
  }
  catch {}
}

function Get-NormalizedPath {
  param([Parameter(Mandatory = $true)][string]$Path)

  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Test-SamePath {
  param(
    [Parameter(Mandatory = $true)][string]$Left,
    [Parameter(Mandatory = $true)][string]$Right
  )

  return [string]::Equals(
    (Get-NormalizedPath -Path $Left),
    (Get-NormalizedPath -Path $Right),
    [System.StringComparison]::OrdinalIgnoreCase
  )
}

function Read-DataRootPointer {
  param([Parameter(Mandatory = $true)][string]$Path)

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }

  try {
    $bytes = [System.IO.File]::ReadAllBytes($Path)
    if ($bytes.Length -ge 2 -and $bytes[0] -eq 0xff -and $bytes[1] -eq 0xfe) {
      $value = [System.Text.Encoding]::Unicode.GetString($bytes, 2, $bytes.Length - 2)
    }
    else {
      $value = [System.Text.Encoding]::UTF8.GetString($bytes)
    }
    $value = $value.Trim([char]0xfeff).Trim()
    if ($value -and [System.IO.Path]::IsPathRooted($value)) {
      $normalizedValue = Get-NormalizedPath -Path $value
      $runtimeRoot = [System.IO.Path]::GetPathRoot($normalizedValue)
      $canonicalDriveRuntimeHome = if ($runtimeRoot) {
        Join-Path $runtimeRoot "MemmyData\.memmy"
      } else {
        ""
      }
      if (($LegacyRuntimeHomePath -and (Test-SamePath -Left $normalizedValue -Right $LegacyRuntimeHomePath)) -or
          (Test-SamePath -Left $normalizedValue -Right $TargetRuntimeHomePath) -or
          ($canonicalDriveRuntimeHome -and (Test-SamePath -Left $normalizedValue -Right $canonicalDriveRuntimeHome)) -or
          ($AllowedRememberedRuntimeHomePath -and
            (Test-SamePath -Left $normalizedValue -Right $AllowedRememberedRuntimeHomePath))) {
        return $normalizedValue
      }
      Write-MigrationLog -Message "Ignoring data-root pointer outside a supported Memmy runtime root: $normalizedValue"
    }
  }
  catch {
    Write-MigrationLog -Message ("Ignoring unreadable data-root pointer: {0}" -f $_.Exception.Message)
  }
  return $null
}

function Resolve-TrustedInstallDataPath {
  if ($effectiveSourceAuthority -eq "untrusted-residual") {
    Write-MigrationLog -Message "Install data source is not externally trusted; it cannot replace persistent targets: $effectiveSourceDataPath"
    return $null
  }
  if (-not $effectiveSourceInstallDir -or -not [System.IO.Path]::IsPathRooted($effectiveSourceInstallDir)) {
    throw "A trusted install source requires an absolute source installation directory."
  }

  $normalizedSourceDataPath = Get-NormalizedPath -Path $effectiveSourceDataPath
  $normalizedSourceInstallDir = Get-NormalizedPath -Path $effectiveSourceInstallDir
  if (@("current-install-authority", "selected-install-authority") -contains $effectiveSourceAuthority) {
    if ($effectiveSourceAuthority -eq "selected-install-authority" -and $Owner -ne "installer") {
      throw "Selected-install authority requires direct installer ownership."
    }
    $expectedSourceDataPath = Get-NormalizedPath -Path (Join-Path $normalizedSourceInstallDir "data")
    if (-not (Test-SamePath -Left $normalizedSourceDataPath -Right $expectedSourceDataPath)) {
      throw "Install source data is outside the exact installation directory."
    }
    return $normalizedSourceDataPath
  }

  if ($effectiveSourceAuthority -eq "relay-backup-authority") {
    if ($Owner -ne "relay") {
      throw "Relay backup authority requires relay ownership."
    }
    if (-not [string]::Equals(
        (Split-Path -Leaf $normalizedSourceDataPath),
        "data-backup",
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
      throw "Relay source data must be the validated data-backup directory."
    }
    $backupRoot = Split-Path -Parent $normalizedSourceDataPath
    $backupParent = Split-Path -Parent $backupRoot
    $expectedBackupParent = "$normalizedSourceInstallDir.memmy-upgrade-backup"
    if (-not (Test-SamePath -Left $backupParent -Right $expectedBackupParent) -or
        -not (Split-Path -Leaf $backupRoot)) {
      throw "Relay source data is outside the validated installation backup directory."
    }
    return $normalizedSourceDataPath
  }

  if (-not $effectiveSourceGeneration) {
    throw "A persisted install authority requires a recorded source generation."
  }
  $expectedPersistedDataPath = Get-NormalizedPath -Path (Join-Path $normalizedSourceInstallDir "data")
  $failedBackupRoot = Split-Path -Parent $normalizedSourceDataPath
  $failedBackupParent = Split-Path -Parent $failedBackupRoot
  $expectedFailedBackupParent = Get-NormalizedPath -Path "$normalizedSourceInstallDir.memmy-migration-failed"
  $isValidatedFailedBackup = [string]::Equals(
      (Split-Path -Leaf $normalizedSourceDataPath),
      "data-backup",
      [System.StringComparison]::OrdinalIgnoreCase
    ) -and
    (Test-SamePath -Left $failedBackupParent -Right $expectedFailedBackupParent) -and
    (Split-Path -Leaf $failedBackupRoot) -match '^[0-9]{14}-[a-f0-9]{32}$'
  if (-not (Test-SamePath -Left $normalizedSourceDataPath -Right $expectedPersistedDataPath) -and
      -not $isValidatedFailedBackup) {
    throw "Persisted source data does not match its recorded installation directory."
  }
  return $normalizedSourceDataPath
}

function Resolve-SourceGeneration {
  if ($effectiveSourceGeneration) {
    return $effectiveSourceGeneration.Trim()
  }
  if ($effectiveSourceAuthority -eq "untrusted-residual") {
    return $null
  }
  return "legacy-install:$((Get-NormalizedPath -Path $effectiveSourceInstallDir).ToLowerInvariant())"
}

function Test-CompleteInstallUserData {
  param([Parameter(Mandatory = $true)][string]$Path)

  return Test-Path -LiteralPath (Join-Path $Path "app.sqlite") -PathType Leaf
}

function Test-CompleteInstallRuntimeData {
  param([Parameter(Mandatory = $true)][string]$Path)

  return Test-Path -LiteralPath (Join-Path $Path "config.yaml") -PathType Leaf
}

function Read-InstallationRecord {
  if (-not $InstallationRecordPath -or
      -not (Test-Path -LiteralPath $InstallationRecordPath -PathType Leaf)) {
    return $null
  }
  try {
    $record = Get-Content -LiteralPath $InstallationRecordPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([int]$record.schemaVersion -ne 1 -or
        -not $record.installDir -or
        -not [System.IO.Path]::IsPathRooted([string]$record.installDir) -or
        @("external-v1", "install-local-v1") -notcontains [string]$record.dataLayoutGeneration) {
      Write-MigrationLog -Message "Ignoring an invalid installation data-layout record: $InstallationRecordPath"
      return $null
    }
    return $record
  }
  catch {
    Write-MigrationLog -Message "Ignoring an unreadable installation data-layout record: $($_.Exception.Message)"
    return $null
  }
}

function Test-IsKnownInstallLocalVersion {
  if (-not $effectiveSourceInstalledVersion) { return $false }
  $match = [Regex]::Match($effectiveSourceInstalledVersion.Trim(), '^(?<version>[0-9]+\.[0-9]+\.[0-9]+(?:\.[0-9]+)?)')
  if (-not $match.Success) { return $false }
  try {
    $parsed = [Version]$match.Groups['version'].Value
  }
  catch {
    return $false
  }
  return $parsed -ge [Version]'1.0.6' -and $parsed -lt [Version]'1.1.0'
}

function Resolve-EffectiveInstallSource {
  $record = Read-InstallationRecord
  if ($effectiveSourceAuthority -eq "untrusted-residual" -and
      $null -ne $record -and
      [string]$record.dataLayoutGeneration -eq "install-local-v1") {
    $recordedInstallDir = Get-NormalizedPath -Path ([string]$record.installDir)
    $script:effectiveSourceInstallDir = $recordedInstallDir
    $script:effectiveSourceDataPath = if (
      $record.PSObject.Properties.Name -contains "sourceDataPath" -and $record.sourceDataPath
    ) {
      Get-NormalizedPath -Path ([string]$record.sourceDataPath)
    } else {
      Get-NormalizedPath -Path (Join-Path $recordedInstallDir "data")
    }
    $script:effectiveSourceAuthority = "persisted-install-authority"
    $script:effectiveSourceGeneration = if (
      $record.PSObject.Properties.Name -contains "sourceGeneration" -and $record.sourceGeneration
    ) {
      [string]$record.sourceGeneration
    } else {
      "legacy-install:$($recordedInstallDir.ToLowerInvariant())"
    }
    Write-MigrationLog -Message "Using the persisted trusted install-local source: $effectiveSourceDataPath"
  }
  elseif (@("current-install-authority", "selected-install-authority", "relay-backup-authority") -contains $effectiveSourceAuthority -and
      $null -ne $record -and
      [string]$record.dataLayoutGeneration -eq "external-v1" -and
      (Test-SamePath -Left ([string]$record.installDir) -Right $effectiveSourceInstallDir)) {
    if (@("current-install-authority", "relay-backup-authority") -contains $effectiveSourceAuthority -and
        (Test-IsKnownInstallLocalVersion)) {
      Write-MigrationLog -Message "Installed version $effectiveSourceInstalledVersion uses the install-local layout; it remains authoritative despite an earlier external marker."
    }
    else {
      Write-MigrationLog -Message "Install is already verified on the external layout; install-local residual data cannot replace targets."
      $script:effectiveSourceAuthority = "untrusted-residual"
      $script:effectiveSourceGeneration = ""
    }
  }
}

function Record-TrustedInstallLocalGeneration {
  if ($Owner -ne "installer" -or
      -not $InstallationRecordPath -or
      @("current-install-authority", "selected-install-authority", "persisted-install-authority") -notcontains $effectiveSourceAuthority) {
    return
  }
  $userDataPath = Join-Path $effectiveSourceDataPath "Memmy"
  $runtimePath = Join-Path $effectiveSourceDataPath ".memmy"
  if (-not (Test-CompleteInstallUserData -Path $userDataPath) -and
      -not (Test-CompleteInstallRuntimeData -Path $runtimePath)) {
    return
  }
  Write-JsonFileAtomically -Path $InstallationRecordPath -Value ([ordered]@{
    schemaVersion = 1
    dataLayoutGeneration = "install-local-v1"
    installDir = (Get-NormalizedPath -Path $effectiveSourceInstallDir)
    sourceDataPath = (Get-NormalizedPath -Path $effectiveSourceDataPath)
    sourceGeneration = (Resolve-SourceGeneration)
    sourceAppVersion = $effectiveSourceInstalledVersion
    recordedAt = [DateTime]::UtcNow.ToString("o")
  })
}

function Preserve-FailedDirectMigrationSource {
  if ($Mode -ne "Prepare" -or
      $Owner -ne "installer" -or
      -not $InstallationRecordPath -or
      @("current-install-authority", "selected-install-authority", "persisted-install-authority") -notcontains $effectiveSourceAuthority -or
      -not (Test-Path -LiteralPath $effectiveSourceDataPath -PathType Container)) {
    return
  }

  $backupToken = "{0}-{1}" -f [DateTime]::UtcNow.ToString("yyyyMMddHHmmss"), ([Guid]::NewGuid().ToString("N"))
  $backupRoot = Join-Path "$effectiveSourceInstallDir.memmy-migration-failed" $backupToken
  $backupPath = Join-Path $backupRoot "data-backup"
  try {
    New-Item -ItemType Directory -Path $backupPath -Force -ErrorAction Stop | Out-Null
    Copy-DirectoryContents -Source $effectiveSourceDataPath -Destination $backupPath
    $sourceFingerprint = Get-DirectoryFingerprint -Path $effectiveSourceDataPath
    $backupFingerprint = Get-DirectoryFingerprint -Path $backupPath
    if ($sourceFingerprint.FileCount -ne $backupFingerprint.FileCount -or
        $sourceFingerprint.TotalBytes -ne $backupFingerprint.TotalBytes) {
      throw "Unmigrated source preservation verification failed."
    }
    Write-JsonFileAtomically -Path $InstallationRecordPath -Value ([ordered]@{
      schemaVersion = 1
      dataLayoutGeneration = "install-local-v1"
      installDir = (Get-NormalizedPath -Path $effectiveSourceInstallDir)
      sourceDataPath = (Get-NormalizedPath -Path $backupPath)
      sourceGeneration = (Resolve-SourceGeneration)
      sourceAppVersion = $effectiveSourceInstalledVersion
      migrationFailed = $true
      recordedAt = [DateTime]::UtcNow.ToString("o")
    })
    Write-MigrationLog -Message "Preserved unmigrated install data for manual or automatic retry at $backupPath"
  }
  catch {
    if (Test-Path -LiteralPath $backupRoot) {
      Remove-Item -LiteralPath $backupRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    Write-MigrationLog -Message "Unable to preserve an additional unmigrated install-data copy; the original source was left untouched: $($_.Exception.Message)"
  }
}

function Open-CriticalFilesForMigration {
  param([Parameter(Mandatory = $true)][string]$RootPath)

  if (-not (Test-Path -LiteralPath $RootPath -PathType Container)) {
    return @()
  }

  $streams = @()
  $criticalFiles = Get-ChildItem -LiteralPath $RootPath -Recurse -Force -File -ErrorAction Stop |
    Where-Object { $_.Name -match '(?i)(\.sqlite(?:-wal|-shm)?|\.db(?:-wal|-shm)?)$' }
  try {
    foreach ($file in $criticalFiles) {
      try {
        $streams += [System.IO.File]::Open(
          $file.FullName,
          [System.IO.FileMode]::Open,
          [System.IO.FileAccess]::Read,
          [System.IO.FileShare]::Read
        )
      }
      catch {
        throw "Data file is still in use: $($file.FullName)"
      }
    }
    return @($streams)
  }
  catch {
    foreach ($stream in $streams) { $stream.Dispose() }
    throw
  }
}

function Get-DirectoryFingerprint {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$ExcludeTopLevelNames = @()
  )

  $files = @()
  foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)) {
    if ($ExcludeTopLevelNames -contains $item.Name) { continue }
    if ($item.PSIsContainer) {
      $files += @(Get-ChildItem -LiteralPath $item.FullName -Recurse -Force -File -ErrorAction Stop)
    }
    else {
      $files += $item
    }
  }
  $totalBytes = [Int64]0
  foreach ($file in $files) {
    $totalBytes += $file.Length
  }
  return [PSCustomObject]@{
    FileCount = $files.Count
    TotalBytes = $totalBytes
  }
}

function Test-DirectoryContainsData {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$ExcludeTopLevelNames = @()
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Container)) {
    return $false
  }
  foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop)) {
    if ($ExcludeTopLevelNames -contains $item.Name) { continue }
    if (-not $item.PSIsContainer) { return $true }
    if ($null -ne (Get-ChildItem -LiteralPath $item.FullName -Recurse -Force -File -ErrorAction Stop |
        Select-Object -First 1)) {
      return $true
    }
  }
  return $false
}

function Copy-DirectoryContents {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string[]]$ExcludeTopLevelNames = @()
  )

  New-Item -ItemType Directory -Path $Destination -Force | Out-Null
  foreach ($item in @(Get-ChildItem -LiteralPath $Source -Force -ErrorAction Stop)) {
    if ($ExcludeTopLevelNames -contains $item.Name) { continue }
    Copy-Item -LiteralPath $item.FullName -Destination $Destination -Recurse -Force -ErrorAction Stop
  }
}

function Replace-TextOrdinalIgnoreCase {
  param(
    [Parameter(Mandatory = $true)][string]$Text,
    [Parameter(Mandatory = $true)][string]$Search,
    [Parameter(Mandatory = $true)][string]$Replacement
  )

  if (-not $Search) { return $Text }
  $builder = New-Object System.Text.StringBuilder
  $offset = 0
  while ($true) {
    $index = $Text.IndexOf($Search, $offset, [System.StringComparison]::OrdinalIgnoreCase)
    if ($index -lt 0) { break }
    [void]$builder.Append($Text.Substring($offset, $index - $offset))
    [void]$builder.Append($Replacement)
    $offset = $index + $Search.Length
  }
  [void]$builder.Append($Text.Substring($offset))
  return $builder.ToString()
}

function Update-StagedRuntimeConfigDefaults {
  param(
    [Parameter(Mandatory = $true)][string]$StagingPath,
    [Parameter(Mandatory = $true)][string]$SourceRuntimeHomePath,
    [Parameter(Mandatory = $true)][string]$TargetRuntimeHomePath
  )

  $configPath = Join-Path $StagingPath "config.yaml"
  if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) { return $false }

  $sourceWorkspacePath = Join-Path $SourceRuntimeHomePath "workspace"
  $targetWorkspacePath = Join-Path $TargetRuntimeHomePath "workspace"
  $sourceMemoryDatabasePath = Join-Path $SourceRuntimeHomePath "memory-service\memory.sqlite"
  $targetMemoryDatabasePath = Join-Path $TargetRuntimeHomePath "memory-service\memory.sqlite"
  $original = [System.IO.File]::ReadAllText($configPath, [System.Text.Encoding]::UTF8)
  $updated = $original
  foreach ($replacement in @(
      @($sourceWorkspacePath, $targetWorkspacePath),
      @($sourceWorkspacePath.Replace('\', '/'), $targetWorkspacePath.Replace('\', '/')),
      @($sourceWorkspacePath.Replace('\', '\\'), $targetWorkspacePath.Replace('\', '\\')),
      @($sourceMemoryDatabasePath, $targetMemoryDatabasePath),
      @($sourceMemoryDatabasePath.Replace('\', '/'), $targetMemoryDatabasePath.Replace('\', '/')),
      @($sourceMemoryDatabasePath.Replace('\', '\\'), $targetMemoryDatabasePath.Replace('\', '\\'))
    )) {
    $updated = Replace-TextOrdinalIgnoreCase `
      -Text $updated `
      -Search ([string]$replacement[0]) `
      -Replacement ([string]$replacement[1])
  }
  if ([string]::Equals($original, $updated, [System.StringComparison]::Ordinal)) { return $false }

  $temporaryPath = "$configPath.rebase-$([Guid]::NewGuid().ToString('N')).tmp"
  try {
    [System.IO.File]::WriteAllText(
      $temporaryPath,
      $updated,
      (New-Object System.Text.UTF8Encoding($false))
    )
    Move-Item -LiteralPath $temporaryPath -Destination $configPath -Force -ErrorAction Stop
  }
  finally {
    if (Test-Path -LiteralPath $temporaryPath) {
      Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
    }
  }
  return $true
}

function Update-StagedStandaloneSessionBindings {
  param(
    [Parameter(Mandatory = $true)][string]$StagingPath,
    [Parameter(Mandatory = $true)][string]$SourceRuntimeHomePath,
    [Parameter(Mandatory = $true)][string]$TargetRuntimeHomePath
  )

  $sessionsPath = Join-Path $StagingPath "workspace\sessions"
  if (-not (Test-Path -LiteralPath $sessionsPath -PathType Container)) { return 0 }
  $sourceWorkspacePath = Join-Path $SourceRuntimeHomePath "workspace"
  $targetWorkspacePath = Join-Path $TargetRuntimeHomePath "workspace"
  $updatedCount = 0
  $utf8 = New-Object System.Text.UTF8Encoding($false)

  foreach ($sessionFile in @(Get-ChildItem -LiteralPath $sessionsPath -Filter "*.jsonl" -File -Recurse -ErrorAction Stop)) {
    $bytes = [System.IO.File]::ReadAllBytes($sessionFile.FullName)
    if ($bytes.Length -eq 0) { continue }
    $newlineIndex = -1
    for ($index = 0; $index -lt $bytes.Length; $index++) {
      if ($bytes[$index] -eq 0x0a) {
        $newlineIndex = $index
        break
      }
    }
    $firstLineLength = if ($newlineIndex -ge 0) { $newlineIndex } else { $bytes.Length }
    if ($firstLineLength -gt 0 -and $bytes[$firstLineLength - 1] -eq 0x0d) {
      $firstLineLength--
    }
    $firstLine = [System.Text.Encoding]::UTF8.GetString($bytes, 0, $firstLineLength).TrimStart([char]0xfeff)
    try {
      $record = $firstLine | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
      # Older runtime builds can leave plain-text or otherwise non-session JSONL
      # files in this directory. They are user data, so preserve them verbatim.
      continue
    }
    $metadataProperty = $record.PSObject.Properties["metadata"]
    $keyProperty = $record.PSObject.Properties["key"]
    if ($null -eq $metadataProperty -or $null -eq $metadataProperty.Value -or
        $null -eq $keyProperty -or -not ([string]$keyProperty.Value).StartsWith("websocket:", [System.StringComparison]::Ordinal)) {
      continue
    }
    $metadata = $metadataProperty.Value
    $webuiProperty = $metadata.PSObject.Properties["webui"]
    $projectProperty = $metadata.PSObject.Properties["webuiProjectId"]
    $workspaceProperty = $metadata.PSObject.Properties["webuiWorkspaceCwd"]
    if ($null -eq $webuiProperty -or $webuiProperty.Value -ne $true -or
        $null -eq $projectProperty -or $null -ne $projectProperty.Value -or
        $null -eq $workspaceProperty -or -not ($workspaceProperty.Value -is [string]) -or
        -not (Test-SamePath -Left ([string]$workspaceProperty.Value) -Right $sourceWorkspacePath)) {
      continue
    }

    $workspaceProperty.Value = $targetWorkspacePath
    $updatedFirstLineBytes = $utf8.GetBytes(($record | ConvertTo-Json -Compress -Depth 100))
    $suffixOffset = if ($newlineIndex -ge 0) { $firstLineLength } else { $bytes.Length }
    $updatedBytes = New-Object byte[] ($updatedFirstLineBytes.Length + $bytes.Length - $suffixOffset)
    [System.Buffer]::BlockCopy($updatedFirstLineBytes, 0, $updatedBytes, 0, $updatedFirstLineBytes.Length)
    if ($suffixOffset -lt $bytes.Length) {
      [System.Buffer]::BlockCopy(
        $bytes,
        $suffixOffset,
        $updatedBytes,
        $updatedFirstLineBytes.Length,
        $bytes.Length - $suffixOffset
      )
    }
    $temporaryPath = "$($sessionFile.FullName).rebase-$([Guid]::NewGuid().ToString('N')).tmp"
    try {
      [System.IO.File]::WriteAllBytes($temporaryPath, $updatedBytes)
      Move-Item -LiteralPath $temporaryPath -Destination $sessionFile.FullName -Force -ErrorAction Stop
    }
    finally {
      if (Test-Path -LiteralPath $temporaryPath) {
        Remove-Item -LiteralPath $temporaryPath -Force -ErrorAction SilentlyContinue
      }
    }
    $updatedCount++
  }
  return $updatedCount
}

function Update-StagedRuntimePaths {
  param(
    [Parameter(Mandatory = $true)][string]$StagingPath,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$SourceRuntimeHomePaths,
    [Parameter(Mandatory = $true)][string]$TargetRuntimeHomePath
  )

  $configUpdated = $false
  $sessionCount = 0
  $processedSourcePaths = @()
  foreach ($sourceRuntimeHomePath in @($SourceRuntimeHomePaths | Where-Object { $_ })) {
    if (Test-SamePath -Left $sourceRuntimeHomePath -Right $TargetRuntimeHomePath) { continue }
    if (@($processedSourcePaths | Where-Object { Test-SamePath -Left $_ -Right $sourceRuntimeHomePath }).Count -gt 0) {
      continue
    }
    $processedSourcePaths += $sourceRuntimeHomePath
    if (Update-StagedRuntimeConfigDefaults `
        -StagingPath $StagingPath `
        -SourceRuntimeHomePath $sourceRuntimeHomePath `
        -TargetRuntimeHomePath $TargetRuntimeHomePath) {
      $configUpdated = $true
    }
    $sessionCount += Update-StagedStandaloneSessionBindings `
      -StagingPath $StagingPath `
      -SourceRuntimeHomePath $sourceRuntimeHomePath `
      -TargetRuntimeHomePath $TargetRuntimeHomePath
  }
  Write-MigrationLog -Message "Rebased staged runtime defaults config=$configUpdated standaloneSessions=$sessionCount sources=$($processedSourcePaths -join ';') target=$TargetRuntimeHomePath"
}

function Invoke-TransactionalDirectoryCopy {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [string[]]$ExcludeTopLevelNames = @(),
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$PreviouslyPreparedCopies,
    [Parameter(Mandatory = $true)][bool]$PreviousPointerExisted,
    [AllowNull()][string]$PreviousPointerBytesBase64,
    [AllowEmptyCollection()][object[]]$DeferredCleanupStates = @(),
    [string[]]$RuntimeSourceHomePaths = @(),
    [string]$RuntimeTargetHomePath = ""
  )

  if (Test-SamePath -Left $Source -Right $Destination) {
    Write-MigrationLog -Message "Source already equals target: $Destination"
    return $null
  }

  $criticalFileStreams = @(Open-CriticalFilesForMigration -RootPath $Source)
  $destinationParent = Split-Path -Parent $Destination
  if (-not (Test-Path -LiteralPath $destinationParent -PathType Container)) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
  }

  $token = [Guid]::NewGuid().ToString("N")
  $stagingPath = "$Destination.migrating-$token"
  $backupPath = $null
  $journalUpdated = $false
  try {
    Copy-DirectoryContents -Source $Source -Destination $stagingPath -ExcludeTopLevelNames $ExcludeTopLevelNames
    $sourceFingerprint = Get-DirectoryFingerprint -Path $Source -ExcludeTopLevelNames $ExcludeTopLevelNames
    $stagingFingerprint = Get-DirectoryFingerprint -Path $stagingPath
    if ($sourceFingerprint.FileCount -ne $stagingFingerprint.FileCount -or
        $sourceFingerprint.TotalBytes -ne $stagingFingerprint.TotalBytes) {
      throw "Copied data verification failed for $Source"
    }
    if ($RuntimeSourceHomePaths.Count -gt 0 -and $RuntimeTargetHomePath) {
      Update-StagedRuntimePaths `
        -StagingPath $stagingPath `
        -SourceRuntimeHomePaths $RuntimeSourceHomePaths `
        -TargetRuntimeHomePath $RuntimeTargetHomePath
    }

    $destinationExisted = Test-Path -LiteralPath $Destination
    $backupPath = if ($destinationExisted) { "$Destination.migration-backup-$token" } else { $null }
    $copyRecord = [PSCustomObject]@{
      SourcePath = $Source
      DestinationPath = $Destination
      BackupPath = $backupPath
      StagingPath = $stagingPath
    }
    # Write-ahead: startup can safely roll back whether termination occurs before the
    # destination move, between the two moves, or after the replacement.
    Write-PreparedRollbackJournal `
      -Copies @($PreviouslyPreparedCopies + $copyRecord) `
      -PreviousPointerExisted $PreviousPointerExisted `
      -PreviousPointerBytesBase64 $PreviousPointerBytesBase64 `
      -DeferredCleanupStates $DeferredCleanupStates
    $journalUpdated = $true

    if ($destinationExisted) {
      Move-Item -LiteralPath $Destination -Destination $backupPath -Force -ErrorAction Stop
    }
    Move-Item -LiteralPath $stagingPath -Destination $Destination -Force -ErrorAction Stop
    Write-MigrationLog -Message "Prepared data copy: $Source -> $Destination"
    return $copyRecord
  }
  catch {
    $copyFailure = $_
    try {
      if (Test-Path -LiteralPath $stagingPath) {
        Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction Stop
      }
      if ($backupPath -and (Test-Path -LiteralPath $backupPath)) {
        if (Test-Path -LiteralPath $Destination) {
          Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction Stop
        }
        Move-Item -LiteralPath $backupPath -Destination $Destination -Force -ErrorAction Stop
      }
      if ($journalUpdated) {
        if ($PreviouslyPreparedCopies.Count -gt 0) {
          Write-PreparedRollbackJournal `
            -Copies $PreviouslyPreparedCopies `
            -PreviousPointerExisted $PreviousPointerExisted `
            -PreviousPointerBytesBase64 $PreviousPointerBytesBase64 `
            -DeferredCleanupStates $DeferredCleanupStates
        }
        elseif (Test-Path -LiteralPath $StatePath -PathType Leaf) {
          Remove-Item -LiteralPath $StatePath -Force -ErrorAction Stop
        }
      }
    }
    catch {
      throw "Transactional copy failed and its original target could not be restored. Original data remains at '$backupPath'. Copy error: $($copyFailure.Exception.Message). Restore error: $($_.Exception.Message)"
    }
    throw $copyFailure
  }
  finally {
    foreach ($stream in $criticalFileStreams) {
      $stream.Dispose()
    }
  }
}

function Write-UnicodeFileAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$Value
  )

  Ensure-ParentDirectory -Path $Path
  $temporaryPath = "$Path.tmp-$([Guid]::NewGuid().ToString('N'))"
  $preamble = [System.Text.Encoding]::Unicode.GetPreamble()
  $contents = [System.Text.Encoding]::Unicode.GetBytes($Value)
  $bytes = New-Object byte[] ($preamble.Length + $contents.Length)
  [Array]::Copy($preamble, 0, $bytes, 0, $preamble.Length)
  [Array]::Copy($contents, 0, $bytes, $preamble.Length, $contents.Length)
  [System.IO.File]::WriteAllBytes($temporaryPath, $bytes)
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Write-JsonFileAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][object]$Value
  )

  Ensure-ParentDirectory -Path $Path
  $temporaryPath = "$Path.tmp-$([Guid]::NewGuid().ToString('N'))"
  $json = $Value | ConvertTo-Json -Depth 8
  [System.IO.File]::WriteAllText(
    $temporaryPath,
    $json,
    (New-Object System.Text.UTF8Encoding($false))
  )
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Write-BytesFileAtomically {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][byte[]]$Value
  )

  Ensure-ParentDirectory -Path $Path
  $temporaryPath = "$Path.tmp-$([Guid]::NewGuid().ToString('N'))"
  [System.IO.File]::WriteAllBytes($temporaryPath, $Value)
  Move-Item -LiteralPath $temporaryPath -Destination $Path -Force
}

function Write-PreparedRollbackJournal {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Copies,
    [Parameter(Mandatory = $true)][bool]$PreviousPointerExisted,
    [AllowNull()][string]$PreviousPointerBytesBase64,
    [AllowEmptyCollection()][object[]]$DeferredCleanupStates = @()
  )

  $backupPaths = @($Copies | ForEach-Object { $_.BackupPath } | Where-Object { $_ })
  Write-JsonFileAtomically -Path $StatePath -Value ([ordered]@{
    schemaVersion = 2
    phase = "recovery-required"
    owner = $Owner
    sourceAuthority = $effectiveSourceAuthority
    sourceGeneration = (Resolve-SourceGeneration)
    sourceAppVersion = $effectiveSourceInstalledVersion
    sourceInstallDir = if ($effectiveSourceInstallDir) { Get-NormalizedPath -Path $effectiveSourceInstallDir } else { $null }
    sourceDataPath = (Get-NormalizedPath -Path $effectiveSourceDataPath)
    targetUserDataPath = (Get-NormalizedPath -Path $TargetUserDataPath)
    targetRuntimeHomePath = (Get-NormalizedPath -Path $TargetRuntimeHomePath)
    pointerPath = (Get-NormalizedPath -Path $PointerPath)
    backupPaths = @($backupPaths)
    preparedCopies = @($Copies)
    previousPointerExisted = $PreviousPointerExisted
    previousPointerBytesBase64 = $PreviousPointerBytesBase64
    deferredCleanupStates = @($DeferredCleanupStates)
    journalOnly = $true
    createdAt = [DateTime]::UtcNow.ToString("o")
  })
}

function Restore-PreparedCopy {
  param([Parameter(Mandatory = $true)]$Copy)

  $destinationPath = [string]$Copy.DestinationPath
  $backupPath = if ($Copy.BackupPath) { [string]$Copy.BackupPath } else { $null }
  $stagingPath = if ($Copy.PSObject.Properties["StagingPath"] -and $Copy.StagingPath) { [string]$Copy.StagingPath } else { $null }
  if ($stagingPath -and (Test-Path -LiteralPath $stagingPath)) {
    Remove-Item -LiteralPath $stagingPath -Recurse -Force -ErrorAction Stop
  }
  if ($backupPath) {
    if (Test-Path -LiteralPath $backupPath) {
      if (Test-Path -LiteralPath $destinationPath) {
        Remove-Item -LiteralPath $destinationPath -Recurse -Force -ErrorAction Stop
      }
      Move-Item -LiteralPath $backupPath -Destination $destinationPath -Force -ErrorAction Stop
    }
    elseif (-not (Test-Path -LiteralPath $destinationPath)) {
      throw "Prepared migration backup and destination are both missing: $backupPath"
    }
    return
  }

  if (Test-Path -LiteralPath $destinationPath) {
    Remove-Item -LiteralPath $destinationPath -Recurse -Force -ErrorAction Stop
  }
}

function Undo-PreparedCopies {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][object[]]$Copies)

  $copiesInReverse = @($Copies)
  [Array]::Reverse($copiesInReverse)
  foreach ($copy in $copiesInReverse) {
    if ($null -eq $copy) {
      continue
    }
    Restore-PreparedCopy -Copy $copy
  }
}

function Rollback-PreparedMigration {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
    throw "Migration state is missing: $StatePath"
  }

  $state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@("prepared", "recovery-required", "prepared-for-retry", "awaiting-app-verification", "app-verified") -notcontains [string]$state.phase) {
    throw "Migration phase cannot be rolled back: $($state.phase)"
  }
  if (-not (Test-SamePath -Left $state.targetUserDataPath -Right $TargetUserDataPath) -or
      -not (Test-SamePath -Left $state.targetRuntimeHomePath -Right $TargetRuntimeHomePath)) {
    throw "Migration state target does not match the requested target."
  }

  $copies = @()
  $preparedCopiesProperty = $state.PSObject.Properties["preparedCopies"]
  if ($null -ne $preparedCopiesProperty) {
    $copies = @($preparedCopiesProperty.Value)
  }
  else {
    foreach ($backupPath in @($state.backupPaths)) {
      if (-not $backupPath) { continue }
      foreach ($targetPath in @($state.targetUserDataPath, $state.targetRuntimeHomePath)) {
        $prefix = "$(Get-NormalizedPath -Path ([string]$targetPath)).migration-backup-"
        $normalizedBackupPath = Get-NormalizedPath -Path ([string]$backupPath)
        if ($normalizedBackupPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
          $copies += [PSCustomObject]@{
            DestinationPath = Get-NormalizedPath -Path ([string]$targetPath)
            BackupPath = $normalizedBackupPath
          }
          break
        }
      }
    }
  }

  $validatedCopies = @()
  $validatedDestinationKeys = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($copy in $copies) {
    if ($null -eq $copy -or -not $copy.DestinationPath) { continue }
    $destinationPath = Get-NormalizedPath -Path ([string]$copy.DestinationPath)
    if (-not (Test-SamePath -Left $destinationPath -Right $TargetUserDataPath) -and
        -not (Test-SamePath -Left $destinationPath -Right $TargetRuntimeHomePath)) {
      throw "Prepared copy destination is outside the requested migration targets: $destinationPath"
    }
    if (-not $validatedDestinationKeys.Add($destinationPath)) {
      throw "Prepared migration state contains a duplicate destination: $destinationPath"
    }
    $backupPath = if ($copy.BackupPath) { Get-NormalizedPath -Path ([string]$copy.BackupPath) } else { $null }
    if ($backupPath) {
      $prefix = "$destinationPath.migration-backup-"
      if (-not $backupPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) -or
          $backupPath.Substring($prefix.Length) -notmatch '^[a-f0-9]{32}$') {
        throw "Prepared copy backup is outside the validated migration backup path: $backupPath"
      }
    }
    $stagingPath = if ($copy.PSObject.Properties["StagingPath"] -and $copy.StagingPath) {
      Get-NormalizedPath -Path ([string]$copy.StagingPath)
    } else {
      $null
    }
    if ($stagingPath) {
      $stagingPrefix = "$destinationPath.migrating-"
      if (-not $stagingPath.StartsWith($stagingPrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
          $stagingPath.Substring($stagingPrefix.Length) -notmatch '^[a-f0-9]{32}$') {
        throw "Prepared copy staging path is outside the validated migration staging path: $stagingPath"
      }
    }
    $validatedCopies += [PSCustomObject]@{
      DestinationPath = $destinationPath
      BackupPath = $backupPath
      StagingPath = $stagingPath
    }
  }

  $copiesInReverse = @($validatedCopies)
  [Array]::Reverse($copiesInReverse)
  foreach ($copy in $copiesInReverse) {
    Restore-PreparedCopy -Copy $copy
  }

  $pointerExistedProperty = $state.PSObject.Properties["previousPointerExisted"]
  if ($null -ne $pointerExistedProperty) {
    if ([bool]$pointerExistedProperty.Value) {
      $pointerBytesProperty = $state.PSObject.Properties["previousPointerBytesBase64"]
      if ($null -eq $pointerBytesProperty) {
        throw "Previous data-root pointer contents are unavailable."
      }
      $pointerBytes = [Convert]::FromBase64String([string]$pointerBytesProperty.Value)
      Write-BytesFileAtomically -Path $PointerPath -Value $pointerBytes
    }
    elseif (Test-Path -LiteralPath $PointerPath) {
      Remove-Item -LiteralPath $PointerPath -Force -ErrorAction Stop
    }
  }

  Remove-Item -LiteralPath $StatePath -Force -ErrorAction Stop
  Write-MigrationLog -Message "Prepared migration rolled back."
}

function Resume-PreservedMigrationForRetry {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
    return $false
  }

  $state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if (@("prepared-for-retry", "app-verified") -notcontains [string]$state.phase) {
    return $false
  }
  $statePointerPath = if ($state.PSObject.Properties.Name -contains "pointerPath") { [string]$state.pointerPath } else { $PointerPath }
  if (-not (Test-SamePath -Left $state.targetUserDataPath -Right $TargetUserDataPath) -or
      -not (Test-SamePath -Left $state.targetRuntimeHomePath -Right $TargetRuntimeHomePath) -or
      -not (Test-SamePath -Left $statePointerPath -Right $PointerPath)) {
    return $false
  }

  $currentTrustedDataPath = Resolve-TrustedInstallDataPath
  if ($currentTrustedDataPath -and (
      (Test-CompleteInstallUserData -Path (Join-Path $currentTrustedDataPath "Memmy")) -or
      (Test-CompleteInstallRuntimeData -Path (Join-Path $currentTrustedDataPath ".memmy"))
    )) {
    Write-MigrationLog -Message "A current trusted install source supersedes the preserved migration state; rolling the preserved target back before preparing it."
    Rollback-PreparedMigration
    return $false
  }

  $statePreparedCopies = if ($state.PSObject.Properties.Name -contains "preparedCopies") { @($state.preparedCopies) } else { @() }
  foreach ($copy in $statePreparedCopies) {
    if ($null -ne $copy -and $copy.DestinationPath -and
        -not (Test-Path -LiteralPath ([string]$copy.DestinationPath))) {
      throw "Preserved migration destination is missing: $($copy.DestinationPath)"
    }
  }
  $stateAccountAuthority = if ($state.PSObject.Properties.Name -contains "accountSourceAuthority") { [string]$state.accountSourceAuthority } else { "target-existing" }
  $stateRuntimeAuthority = if ($state.PSObject.Properties.Name -contains "runtimeSourceAuthority") { [string]$state.runtimeSourceAuthority } else { "target-existing" }
  if ($stateAccountAuthority -and
      @("target-existing", "current-install-authority", "selected-install-authority", "relay-backup-authority", "persisted-install-authority") -notcontains $stateAccountAuthority) {
    throw "Preserved migration account authority is invalid."
  }
  if ($stateRuntimeAuthority -and
      @("target-existing", "legacy-home-fallback", "current-install-authority", "selected-install-authority", "relay-backup-authority", "persisted-install-authority") -notcontains $stateRuntimeAuthority) {
    throw "Preserved migration runtime authority is invalid."
  }
  if ($stateAccountAuthority -ne "target-existing" -and
      -not (Test-CompleteInstallUserData -Path $TargetUserDataPath)) {
    throw "Preserved migrated account destination is incomplete."
  }
  if ($stateRuntimeAuthority -ne "target-existing" -and
      -not (Test-CompleteInstallRuntimeData -Path $TargetRuntimeHomePath)) {
    throw "Preserved migrated runtime destination is incomplete."
  }

  Write-UnicodeFileAtomically -Path $PointerPath -Value "$TargetRuntimeHomePath`r`n"
  Write-MigrationLog -Message "Reusing preserved migration data without deleting its rollback artifacts."
  return $true
}

function Recover-PreparedMigration {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
    throw "Migration state is missing: $StatePath"
  }

  $state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  $phase = [string]$state.phase
  if (@("prepared-for-retry", "awaiting-app-verification", "app-verified") -contains $phase) {
    Write-MigrationLog -Message "Migration recovery is already safe in phase $phase."
    return
  }
  if (@("prepared", "recovery-required") -notcontains $phase) {
    throw "Only a prepared migration can be recovered."
  }
  if (-not (Test-SamePath -Left $state.sourceDataPath -Right $SourceDataPath) -or
      -not (Test-SamePath -Left $state.targetUserDataPath -Right $TargetUserDataPath) -or
      -not (Test-SamePath -Left $state.targetRuntimeHomePath -Right $TargetRuntimeHomePath) -or
      -not (Test-SamePath -Left $state.pointerPath -Right $PointerPath)) {
    throw "Migration recovery paths do not match the prepared state."
  }

  $preparedCopies = @($state.preparedCopies | Where-Object { $null -ne $_ })
  if ($preparedCopies.Count -eq 0) {
    Rollback-PreparedMigration
    return
  }

  $missingPreparedSource = $false
  foreach ($copy in $preparedCopies) {
    $sourcePaths = @()
    if ($copy.PSObject.Properties["SourcePaths"]) {
      $sourcePaths = @($copy.SourcePaths | Where-Object { $_ })
    }
    elseif ($copy.SourcePath) {
      $sourcePaths = @([string]$copy.SourcePath)
    }
    if ($sourcePaths.Count -eq 0) {
      $missingPreparedSource = $true
      break
    }
    foreach ($preparedSourcePath in $sourcePaths) {
      if (-not (Test-DirectoryContainsData -Path ([string]$preparedSourcePath) -ExcludeTopLevelNames @("updates"))) {
        $missingPreparedSource = $true
        break
      }
    }
    if ($missingPreparedSource) { break }
  }

  if (-not $missingPreparedSource) {
    Rollback-PreparedMigration
    return
  }

  $state.phase = "prepared-for-retry"
  $state | Add-Member -NotePropertyName recoveredAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
  Write-JsonFileAtomically -Path $StatePath -Value $state
  Write-MigrationLog -Message "Old source is unavailable; preserved prepared data for an installation retry."
}

function Read-VerifiedPreviousMigrationForCarryForward {
  if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
    return $null
  }

  $previousState = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ([string]$previousState.phase -ne "app-verified") {
    throw "A previous data migration still requires app verification. Open Memmy successfully before installing again."
  }
  if (-not $previousState.targetUserDataPath -or
      -not $previousState.targetRuntimeHomePath -or
      -not (Test-SamePath -Left ([string]$previousState.targetUserDataPath) -Right $TargetUserDataPath)) {
    throw "Verified migration cleanup targets do not match the current trusted data layout. Open the existing Memmy again before changing its installation drive."
  }

  $rememberedRuntimeHomePath = Read-DataRootPointer -Path $PointerPath
  $previousRuntimeTargetIsTrusted =
    (Test-SamePath -Left ([string]$previousState.targetRuntimeHomePath) -Right $TargetRuntimeHomePath) -or
    ($rememberedRuntimeHomePath -and
      (Test-SamePath -Left ([string]$previousState.targetRuntimeHomePath) -Right $rememberedRuntimeHomePath))
  if (-not $previousRuntimeTargetIsTrusted) {
    throw "Verified migration cleanup targets do not match the current trusted data layout. Open the existing Memmy again before changing its installation drive."
  }

  Write-MigrationLog -Message "Carrying the previously verified migration rollback artifacts into the next migration transaction."
  return $previousState
}

try {
  if ($AcquireLock) {
    Ensure-ParentDirectory -Path $LockPath
    New-Item -ItemType Directory -Path $LockPath -ErrorAction Stop | Out-Null
    $lockAcquiredHere = $true
    if ($Owner -eq "installer") {
      if ($InstallerPid -le 0 -or
          -not $InstallerPath -or -not [System.IO.Path]::IsPathRooted($InstallerPath) -or
          -not $InstallerInstallDir -or -not [System.IO.Path]::IsPathRooted($InstallerInstallDir)) {
        throw "Direct installer identity is required before migration can acquire the update lock."
      }
      Write-JsonFileAtomically -Path (Join-Path $LockPath "state.json") -Value ([ordered]@{
        schemaVersion = 3
        owner = "installer"
        phase = "direct-migration-running"
        installerPid = $InstallerPid
        installerPath = (Get-NormalizedPath -Path $InstallerPath)
        installDir = (Get-NormalizedPath -Path $InstallerInstallDir)
        targetUserDataPath = (Get-NormalizedPath -Path $TargetUserDataPath)
        targetRuntimeHomePath = (Get-NormalizedPath -Path $TargetRuntimeHomePath)
        createdAt = [DateTime]::UtcNow.ToString("o")
      })
    }
  }
  if (-not (Test-Path -LiteralPath $LockPath -PathType Container)) {
    throw "Unified update lock is not held: $LockPath"
  }

  if ($Mode -eq "Prepare") {
    Resolve-EffectiveInstallSource
    if (Resume-PreservedMigrationForRetry) {
      Write-MigrationLog -Message "Migration preparation resumed."
    }
    else {
      $preparedCopies = @()
      $preparedStateWritten = $false
      $previousPointerExisted = $false
      $previousPointerBytesBase64 = $null
      [object[]]$deferredCleanupStates = @()
      try {
        $previousVerifiedState = Read-VerifiedPreviousMigrationForCarryForward
        $previousPointerExisted = Test-Path -LiteralPath $PointerPath -PathType Leaf
        $previousPointerBytesBase64 = if ($previousPointerExisted) {
          [Convert]::ToBase64String([System.IO.File]::ReadAllBytes($PointerPath))
        } else {
          $null
        }
        $deferredCleanupStates = if ($null -ne $previousVerifiedState) {
          ,$previousVerifiedState
        } else {
          @()
        }
        $rememberedRuntimeHomePath = Read-DataRootPointer -Path $PointerPath
        $trustedInstallDataPath = Resolve-TrustedInstallDataPath
        $resolvedSourceGeneration = Resolve-SourceGeneration
        Record-TrustedInstallLocalGeneration
        $installUserDataPath = if ($trustedInstallDataPath) {
          Join-Path $trustedInstallDataPath "Memmy"
        } else {
          $null
        }
        $installRuntimeHomePath = if ($trustedInstallDataPath) {
          Join-Path $trustedInstallDataPath ".memmy"
        } else {
          $null
        }
        $userDataExcludedNames = @(
          "updates",
          "data-root.txt",
          "prepared-required-update.json",
          "prepared-required-update.json.lock",
          "prepared-required-update.json.prompt",
          "prepared-required-update.json.attempt"
        )

        $targetUserDataHadData = Test-DirectoryContainsData `
          -Path $TargetUserDataPath `
          -ExcludeTopLevelNames $userDataExcludedNames
        $accountSourcePath = if ($installUserDataPath -and
            (Test-CompleteInstallUserData -Path $installUserDataPath)) {
          Get-NormalizedPath -Path $installUserDataPath
        } else {
          $null
        }
        $accountSourceAuthority = if ($accountSourcePath) { $effectiveSourceAuthority } else { "target-existing" }
        if ($accountSourcePath) {
          $copy = Invoke-TransactionalDirectoryCopy `
            -Source $accountSourcePath `
            -Destination $TargetUserDataPath `
            -ExcludeTopLevelNames $userDataExcludedNames `
            -PreviouslyPreparedCopies $preparedCopies `
            -PreviousPointerExisted $previousPointerExisted `
            -PreviousPointerBytesBase64 $previousPointerBytesBase64 `
            -DeferredCleanupStates $deferredCleanupStates
          if ($null -ne $copy) {
            $preparedCopies += $copy
            $preparedStateWritten = $true
          }
          Write-MigrationLog -Message "Trusted install account data selected over target: $accountSourcePath"
        }
        elseif ($targetUserDataHadData) {
          Write-MigrationLog -Message "No higher-authority account source exists; target user data retained."
        }
        elseif (-not (Test-Path -LiteralPath $TargetUserDataPath -PathType Container)) {
          New-Item -ItemType Directory -Path $TargetUserDataPath -Force | Out-Null
        }

        $targetRuntimeHadData = Test-DirectoryContainsData `
          -Path $TargetRuntimeHomePath `
          -ExcludeTopLevelNames @("updates")
        $runtimeSourcePath = if ($installRuntimeHomePath -and
            (Test-CompleteInstallRuntimeData -Path $installRuntimeHomePath)) {
          Get-NormalizedPath -Path $installRuntimeHomePath
        } else {
          $null
        }
        $runtimeSourceAuthority = if ($runtimeSourcePath) { $effectiveSourceAuthority } else { "target-existing" }
        if (-not $runtimeSourcePath -and -not $targetRuntimeHadData) {
          foreach ($candidate in @($rememberedRuntimeHomePath, $LegacyRuntimeHomePath)) {
            if ($candidate -and
                -not (Test-SamePath -Left $candidate -Right $TargetRuntimeHomePath) -and
                (Test-DirectoryContainsData -Path $candidate -ExcludeTopLevelNames @("updates"))) {
              $runtimeSourcePath = Get-NormalizedPath -Path $candidate
              $runtimeSourceAuthority = "legacy-home-fallback"
              break
            }
          }
        }

        if ($runtimeSourcePath) {
          $runtimeRebaseSourceHomePaths = @($runtimeSourcePath)
          if ($installRuntimeHomePath -and (Test-SamePath -Left $runtimeSourcePath -Right $installRuntimeHomePath)) {
            $runtimeRebaseSourceHomePaths += Join-Path $effectiveSourceInstallDir "data\.memmy"
          }
          if ($LegacyRuntimeHomePath) {
            $runtimeRebaseSourceHomePaths += $LegacyRuntimeHomePath
          }
          if ($rememberedRuntimeHomePath) {
            $runtimeRebaseSourceHomePaths += $rememberedRuntimeHomePath
          }
          $copy = Invoke-TransactionalDirectoryCopy `
            -Source $runtimeSourcePath `
            -Destination $TargetRuntimeHomePath `
            -ExcludeTopLevelNames @("updates") `
            -PreviouslyPreparedCopies $preparedCopies `
            -PreviousPointerExisted $previousPointerExisted `
            -PreviousPointerBytesBase64 $previousPointerBytesBase64 `
            -DeferredCleanupStates $deferredCleanupStates `
            -RuntimeSourceHomePaths $runtimeRebaseSourceHomePaths `
            -RuntimeTargetHomePath $TargetRuntimeHomePath
          if ($null -ne $copy) {
            $preparedCopies += $copy
            $preparedStateWritten = $true
          }
          Write-MigrationLog -Message "Runtime data selected authority=$runtimeSourceAuthority source=$runtimeSourcePath"
        }
        elseif ($targetRuntimeHadData) {
          Write-MigrationLog -Message "No higher-authority runtime source exists; target runtime data retained: $TargetRuntimeHomePath"
        }
        elseif (-not (Test-Path -LiteralPath $TargetRuntimeHomePath -PathType Container)) {
          New-Item -ItemType Directory -Path $TargetRuntimeHomePath -Force | Out-Null
        }

        $runtimeSourcePaths = if ($runtimeSourcePath) { @($runtimeSourcePath) } else { @() }
        $backupPaths = @($preparedCopies | ForEach-Object { $_.BackupPath } | Where-Object { $_ })
        $state = [ordered]@{
          schemaVersion = 2
          phase = "prepared"
          owner = $Owner
          sourceAuthority = $effectiveSourceAuthority
          sourceGeneration = $resolvedSourceGeneration
          sourceAppVersion = $effectiveSourceInstalledVersion
          sourceInstallDir = if ($effectiveSourceInstallDir) { Get-NormalizedPath -Path $effectiveSourceInstallDir } else { $null }
          sourceDataPath = (Get-NormalizedPath -Path $effectiveSourceDataPath)
          accountSourcePath = $accountSourcePath
          accountSourceAuthority = $accountSourceAuthority
          runtimeSourcePath = $runtimeSourcePath
          runtimeSourcePaths = @($runtimeSourcePaths)
          runtimeSourceAuthority = $runtimeSourceAuthority
          categorySourcesShareGeneration = [bool]($accountSourcePath -and
            $runtimeSourcePath -and
            $runtimeSourceAuthority -eq $effectiveSourceAuthority)
          targetUserDataHadData = $targetUserDataHadData
          targetRuntimeHadData = $targetRuntimeHadData
          targetUserDataPath = (Get-NormalizedPath -Path $TargetUserDataPath)
          targetRuntimeHomePath = (Get-NormalizedPath -Path $TargetRuntimeHomePath)
          pointerPath = (Get-NormalizedPath -Path $PointerPath)
          backupPaths = @($backupPaths)
          preparedCopies = @($preparedCopies)
          previousPointerExisted = $previousPointerExisted
          previousPointerBytesBase64 = $previousPointerBytesBase64
          deferredCleanupStates = $deferredCleanupStates
          createdAt = [DateTime]::UtcNow.ToString("o")
        }
        Write-JsonFileAtomically -Path $StatePath -Value $state
        $preparedStateWritten = $true
        Write-UnicodeFileAtomically -Path $PointerPath -Value "$TargetRuntimeHomePath`r`n"
        Write-MigrationLog -Message "Migration preparation completed."
      }
      catch {
        $prepareFailure = $_
        if ($preparedCopies.Count -gt 0 -and -not $preparedStateWritten) {
          try {
            Write-PreparedRollbackJournal `
              -Copies $preparedCopies `
              -PreviousPointerExisted $previousPointerExisted `
              -PreviousPointerBytesBase64 $previousPointerBytesBase64 `
              -DeferredCleanupStates $deferredCleanupStates
            $preparedStateWritten = $true
          }
          catch {
            Write-MigrationLog -Message "Unable to persist the emergency rollback journal: $($_.Exception.Message)"
          }
        }
        try {
          Undo-PreparedCopies -Copies $preparedCopies
          if ($preparedStateWritten -and (Test-Path -LiteralPath $StatePath)) {
            Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
          }
        }
        catch {
          throw "Migration preparation failed and rollback requires recovery from '$StatePath'. Prepare error: $($prepareFailure.Exception.Message). Rollback error: $($_.Exception.Message)"
        }
        throw $prepareFailure
      }
    }
  }
  elseif ($Mode -eq "Complete") {
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
      throw "Migration state is missing: $StatePath"
    }
    $state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not (Test-SamePath -Left $state.targetUserDataPath -Right $TargetUserDataPath) -or
        -not (Test-SamePath -Left $state.targetRuntimeHomePath -Right $TargetRuntimeHomePath)) {
      throw "Migration state target does not match the requested target."
    }

    foreach ($markerName in @(
      "prepared-required-update.json",
      "prepared-required-update.json.lock",
      "prepared-required-update.json.prompt",
      "prepared-required-update.json.attempt"
    )) {
      $markerPath = Join-Path $TargetUserDataPath $markerName
      if (Test-Path -LiteralPath $markerPath) {
        Remove-Item -LiteralPath $markerPath -Recurse -Force -ErrorAction Stop
      }
    }
    $legacyUpdatesPath = Join-Path $TargetUserDataPath "updates"
    if (Test-Path -LiteralPath $legacyUpdatesPath) {
      Remove-Item -LiteralPath $legacyUpdatesPath -Recurse -Force -ErrorAction Stop
    }

    $state.phase = "awaiting-app-verification"
    $state | Add-Member -NotePropertyName completedAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
    Write-JsonFileAtomically -Path $StatePath -Value $state
    Write-MigrationLog -Message "Migration completion recorded; source and backups retained for app verification."
  }
  elseif ($Mode -eq "Rollback") {
    Rollback-PreparedMigration
  }
  elseif ($Mode -eq "Recover") {
    Recover-PreparedMigration
  }
  else {
    if (-not (Test-Path -LiteralPath $StatePath -PathType Leaf)) {
      throw "Migration state is missing: $StatePath"
    }
    $state = Get-Content -LiteralPath $StatePath -Raw -Encoding UTF8 | ConvertFrom-Json
    if (-not (Test-SamePath -Left $state.targetUserDataPath -Right $TargetUserDataPath) -or
        -not (Test-SamePath -Left $state.targetRuntimeHomePath -Right $TargetRuntimeHomePath)) {
      throw "Migration state target does not match the requested target."
    }
    if (@("prepared", "recovery-required") -notcontains [string]$state.phase) {
      throw "Only a prepared migration can require startup recovery."
    }
    $state.phase = "recovery-required"
    $state | Add-Member -NotePropertyName recoveryRequiredAt -NotePropertyValue ([DateTime]::UtcNow.ToString("o")) -Force
    Write-JsonFileAtomically -Path $StatePath -Value $state
    Write-MigrationLog -Message "Migration marked as requiring startup rollback."
  }
  exit 0
}
catch {
  try {
    Preserve-FailedDirectMigrationSource
  }
  catch {}
  if ($lockAcquiredHere -and (Test-Path -LiteralPath $LockPath)) {
    Remove-Item -LiteralPath $LockPath -Recurse -Force -ErrorAction SilentlyContinue
  }
  try {
    Write-MigrationLog -Message ("Migration failed: {0}" -f $_.Exception.Message)
  }
  catch {}
  Write-Error $_.Exception.Message
  exit 5
}
