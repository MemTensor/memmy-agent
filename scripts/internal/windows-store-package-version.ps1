Set-StrictMode -Version Latest

function Resolve-MemmyWindowsStorePackageVersion {
  param(
    [Parameter(Mandatory = $true)][string]$AppVersion,
    [ValidateRange(0, 99)][int]$StoreBuild = 0
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

  [uint64]$encodedBuild = ([uint64]$numericSegments[2] * 100) + [uint64]$StoreBuild
  if ($encodedBuild -gt 65535) {
    throw "Encoded MSIX build segment must not exceed 65535: AppVersion=$AppVersion StoreBuild=$StoreBuild EncodedBuild=$encodedBuild"
  }

  return [pscustomobject]@{
    AppVersion = $AppVersion
    StoreBuild = $StoreBuild
    StoreBuildLabel = $StoreBuild.ToString("00")
    PackageVersion = "$($numericSegments[0]).$($numericSegments[1]).$encodedBuild.0"
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
