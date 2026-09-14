Set-StrictMode -Version Latest

if (-not ([System.Management.Automation.PSTypeName]"Memmy.StorePublishing.PackageIdentityNative").Type) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

namespace Memmy.StorePublishing {
  public static class PackageIdentityNative {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PackageId {
      public UInt32 Reserved;
      public UInt32 ProcessorArchitecture;
      public UInt64 Version;
      [MarshalAs(UnmanagedType.LPWStr)] public string Name;
      [MarshalAs(UnmanagedType.LPWStr)] public string Publisher;
      [MarshalAs(UnmanagedType.LPWStr)] public string ResourceId;
      [MarshalAs(UnmanagedType.LPWStr)] public string PublisherId;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    private static extern int PackageFamilyNameFromId(
      ref PackageId packageId,
      ref UInt32 packageFamilyNameLength,
      StringBuilder packageFamilyName
    );

    public static string GetPackageFamilyName(string name, string publisher) {
      var packageId = new PackageId {
        Name = name,
        Publisher = publisher,
        ResourceId = String.Empty,
        PublisherId = null
      };
      UInt32 length = 0;
      var result = PackageFamilyNameFromId(ref packageId, ref length, null);
      const int ErrorInsufficientBuffer = 122;
      if (result != ErrorInsufficientBuffer) {
        throw new InvalidOperationException(
          "PackageFamilyNameFromId size query failed with error " + result + "."
        );
      }
      var value = new StringBuilder((int)length);
      result = PackageFamilyNameFromId(ref packageId, ref length, value);
      if (result != 0) {
        throw new InvalidOperationException(
          "PackageFamilyNameFromId failed with error " + result + "."
        );
      }
      return value.ToString();
    }
  }
}
'@
}

function Assert-ExactStorePublishingProperties {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string[]]$ExpectedProperties,
    [Parameter(Mandatory = $true)][string]$Context
  )

  if ($null -eq $Object) {
    throw "$Context is missing."
  }
  $actualProperties = @($Object.PSObject.Properties | ForEach-Object { $_.Name })
  foreach ($expectedProperty in $ExpectedProperties) {
    $exactMatches = @($actualProperties | Where-Object {
      [string]::Equals($_, $expectedProperty, [StringComparison]::Ordinal)
    })
    if ($exactMatches.Count -ne 1) {
      throw "$Context must contain the exact property '$expectedProperty'."
    }
  }
  foreach ($actualProperty in $actualProperties) {
    $exactMatches = @($ExpectedProperties | Where-Object {
      [string]::Equals($_, $actualProperty, [StringComparison]::Ordinal)
    })
    if ($exactMatches.Count -ne 1) {
      throw "$Context contains unsupported property '$actualProperty'."
    }
  }
}

function Get-RequiredStorePublishingValue {
  param(
    [Parameter(Mandatory = $true)]$Object,
    [Parameter(Mandatory = $true)][string]$PropertyName,
    [Parameter(Mandatory = $true)][string]$ProfileName
  )

  $property = @($Object.PSObject.Properties | Where-Object {
    [string]::Equals($_.Name, $PropertyName, [StringComparison]::Ordinal)
  })
  if (
    $property.Count -ne 1 -or
    $null -eq $property[0].Value -or
    [string]::IsNullOrWhiteSpace([string]$property[0].Value)
  ) {
    throw "Windows Store publishing profile '$ProfileName' is not configured: missing $PropertyName."
  }
  return [string]$property[0].Value
}

function Register-UniqueStorePublishingValue {
  param(
    [Parameter(Mandatory = $true)]
    [Collections.Generic.Dictionary[string, string]]$SeenValues,
    [Parameter(Mandatory = $true)][string]$FieldName,
    [Parameter(Mandatory = $true)][string]$Value,
    [Parameter(Mandatory = $true)][string]$ProfileName
  )

  if ($SeenValues.ContainsKey($Value)) {
    throw "Windows Store publishing profiles '$($SeenValues[$Value])' and '$ProfileName' reuse $FieldName '$Value'. Each company Store product must use a unique identity."
  }
  $SeenValues.Add($Value, $ProfileName)
}

function Assert-MemmyCompanyStorePublishingConfig {
  param([Parameter(Mandatory = $true)]$Config)

  $expectedCommon = [ordered]@{
    publisher = "CN=2CA03910-614F-4524-BAEC-BAE9D6F10DD0"
    publisherDisplayName = "Memtensor"
    windowsDisplayName = "Memmy"
    legacyNsisAumid = "cn.memtensor.memmy"
  }
  foreach ($entry in $expectedCommon.GetEnumerator()) {
    $actual = [string]$Config.PSObject.Properties[$entry.Key].Value
    if (-not [string]::Equals($actual, $entry.Value, [StringComparison]::Ordinal)) {
      throw "Canonical Windows Store company profile '$($entry.Key)' must exactly match '$($entry.Value)'."
    }
  }

  $expectedApplications = [ordered]@{
    cn = [ordered]@{
      storeProductId = "9MZGLKWMZZV6"
      identityName = "Memtensor.Memmy"
      manifestApplicationId = "Memmy"
      packageFamilyName = "Memtensor.Memmy_eyack96k521x2"
    }
    intl = [ordered]@{
      storeProductId = "9NFVJC9K7ZK9"
      identityName = "Memtensor.MemmyAgent"
      manifestApplicationId = "Memmy"
      packageFamilyName = "Memtensor.MemmyAgent_eyack96k521x2"
    }
  }
  foreach ($channelEntry in $expectedApplications.GetEnumerator()) {
    $application = $Config.applications.PSObject.Properties[$channelEntry.Key].Value
    foreach ($fieldEntry in $channelEntry.Value.GetEnumerator()) {
      $actual = [string]$application.PSObject.Properties[$fieldEntry.Key].Value
      if (-not [string]::Equals($actual, $fieldEntry.Value, [StringComparison]::Ordinal)) {
        throw "Canonical Windows Store company/$($channelEntry.Key) '$($fieldEntry.Key)' must exactly match '$($fieldEntry.Value)'."
      }
    }
  }
}

function Get-ValidatedStorePublishingProfiles {
  param([Parameter(Mandatory = $true)]$Config)

  Assert-ExactStorePublishingProperties `
    -Object $Config `
    -ExpectedProperties @(
      "schemaVersion",
      "publisher",
      "publisherDisplayName",
      "windowsDisplayName",
      "legacyNsisAumid",
      "applications"
    ) `
    -Context "Windows Store publishing config"
  if ([string]$Config.schemaVersion -cne "2") {
    throw "Windows Store publishing config must use schemaVersion 2."
  }

  $publisher = Get-RequiredStorePublishingValue `
    -Object $Config -PropertyName "publisher" -ProfileName "company"
  $publisherDisplayName = Get-RequiredStorePublishingValue `
    -Object $Config -PropertyName "publisherDisplayName" -ProfileName "company"
  $windowsDisplayName = Get-RequiredStorePublishingValue `
    -Object $Config -PropertyName "windowsDisplayName" -ProfileName "company"
  $legacyNsisAumid = Get-RequiredStorePublishingValue `
    -Object $Config -PropertyName "legacyNsisAumid" -ProfileName "company"
  Assert-ExactStorePublishingProperties `
    -Object $Config.applications `
    -ExpectedProperties @("cn", "intl") `
    -Context "Windows Store publishing applications"

  if ($publisher.Length -gt 8192) {
    throw "Windows Store publisher is too long."
  }
  if ($publisherDisplayName.Length -gt 256 -or $windowsDisplayName.Length -gt 256) {
    throw "Windows Store display names must not exceed 256 characters."
  }
  if (-not [string]::Equals(
    $legacyNsisAumid,
    "cn.memtensor.memmy",
    [StringComparison]::Ordinal
  )) {
    throw "Windows Store legacyNsisAumid must exactly match the company NSIS AUMID 'cn.memtensor.memmy'."
  }

  $seenStoreProductIds = [Collections.Generic.Dictionary[string, string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  $seenIdentityNames = [Collections.Generic.Dictionary[string, string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  $seenPackageFamilyNames = [Collections.Generic.Dictionary[string, string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  $seenAumids = [Collections.Generic.Dictionary[string, string]]::new(
    [StringComparer]::OrdinalIgnoreCase
  )
  $profiles = @{}
  $restrictedApplicationIds = @(
    "CON", "PRN", "AUX", "NUL",
    "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8", "COM9",
    "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9"
  )

  foreach ($channel in @("cn", "intl")) {
    $profileName = "company/$channel"
    $applicationConfig = $Config.applications.PSObject.Properties[$channel].Value
    Assert-ExactStorePublishingProperties `
      -Object $applicationConfig `
      -ExpectedProperties @(
        "storeListingDisplayName",
        "storeProductId",
        "acquisitionUri",
        "identityName",
        "manifestApplicationId",
        "packageFamilyName"
      ) `
      -Context "Windows Store publishing profile '$profileName'"

    $storeListingDisplayName = Get-RequiredStorePublishingValue `
      -Object $applicationConfig `
      -PropertyName "storeListingDisplayName" `
      -ProfileName $profileName
    $storeProductId = Get-RequiredStorePublishingValue `
      -Object $applicationConfig `
      -PropertyName "storeProductId" `
      -ProfileName $profileName
    $identityName = Get-RequiredStorePublishingValue `
      -Object $applicationConfig `
      -PropertyName "identityName" `
      -ProfileName $profileName
    $applicationId = Get-RequiredStorePublishingValue `
      -Object $applicationConfig `
      -PropertyName "manifestApplicationId" `
      -ProfileName $profileName
    $packageFamilyName = Get-RequiredStorePublishingValue `
      -Object $applicationConfig `
      -PropertyName "packageFamilyName" `
      -ProfileName $profileName

    if ($storeListingDisplayName.Length -gt 256) {
      throw "Windows Store publishing profile '$profileName' has a Store listing display name longer than 256 characters."
    }
    if ($storeProductId -cnotmatch '^[A-Z0-9]{12}$') {
      throw "Windows Store publishing profile '$profileName' has an invalid storeProductId."
    }
    if (
      $identityName -cnotmatch '^[A-Za-z0-9.-]{3,50}$' -or
      $restrictedApplicationIds -contains $identityName.ToUpperInvariant()
    ) {
      throw "Windows Store publishing profile '$profileName' has an invalid identityName."
    }
    if (
      $applicationId.Length -gt 64 -or
      $applicationId -cnotmatch '^([A-Za-z][A-Za-z0-9]*)(\.[A-Za-z][A-Za-z0-9]*)*$' -or
      $restrictedApplicationIds -contains $applicationId.ToUpperInvariant()
    ) {
      throw "Windows Store publishing profile '$profileName' has an invalid manifestApplicationId."
    }
    if (
      $packageFamilyName -cnotmatch '^[A-Za-z0-9.-]+_[a-z0-9]{13}$' -or
      -not $packageFamilyName.StartsWith("$identityName`_", [StringComparison]::Ordinal)
    ) {
      throw "Windows Store publishing profile '$profileName' has a packageFamilyName that does not match identityName and publisher."
    }

    try {
      $expectedPackageFamilyName = [Memmy.StorePublishing.PackageIdentityNative]::GetPackageFamilyName(
        $identityName,
        $publisher
      )
    } catch {
      throw "Windows Store publishing profile '$profileName' packageFamilyName does not match identityName and publisher. $($_.Exception.Message)"
    }
    if (-not [string]::Equals(
      $packageFamilyName,
      $expectedPackageFamilyName,
      [StringComparison]::Ordinal
    )) {
      throw "Windows Store publishing profile '$profileName' packageFamilyName does not match identityName and publisher; expected '$expectedPackageFamilyName'."
    }

    $aumid = "$packageFamilyName!$applicationId"
    if (-not [string]::Equals($aumid, "$expectedPackageFamilyName!$applicationId", [StringComparison]::Ordinal)) {
      throw "Windows Store publishing profile '$profileName' has an invalid AUMID."
    }

    Register-UniqueStorePublishingValue `
      -SeenValues $seenStoreProductIds -FieldName "storeProductId" `
      -Value $storeProductId -ProfileName $profileName
    Register-UniqueStorePublishingValue `
      -SeenValues $seenIdentityNames -FieldName "identityName" `
      -Value $identityName -ProfileName $profileName
    Register-UniqueStorePublishingValue `
      -SeenValues $seenPackageFamilyNames -FieldName "packageFamilyName" `
      -Value $packageFamilyName -ProfileName $profileName
    Register-UniqueStorePublishingValue `
      -SeenValues $seenAumids -FieldName "AUMID" `
      -Value $aumid -ProfileName $profileName

    $profiles[$channel] = [pscustomobject]@{
      Channel = $channel
      Publisher = $publisher
      PublisherDisplayName = $publisherDisplayName
      WindowsDisplayName = $windowsDisplayName
      StoreListingDisplayName = $storeListingDisplayName
      StoreProductId = $storeProductId
      AcquisitionUri = Get-RequiredStorePublishingValue -Object $applicationConfig -PropertyName "acquisitionUri" -ProfileName $profileName
      IdentityName = $identityName
      ApplicationId = $applicationId
      PackageFamilyName = $packageFamilyName
      Aumid = $aumid
      LegacyNsisAumid = $legacyNsisAumid
    }
  }

  foreach ($entry in $profiles.Values) {
    $uri = $null
    if (-not [Uri]::TryCreate($entry.AcquisitionUri, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -ne 'https' -or $uri.UserInfo -or -not $uri.IsDefaultPort -or $uri.Query -or $uri.Fragment -or
        $uri.Host -ne 'get.microsoft.com' -or $uri.AbsolutePath -cne "/installer/download/$($entry.StoreProductId)") {
      throw "Windows Store publishing profile '$($entry.Channel)' acquisitionUri must be its official Web Install URL."
    }
  }
  return $profiles
}

function Resolve-MemmyStorePublishingProfile {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ConfigPath,
    [Parameter(Mandatory = $true)]
    [ValidateSet("cn", "intl")]
    [string]$Channel,
    [switch]$TestOnlyAllowCustomConfig
  )

  if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
    throw "Windows Store publishing config was not found: $ConfigPath"
  }
  $resolvedConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
  $canonicalConfigPath = (Resolve-Path -LiteralPath (Join-Path `
    $PSScriptRoot `
    "..\..\App\shell\desktop\build\store-publishing-profiles.json"
  )).Path
  if (
    -not $TestOnlyAllowCustomConfig -and
    -not [string]::Equals(
      $resolvedConfigPath,
      $canonicalConfigPath,
      [StringComparison]::OrdinalIgnoreCase
    )
  ) {
    throw "Custom Windows Store publishing configs are test-only. Canonical packaging must use the checked-in company profile."
  }
  try {
    $config = Get-Content -Raw -LiteralPath $resolvedConfigPath | ConvertFrom-Json
  } catch {
    throw "Windows Store publishing config is invalid JSON: $resolvedConfigPath. $($_.Exception.Message)"
  }

  if (-not $TestOnlyAllowCustomConfig) {
    Assert-MemmyCompanyStorePublishingConfig -Config $config
  }

  $profiles = Get-ValidatedStorePublishingProfiles -Config $config
  $profile = $profiles[$Channel]
  $profile | Add-Member `
    -NotePropertyName ConfigPath `
    -NotePropertyValue $resolvedConfigPath
  return $profile
}
