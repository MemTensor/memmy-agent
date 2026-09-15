[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("cn", "intl")]
  [string]$Channel
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$canonicalConfigPath = Join-Path `
  $root `
  "App\shell\desktop\build\store-publishing-profiles.json"
$profileResolverPath = Join-Path $PSScriptRoot "windows-store-publishing-profile.ps1"
. $profileResolverPath
$packageVersionResolverPath = Join-Path $PSScriptRoot "windows-store-package-version.ps1"
. $packageVersionResolverPath

if ($env:MEMMY_STORE_PUBLISHING_CONFIG_PATH) {
  throw "MEMMY_STORE_PUBLISHING_CONFIG_PATH is not supported by the canonical Windows Store build."
}

$profile = Resolve-MemmyStorePublishingProfile `
  -ConfigPath $canonicalConfigPath `
  -Channel $Channel

function Assert-ExactWindowsStoreBuildEnvironmentValue {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Expected
  )

  $actual = [Environment]::GetEnvironmentVariable(
    $Name,
    [EnvironmentVariableTarget]::Process
  )
  if (-not [string]::Equals($actual, $Expected, [StringComparison]::Ordinal)) {
    throw "Windows AppX build environment '$Name' must exactly match company/$Channel. Expected '$Expected', found '$actual'."
  }
}

$expectedValues = [ordered]@{
  MEMMY_WINDOWS_APPX_IDENTITY_NAME = $profile.IdentityName
  MEMMY_WINDOWS_APPX_APPLICATION_ID = $profile.ApplicationId
  MEMMY_WINDOWS_APPX_PUBLISHER = $profile.Publisher
  MEMMY_WINDOWS_APPX_PUBLISHER_DISPLAY_NAME = $profile.PublisherDisplayName
  MEMMY_WINDOWS_APPX_DISPLAY_NAME = $profile.WindowsDisplayName
  MEMMY_STORE_PRODUCT_ID = $profile.StoreProductId
  MEMMY_STORE_LISTING_DISPLAY_NAME = $profile.StoreListingDisplayName
  MEMMY_STORE_PUBLISHER = $profile.Publisher
  MEMMY_STORE_PUBLISHER_DISPLAY_NAME = $profile.PublisherDisplayName
  MEMMY_STORE_WINDOWS_DISPLAY_NAME = $profile.WindowsDisplayName
  MEMMY_STORE_IDENTITY_NAME = $profile.IdentityName
  MEMMY_STORE_APPLICATION_ID = $profile.ApplicationId
  MEMMY_STORE_PACKAGE_FAMILY_NAME = $profile.PackageFamilyName
  MEMMY_STORE_AUMID = $profile.Aumid
  MEMMY_STORE_LEGACY_NSIS_AUMID = $profile.LegacyNsisAumid
}

foreach ($entry in $expectedValues.GetEnumerator()) {
  Assert-ExactWindowsStoreBuildEnvironmentValue `
    -Name $entry.Key `
    -Expected ([string]$entry.Value)
}

Assert-ExactWindowsStoreBuildEnvironmentValue `
  -Name "MEMMY_WINDOWS_BUILDER_CONFIG" `
  -Expected "electron-builder.store.unsigned.yml"

$packageVersion = $env:MEMMY_WINDOWS_APPX_PACKAGE_VERSION
if ([string]::IsNullOrWhiteSpace($packageVersion)) {
  throw "MEMMY_WINDOWS_APPX_PACKAGE_VERSION is required for Windows AppX packaging."
}
$manifestRelativePath = $env:MEMMY_WINDOWS_APPX_CUSTOM_MANIFEST_PATH
if ($manifestRelativePath -cnotmatch '^build/appx-manifest\.generated\.[0-9]+\.xml$') {
  throw "MEMMY_WINDOWS_APPX_CUSTOM_MANIFEST_PATH must name the canonical generated Store manifest file."
}
$manifestPath = Join-Path $root "App\shell\desktop\$manifestRelativePath"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Canonical generated Store manifest file was not found: $manifestPath"
}
$manifestTemplatePath = Join-Path $root "App\shell\desktop\build\appx-manifest.xml"
$manifestTemplate = Get-Content -Raw -LiteralPath $manifestTemplatePath
$expectedManifest = New-MemmyWindowsStoreVersionedManifestContent `
  -Template $manifestTemplate `
  -PackageVersion $packageVersion `
  -StoreListingDisplayName $profile.StoreListingDisplayName
$actualManifest = Get-Content -Raw -LiteralPath $manifestPath
if (-not [string]::Equals(
  $actualManifest,
  $expectedManifest,
  [StringComparison]::Ordinal
)) {
  throw "Generated Store manifest must exactly match the canonical template with only its package version and Store listing display name replaced."
}

$extensionsRelativePath = $env:MEMMY_WINDOWS_APPX_CUSTOM_EXTENSIONS_PATH
if ($extensionsRelativePath -cnotmatch '^build/appx-extensions\.generated\.[0-9]+\.xml$') {
  throw "MEMMY_WINDOWS_APPX_CUSTOM_EXTENSIONS_PATH must name the canonical generated Store extensions file."
}
$extensionsPath = Join-Path $root "App\shell\desktop\$extensionsRelativePath"
if (-not (Test-Path -LiteralPath $extensionsPath -PathType Leaf)) {
  throw "Canonical generated Store extensions file was not found: $extensionsPath"
}
$extensions = Get-Content -Raw -LiteralPath $extensionsPath
if (-not $extensions.Contains("AumId=`"$($profile.LegacyNsisAumid)`"")) {
  throw "Generated Store extensions do not contain the exact legacy NSIS AUMID."
}
if ($extensions.Contains($profile.Aumid)) {
  throw "Generated Store extensions must not use the Store AUMID as the legacy desktop migration source."
}
