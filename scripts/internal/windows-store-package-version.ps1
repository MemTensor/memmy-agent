Set-StrictMode -Version Latest

function Resolve-MemmyWindowsStorePackageVersion {
  param(
    [Parameter(Mandatory = $true)][string]$AppVersion,
    [AllowEmptyString()][string]$StoreBuild = ''
  )

  if ($AppVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') {
    throw "Windows Store AppVersion must be a three-part semantic version."
  }

  $segments = @($AppVersion.Split("."))
  $numericSegments = @()
  foreach ($segment in $segments) {
    [uint32]$segmentValue = 0
    if (-not [uint32]::TryParse($segment, [ref]$segmentValue) -or $segmentValue -gt 65535) {
      throw "Windows Store AppVersion segments must be between 0 and 65535: $AppVersion"
    }
    $numericSegments += $segmentValue
  }
  if ($numericSegments[0] -eq 0) {
    throw "Windows Store AppVersion major segment must be between 1 and 65535: $AppVersion"
  }

  $patch = [uint64]$numericSegments[2]
  $storeBuildText = if ([string]::IsNullOrEmpty($StoreBuild)) { $null } else { $StoreBuild }
  if ($null -ne $storeBuildText -and $storeBuildText -notmatch '^\d{1,2}$') {
    throw "StoreBuild must be omitted or contain one or two decimal digits: $StoreBuild"
  }

  if ($null -eq $storeBuildText) {
    $packageBuild = $patch
    $artifactVersionLabel = $AppVersion
  } else {
    [uint64]$packageBuild = 0
    $candidateBuild = "$patch$storeBuildText"
    if (-not [uint64]::TryParse($candidateBuild, [ref]$packageBuild) -or $packageBuild -gt 65535) {
      throw "MSIX build segment must not exceed 65535: AppVersion=$AppVersion StoreBuild=$storeBuildText PackageBuild=$candidateBuild"
    }
    $artifactVersionLabel = "$AppVersion-$storeBuildText"
  }

  return [pscustomobject]@{
    AppVersion = $AppVersion
    StoreBuild = $storeBuildText
    StoreBuildLabel = if ($null -eq $storeBuildText) { '' } else { $storeBuildText }
    ArtifactVersionLabel = $artifactVersionLabel
    PackageVersion = "$($numericSegments[0]).$($numericSegments[1]).$packageBuild.0"
  }
}

function New-MemmyWindowsStoreVersionedManifestContent {
  param(
    [Parameter(Mandatory = $true)][string]$Template,
    [Parameter(Mandatory = $true)][string]$PackageVersion,
    [Parameter(Mandatory = $true)][string]$StoreListingDisplayName
  )

  if ($PackageVersion -notmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\.0$') {
    throw "Windows Store PackageVersion must contain four numeric segments and end in .0: $PackageVersion"
  }
  $packageSegments = @($PackageVersion.Split("."))
  foreach ($segment in $packageSegments) {
    [uint32]$segmentValue = 0
    if (-not [uint32]::TryParse($segment, [ref]$segmentValue) -or $segmentValue -gt 65535) {
      throw "Windows Store PackageVersion segments must be between 0 and 65535: $PackageVersion"
    }
  }
  if ([uint32]$packageSegments[0] -eq 0) {
    throw "Windows Store PackageVersion major segment must be between 1 and 65535: $PackageVersion"
  }

  $replacements = [ordered]@{
    'Version="${version}"' = "Version=`"$PackageVersion`""
    '<DisplayName>${storeListingDisplayName}</DisplayName>' = "<DisplayName>$([Security.SecurityElement]::Escape($StoreListingDisplayName))</DisplayName>"
  }
  $manifest = $Template
  foreach ($entry in $replacements.GetEnumerator()) {
    $placeholder = $entry.Key
    $placeholderIndex = $Template.IndexOf($placeholder, [StringComparison]::Ordinal)
    if ($placeholderIndex -lt 0) {
      throw "Canonical Store manifest template is missing $placeholder."
    }
    $nextPlaceholderIndex = $Template.IndexOf(
      $placeholder,
      $placeholderIndex + $placeholder.Length,
      [StringComparison]::Ordinal
    )
    if ($nextPlaceholderIndex -ge 0) {
      throw "Canonical Store manifest template must contain exactly one $placeholder."
    }
    $manifest = $manifest.Replace($placeholder, $entry.Value)
  }

  return $manifest
}
