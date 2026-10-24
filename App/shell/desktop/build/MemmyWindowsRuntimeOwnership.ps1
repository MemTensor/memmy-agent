param([string]$RuntimeHomePath = '', [switch]$LibraryOnly, [switch]$AcceptDriveRisk)

# Every consumer calls this before probing or reading a shared non-C runtime.
# An installation folder on the same drive still resolves to the same MemmyData.
function Get-MemmySharedRuntimeRoot([string]$RuntimeHomePath) {
  $path = [System.IO.Path]::GetFullPath($RuntimeHomePath).TrimEnd('\')
  $drive = [System.IO.Path]::GetPathRoot($path)
  if (-not $drive -or $drive -notmatch '^[A-Za-z]:\\$') { throw 'Memmy runtime must use a local drive' }
  $expected = Join-Path $drive 'MemmyData\.memmy'
  if ([string]::Equals($drive, 'C:\', [System.StringComparison]::OrdinalIgnoreCase) -or
      -not ([string]::Equals($path, $expected, [System.StringComparison]::OrdinalIgnoreCase) -or
        $path.StartsWith("$expected\", [System.StringComparison]::OrdinalIgnoreCase) -or
        $path.StartsWith("$expected.migration-backup-", [System.StringComparison]::OrdinalIgnoreCase))) { return $null }
  return Join-Path $drive 'MemmyData'
}

function Assert-MemmyOwnershipNoReparse([string]$Path) {
  $cursor = [System.IO.Path]::GetFullPath($Path)
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Memmy ownership path crosses a reparse point' }
    }
    $cursor = Split-Path -Parent $cursor
  }
}

function Get-MemmyOwnershipSid([string]$Path) {
  return (Get-Acl -LiteralPath $Path -ErrorAction Stop).GetOwner([System.Security.Principal.SecurityIdentifier]).Value
}

function New-MemmyPrivateAccessAcl([string]$Sid, [switch]$Directory) {
  # A per-user installer cannot SetOwner. The creator already owns a new object.
  $acl = if ($Directory) { New-Object System.Security.AccessControl.DirectorySecurity } else { New-Object System.Security.AccessControl.FileSecurity }
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($allowedSid in @($Sid, 'S-1-5-18', 'S-1-5-32-544')) {
    $identity = New-Object System.Security.Principal.SecurityIdentifier($allowedSid)
    $rule = if ($Directory) {
      New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit, ObjectInherit', 'None', 'Allow')
    } else {
      New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'Allow')
    }
    $acl.AddAccessRule($rule)
  }
  return $acl
}

function New-MemmyPrivateOwnershipAcl([string]$Sid, [switch]$Directory) {
  $acl = New-MemmyPrivateAccessAcl $Sid -Directory:$Directory
  $acl.SetOwner((New-Object System.Security.Principal.SecurityIdentifier($Sid)))
  return $acl
}

function Get-MemmyAcceptedDriveRiskPath {
  if (-not $env:LOCALAPPDATA) { return $null }
  return Join-Path $env:LOCALAPPDATA 'Memmy\data-layout\accepted-shared-drive-risk.json'
}

function Test-MemmyAcceptedDriveRisk([string]$DriveRoot, [string]$CurrentSid) {
  $path = Get-MemmyAcceptedDriveRiskPath
  if (-not $path -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  try {
    $accepted = Get-Content -LiteralPath $path -Raw -ErrorAction Stop | ConvertFrom-Json
    return [int]$accepted.schemaVersion -eq 1 -and [string]$accepted.windowsSid -eq $CurrentSid -and [string]$accepted.driveRoot -eq $DriveRoot
  } catch { return $false }
}

function Save-MemmyAcceptedDriveRisk([string]$DriveRoot, [string]$CurrentSid) {
  $path = Get-MemmyAcceptedDriveRiskPath
  if (-not $path) { throw 'LOCALAPPDATA is required to record shared-drive install risk acceptance' }
  $parent = Split-Path -Parent $path
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
  $payload = [ordered]@{ schemaVersion = 1; windowsSid = $CurrentSid; driveRoot = $DriveRoot }
  [System.IO.File]::WriteAllText($path, ($payload | ConvertTo-Json -Compress))
}

function Assert-MemmyOwnershipEvidence([string]$CurrentSid, [string]$OwnerSid, $Claim, [string]$ClaimOwnerSid) {
  if ($CurrentSid -notmatch '^S-1-(?:5-21|12-1)-\d+(?:-\d+)+$' -or $OwnerSid -ne $CurrentSid) { throw 'Cannot verify this Memmy data directory belongs to the current Windows account' }
  if ($null -ne $Claim) {
    if ($ClaimOwnerSid -ne $CurrentSid -or [int]$Claim.schemaVersion -ne 1 -or [string]$Claim.windowsSid -ne $CurrentSid) { throw 'Memmy data directory ownership claim does not match the current Windows account' }
  }
}

function Assert-MemmySharedRuntimeOwnership([string]$RuntimeHomePath) {
  $root = Get-MemmySharedRuntimeRoot $RuntimeHomePath
  if (-not $root) { return }
  try {
    $result = Assert-MemmyRuntimeRootOwnership $root
    Assert-MemmyOwnershipNoReparse $RuntimeHomePath
    if (Test-Path -LiteralPath $RuntimeHomePath) {
      Assert-MemmyOwnershipEvidence $result.currentSid (Get-MemmyOwnershipSid $RuntimeHomePath) $null ''
    }
    return $result
  } catch {
    if ($_.Exception.Message -like '*reparse*') { throw }
    $drive = [System.IO.Path]::GetPathRoot([System.IO.Path]::GetFullPath($RuntimeHomePath))
    $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    if (-not (Test-MemmyAcceptedDriveRisk $drive $sid)) { throw }
    Assert-MemmyOwnershipNoReparse $RuntimeHomePath
    return [ordered]@{ currentSid = $sid; ownerSid = $sid; claimOwnerSid = $sid; claimSid = $sid; fresh = $false }
  }
}

function Assert-MemmyRuntimeRootOwnership([string]$RootPath) {
  $ErrorActionPreference = 'Stop'
  $root = [System.IO.Path]::GetFullPath($RootPath).TrimEnd('\')
  $currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  Assert-MemmyOwnershipNoReparse $root
  $fresh = -not (Test-Path -LiteralPath $root)
  if ($fresh) {
    # Publish a fully private directory atomically. Never alter a raced/legacy root ACL.
    # Create as the current user, then protect the DACL. SetOwner requires elevation.
    $staging = "$root.owner-init-$([Guid]::NewGuid().ToString('N'))"
    try {
      New-Item -ItemType Directory -Path $staging -ErrorAction Stop | Out-Null
      Set-Acl -LiteralPath $staging -AclObject (New-MemmyPrivateAccessAcl $currentSid -Directory)
      [System.IO.Directory]::Move($staging, $root)
    } catch {
      if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw }
      $fresh = $false
    } finally {
      if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Force -ErrorAction SilentlyContinue }
    }
  }
  Assert-MemmyOwnershipNoReparse $root
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Memmy data root is not a directory' }
  $ownerSid = Get-MemmyOwnershipSid $root
  # No config/database or claim content is read before native root ownership is verified.
  Assert-MemmyOwnershipEvidence $currentSid $ownerSid $null ''
  foreach ($child in @('.memmy', 'updates')) {
    $childPath = Join-Path $root $child
    Assert-MemmyOwnershipNoReparse $childPath
    if (Test-Path -LiteralPath $childPath) {
      if (-not (Test-Path -LiteralPath $childPath -PathType Container)) { throw 'Memmy runtime/update root is not a directory' }
      Assert-MemmyOwnershipEvidence $currentSid (Get-MemmyOwnershipSid $childPath) $null ''
    }
  }
  $claimPath = Join-Path $root '.memmy-windows-owner.json'
  Assert-MemmyOwnershipNoReparse $claimPath
  if (-not (Test-Path -LiteralPath $claimPath)) {
    $claim = [ordered]@{ schemaVersion = 1; windowsSid = $currentSid }
    $bytes = [System.Text.UTF8Encoding]::new($false).GetBytes(($claim | ConvertTo-Json -Compress))
    $stream = $null
    try {
      $security = New-MemmyPrivateAccessAcl $currentSid
      $stream = New-Object System.IO.FileStream($claimPath, [System.IO.FileMode]::CreateNew, [System.Security.AccessControl.FileSystemRights]::Write, [System.IO.FileShare]::None, 4096, [System.IO.FileOptions]::None, $security)
      $stream.Write($bytes, 0, $bytes.Length)
    } catch {
      if (-not (Test-Path -LiteralPath $claimPath -PathType Leaf)) { throw }
    } finally { if ($null -ne $stream) { $stream.Dispose() } }
  }
  Assert-MemmyOwnershipNoReparse $claimPath
  # Pin the same claim file through native owner/DACL validation and JSON reading.
  # Legacy parents may allow DeleteChild; FileShare.Read prevents replacement/deletion.
  $claimHandle = [System.IO.File]::Open($claimPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  $reader = $null
  try {
    $claimOwnerSid = Get-MemmyOwnershipSid $claimPath
    if ($claimOwnerSid -ne $currentSid) { throw 'Memmy ownership claim belongs to another Windows account' }
    $claimAcl = Get-Acl -LiteralPath $claimPath
    if (-not $claimAcl.AreAccessRulesProtected) { throw 'Memmy ownership claim permissions cannot be verified' }
    foreach ($rule in $claimAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
      if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($currentSid, 'S-1-5-18', 'S-1-5-32-544')) { throw 'Memmy ownership claim is writable or readable by an unrelated account' }
    }
    $reader = New-Object System.IO.StreamReader($claimHandle, (New-Object System.Text.UTF8Encoding($false, $true)), $true)
    $claim = $reader.ReadToEnd() | ConvertFrom-Json
    Assert-MemmyOwnershipEvidence $currentSid $ownerSid $claim $claimOwnerSid
  } finally {
    if ($null -ne $reader) { $reader.Dispose() }
    $claimHandle.Dispose()
  }
  return [ordered]@{ currentSid = $currentSid; ownerSid = $ownerSid; claimOwnerSid = $claimOwnerSid; claimSid = [string]$claim.windowsSid; fresh = $fresh }
}

if (-not $LibraryOnly) {
  try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    if ($AcceptDriveRisk) {
      $acceptedPath = [System.IO.Path]::GetFullPath($RuntimeHomePath)
      $acceptedDrive = [System.IO.Path]::GetPathRoot($acceptedPath)
      $acceptedSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      if ($acceptedDrive -notmatch '^[A-Za-z]:\\$' -or [string]::Equals($acceptedDrive, 'C:\', [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Shared-drive risk acceptance applies only to a non-C local drive'
      }
      Assert-MemmyOwnershipNoReparse $acceptedPath
      Save-MemmyAcceptedDriveRisk $acceptedDrive $acceptedSid
    }
    $result = Assert-MemmySharedRuntimeOwnership $RuntimeHomePath
    if ($null -ne $result) { $result | ConvertTo-Json -Compress }
    exit 0
  } catch {
    [Console]::Error.WriteLine('MEMMY_WINDOWS_DATA_OWNERSHIP: Choose C: for a per-user installation, or use a separate drive. Another folder on this same drive cannot isolate Memmy data. ' + $_.Exception.Message)
    exit 5
  }
}
