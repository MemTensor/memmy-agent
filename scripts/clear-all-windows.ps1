#Requires -Version 5.1

<#
.SYNOPSIS
Removes the current user's Memmy installation and local state on Windows.

.DESCRIPTION
The script discovers Memmy paths before changing environment variables. It supports the
current per-user NSIS package, custom installation drives, the historical MSIX test package,
legacy CLI launchers, and Memmy-specific data paths. Source repositories and finished EXE or
MSIX packages are preserved unless -RepositoryRoot is supplied, in which case only known
rebuildable directories are removed.

Environment variables are removed but do not authorize arbitrary file deletion. Existing
external database or config paths are retained and reported; pass a Memmy-owned home with
-AdditionalMemmyHome or manually clean the exact SQLite file together with its -wal and
-shm sidecars after reviewing it.

The script never recursively deletes a volume root, profile root, AppData root, Windows,
Program Files, ProgramData, Desktop, or an arbitrary external workspace. Reparse points are
removed without traversing their targets.

.PARAMETER Force
Skips the interactive "CLEAR MEMMY" confirmation.

.PARAMETER IncludeMachineScope
Also cleans machine-level environment, PATH, registry, and legacy all-users locations. This
requires an already elevated PowerShell session; the script never self-elevates.

.PARAMETER AdditionalMemmyHome
Adds one or more explicit Memmy data homes. Each final directory name must begin with
"Memmy" or ".memmy", or be exactly "memory-service". UNC paths and protected roots are
still rejected.

.PARAMETER RepositoryRoot
Optionally identifies a Memmy source repository. Only Windows unpacked output and packaged
runtime staging directories are removed; finished installers are retained.

.EXAMPLE
.\clear-all-windows.ps1 -WhatIf

.EXAMPLE
.\clear-all-windows.ps1 -Force

.EXAMPLE
.\clear-all-windows.ps1 -AdditionalMemmyHome "D:\.memmy" -Force

.EXAMPLE
.\clear-all-windows.ps1 -RepositoryRoot "D:\work\memmy" -Force

.EXAMPLE
# Run from an elevated PowerShell only when legacy machine-wide traces must also be removed.
.\clear-all-windows.ps1 -IncludeMachineScope -Force
#>

[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  [switch]$Force,
  [switch]$IncludeMachineScope,
  [string[]]$AdditionalMemmyHome = @(),
  [string]$RepositoryRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$script:ProductName = "Memmy"
$script:AppId = "cn.memtensor.memmy"
$script:NsisGuid = "886615f7-a04c-57ec-a2dd-9161dbe1a7c4"
$script:LegacyMsixName = "Memmy.Development"
$script:LegacyMsixFamily = "Memmy.Development_fvzhnh4ztget6"
$script:ShouldProcessHost = $PSCmdlet

$script:Targets = [ordered]@{}
$script:InstallRoots = [ordered]@{}
$script:InstallerManagedRoots = [ordered]@{}
$script:ObservedRunningInstallRoots = [ordered]@{}
$script:ProcessRoots = [ordered]@{}
$script:CliDirectories = [ordered]@{}
$script:Removed = New-Object "System.Collections.Generic.List[string]"
$script:Missing = New-Object "System.Collections.Generic.List[string]"
$script:Retained = New-Object "System.Collections.Generic.List[string]"
$script:Failures = New-Object "System.Collections.Generic.List[string]"
$script:EnvironmentEntries = @()
$script:UninstallEntries = @()
$script:LegacyMsixPackages = @()
$script:RepositoryRootNormalized = $null
$script:ProtectedExternalPaths = [ordered]@{}
$script:ProtectedProcessIds = [ordered]@{}
$script:IsAdministrator = $false

function Write-Step {
  param([string]$Message)
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Add-ListItem {
  param(
    [System.Collections.Generic.List[string]]$List,
    [string]$Value
  )

  if (-not $List.Contains($Value)) {
    [void]$List.Add($Value)
  }
}

function Test-IsAdministrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($identity)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Expand-NormalizedPath {
  param([AllowNull()][string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return $null
  }

  $candidate = $Value.Trim()
  if ($candidate.Length -ge 2) {
    $first = $candidate.Substring(0, 1)
    $last = $candidate.Substring($candidate.Length - 1, 1)
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
      $candidate = $candidate.Substring(1, $candidate.Length - 2)
    }
  }

  if ($candidate -match "^[A-Za-z][A-Za-z0-9+.-]*://") {
    return $null
  }

  $candidate = [Environment]::ExpandEnvironmentVariables($candidate)
  if ($candidate -eq "~") {
    $candidate = $env:USERPROFILE
  } elseif ($candidate.StartsWith("~\") -or $candidate.StartsWith("~/")) {
    $candidate = Join-Path $env:USERPROFILE $candidate.Substring(2)
  }

  $candidate = $candidate.Replace('/', '\')
  if ($candidate -notmatch "^[A-Za-z]:\\") {
    return $null
  }

  try {
    $fullPath = [IO.Path]::GetFullPath($candidate)
    $root = [IO.Path]::GetPathRoot($fullPath)
    if ($fullPath.Length -gt $root.Length) {
      $fullPath = $fullPath.TrimEnd('\')
    }
    return $fullPath
  } catch {
    return $null
  }
}

function Get-ProtectedPaths {
  $paths = @(
    $env:SystemDrive,
    $env:SystemRoot,
    $env:WINDIR,
    $env:USERPROFILE,
    $env:APPDATA,
    $env:LOCALAPPDATA,
    $env:ProgramData,
    $env:PUBLIC,
    $env:TEMP,
    $env:TMP,
    [Environment]::GetEnvironmentVariable("ProgramFiles"),
    [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
  )

  if ($script:RepositoryRootNormalized) {
    $paths += $script:RepositoryRootNormalized
  }
  foreach ($path in $script:ProtectedExternalPaths.Values) {
    $paths += $path
  }

  $normalized = @()
  foreach ($path in $paths) {
    $value = Expand-NormalizedPath $path
    if ($value) {
      $normalized += $value.TrimEnd('\')
      $root = [IO.Path]::GetPathRoot($value)
      if ($root) {
        $normalized += $root.TrimEnd('\')
      }
    }
  }
  return @($normalized | Sort-Object -Unique)
}

function Test-IsProtectedPath {
  param([string]$NormalizedPath)

  $candidate = $NormalizedPath.TrimEnd('\')
  $root = [IO.Path]::GetPathRoot($NormalizedPath)
  if (-not $root -or $candidate -ieq $root.TrimEnd('\')) {
    return $true
  }

  foreach ($protected in Get-ProtectedPaths) {
    if ($candidate -ieq $protected.TrimEnd('\')) {
      return $true
    }
  }
  return $false
}

function Test-WouldContainProtectedPath {
  param([string]$NormalizedPath)

  foreach ($protected in Get-ProtectedPaths) {
    if (Test-IsPathEqualOrWithin $protected $NormalizedPath) {
      return $true
    }
  }
  return $false
}

function Test-IntersectsProtectedExternalPath {
  param([string]$NormalizedPath)

  foreach ($protected in $script:ProtectedExternalPaths.Values) {
    if ((Test-IsPathEqualOrWithin $NormalizedPath $protected) -or
        (Test-IsPathEqualOrWithin $protected $NormalizedPath)) {
      return $true
    }
  }
  return $false
}

function Test-IsPathEqualOrWithin {
  param(
    [AllowNull()][string]$Path,
    [AllowNull()][string]$Root
  )

  $normalizedPath = Expand-NormalizedPath $Path
  $normalizedRoot = Expand-NormalizedPath $Root
  if (-not $normalizedPath -or -not $normalizedRoot) {
    return $false
  }

  $candidate = $normalizedPath.TrimEnd('\')
  $boundary = $normalizedRoot.TrimEnd('\')
  if ($candidate -ieq $boundary) {
    return $true
  }
  return $candidate.StartsWith($boundary + '\', [StringComparison]::OrdinalIgnoreCase)
}

function Test-IsMemmyScopedDirectory {
  param([string]$NormalizedPath)

  $leaf = Split-Path -Leaf $NormalizedPath.TrimEnd('\')
  return ($leaf -match "(?i)^\.?memmy(?:$|[-_. ])" -or $leaf -match "(?i)^memory-service$")
}

function Test-IsSensitiveExactFilePath {
  param([string]$NormalizedPath)

  $sensitiveRoots = @(
    $env:SystemRoot,
    $env:WINDIR,
    [Environment]::GetEnvironmentVariable("ProgramFiles"),
    [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"),
    $env:ProgramData,
    $env:PUBLIC,
    [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory),
    $script:RepositoryRootNormalized
  )

  foreach ($root in $sensitiveRoots) {
    if ($root -and (Test-IsPathEqualOrWithin $NormalizedPath $root)) {
      return $true
    }
  }
  return $false
}

function Test-IsForbiddenInstallRoot {
  param([string]$NormalizedPath)

  foreach ($root in @(
    $env:SystemRoot,
    $env:WINDIR,
    $env:PUBLIC,
    [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory),
    [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory),
    $script:RepositoryRootNormalized
  )) {
    if ($root -and (Test-IsPathEqualOrWithin $NormalizedPath $root)) {
      return $true
    }
  }

  if (-not $IncludeMachineScope) {
    foreach ($root in @(
      [Environment]::GetEnvironmentVariable("ProgramFiles"),
      [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"),
      $env:ProgramData
    )) {
      if ($root -and (Test-IsPathEqualOrWithin $NormalizedPath $root)) {
        return $true
      }
    }
  }
  return $false
}

function Test-IsTrustedMemmyExactFile {
  param([string]$NormalizedPath)

  if (Test-IsSensitiveExactFilePath $NormalizedPath) {
    return $false
  }

  $leaf = Split-Path -Leaf $NormalizedPath
  if ($leaf -match "(?i)^(?:memmy|memory|app)[A-Za-z0-9._ -]*\.(?:ya?ml|json|sqlite3?|db)(?:-(?:wal|shm))?$") {
    return $true
  }

  $parent = Split-Path -Parent $NormalizedPath
  foreach ($segment in $parent.Split('\')) {
    if ($segment -match "(?i)^(?:\.memmy(?:-intl)?|Memmy(?:Intl)?|memory-service|cn\.memtensor\.memmy|ai\.memmy\.desktop)$") {
      return $true
    }
  }
  return $false
}

function Test-HasReparsePointAncestor {
  param(
    [string]$NormalizedPath,
    [switch]$IncludeLeaf
  )

  if ($IncludeLeaf) {
    $current = $NormalizedPath
  } else {
    $current = Split-Path -Parent $NormalizedPath
  }

  while ($current) {
    try {
      if (Test-Path -LiteralPath $current) {
        $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
          return $true
        }
      }
    } catch {
      return $true
    }

    $parent = Split-Path -Parent $current
    if (-not $parent -or $parent -ieq $current) {
      break
    }
    $current = $parent
  }
  return $false
}

function Add-Target {
  param(
    [AllowNull()][string]$Path,
    [ValidateSet("File", "Directory")][string]$Kind,
    [string]$Reason,
    [ValidateSet("Known", "Custom", "ExactFile", "Explicit")][string]$Trust = "Known"
  )

  $normalized = Expand-NormalizedPath $Path
  if (-not $normalized) {
    if (-not [string]::IsNullOrWhiteSpace($Path)) {
      Add-ListItem $script:Retained "skipped-unsafe: $Path [$Reason; invalid, relative, or network path]"
    }
    return
  }
  if (Test-IsProtectedPath $normalized) {
    Add-ListItem $script:Retained "skipped-unsafe: $normalized [$Reason; protected root]"
    return
  }
  if ($Kind -eq "File" -and $Trust -eq "ExactFile" -and -not (Test-IsTrustedMemmyExactFile $normalized)) {
    Add-ListItem $script:Retained "skipped-unsafe: $normalized [$Reason; exact file is not demonstrably Memmy-owned]"
    return
  }
  if ($Kind -eq "Directory" -and $Trust -eq "Custom" -and -not (Test-IsMemmyScopedDirectory $normalized)) {
    Add-ListItem $script:Retained "skipped-unsafe: $normalized [$Reason; directory is not Memmy-labeled]"
    return
  }
  if ($Kind -eq "Directory" -and $Trust -eq "Explicit") {
    if (Test-IsSensitiveExactFilePath $normalized) {
      Add-ListItem $script:Failures "skipped-unsafe: $normalized [$Reason; explicit home is inside a protected system, desktop, or repository tree]"
      return
    }
    $leaf = Split-Path -Leaf $normalized
    if ($leaf -notmatch "(?i)^\.?memmy" -and $leaf -ine "memory-service") {
      Add-ListItem $script:Failures "skipped-unsafe: $normalized [$Reason; explicit home must be Memmy-labeled]"
      return
    }
  }

  $key = $normalized.ToLowerInvariant()
  if (-not $script:Targets.Contains($key)) {
    $script:Targets[$key] = [pscustomobject]@{
      Path = $normalized
      Kind = $Kind
      Reason = $Reason
      Trust = $Trust
    }
  }
}

function Test-IsVerifiedMemmyInstallRoot {
  param([AllowNull()][string]$Path)

  $normalized = Expand-NormalizedPath $Path
  if (-not $normalized -or -not (Test-Path -LiteralPath $normalized -PathType Container)) {
    return $false
  }
  if (Test-HasReparsePointAncestor $normalized -IncludeLeaf) {
    return $false
  }

  $executable = Join-Path $normalized "Memmy.exe"
  $appArchive = Join-Path $normalized "resources\app.asar"
  return ((Test-Path -LiteralPath $executable -PathType Leaf) -and
          (Test-Path -LiteralPath $appArchive -PathType Leaf))
}

function Add-ProcessRoot {
  param(
    [AllowNull()][string]$Path,
    [string]$Reason
  )

  $normalized = Expand-NormalizedPath $Path
  if (-not $normalized -or (Test-IsProtectedPath $normalized)) {
    return
  }
  $key = $normalized.ToLowerInvariant()
  if (-not $script:ProcessRoots.Contains($key)) {
    $script:ProcessRoots[$key] = [pscustomobject]@{
      Path = $normalized
      Reason = $Reason
    }
  }
}

function Add-InstallRoot {
  param(
    [AllowNull()][string]$Path,
    [string]$Reason,
    [switch]$KnownDefault,
    [switch]$KnownRegistry
  )

  $normalized = Expand-NormalizedPath $Path
  if (-not $normalized -or (Test-IsProtectedPath $normalized)) {
    if ($Path) {
      Add-ListItem $script:Retained "skipped-unsafe-install-root: $Path [$Reason]"
    }
    return
  }
  if (Test-IsForbiddenInstallRoot $normalized) {
    Add-ListItem $script:Retained "skipped-forbidden-install-root: $normalized [$Reason; outside the selected cleanup scope]"
    return
  }

  $verifiedPackage = Test-IsVerifiedMemmyInstallRoot $normalized
  if (-not $KnownDefault -and -not $verifiedPackage) {
    if (Test-Path -LiteralPath $normalized) {
      Add-ListItem $script:Failures "skipped-unverified-install-root: $normalized [$Reason; package markers missing or path contains a reparse point]"
    } else {
      Add-ListItem $script:Missing "$normalized [$Reason; registered installation path is already absent]"
    }
    return
  }

  $key = $normalized.ToLowerInvariant()
  if (-not $script:InstallRoots.Contains($key)) {
    $script:InstallRoots[$key] = [pscustomobject]@{
      Path = $normalized
      Reason = $Reason
      KnownDefault = [bool]$KnownDefault
      KnownRegistry = [bool]$KnownRegistry
      VerifiedPackage = [bool]$verifiedPackage
    }
  }
  Add-ProcessRoot $normalized "Installation process root: $Reason"

  $cliPath = Join-Path $normalized "resources\cli"
  $cliKey = $cliPath.ToLowerInvariant().TrimEnd('\')
  if (-not $script:CliDirectories.Contains($cliKey)) {
    $script:CliDirectories[$cliKey] = $cliPath.TrimEnd('\')
  }

  if ($KnownDefault -or ($verifiedPackage -and (Test-IsMemmyScopedDirectory $normalized))) {
    Add-Target $normalized "Directory" "Application installation: $Reason" "Known"
  } else {
    $script:InstallerManagedRoots[$key] = $normalized
    Add-ListItem $script:Retained "installer-managed-only: $normalized [$Reason; shared-looking directory is not recursively deleted]"
  }
}

function Get-EnvironmentTarget {
  param([ValidateSet("Process", "User", "Machine")][string]$Scope)

  switch ($Scope) {
    "Process" { return [EnvironmentVariableTarget]::Process }
    "User" { return [EnvironmentVariableTarget]::User }
    "Machine" { return [EnvironmentVariableTarget]::Machine }
  }
}

function Get-MemmyEnvironmentEntries {
  $entries = @()
  foreach ($scope in @("Process", "User", "Machine")) {
    $target = Get-EnvironmentTarget $scope
    try {
      $variables = [Environment]::GetEnvironmentVariables($target)
      foreach ($name in $variables.Keys) {
        $textName = [string]$name
        if ($textName -match "(?i)^(MEMMY_|MEMORY_SERVICE_)[A-Z0-9_]*$") {
          $entries += [pscustomobject]@{
            Scope = $scope
            Name = $textName
            Value = [string]$variables[$name]
          }
        }
      }
    } catch {
      Add-ListItem $script:Failures "environment-read-failed: $scope [$($_.Exception.Message)]"
    }
  }
  return $entries
}

function Record-ExternalEnvironmentPaths {
  $pathVariables = @(
    "MEMMY_HOME",
    "MEMMY_CONFIG",
    "MEMMY_CONFIG_PATH",
    "MEMMY_RUNTIME_CONFIG_PATH",
    "MEMMY_AGENT_DATA_DIR",
    "MEMMY_AGENT_SESSION_DAG_DIR",
    "MEMMY_AGENT_TMUX_SOCKET_DIR",
    "MEMMY_MEMORY_HOME",
    "MEMORY_SERVICE_HOME",
    "MEMMY_APP_DB_PATH",
    "MEMMY_MEMORY_DB",
    "MEMMY_MEMORY_DB_PATH",
    "MEMMY_MEMOS_DB_PATH",
    "MEMORY_SERVICE_DB",
    "MEMMY_AGENT_WORKSPACE",
    "MEMMY_WORKSPACE"
  )
  $workspaceVariables = @("MEMMY_AGENT_WORKSPACE", "MEMMY_WORKSPACE")

  foreach ($entry in $script:EnvironmentEntries) {
    if ($entry.Scope -eq "Machine" -and -not $IncludeMachineScope) {
      continue
    }
    if ($pathVariables -notcontains $entry.Name) {
      continue
    }

    $normalized = Expand-NormalizedPath $entry.Value
    if (-not $normalized -or -not (Test-Path -LiteralPath $normalized)) {
      continue
    }

    if ($workspaceVariables -contains $entry.Name) {
      $isInternalWorkspace = $false
      foreach ($target in $script:Targets.Values) {
        if ($target.Kind -eq "Directory" -and
            $target.Reason -match "(?i)(runtime home|Explicit AdditionalMemmyHome)" -and
            (Test-IsPathEqualOrWithin $normalized $target.Path)) {
          $isInternalWorkspace = $true
          break
        }
      }
      if (-not $isInternalWorkspace) {
        $script:ProtectedExternalPaths[$normalized.ToLowerInvariant()] = $normalized
        Add-ListItem $script:Retained "retained-external-workspace: $normalized [$($entry.Scope):$($entry.Name)]"
        continue
      }
    }

    $covered = $false
    foreach ($target in $script:Targets.Values) {
      if ($target.Kind -eq "Directory" -and (Test-IsPathEqualOrWithin $normalized $target.Path)) {
        $covered = $true
        break
      }
      if ($target.Kind -eq "File" -and $normalized -ieq $target.Path) {
        $covered = $true
        break
      }
    }
    if ($covered) {
      continue
    }

    if ($workspaceVariables -notcontains $entry.Name) {
      Add-ListItem $script:Failures "external-memmy-path-retained: $normalized [$($entry.Scope):$($entry.Name); pass its Memmy-owned home with -AdditionalMemmyHome or clean it manually]"
    }
  }
}

function ConvertFrom-SimpleConfigScalar {
  param([string]$Value)

  $result = $Value.Trim()
  if ($result.Length -ge 2) {
    $first = $result.Substring(0, 1)
    $last = $result.Substring($result.Length - 1, 1)
    if (($first -eq '"' -and $last -eq '"') -or ($first -eq "'" -and $last -eq "'")) {
      return $result.Substring(1, $result.Length - 2)
    }
  }
  return ($result -replace "\s+#.*$", "").Trim()
}

function Record-ExternalConfigDatabasePaths {
  $configPaths = [ordered]@{}
  foreach ($target in $script:Targets.Values) {
    $candidate = $null
    if ($target.Kind -eq "File" -and $target.Reason -match "(?i)Memmy config") {
      $candidate = $target.Path
    } elseif ($target.Kind -eq "Directory" -and $target.Reason -match "(?i)(runtime home|Explicit AdditionalMemmyHome)") {
      $candidate = Join-Path $target.Path "config.yaml"
    }
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $configPaths[$candidate.ToLowerInvariant()] = $candidate
    }
  }
  foreach ($entry in $script:EnvironmentEntries) {
    if ($entry.Scope -eq "Machine" -and -not $IncludeMachineScope) {
      continue
    }
    if ($entry.Name -notmatch "(?i)^MEMMY_(?:CONFIG|CONFIG_PATH|RUNTIME_CONFIG_PATH)$") {
      continue
    }
    $candidate = Expand-NormalizedPath $entry.Value
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $configPaths[$candidate.ToLowerInvariant()] = $candidate
    }
  }

  foreach ($configPath in $configPaths.Values) {
    try {
      foreach ($line in Get-Content -LiteralPath $configPath -ErrorAction Stop) {
        if ($line -notmatch "^\s*sqlitePath\s*:\s*(.+?)\s*$") {
          continue
        }
        $rawPath = ConvertFrom-SimpleConfigScalar $Matches[1]
        $databasePath = Expand-NormalizedPath $rawPath
        if (-not $databasePath) {
          Add-ListItem $script:Failures "external-config-database-path-unresolved: $rawPath [from $configPath; clean manually]"
          continue
        }

        $covered = $false
        foreach ($cleanupTarget in $script:Targets.Values) {
          if ($cleanupTarget.Kind -eq "Directory" -and (Test-IsPathEqualOrWithin $databasePath $cleanupTarget.Path)) {
            $covered = $true
            break
          }
        }
        if ($covered) {
          continue
        }

        $existingFiles = @(@($databasePath, "$databasePath-wal", "$databasePath-shm") | Where-Object {
          Test-Path -LiteralPath $_ -PathType Leaf
        })
        if ($existingFiles.Count -gt 0) {
          Add-ListItem $script:Failures "external-config-database-retained: $databasePath [from $configPath; clean the SQLite file and its -wal/-shm files manually]"
        }
      }
    } catch {
      Add-ListItem $script:Failures "config-path-discovery-failed: $configPath [$($_.Exception.Message)]"
    }
  }
}

function Get-ObjectPropertyValue {
  param(
    [object]$Object,
    [string]$Name
  )

  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) {
    return $null
  }
  return $property.Value
}

function Get-ExecutableFromCommandLine {
  param([AllowNull()][string]$CommandLine)

  if ([string]::IsNullOrWhiteSpace($CommandLine)) {
    return $null
  }
  $command = $CommandLine.Trim()
  if ($command.StartsWith('"')) {
    $closingQuote = $command.IndexOf('"', 1)
    if ($closingQuote -gt 1) {
      return Expand-NormalizedPath $command.Substring(1, $closingQuote - 1)
    }
    return $null
  }
  if ($command -match "^(.*?\.exe)(?:\s|$)") {
    return Expand-NormalizedPath $Matches[1]
  }
  return $null
}

function Test-PathWithinRoot {
  param(
    [AllowNull()][string]$Path,
    [AllowNull()][string]$Root
  )

  $normalizedPath = Expand-NormalizedPath $Path
  $normalizedRoot = Expand-NormalizedPath $Root
  if (-not $normalizedPath -or -not $normalizedRoot) {
    return $false
  }
  $prefix = $normalizedRoot.TrimEnd('\') + '\'
  return $normalizedPath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function New-UninstallEntry {
  param(
    [string]$RegistryPath,
    [object]$Properties,
    [string]$Scope,
    [bool]$KnownGuid
  )

  $displayName = [string](Get-ObjectPropertyValue $Properties "DisplayName")
  $installLocation = Expand-NormalizedPath ([string](Get-ObjectPropertyValue $Properties "InstallLocation"))
  $uninstallCommands = @(
    [string](Get-ObjectPropertyValue $Properties "QuietUninstallString"),
    [string](Get-ObjectPropertyValue $Properties "UninstallString")
  )
  $uninstallExecutable = $null

  foreach ($command in $uninstallCommands) {
    $candidate = Get-ExecutableFromCommandLine $command
    if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
      $uninstallExecutable = $candidate
      break
    }
  }
  if (-not $uninstallExecutable -and $installLocation) {
    $candidate = Join-Path $installLocation "Uninstall Memmy.exe"
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      $uninstallExecutable = $candidate
    }
  }

  if ($uninstallExecutable -and -not $installLocation) {
    $installLocation = Expand-NormalizedPath (Split-Path -Parent $uninstallExecutable)
  }
  if ($uninstallExecutable -and (Split-Path -Leaf $uninstallExecutable) -notmatch "(?i)^(Uninstall Memmy|unins\d*)\.exe$") {
    Add-ListItem $script:Retained "skipped-unsafe-uninstaller: $uninstallExecutable [unexpected file name]"
    $uninstallExecutable = $null
  }
  if ($uninstallExecutable -and (-not $installLocation -or -not (Test-PathWithinRoot $uninstallExecutable $installLocation))) {
    Add-ListItem $script:Retained "skipped-unsafe-uninstaller: $uninstallExecutable [outside verified InstallLocation]"
    $uninstallExecutable = $null
  }
  if ($uninstallExecutable -and -not (Test-IsVerifiedMemmyInstallRoot $installLocation)) {
    Add-ListItem $script:Retained "skipped-unsafe-uninstaller: $uninstallExecutable [Memmy.exe or resources\app.asar marker missing]"
    $uninstallExecutable = $null
  }
  if ($uninstallExecutable -and (Test-HasReparsePointAncestor $uninstallExecutable -IncludeLeaf)) {
    Add-ListItem $script:Retained "skipped-unsafe-uninstaller: $uninstallExecutable [reparse point in path]"
    $uninstallExecutable = $null
  }

  return [pscustomobject]@{
    RegistryPath = $RegistryPath
    Scope = $Scope
    DisplayName = $displayName
    InstallLocation = $installLocation
    UninstallExecutable = $uninstallExecutable
    KnownGuid = $KnownGuid
    UninstallFailed = $false
    UninstallSucceeded = $false
  }
}

function Get-MemmyUninstallEntries {
  $roots = @(
    [pscustomobject]@{ Path = "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall"; Scope = "User" },
    [pscustomobject]@{ Path = "Registry::HKEY_CURRENT_USER\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"; Scope = "User" }
  )
  if ($IncludeMachineScope) {
    $roots += @(
      [pscustomobject]@{ Path = "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall"; Scope = "Machine" },
      [pscustomobject]@{ Path = "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"; Scope = "Machine" }
    )
  }

  $entries = @()
  foreach ($root in $roots) {
    if (-not (Test-Path -LiteralPath $root.Path)) {
      continue
    }
    try {
      foreach ($key in Get-ChildItem -LiteralPath $root.Path -ErrorAction Stop) {
        try {
          $properties = Get-ItemProperty -LiteralPath $key.PSPath -ErrorAction Stop
          $displayName = [string](Get-ObjectPropertyValue $properties "DisplayName")
          $publisher = [string](Get-ObjectPropertyValue $properties "Publisher")
          $keyName = Split-Path -Leaf $key.Name
          $knownGuid = $keyName -ieq $script:NsisGuid
          $isMemmy = $knownGuid -or (
            $displayName -match "(?i)^Memmy(?: Desktop)?(?:\s+\d+(?:\.\d+){1,3}(?:[-+][A-Za-z0-9.-]+)?)?$" -and
            $publisher -match "(?i)^(?:MemTensor|Memmy)(?:\s|$)"
          )
          if ($isMemmy) {
            $entries += New-UninstallEntry $key.PSPath $properties $root.Scope $knownGuid
          }
        } catch {
          Add-ListItem $script:Failures "uninstall-registry-entry-read-failed: $($key.PSPath) [$($_.Exception.Message)]"
        }
      }
    } catch {
      Add-ListItem $script:Failures "uninstall-registry-read-failed: $($root.Path) [$($_.Exception.Message)]"
    }
  }

  return $entries
}

function Add-KnownInstallRegistryRoots {
  $records = @(
    [pscustomobject]@{ Path = "Registry::HKEY_CURRENT_USER\Software\$($script:NsisGuid)"; Scope = "User" },
    [pscustomobject]@{ Path = "Registry::HKEY_CURRENT_USER\Software\WOW6432Node\$($script:NsisGuid)"; Scope = "User" }
  )
  if ($IncludeMachineScope) {
    $records += @(
      [pscustomobject]@{ Path = "Registry::HKEY_LOCAL_MACHINE\Software\$($script:NsisGuid)"; Scope = "Machine" },
      [pscustomobject]@{ Path = "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\$($script:NsisGuid)"; Scope = "Machine" }
    )
  }

  foreach ($record in $records) {
    if (-not (Test-Path -LiteralPath $record.Path)) {
      continue
    }
    try {
      $properties = Get-ItemProperty -LiteralPath $record.Path -ErrorAction Stop
      $location = [string](Get-ObjectPropertyValue $properties "InstallLocation")
      if ($location) {
        Add-InstallRoot $location "Known NSIS registry ($($record.Scope))" -KnownRegistry
      }
    } catch {
      Add-ListItem $script:Failures "install-registry-read-failed: $($record.Path) [$($_.Exception.Message)]"
    }
  }
}

function Get-RawPathValue {
  param([ValidateSet("Process", "User", "Machine")][string]$Scope)

  if ($Scope -eq "Process") {
    return [pscustomobject]@{ Value = [string]$env:Path; Kind = $null }
  }

  $baseKey = $null
  $subKey = $null
  try {
    if ($Scope -eq "User") {
      $baseKey = [Microsoft.Win32.Registry]::CurrentUser
      $subKey = $baseKey.OpenSubKey("Environment", $false)
    } else {
      $baseKey = [Microsoft.Win32.Registry]::LocalMachine
      $subKey = $baseKey.OpenSubKey("SYSTEM\CurrentControlSet\Control\Session Manager\Environment", $false)
    }
    if ($null -eq $subKey) {
      return [pscustomobject]@{ Value = $null; Kind = $null }
    }
    $value = $subKey.GetValue("Path", $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = $null
    if ($null -ne $value) {
      $kind = $subKey.GetValueKind("Path")
    }
    return [pscustomobject]@{ Value = [string]$value; Kind = $kind }
  } finally {
    if ($null -ne $subKey) {
      $subKey.Dispose()
    }
  }
}

function Set-RawPathValue {
  param(
    [ValidateSet("Process", "User", "Machine")][string]$Scope,
    [string]$Value,
    [AllowNull()][object]$Kind
  )

  if ($Scope -eq "Process") {
    $env:Path = $Value
    return
  }

  $baseKey = $null
  $subKey = $null
  try {
    if ($Scope -eq "User") {
      $baseKey = [Microsoft.Win32.Registry]::CurrentUser
      $subKey = $baseKey.OpenSubKey("Environment", $true)
    } else {
      $baseKey = [Microsoft.Win32.Registry]::LocalMachine
      $subKey = $baseKey.OpenSubKey("SYSTEM\CurrentControlSet\Control\Session Manager\Environment", $true)
    }
    if ($null -eq $subKey) {
      throw "Environment registry key is unavailable."
    }
    $valueKind = $Kind
    if ($null -eq $valueKind) {
      $valueKind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    }
    $subKey.SetValue("Path", $Value, $valueKind)
  } finally {
    if ($null -ne $subKey) {
      $subKey.Dispose()
    }
  }
}

function Discover-CliDirectoriesFromPath {
  $scopes = @("User")
  if ($IncludeMachineScope) {
    $scopes += "Machine"
  }
  foreach ($scope in $scopes) {
    $record = Get-RawPathValue $scope
    if ([string]::IsNullOrWhiteSpace($record.Value)) {
      continue
    }
    foreach ($segment in $record.Value.Split(';')) {
      $normalized = Expand-NormalizedPath $segment
      if (-not $normalized) {
        continue
      }
      $memmyCommand = Join-Path $normalized "memmy.cmd"
      $memoryCommand = Join-Path $normalized "memmy-memory.cmd"
      if ((Split-Path -Leaf $normalized) -ieq "cli" -and
          (Split-Path -Leaf (Split-Path -Parent $normalized)) -ieq "resources" -and
          ((Test-Path -LiteralPath $memmyCommand -PathType Leaf) -or (Test-Path -LiteralPath $memoryCommand -PathType Leaf))) {
        $installRoot = Split-Path -Parent (Split-Path -Parent $normalized)
        Add-InstallRoot $installRoot "PATH discovery ($scope)"
      }
    }
  }
}

function Test-IsVerifiedCliLauncherContent {
  param([string]$Path)

  try {
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      return $true
    }
    if ($item.Length -gt 1MB) {
      return $false
    }
    $content = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    return ($content -match "(?i)(Managed by Memmy dev-start|node_modules[\\/](?:memmy-agent|@memtensor[\\/]memmy-memory-cli)|App[\\/]memmy-agent[\\/]dist[\\/]main\.js|Memory[\\/]dist[\\/]src[\\/]cli[\\/]index\.js)")
  } catch {
    return $false
  }
}

function Add-VerifiedCliLauncher {
  param(
    [string]$Path,
    [string]$Reason
  )

  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return
  }
  if (Test-IsSensitiveExactFilePath $Path) {
    Add-ListItem $script:Retained "skipped-cli-launcher: $Path [$Reason; sensitive location]"
    return
  }
  if (Test-IsVerifiedCliLauncherContent $Path) {
    Add-Target $Path "File" $Reason "Known"
  } else {
    Add-ListItem $script:Retained "skipped-cli-launcher: $Path [$Reason; content is not a verified Memmy launcher]"
  }
}

function Add-VerifiedNodePackage {
  param(
    [string]$Path,
    [string]$ExpectedName
  )

  $packageJson = Join-Path $Path "package.json"
  if (-not (Test-Path -LiteralPath $packageJson -PathType Leaf)) {
    return
  }
  try {
    $metadata = Get-Content -LiteralPath $packageJson -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    if ([string]$metadata.name -cne $ExpectedName) {
      Add-ListItem $script:Retained "skipped-global-package: $Path [package name mismatch]"
      return
    }
    if (Test-IsSensitiveExactFilePath $Path) {
      Add-ListItem $script:Retained "skipped-global-package: $Path [sensitive location]"
      return
    }
    Add-Target $Path "Directory" "Verified global package $ExpectedName" "Known"
  } catch {
    Add-ListItem $script:Retained "skipped-global-package: $Path [unreadable package metadata]"
  }
}

function Discover-VerifiedGlobalCliTargets {
  $scopes = @("User")
  if ($IncludeMachineScope) {
    $scopes += "Machine"
  }
  $launcherNames = @(
    "memmy", "memmy.cmd", "memmy.ps1", "memmy.bat",
    "memmy-memory", "memmy-memory.cmd", "memmy-memory.ps1", "memmy-memory.bat",
    "memmy-agent", "memmy-agent.cmd", "memmy-agent.ps1", "memmy-agent.bat"
  )

  foreach ($scope in $scopes) {
    $record = Get-RawPathValue $scope
    if (-not $record.Value) {
      continue
    }
    foreach ($segment in $record.Value.Split(';')) {
      $directory = Expand-NormalizedPath $segment
      if (-not $directory -or -not (Test-Path -LiteralPath $directory -PathType Container)) {
        continue
      }
      foreach ($name in $launcherNames) {
        Add-VerifiedCliLauncher (Join-Path $directory $name) "Verified $scope PATH CLI launcher"
      }
      Add-VerifiedNodePackage (Join-Path $directory "node_modules\memmy-agent") "memmy-agent"
      Add-VerifiedNodePackage (Join-Path $directory "node_modules\@memtensor\memmy-memory-cli") "@memtensor/memmy-memory-cli"
    }
  }
}

function Add-DefaultTargets {
  $localPrograms = Join-Path $env:LOCALAPPDATA "Programs\Memmy"
  Add-InstallRoot $localPrograms "Current per-user NSIS default" -KnownDefault

  $launchProxy = (Join-Path $env:LOCALAPPDATA "Memmy\launcher").TrimEnd('\')
  $script:CliDirectories[$launchProxy.ToLowerInvariant()] = $launchProxy

  Add-Target (Join-Path $env:USERPROFILE ".memmy") "Directory" "Default Memmy runtime home" "Known"
  Add-Target (Join-Path $env:USERPROFILE ".memmy-intl") "Directory" "Legacy international runtime home" "Known"
  Add-Target (Join-Path $env:APPDATA "Memmy") "Directory" "Electron userData" "Known"
  Add-Target (Join-Path $env:APPDATA "MemmyIntl") "Directory" "Legacy international Electron userData" "Known"
  Add-Target (Join-Path $env:LOCALAPPDATA "Memmy") "Directory" "Windows launch proxy and local state" "Known"
  Add-Target (Join-Path $env:LOCALAPPDATA "@memmydesktop-updater") "Directory" "Legacy updater cache" "Known"
  Add-Target (Join-Path $env:LOCALAPPDATA "memmy-updater") "Directory" "Updater cache" "Known"
  Add-Target (Join-Path $env:LOCALAPPDATA "cn.memtensor.memmy") "Directory" "Legacy app-id cache" "Known"
  Add-Target (Join-Path $env:LOCALAPPDATA "ai.memmy.desktop") "Directory" "Legacy desktop cache" "Known"
  Add-Target (Join-Path $env:APPDATA "cn.memtensor.memmy") "Directory" "Legacy roaming app-id state" "Known"
  Add-Target (Join-Path $env:APPDATA "ai.memmy.desktop") "Directory" "Legacy roaming desktop state" "Known"

  $legacyMsixState = Join-Path $env:LOCALAPPDATA "Packages\$($script:LegacyMsixFamily)\LocalState\Memmy"
  Add-Target $legacyMsixState "Directory" "Historical MSIX LocalState" "Known"

  $localBin = Join-Path $env:USERPROFILE ".local\bin"
  $npmBin = Join-Path $env:APPDATA "npm"
  foreach ($name in @("memmy", "memmy.cmd", "memmy.ps1", "memmy.bat", "memmy.exe", "memmy-memory", "memmy-memory.cmd", "memmy-memory.ps1", "memmy-memory.bat", "memmy-memory.exe", "memmy-agent", "memmy-agent.cmd", "memmy-agent.ps1", "memmy-agent.bat", "memmy-agent.exe")) {
    Add-VerifiedCliLauncher (Join-Path $localBin $name) "Legacy developer CLI"
    Add-VerifiedCliLauncher (Join-Path $npmBin $name) "Global npm CLI launcher"
  }
  Add-VerifiedNodePackage (Join-Path $npmBin "node_modules\memmy-agent") "memmy-agent"
  Add-VerifiedNodePackage (Join-Path $npmBin "node_modules\@memtensor\memmy-memory-cli") "@memtensor/memmy-memory-cli"

  $crashDumpDirectory = Join-Path $env:LOCALAPPDATA "CrashDumps"
  if (Test-Path -LiteralPath $crashDumpDirectory -PathType Container) {
    foreach ($dump in Get-ChildItem -LiteralPath $crashDumpDirectory -Filter "Memmy*.dmp" -File -ErrorAction SilentlyContinue) {
      Add-Target $dump.FullName "File" "Windows crash dump" "Known"
    }
  }
}

function Add-MachineTargets {
  if (-not $IncludeMachineScope) {
    return
  }
  foreach ($base in @(
    [Environment]::GetEnvironmentVariable("ProgramFiles"),
    [Environment]::GetEnvironmentVariable("ProgramFiles(x86)"),
    $env:ProgramData
  )) {
    if ($base) {
      Add-InstallRoot (Join-Path $base "Memmy") "Legacy machine-wide location" -KnownDefault
    }
  }
}

function Add-ShortcutTargets {
  $shortcutCandidates = @()
  $desktop = [Environment]::GetFolderPath([Environment+SpecialFolder]::DesktopDirectory)
  $startMenu = [Environment]::GetFolderPath([Environment+SpecialFolder]::StartMenu)

  foreach ($base in @($desktop)) {
    if ($base) {
      $shortcutCandidates += Join-Path $base "Memmy.lnk"
    }
  }
  foreach ($base in @($startMenu)) {
    if ($base) {
      $programs = Join-Path $base "Programs"
      $shortcutCandidates += Join-Path $programs "Memmy.lnk"
    }
  }
  if ($IncludeMachineScope) {
    foreach ($base in @(
      [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonDesktopDirectory),
      [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonStartMenu)
    )) {
      if ($base) {
        if ($base -ieq [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonStartMenu)) {
          $base = Join-Path $base "Programs"
        }
        $shortcutCandidates += Join-Path $base "Memmy.lnk"
      }
    }
  }
  $shortcutCandidates += Join-Path $env:APPDATA "Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar\Memmy.lnk"

  $shell = $null
  foreach ($shortcutPath in $shortcutCandidates) {
    if (-not (Test-Path -LiteralPath $shortcutPath -PathType Leaf)) {
      continue
    }
    try {
      if ($null -eq $shell) {
        $shell = New-Object -ComObject WScript.Shell
      }
      $shortcut = $shell.CreateShortcut($shortcutPath)
      $identity = "$($shortcut.TargetPath) $($shortcut.Arguments)"
      if ($identity -match "(?i)(Memmy\.exe|MemmyLauncher\.vbs|\\Memmy\\launcher)") {
        Add-Target $shortcutPath "File" "Verified Memmy shortcut" "Known"
      } else {
        Add-ListItem $script:Retained "skipped-shortcut: $shortcutPath [target is not Memmy]"
      }
    } catch {
      Add-ListItem $script:Retained "skipped-shortcut: $shortcutPath [unable to inspect target]"
    }
  }
}

function Add-RepositoryTargets {
  if ([string]::IsNullOrWhiteSpace($RepositoryRoot)) {
    return
  }

  $normalized = Expand-NormalizedPath $RepositoryRoot
  if (-not $normalized -or (Test-IsProtectedPath $normalized)) {
    throw "RepositoryRoot is invalid or protected: $RepositoryRoot"
  }
  $markers = @(
    (Join-Path $normalized "package.json"),
    (Join-Path $normalized "App\shell\desktop\electron-builder.win.yml"),
    (Join-Path $normalized "scripts\clear-all.sh")
  )
  foreach ($marker in $markers) {
    if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
      throw "RepositoryRoot is not a verified Memmy repository; missing: $marker"
    }
  }
  $script:RepositoryRootNormalized = $normalized

  foreach ($relative in @(
    "App\shell\desktop\release\win-unpacked",
    "App\shell\desktop\release\win-ia32-unpacked",
    "App\shell\desktop\release\win-arm64-unpacked",
    "App\shell\desktop\dist\runtime"
  )) {
    $targetPath = Join-Path $normalized $relative
    Add-Target $targetPath "Directory" "Rebuildable Windows repository artifact" "Known"
    if ($relative -match "(?i)win-(?:unpacked|ia32-unpacked|arm64-unpacked)$") {
      Add-ProcessRoot $targetPath "Verified repository Windows unpacked output"
    }
  }
  foreach ($relative in @(
    "App\shell\desktop\release\builder-effective-config.yaml",
    "App\shell\desktop\release\builder-debug.yml",
    "App\shell\desktop\dist\main\desktop-edition.json",
    "App\shell\desktop\dist\main\release-provenance.json"
  )) {
    Add-Target (Join-Path $normalized $relative) "File" "Rebuildable Windows repository metadata" "Known"
  }
}

function Get-LegacyMsixPackages {
  if (-not (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)) {
    return @()
  }
  try {
    return @(Get-AppxPackage -Name $script:LegacyMsixName -ErrorAction SilentlyContinue | Where-Object {
      $_.PackageFamilyName -ieq $script:LegacyMsixFamily
    })
  } catch {
    Add-ListItem $script:Failures "msix-discovery-failed: $($_.Exception.Message)"
    return @()
  }
}

function Discover-InstallRootsFromRunningProcesses {
  try {
    $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'Memmy.exe'" -ErrorAction Stop)
  } catch {
    Add-ListItem $script:Failures "process-install-discovery-failed: $($_.Exception.Message)"
    return
  }

  foreach ($process in $processes) {
    $executablePath = Expand-NormalizedPath ([string]$process.ExecutablePath)
    if (-not $executablePath) {
      continue
    }
    $installRoot = Split-Path -Parent $executablePath
    $markers = @(
      (Join-Path $installRoot "Uninstall Memmy.exe"),
      (Join-Path $installRoot "resources\app.asar"),
      (Join-Path $installRoot "resources\cli\memmy.cmd")
    )
    if (@($markers | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }).Count -gt 0) {
      $rootKey = $installRoot.ToLowerInvariant()
      $script:ObservedRunningInstallRoots[$rootKey] = $installRoot
      $withinCurrentProfile = Test-IsPathEqualOrWithin $installRoot $env:USERPROFILE
      if ($IncludeMachineScope -or $withinCurrentProfile -or $script:InstallRoots.Contains($rootKey) -or $script:ProcessRoots.Contains($rootKey)) {
        Add-ProcessRoot $installRoot "Verified running Memmy executable"
        Add-ListItem $script:Retained "process-only-install-root: $installRoot [running process discovery does not authorize recursive deletion]"
        if (-not $script:InstallRoots.Contains($rootKey) -and -not $script:Targets.Contains($rootKey)) {
          $script:InstallerManagedRoots[$rootKey] = $installRoot
        }
      } else {
        Add-ListItem $script:Failures "verified-running-install-outside-scope: $installRoot [not registered in the selected user scope; close it or rerun with the correct scope]"
      }
    } else {
      Add-ListItem $script:Retained "skipped-process-install-root: $installRoot [missing Memmy package markers]"
    }
  }
}

function Test-CommandLineContainsRoot {
  param(
    [AllowNull()][string]$CommandLine,
    [AllowNull()][string]$Root
  )

  $normalizedRoot = Expand-NormalizedPath $Root
  if (-not $CommandLine -or -not $normalizedRoot) {
    return $false
  }
  $pattern = '(?i)(?:^|[\s"=])' + [Regex]::Escape($normalizedRoot.TrimEnd('\')) + '(?:[\\/\s"]|$)'
  return [Regex]::IsMatch($CommandLine, $pattern)
}

function Get-MemmyProcesses {
  $results = @()
  try {
    $processes = @(Get-CimInstance Win32_Process -ErrorAction Stop)
  } catch {
    Add-ListItem $script:Failures "process-discovery-failed: $($_.Exception.Message)"
    return @()
  }

  foreach ($process in $processes) {
    $processKey = ([int]$process.ProcessId).ToString()
    if ($script:ProtectedProcessIds.Contains($processKey)) {
      continue
    }
    $name = [string]$process.Name
    $executablePath = Expand-NormalizedPath ([string]$process.ExecutablePath)
    $commandLine = [string]$process.CommandLine
    $isMemmy = $false

    if ($name -ieq "Memmy.exe" -and $executablePath) {
      foreach ($root in $script:ProcessRoots.Values) {
        if (Test-PathWithinRoot $executablePath $root.Path) {
          $isMemmy = $true
          break
        }
      }
      if (-not $isMemmy) {
        foreach ($package in $script:LegacyMsixPackages) {
          if (Test-PathWithinRoot $executablePath ([string]$package.InstallLocation)) {
            $isMemmy = $true
            break
          }
        }
      }
    }

    if (-not $isMemmy -and
        $name -match "(?i)^(node|electron|memmy-memory|memmy-agent)\.exe$" -and
        $commandLine -match "(?i)(memmy|memory-service)") {
      $runtimeRoots = @(
        (Join-Path $env:USERPROFILE ".memmy"),
        (Join-Path $env:USERPROFILE ".memmy-intl"),
        (Join-Path $env:APPDATA "Memmy"),
        (Join-Path $env:APPDATA "MemmyIntl"),
        (Join-Path $env:LOCALAPPDATA "Memmy")
      )
      foreach ($root in $script:InstallRoots.Values) {
        $runtimeRoots += $root.Path
      }
      foreach ($target in $script:Targets.Values) {
        if ($target.Kind -eq "Directory" -and $target.Reason -match "(?i)(Global .*package|runtime home|userData|updates?|launch proxy|Explicit AdditionalMemmyHome)") {
          $runtimeRoots += $target.Path
        }
      }
      foreach ($runtimeRoot in $runtimeRoots) {
        if (Test-CommandLineContainsRoot $commandLine $runtimeRoot) {
          $isMemmy = $true
          break
        }
      }
    }

    if (-not $isMemmy -and
        $name -match "(?i)^(cmd|powershell|pwsh|wscript|cscript)\.exe$" -and
        $commandLine -match "(?i)(MemmyLauncher\.vbs|MemmyUpdatePrompt\.ps1|(?:install|launch)-win-update-[A-Za-z0-9._-]+\.(?:cmd|ps1|vbs))") {
      foreach ($helperRoot in @(
        (Join-Path $env:LOCALAPPDATA "Memmy\launcher"),
        (Join-Path $env:APPDATA "Memmy\updates"),
        (Join-Path $env:APPDATA "MemmyIntl\updates")
      )) {
        if (Test-CommandLineContainsRoot $commandLine $helperRoot) {
          $isMemmy = $true
          break
        }
      }
    }

    if (-not $isMemmy -and $name -match "(?i)^(memmy|memmy-memory|memmy-agent)\.exe$" -and $executablePath) {
      foreach ($target in $script:Targets.Values) {
        if ($target.Kind -eq "File" -and $executablePath -ieq $target.Path) {
          $isMemmy = $true
          break
        }
      }
    }

    if (-not $isMemmy -and
        $name -ieq "electron.exe" -and
        $script:RepositoryRootNormalized -and
        $commandLine -and
        (Test-CommandLineContainsRoot $commandLine $script:RepositoryRootNormalized) -and
        $commandLine -match "(?i)(App[\\/]shell[\\/]desktop|dist[\\/]main[\\/]main\.js)") {
      $isMemmy = $true
    }

    if ($isMemmy) {
      $results += $process
    }
  }
  return $results
}

function Initialize-ProtectedProcessIds {
  $processId = [int]$PID
  while ($processId -gt 0) {
    $key = [string]$processId
    if ($script:ProtectedProcessIds.Contains($key)) {
      break
    }
    $script:ProtectedProcessIds[$key] = $true
    try {
      $current = @(Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop)
      if ($current.Count -ne 1) {
        break
      }
      $parentId = [int]$current[0].ParentProcessId
      if ($parentId -le 0 -or $parentId -eq $processId) {
        break
      }
      $processId = $parentId
    } catch {
      break
    }
  }
}

function Get-SameProcessInstance {
  param([object]$OriginalProcess)

  try {
    $processId = [int]$OriginalProcess.ProcessId
    $current = @(Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop)
    if ($current.Count -ne 1) {
      return $null
    }

    $candidate = $current[0]
    if ([string]$candidate.CreationDate -cne [string]$OriginalProcess.CreationDate) {
      return $null
    }
    if ([string]$candidate.ExecutablePath -cne [string]$OriginalProcess.ExecutablePath) {
      return $null
    }
    if ([string]$candidate.CommandLine -cne [string]$OriginalProcess.CommandLine) {
      return $null
    }
    return $candidate
  } catch {
    return $null
  }
}

function Stop-MemmyProcesses {
  Write-Step "Stopping verified Memmy processes"
  $processes = @(Get-MemmyProcesses)
  if ($processes.Count -eq 0) {
    Write-Host "missing: no verified Memmy process is running"
    return
  }

  $approvedProcesses = @()
  foreach ($process in $processes) {
    $processId = [int]$process.ProcessId
    if ($script:ShouldProcessHost.ShouldProcess("PID $processId ($($process.Name))", "Gracefully close and stop verified Memmy process tree")) {
      $sameProcess = Get-SameProcessInstance $process
      if ($null -ne $sameProcess) {
        $approvedProcesses += $sameProcess
      } else {
        Write-Host "skipped-stale-process: PID $processId"
      }
    }
  }

  if ($approvedProcesses.Count -eq 0) {
    return
  }

  foreach ($process in $approvedProcesses) {
    try {
      $sameBeforeClose = Get-SameProcessInstance $process
      if ($null -eq $sameBeforeClose) {
        continue
      }
      $managed = Get-Process -Id ([int]$sameBeforeClose.ProcessId) -ErrorAction SilentlyContinue
      $sameAfterOpen = Get-SameProcessInstance $process
      if ($null -ne $managed -and $null -ne $sameAfterOpen -and $managed.MainWindowHandle -ne 0) {
        [void]$managed.CloseMainWindow()
      }
    } catch {
      # Graceful close is best-effort; the verified process tree is force-stopped below.
    }
  }
  Start-Sleep -Milliseconds 1200

  $taskkill = Join-Path ([Environment]::SystemDirectory) "taskkill.exe"
  foreach ($process in $approvedProcesses) {
    $processId = [int]$process.ProcessId
    $sameProcess = Get-SameProcessInstance $process
    if ($null -eq $sameProcess) {
      Write-Host "skipped-stale-process: PID $processId"
      continue
    }
    try {
      $output = & $taskkill /PID $processId /T /F 2>&1
      if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
        throw ($output -join " ")
      }
      Write-Host "stopped: PID $processId ($($process.Name))"
    } catch {
      Add-ListItem $script:Failures "process-stop-failed: PID $processId [$($_.Exception.Message)]"
    }
  }
}

function Invoke-MemmyUninstallers {
  Write-Step "Running verified Memmy uninstallers"
  $seen = [ordered]@{}
  foreach ($entry in $script:UninstallEntries) {
    $executable = $entry.UninstallExecutable
    if (-not $executable) {
      if (-not $entry.InstallLocation -or -not (Test-Path -LiteralPath $entry.InstallLocation)) {
        Write-Host "missing: uninstaller for $($entry.RegistryPath)"
      } else {
        Add-ListItem $script:Retained "uninstaller-missing: $($entry.InstallLocation)"
      }
      continue
    }

    $installLocation = Expand-NormalizedPath ([string]$entry.InstallLocation)
    $defaultUserInstall = Expand-NormalizedPath (Join-Path $env:LOCALAPPDATA "Programs\Memmy")
    $isDedicatedInstallRoot = $installLocation -and (
      $installLocation -ieq $defaultUserInstall -or (Test-IsMemmyScopedDirectory $installLocation)
    )
    if (-not $isDedicatedInstallRoot -or
        (Test-WouldContainProtectedPath $installLocation) -or
        (Test-IntersectsProtectedExternalPath $installLocation)) {
      Add-ListItem $script:Retained "unsafe-uninstaller-root-skipped: $executable [InstallLocation is shared-looking or contains a protected path]"
      continue
    }

    if ($script:IsAdministrator) {
      Add-ListItem $script:Retained "elevated-uninstaller-skipped: $executable [registry-discovered executables are never launched with an elevated token]"
      continue
    }

    $key = $executable.ToLowerInvariant()
    if ($seen.Contains($key)) {
      continue
    }
    $seen[$key] = $true

    if (-not $script:ShouldProcessHost.ShouldProcess($executable, "Run silent Memmy uninstaller")) {
      continue
    }
    try {
      $arguments = @("/S")
      if ($entry.Scope -eq "Machine") {
        $arguments += "/allusers"
      } else {
        $arguments += "/currentuser"
      }
      $uninstallProcess = Start-Process -FilePath $executable -ArgumentList $arguments -Wait -PassThru -WindowStyle Hidden
      if ($uninstallProcess.ExitCode -ne 0) {
        throw "Uninstaller exited with code $($uninstallProcess.ExitCode)."
      }
      $entry.UninstallSucceeded = $true
      Write-Host "uninstalled: $executable"
    } catch {
      $entry.UninstallFailed = $true
      Add-ListItem $script:Failures "uninstaller-failed: $executable [$($_.Exception.Message)]"
    }
  }
}

function Remove-LegacyMsixPackages {
  Write-Step "Removing historical Memmy MSIX package for the current user"
  if ($script:LegacyMsixPackages.Count -eq 0) {
    Write-Host "missing: $($script:LegacyMsixName)"
    return
  }
  foreach ($package in $script:LegacyMsixPackages) {
    if (-not $script:ShouldProcessHost.ShouldProcess($package.PackageFullName, "Remove current-user Memmy MSIX package")) {
      continue
    }
    try {
      Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
      Write-Host "removed-msix: $($package.PackageFullName)"
    } catch {
      Add-ListItem $script:Failures "msix-remove-failed: $($package.PackageFullName) [$($_.Exception.Message)]"
    }
  }
}

function Initialize-NativeReparseRemoval {
  if ("MemmyNativeReparseRemoval" -as [type]) {
    return
  }

  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

public static class MemmyNativeReparseRemoval
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool DeleteFile(string lpFileName);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool RemoveDirectory(string lpPathName);

    public static void DeleteLink(string path, bool isDirectory)
    {
        bool succeeded = isDirectory ? RemoveDirectory(path) : DeleteFile(path);
        if (!succeeded)
        {
            throw new Win32Exception(Marshal.GetLastWin32Error());
        }
    }
}
"@
}

function Remove-ReparsePointOnly {
  param(
    [string]$Path,
    [object]$Item
  )

  Initialize-NativeReparseRemoval
  [MemmyNativeReparseRemoval]::DeleteLink($Path, [bool]$Item.PSIsContainer)
}

function Remove-DirectoryWithoutFollowingLinks {
  param([string]$Path)

  $item = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    Remove-ReparsePointOnly $Path $item
    return
  }

  foreach ($child in Get-ChildItem -LiteralPath $Path -Force -ErrorAction Stop) {
    if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      Remove-ReparsePointOnly $child.FullName $child
    } elseif ($child.PSIsContainer) {
      Remove-DirectoryWithoutFollowingLinks $child.FullName
    } else {
      [IO.File]::SetAttributes($child.FullName, [IO.FileAttributes]::Normal)
      [IO.File]::Delete($child.FullName)
    }
  }
  [IO.Directory]::Delete($Path, $false)
}

function Remove-SafeTargets {
  Write-Step "Removing Memmy files and directories"
  $orderedTargets = @($script:Targets.Values | Sort-Object -Property @(
    @{ Expression = { if ($_.Kind -eq "File") { 0 } else { 1 } }; Descending = $false },
    @{ Expression = { $_.Path.Length }; Descending = $true }
  ))

  foreach ($target in $orderedTargets) {
    if (Test-IsProtectedPath $target.Path) {
      Add-ListItem $script:Failures "blocked-protected-target: $($target.Path)"
      continue
    }
    if ($target.Kind -eq "Directory" -and (Test-WouldContainProtectedPath $target.Path)) {
      Add-ListItem $script:Failures "blocked-target-containing-protected-path: $($target.Path)"
      continue
    }
    if (Test-IntersectsProtectedExternalPath $target.Path) {
      Add-ListItem $script:Failures "blocked-target-intersecting-external-workspace: $($target.Path)"
      continue
    }
    if (Test-HasReparsePointAncestor $target.Path) {
      Add-ListItem $script:Failures "blocked-reparse-ancestor: $($target.Path)"
      continue
    }
    if (-not (Test-Path -LiteralPath $target.Path)) {
      Add-ListItem $script:Missing "$($target.Path) [$($target.Reason)]"
      continue
    }
    if (-not $script:ShouldProcessHost.ShouldProcess($target.Path, "Delete $($target.Reason)")) {
      continue
    }

    try {
      $item = Get-Item -LiteralPath $target.Path -Force -ErrorAction Stop
      if ($target.Kind -eq "File" -and $item.PSIsContainer) {
        throw "Expected a file but found a directory."
      }
      if ($target.Kind -eq "Directory" -and -not $item.PSIsContainer) {
        throw "Expected a directory but found a file."
      }

      if ($item.PSIsContainer) {
        Remove-DirectoryWithoutFollowingLinks $target.Path
      } elseif (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Remove-ReparsePointOnly $target.Path $item
      } else {
        [IO.File]::SetAttributes($target.Path, [IO.FileAttributes]::Normal)
        [IO.File]::Delete($target.Path)
      }
      Add-ListItem $script:Removed "$($target.Path) [$($target.Reason)]"
      Write-Host "deleted: $($target.Path)"
    } catch {
      Add-ListItem $script:Failures "delete-failed: $($target.Path) [$($_.Exception.Message)]"
    }
  }
}

function Remove-MemmyPathEntries {
  Write-Step "Removing exact Memmy CLI entries from PATH"
  $scopes = @("Process", "User")
  if ($IncludeMachineScope) {
    $scopes += "Machine"
  }

  foreach ($scope in $scopes) {
    try {
      $record = Get-RawPathValue $scope
      if ([string]::IsNullOrWhiteSpace($record.Value)) {
        Write-Host "missing: $scope PATH"
        continue
      }

      $changed = $false
      $kept = New-Object "System.Collections.Generic.List[string]"
      $removedSegments = New-Object "System.Collections.Generic.List[string]"
      foreach ($segment in $record.Value.Split(';')) {
        $normalized = Expand-NormalizedPath $segment
        $remove = $false
        if ($normalized) {
          $key = $normalized.ToLowerInvariant().TrimEnd('\')
          $remove = $script:CliDirectories.Contains($key)
        }
        if ($remove) {
          $changed = $true
          [void]$removedSegments.Add($normalized)
        } else {
          [void]$kept.Add($segment)
        }
      }

      if (-not $changed) {
        Write-Host "missing: no Memmy CLI entry in $scope PATH"
        continue
      }
      if ($script:ShouldProcessHost.ShouldProcess("$scope PATH", "Remove exact Memmy CLI path entries")) {
        Set-RawPathValue $scope ($kept -join ';') $record.Kind
        foreach ($removedSegment in $removedSegments) {
          Write-Host "path-entry-removed: $scope $removedSegment"
        }
      }
    } catch {
      Add-ListItem $script:Failures "path-clean-failed: $scope [$($_.Exception.Message)]"
    }
  }
}

function Remove-MemmyEnvironmentVariables {
  Write-Step "Removing Memmy environment variables"
  foreach ($entry in $script:EnvironmentEntries) {
    if ($entry.Scope -eq "Machine" -and -not $IncludeMachineScope) {
      Add-ListItem $script:Retained "machine-environment-retained: $($entry.Name) [rerun elevated with -IncludeMachineScope]"
      continue
    }
    if (-not $script:ShouldProcessHost.ShouldProcess("$($entry.Scope):$($entry.Name)", "Remove Memmy environment variable")) {
      continue
    }
    try {
      [Environment]::SetEnvironmentVariable($entry.Name, $null, (Get-EnvironmentTarget $entry.Scope))
      Write-Host "environment-removed: $($entry.Scope):$($entry.Name)"
    } catch {
      Add-ListItem $script:Failures "environment-remove-failed: $($entry.Scope):$($entry.Name) [$($_.Exception.Message)]"
    }
  }
}

function Get-MemmyProfilePaths {
  $documents = [Environment]::GetFolderPath([Environment+SpecialFolder]::MyDocuments)
  $paths = @(
    (Join-Path $env:USERPROFILE ".zshenv"),
    (Join-Path $env:USERPROFILE ".zprofile"),
    (Join-Path $env:USERPROFILE ".zshrc"),
    (Join-Path $env:USERPROFILE ".zlogin"),
    (Join-Path $env:USERPROFILE ".profile"),
    (Join-Path $env:USERPROFILE ".bash_profile"),
    (Join-Path $env:USERPROFILE ".bash_login"),
    (Join-Path $env:USERPROFILE ".bashrc")
  )
  if ($documents) {
    foreach ($relative in @(
      "WindowsPowerShell\profile.ps1",
      "WindowsPowerShell\Microsoft.PowerShell_profile.ps1",
      "WindowsPowerShell\Microsoft.VSCode_profile.ps1",
      "PowerShell\profile.ps1",
      "PowerShell\Microsoft.PowerShell_profile.ps1",
      "PowerShell\Microsoft.VSCode_profile.ps1"
    )) {
      $paths += Join-Path $documents $relative
    }
  }
  foreach ($propertyName in @("CurrentUserAllHosts", "CurrentUserCurrentHost")) {
    $profilePath = [string](Get-ObjectPropertyValue $PROFILE $propertyName)
    if ($profilePath) {
      $paths += $profilePath
    }
  }

  $result = [ordered]@{}
  foreach ($path in $paths) {
    $normalized = Expand-NormalizedPath $path
    if ($normalized) {
      $result[$normalized.ToLowerInvariant()] = $normalized
    }
  }
  return @($result.Values)
}

function Get-ProfileTextRecord {
  param([string]$Path)

  $bytes = [IO.File]::ReadAllBytes($Path)
  $offset = 0
  $hasPreamble = $false
  if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) {
    $encoding = [System.Text.UTF8Encoding]::new($true, $true)
    $offset = 3
    $hasPreamble = $true
  } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFF -and $bytes[1] -eq 0xFE) {
    $encoding = [System.Text.UnicodeEncoding]::new($false, $true, $true)
    $offset = 2
    $hasPreamble = $true
  } elseif ($bytes.Length -ge 2 -and $bytes[0] -eq 0xFE -and $bytes[1] -eq 0xFF) {
    $encoding = [System.Text.UnicodeEncoding]::new($true, $true, $true)
    $offset = 2
    $hasPreamble = $true
  } else {
    $encoding = [System.Text.UTF8Encoding]::new($false, $true)
  }

  $text = $encoding.GetString($bytes, $offset, $bytes.Length - $offset)
  return [pscustomobject]@{
    Text = $text
    Encoding = $encoding
    HasPreamble = $hasPreamble
  }
}

function Write-ProfileTextRecord {
  param(
    [string]$Path,
    [string]$Text,
    [object]$Record
  )

  $body = $Record.Encoding.GetBytes($Text)
  if ($Record.HasPreamble) {
    $preamble = $Record.Encoding.GetPreamble()
  } else {
    $preamble = New-Object byte[] 0
  }
  $output = New-Object byte[] ($preamble.Length + $body.Length)
  [Array]::Copy($preamble, 0, $output, 0, $preamble.Length)
  [Array]::Copy($body, 0, $output, $preamble.Length, $body.Length)
  [IO.File]::WriteAllBytes($Path, $output)
}

function Get-CleanedProfileText {
  param([string]$Text)

  $managedPathPattern = '(?m)^[ \t]*# Memmy CLI PATH[ \t]*\r?\n[ \t]*export[ \t]+PATH="\$HOME/\.local/bin:\$PATH"[ \t]*(?:\r?\n|$)'
  $environmentPattern = '(?m)^(?![^\r\n]*\\[ \t]*\r?$)[ \t]*(?:export[ \t]+)?(?:MEMMY_|MEMORY_SERVICE_)[A-Za-z0-9_]*=(?:"(?:\\.|[^"\\])*"|''[^'']*''|[^\s;&|`]*?)[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)'
  $powershellEnvironmentPattern = '(?m)^(?![^\r\n]*`[ \t]*\r?$)[ \t]*\$env:(?:MEMMY_|MEMORY_SERVICE_)[A-Za-z0-9_]*[ \t]*=[ \t]*(?:"(?:`.|[^"`])*"|''[^'']*''|[^\s;|&`]*?)[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)'
  $cleaned = [Regex]::Replace($Text, $managedPathPattern, "")
  $cleaned = [Regex]::Replace($cleaned, $environmentPattern, "")
  return [Regex]::Replace($cleaned, $powershellEnvironmentPattern, "")
}

function Test-ProfileHasMemmyEntries {
  param([string]$Text)

  return ($Text -match '(?mi)^[ \t]*(?:# Memmy CLI PATH[ \t]*$|(?:export[ \t]+)?(?:MEMMY_|MEMORY_SERVICE_)[A-Za-z0-9_]*=|\$env:(?:MEMMY_|MEMORY_SERVICE_)[A-Za-z0-9_]*[ \t]*=)')
}

function Remove-MemmyProfileEntries {
  Write-Step "Removing exact Memmy entries from shell profiles"
  foreach ($path in Get-MemmyProfilePaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      continue
    }
    if (Test-HasReparsePointAncestor $path -IncludeLeaf) {
      Add-ListItem $script:Failures "profile-reparse-path-retained: $path"
      continue
    }
    try {
      $record = Get-ProfileTextRecord $path
      $cleaned = Get-CleanedProfileText $record.Text
      if (Test-ProfileHasMemmyEntries $cleaned) {
        Add-ListItem $script:Failures "profile-complex-entry-retained: $path [review compound Memmy shell commands manually]"
      }
      if ($cleaned -ceq $record.Text) {
        continue
      }
      if ($script:ShouldProcessHost.ShouldProcess($path, "Remove exact Memmy profile entries")) {
        Write-ProfileTextRecord $path $cleaned $record
        Write-Host "profile-cleaned: $path"
      }
    } catch {
      Add-ListItem $script:Failures "profile-clean-failed: $path [$($_.Exception.Message)]"
    }
  }
}

function Send-EnvironmentChangedBroadcast {
  if ($WhatIfPreference) {
    return
  }
  if (-not $script:ShouldProcessHost.ShouldProcess("Windows environment listeners", "Broadcast environment change")) {
    return
  }
  try {
    if (-not ("MemmyEnvironmentBroadcast" -as [type])) {
      Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class MemmyEnvironmentBroadcast
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd,
        uint Msg,
        UIntPtr wParam,
        string lParam,
        uint fuFlags,
        uint uTimeout,
        out UIntPtr lpdwResult);
}
"@
    }
    $result = [UIntPtr]::Zero
    [void][MemmyEnvironmentBroadcast]::SendMessageTimeout(
      [IntPtr]0xFFFF,
      0x001A,
      [UIntPtr]::Zero,
      "Environment",
      0x0002,
      5000,
      [ref]$result
    )
  } catch {
    Add-ListItem $script:Failures "environment-broadcast-failed: $($_.Exception.Message)"
  }
}

function Remove-RegistryPathIfPresent {
  param(
    [string]$Path,
    [string]$Reason
  )

  if (-not (Test-Path -LiteralPath $Path)) {
    return
  }
  if (-not $script:ShouldProcessHost.ShouldProcess($Path, "Remove $Reason")) {
    return
  }
  try {
    Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    Write-Host "registry-deleted: $Path"
  } catch {
    Add-ListItem $script:Failures "registry-delete-failed: $Path [$($_.Exception.Message)]"
  }
}

function Remove-MemmyRegistryTraces {
  Write-Step "Removing Memmy registry traces"

  foreach ($entry in $script:UninstallEntries) {
    $installStillExists = $entry.InstallLocation -and (Test-IsVerifiedMemmyInstallRoot $entry.InstallLocation)
    if ($installStillExists) {
      Add-ListItem $script:Failures "uninstall-registry-retained: $($entry.RegistryPath) [installation remains at $($entry.InstallLocation)]"
      continue
    }
    Remove-RegistryPathIfPresent $entry.RegistryPath "Memmy uninstall registration"
  }

  $knownInstallKeys = @(
    "Registry::HKEY_CURRENT_USER\Software\$($script:NsisGuid)",
    "Registry::HKEY_CURRENT_USER\Software\WOW6432Node\$($script:NsisGuid)"
  )
  if ($IncludeMachineScope) {
    $knownInstallKeys += @(
      "Registry::HKEY_LOCAL_MACHINE\Software\$($script:NsisGuid)",
      "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\$($script:NsisGuid)"
    )
  }
  foreach ($path in $knownInstallKeys) {
    if (-not (Test-Path -LiteralPath $path)) {
      continue
    }
    try {
      $properties = Get-ItemProperty -LiteralPath $path -ErrorAction Stop
      $installLocation = Expand-NormalizedPath ([string](Get-ObjectPropertyValue $properties "InstallLocation"))
      if ($installLocation -and (Test-IsVerifiedMemmyInstallRoot $installLocation)) {
        Add-ListItem $script:Failures "install-registry-retained: $path [installation remains at $installLocation]"
        continue
      }
      Remove-RegistryPathIfPresent $path "Memmy known installation registration"
    } catch {
      Add-ListItem $script:Failures "install-registry-clean-failed: $path [$($_.Exception.Message)]"
    }
  }

  $userKeys = @(
    "Registry::HKEY_CURRENT_USER\Software\Memmy",
    "Registry::HKEY_CURRENT_USER\Software\$($script:AppId)",
    "Registry::HKEY_CURRENT_USER\Software\Classes\Applications\Memmy.exe",
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Memmy.exe"
  )
  foreach ($path in $userKeys) {
    Remove-RegistryPathIfPresent $path "Memmy current-user registration"
  }

  if ($IncludeMachineScope) {
    foreach ($path in @(
      "Registry::HKEY_LOCAL_MACHINE\Software\Memmy",
      "Registry::HKEY_LOCAL_MACHINE\Software\$($script:AppId)",
      "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\Memmy.exe"
    )) {
      Remove-RegistryPathIfPresent $path "Memmy machine registration"
    }
  }

  $runPaths = @(
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run",
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\RunOnce"
  )
  if ($IncludeMachineScope) {
    $runPaths += @(
      "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Run",
      "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    )
  }
  foreach ($runPath in $runPaths) {
    if (-not (Test-Path -LiteralPath $runPath)) {
      continue
    }
    try {
      $properties = Get-ItemProperty -LiteralPath $runPath -ErrorAction Stop
      foreach ($name in @("Memmy", $script:AppId)) {
        if ($null -ne $properties.PSObject.Properties[$name] -and
            $script:ShouldProcessHost.ShouldProcess("$($runPath)::$name", "Remove Memmy startup value")) {
          Remove-ItemProperty -LiteralPath $runPath -Name $name -Force -ErrorAction Stop
          Write-Host "registry-value-deleted: $($runPath)::$name"
        }
      }
    } catch {
      Add-ListItem $script:Failures "startup-registry-clean-failed: $runPath [$($_.Exception.Message)]"
    }
  }
}

function Test-RemainingState {
  Write-Step "Verifying cleanup result"
  if ($WhatIfPreference) {
    Write-Host "what-if: verification is informational because no changes were applied"
    return
  }

  foreach ($target in $script:Targets.Values) {
    if (Test-Path -LiteralPath $target.Path) {
      Add-ListItem $script:Failures "still-exists: $($target.Path)"
    }
  }
  foreach ($path in $script:InstallerManagedRoots.Values) {
    if (Test-IsVerifiedMemmyInstallRoot $path) {
      Add-ListItem $script:Failures "installer-managed-installation-still-present: $path"
    }
  }
  foreach ($path in $script:ObservedRunningInstallRoots.Values) {
    $indicators = @(
      (Join-Path $path "Memmy.exe"),
      (Join-Path $path "Uninstall Memmy.exe"),
      (Join-Path $path "resources\app.asar"),
      (Join-Path $path "resources\cli\memmy.cmd")
    )
    if (@($indicators | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }).Count -gt 0) {
      Add-ListItem $script:Failures "observed-running-installation-still-present: $path"
    }
  }

  $remainingProcesses = @(Get-MemmyProcesses)
  foreach ($process in $remainingProcesses) {
    Add-ListItem $script:Failures "process-still-running: PID $($process.ProcessId) ($($process.Name))"
  }

  foreach ($scope in @("Process", "User")) {
    $variables = [Environment]::GetEnvironmentVariables((Get-EnvironmentTarget $scope))
    foreach ($name in $variables.Keys) {
      if ([string]$name -match "(?i)^(MEMMY_|MEMORY_SERVICE_)[A-Z0-9_]*$") {
        Add-ListItem $script:Failures "environment-still-present: $($scope):$name"
      }
    }
  }
  if ($IncludeMachineScope) {
    $variables = [Environment]::GetEnvironmentVariables([EnvironmentVariableTarget]::Machine)
    foreach ($name in $variables.Keys) {
      if ([string]$name -match "(?i)^(MEMMY_|MEMORY_SERVICE_)[A-Z0-9_]*$") {
        Add-ListItem $script:Failures "environment-still-present: Machine:$name"
      }
    }
  }

  foreach ($path in Get-MemmyProfilePaths) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      continue
    }
    if (Test-HasReparsePointAncestor $path -IncludeLeaf) {
      Add-ListItem $script:Failures "profile-reparse-path-retained: $path"
      continue
    }
    try {
      $record = Get-ProfileTextRecord $path
      if (Test-ProfileHasMemmyEntries $record.Text) {
        Add-ListItem $script:Failures "profile-entry-still-present: $path"
      }
    } catch {
      Add-ListItem $script:Failures "profile-verify-failed: $path [$($_.Exception.Message)]"
    }
  }

  $pathScopes = @("Process", "User")
  if ($IncludeMachineScope) {
    $pathScopes += "Machine"
  }
  foreach ($scope in $pathScopes) {
    $remainingPath = Get-RawPathValue $scope
    if ($remainingPath.Value) {
      foreach ($segment in $remainingPath.Value.Split(';')) {
        $normalized = Expand-NormalizedPath $segment
        if ($normalized -and $script:CliDirectories.Contains($normalized.ToLowerInvariant().TrimEnd('\'))) {
          Add-ListItem $script:Failures "path-entry-still-present: $scope $normalized"
        }
      }
    }
  }

  $registryPaths = @(
    "Registry::HKEY_CURRENT_USER\Software\$($script:NsisGuid)",
    "Registry::HKEY_CURRENT_USER\Software\WOW6432Node\$($script:NsisGuid)",
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($script:NsisGuid)",
    "Registry::HKEY_CURRENT_USER\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$($script:NsisGuid)",
    "Registry::HKEY_CURRENT_USER\Software\Memmy",
    "Registry::HKEY_CURRENT_USER\Software\$($script:AppId)",
    "Registry::HKEY_CURRENT_USER\Software\Classes\Applications\Memmy.exe",
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\Memmy.exe"
  )
  if ($IncludeMachineScope) {
    $registryPaths += @(
      "Registry::HKEY_LOCAL_MACHINE\Software\$($script:NsisGuid)",
      "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\$($script:NsisGuid)",
      "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall\$($script:NsisGuid)",
      "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\$($script:NsisGuid)",
      "Registry::HKEY_LOCAL_MACHINE\Software\Memmy",
      "Registry::HKEY_LOCAL_MACHINE\Software\$($script:AppId)",
      "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\Memmy.exe"
    )
  }
  foreach ($entry in $script:UninstallEntries) {
    $registryPaths += $entry.RegistryPath
  }
  foreach ($path in @($registryPaths | Sort-Object -Unique)) {
    if (Test-Path -LiteralPath $path) {
      Add-ListItem $script:Failures "registry-still-present: $path"
    }
  }

  $runPaths = @(
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run",
    "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\RunOnce"
  )
  if ($IncludeMachineScope) {
    $runPaths += @(
      "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Run",
      "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\RunOnce"
    )
  }
  foreach ($runPath in $runPaths) {
    if (-not (Test-Path -LiteralPath $runPath)) {
      continue
    }
    $properties = Get-ItemProperty -LiteralPath $runPath -ErrorAction SilentlyContinue
    foreach ($name in @("Memmy", $script:AppId)) {
      if ($null -ne $properties -and $null -ne $properties.PSObject.Properties[$name]) {
        Add-ListItem $script:Failures "startup-registry-value-still-present: $($runPath)::$name"
      }
    }
  }

  foreach ($package in @(Get-LegacyMsixPackages)) {
    Add-ListItem $script:Failures "msix-still-present: $($package.PackageFullName)"
  }
}

function Write-Summary {
  Write-Step "Summary"
  Write-Host "deleted-count: $($script:Removed.Count)"
  Write-Host "missing-count: $($script:Missing.Count)"
  Write-Host "retained-for-safety-count: $($script:Retained.Count)"
  Write-Host "failure-count: $($script:Failures.Count)"

  if ($script:Retained.Count -gt 0) {
    Write-Host "`nRetained or skipped for safety:" -ForegroundColor Yellow
    foreach ($item in $script:Retained) {
      Write-Host "  $item"
    }
  }
  if ($script:Failures.Count -gt 0) {
    Write-Host "`nFailures or remaining traces:" -ForegroundColor Red
    foreach ($item in $script:Failures) {
      Write-Host "  $item"
    }
  }

  if ($WhatIfPreference) {
    Write-Host "`nWhatIf completed. No changes were made." -ForegroundColor Yellow
    if ($script:Failures.Count -gt 0) {
      return 1
    }
    return 0
  }
  if ($script:Failures.Count -gt 0) {
    Write-Host "`nMemmy cleanup completed with unresolved items." -ForegroundColor Red
    return 1
  }

  Write-Host "`nMemmy cleanup completed successfully." -ForegroundColor Green
  Write-Host "Fully close and reopen terminals, Codex, and other parent applications before reinstalling or testing."
  return 0
}

if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) {
  throw "This script can only run on Windows."
}
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  throw "Run this script from 64-bit Windows PowerShell so both 64-bit and WOW6432Node registry views are handled predictably."
}

$script:IsAdministrator = Test-IsAdministrator
if ($IncludeMachineScope -and -not $script:IsAdministrator) {
  throw "-IncludeMachineScope requires an already elevated PowerShell session. No changes were made."
}
Initialize-ProtectedProcessIds

Write-Step "Discovering Memmy installation and data paths"
Add-DefaultTargets
Add-MachineTargets
Add-RepositoryTargets
$script:EnvironmentEntries = @(Get-MemmyEnvironmentEntries)
$script:UninstallEntries = @(Get-MemmyUninstallEntries)
foreach ($entry in $script:UninstallEntries) {
  if ($entry.InstallLocation) {
    Add-InstallRoot $entry.InstallLocation "Uninstall registry: $($entry.RegistryPath)" -KnownRegistry:$entry.KnownGuid
  }
}
Add-KnownInstallRegistryRoots
Discover-CliDirectoriesFromPath
Discover-VerifiedGlobalCliTargets
Discover-InstallRootsFromRunningProcesses
foreach ($path in $AdditionalMemmyHome) {
  Add-Target $path "Directory" "Explicit AdditionalMemmyHome" "Explicit"
  $normalizedAdditionalHome = Expand-NormalizedPath $path
  if ($normalizedAdditionalHome -and $script:Targets.Contains($normalizedAdditionalHome.ToLowerInvariant())) {
    Add-ProcessRoot $normalizedAdditionalHome "Explicit AdditionalMemmyHome process root"
  }
}
Add-Target (Join-Path $env:USERPROFILE ".memmy\config.yaml") "File" "Default Memmy config" "ExactFile"
Add-Target (Join-Path $env:USERPROFILE ".memmy-intl\config.yaml") "File" "Legacy international config" "ExactFile"
Add-ShortcutTargets
Record-ExternalEnvironmentPaths
Record-ExternalConfigDatabasePaths
$script:LegacyMsixPackages = @(Get-LegacyMsixPackages)

Write-Host "discovered-install-roots: $($script:InstallRoots.Count)"
Write-Host "discovered-path-targets: $($script:Targets.Count)"
Write-Host "discovered-environment-variables: $($script:EnvironmentEntries.Count)"
Write-Host "discovered-uninstall-records: $($script:UninstallEntries.Count)"

if (-not $Force -and -not $WhatIfPreference) {
  Write-Host "`nWARNING: This permanently deletes Memmy application state and local data." -ForegroundColor Red
  $confirmation = Read-Host "Type CLEAR MEMMY to continue"
  if ($confirmation -cne "CLEAR MEMMY") {
    Write-Host "Canceled. No changes were made."
    exit 2
  }
}

Stop-MemmyProcesses
Invoke-MemmyUninstallers
Remove-LegacyMsixPackages
Stop-MemmyProcesses
Remove-MemmyPathEntries
Remove-MemmyEnvironmentVariables
Remove-MemmyProfileEntries
Send-EnvironmentChangedBroadcast
Remove-SafeTargets
Remove-MemmyRegistryTraces
Test-RemainingState
$exitCode = Write-Summary
exit $exitCode
