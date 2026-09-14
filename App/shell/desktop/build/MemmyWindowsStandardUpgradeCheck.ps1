param(
  [Parameter(Mandatory = $true)][string]$InstallDir,
  [Parameter(Mandatory = $true)][string]$TargetInstallDir,
  [Parameter(Mandatory = $true)][string]$TargetUserDataPath,
  [Parameter(Mandatory = $true)][string]$TargetRuntimeHomePath,
  [Parameter(Mandatory = $true)][string]$InstalledExePath,
  [Parameter(Mandatory = $true)][string]$InstallerPath,
  [Parameter(Mandatory = $true)][string]$InstallationRecordPath,
  [Parameter(Mandatory = $true)][string]$MigrationStatePath,
  [switch]$AllowMissingExecutable
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedAbsolutePath([string]$Path, [string]$Description) {
  $isDriveAbsolute = $Path -match '^[A-Za-z]:[\\/]'
  $isUncAbsolute = $Path -match '^\\\\(?![?.]\\)[^\\/]+[\\/][^\\/]+'
  if (-not $Path -or (-not $isDriveAbsolute -and -not $isUncAbsolute)) {
    throw "$Description is not a fully qualified absolute path"
  }
  $normalized = [System.IO.Path]::GetFullPath($Path)
  $root = [System.IO.Path]::GetPathRoot($normalized)
  if ([string]::Equals($normalized, $root, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $root
  }
  return $normalized.TrimEnd('\')
}

function Assert-NoReparsePath([string]$Path, [string]$Description) {
  $currentPath = $Path
  while (-not (Test-Path -LiteralPath $currentPath)) {
    $parentPath = [System.IO.Path]::GetDirectoryName($currentPath)
    if (-not $parentPath -or (Test-SamePath $parentPath $currentPath)) {
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

function Test-SamePath([string]$Left, [string]$Right) {
  return [string]::Equals($Left, $Right, [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-SameOrDescendantPath([string]$Candidate, [string]$Parent) {
  if (Test-SamePath $Candidate $Parent) { return $true }
  return $Candidate.StartsWith("$($Parent.TrimEnd('\'))\", [System.StringComparison]::OrdinalIgnoreCase)
}

function Test-DirectoryContainsData([string]$Path, [string[]]$ExcludedTopLevelNames = @()) {
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

function Stop-Installation([string]$Reason) {
  throw "installation-blocked:$Reason"
}

function ConvertTo-ComparableVersion([string]$Version, [bool]$AllowMetadata) {
  if (-not $Version) { throw "installed version metadata is missing" }
  $pattern = if ($AllowMetadata) {
    '^\s*(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:\s.*)?$'
  } else {
    '^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?$'
  }
  $match = [regex]::Match($Version, $pattern)
  if (-not $match.Success) { throw "version metadata is not numeric and compatible: $Version" }
  $segments = @(
    [uint32]$match.Groups[1].Value,
    [uint32]$match.Groups[2].Value,
    [uint32]$match.Groups[3].Value,
    $(if ($match.Groups[4].Success) { [uint32]$match.Groups[4].Value } else { [uint32]0 })
  )
  return $segments -join '.'
}

try {
  $normalizedInstallDir = Get-NormalizedAbsolutePath $InstallDir 'installDir'
  $normalizedTargetInstallDir = Get-NormalizedAbsolutePath $TargetInstallDir 'target installDir'
  $normalizedTargetUserDataPath = Get-NormalizedAbsolutePath $TargetUserDataPath 'target userDataPath'
  $normalizedTargetRuntimeHomePath = Get-NormalizedAbsolutePath $TargetRuntimeHomePath 'target runtimeHomePath'
  $normalizedInstalledExePath = Get-NormalizedAbsolutePath $InstalledExePath 'installed executable path'
  $normalizedInstallerPath = Get-NormalizedAbsolutePath $InstallerPath 'installer path'
  $normalizedInstallationRecordPath = Get-NormalizedAbsolutePath $InstallationRecordPath 'installation record path'
  $normalizedMigrationStatePath = Get-NormalizedAbsolutePath $MigrationStatePath 'migration state path'
  $expectedInstalledExePath = Get-NormalizedAbsolutePath (Join-Path $normalizedInstallDir 'Memmy.exe') 'expected installed executable path'

  Assert-NoReparsePath $normalizedInstallDir 'installDir'
  Assert-NoReparsePath $normalizedTargetInstallDir 'target installDir'
  Assert-NoReparsePath $normalizedTargetUserDataPath 'target userDataPath'
  Assert-NoReparsePath $normalizedTargetRuntimeHomePath 'target runtimeHomePath'
  Assert-NoReparsePath $normalizedInstalledExePath 'installed executable path'
  Assert-NoReparsePath $normalizedInstallerPath 'installer path'
  Assert-NoReparsePath $normalizedInstallationRecordPath 'installation record path'
  Assert-NoReparsePath $normalizedMigrationStatePath 'migration state path'

  if (-not (Test-SamePath $normalizedInstalledExePath $expectedInstalledExePath)) {
    throw "installed executable does not match installDir"
  }
  $isRelocation = -not (Test-SamePath $normalizedTargetInstallDir $normalizedInstallDir)
  if ($isRelocation) {
    if ((Test-SameOrDescendantPath $normalizedTargetInstallDir $normalizedInstallDir) -or
        (Test-SameOrDescendantPath $normalizedInstallDir $normalizedTargetInstallDir)) {
      Stop-Installation 'selected target overlaps the installed application directory'
    }
    if (Test-Path -LiteralPath (Join-Path $normalizedTargetInstallDir 'Memmy.exe') -PathType Leaf) {
      Stop-Installation 'selected target already contains Memmy.exe'
    }
    $targetLegacyDataPath = Join-Path $normalizedTargetInstallDir 'data'
    if (Test-DirectoryContainsData $targetLegacyDataPath) {
      Stop-Installation 'selected target already contains install-local Memmy data'
    }

    $targetRuntimeHasData = Test-DirectoryContainsData $normalizedTargetRuntimeHomePath @('updates')
    if ($targetRuntimeHasData) {
      $targetRuntimeIsRecordedSource = $false
      try {
        if (Test-Path -LiteralPath $normalizedInstallationRecordPath -PathType Leaf) {
          $relocationRecord = Get-Content -LiteralPath $normalizedInstallationRecordPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
          if ($relocationRecord.installDir -and $relocationRecord.runtimeHomePath) {
            $recordedRelocationInstallDir = Get-NormalizedAbsolutePath ([string]$relocationRecord.installDir) 'recorded relocation installDir'
            $recordedRelocationRuntimeHomePath = Get-NormalizedAbsolutePath ([string]$relocationRecord.runtimeHomePath) 'recorded relocation runtimeHomePath'
            $targetRuntimeIsRecordedSource =
              (Test-SamePath $recordedRelocationInstallDir $normalizedInstallDir) -and
              (Test-SamePath $recordedRelocationRuntimeHomePath $normalizedTargetRuntimeHomePath)
          }
        }
      } catch {
        $targetRuntimeIsRecordedSource = $false
      }
      if (-not $targetRuntimeIsRecordedSource) {
        Stop-Installation 'selected installation drive already contains Memmy runtime data'
      }
    }

    Write-Output 'relay-required:installation target differs from the installed application'
    exit 1
  }
  $installedExeExists = Test-Path -LiteralPath $normalizedInstalledExePath -PathType Leaf
  if (-not $installedExeExists -and -not $AllowMissingExecutable) {
    throw "installed Memmy.exe is missing"
  }
  if (-not (Test-Path -LiteralPath $normalizedInstallerPath -PathType Leaf)) {
    throw "downloaded installer is missing"
  }
  if (Test-SameOrDescendantPath $normalizedInstallerPath $normalizedInstallDir) {
    throw "downloaded installer is inside installDir"
  }
  if (Test-Path -LiteralPath $normalizedMigrationStatePath) {
    throw "data migration state still exists"
  }

  $legacyDataPath = Join-Path $normalizedInstallDir 'data'
  if (Test-Path -LiteralPath $legacyDataPath) {
    if (-not (Test-Path -LiteralPath $legacyDataPath -PathType Container)) {
      throw "legacy install data path is not a directory"
    }
    if (@(Get-ChildItem -LiteralPath $legacyDataPath -Force -ErrorAction Stop).Count -ne 0) {
      throw "legacy install data still requires relay preservation"
    }
  }

  if (-not (Test-Path -LiteralPath $normalizedInstallationRecordPath -PathType Leaf)) {
    if (-not $installedExeExists -and $AllowMissingExecutable) {
      Write-Output 'standard-install-safe'
      exit 0
    }
    throw "external-v1 installation record is missing"
  }

  $record = Get-Content -LiteralPath $normalizedInstallationRecordPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop
  $requiredProperties = @('schemaVersion', 'dataLayoutGeneration', 'installDir', 'userDataPath', 'runtimeHomePath', 'appVersion')
  foreach ($property in $requiredProperties) {
    if ($record.PSObject.Properties.Name -notcontains $property) {
      throw "external-v1 installation record is missing $property"
    }
  }
  if (($record.schemaVersion -isnot [int]) -and ($record.schemaVersion -isnot [long])) {
    throw "external-v1 installation record schemaVersion must be an integer"
  }
  if ([long]$record.schemaVersion -ne 1) {
    throw "external-v1 installation record schema is unsupported"
  }
  foreach ($property in @('dataLayoutGeneration', 'installDir', 'userDataPath', 'runtimeHomePath', 'appVersion')) {
    if (($record.$property -isnot [string]) -or [string]::IsNullOrWhiteSpace($record.$property)) {
      throw "external-v1 installation record $property must be a non-empty string"
    }
  }
  if (-not [string]::Equals($record.dataLayoutGeneration, 'external-v1', [System.StringComparison]::Ordinal)) {
    throw "data layout generation is not external-v1"
  }

  $recordedInstallDir = Get-NormalizedAbsolutePath $record.installDir 'recorded installDir'
  if (-not (Test-SamePath $recordedInstallDir $normalizedInstallDir)) {
    throw "recorded installDir does not match the installed application"
  }
  $recordedUserDataPath = Get-NormalizedAbsolutePath $record.userDataPath 'recorded userDataPath'
  $recordedRuntimeHomePath = Get-NormalizedAbsolutePath $record.runtimeHomePath 'recorded runtimeHomePath'
  foreach ($externalPath in @($recordedUserDataPath, $recordedRuntimeHomePath)) {
    if (Test-SameOrDescendantPath $externalPath $normalizedInstallDir) {
      throw "recorded external data path is inside installDir"
    }
    if (-not (Test-Path -LiteralPath $externalPath -PathType Container)) {
      throw "recorded external data path is missing"
    }
    Assert-NoReparsePath $externalPath 'recorded external data path'
  }
  if (-not (Test-SamePath $recordedUserDataPath $normalizedTargetUserDataPath)) {
    throw "recorded userDataPath does not match the expected data layout"
  }
  if (-not (Test-SamePath $recordedRuntimeHomePath $normalizedTargetRuntimeHomePath)) {
    throw "recorded runtimeHomePath does not match the expected data layout"
  }

  if (-not $installedExeExists -and $AllowMissingExecutable) {
    Write-Output 'standard-install-safe'
    exit 0
  }

  $recordedVersion = ConvertTo-ComparableVersion $record.appVersion $false
  $installedVersion = [System.Diagnostics.FileVersionInfo]::GetVersionInfo($normalizedInstalledExePath)
  foreach ($candidate in @($installedVersion.ProductVersion, $installedVersion.FileVersion)) {
    $comparableCandidate = ConvertTo-ComparableVersion ([string]$candidate) $true
    if (-not [string]::Equals($recordedVersion, $comparableCandidate, [System.StringComparison]::Ordinal)) {
      throw "recorded appVersion does not match installed executable version"
    }
  }

  Write-Output 'standard-upgrade-safe'
  exit 0
} catch {
  $message = [string]$_.Exception.Message
  if ($message.StartsWith('installation-blocked:', [System.StringComparison]::Ordinal)) {
    Write-Output $message
    exit 2
  }
  Write-Output "relay-required:$message"
  exit 1
}
