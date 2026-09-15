Set-StrictMode -Version Latest

$profileResolverPath = Join-Path $PSScriptRoot "windows-store-publishing-profile.ps1"
. $profileResolverPath

function Get-ExactWindowsStoreManifestNode {
  param(
    [Parameter(Mandatory = $true)][Xml.XmlDocument]$Document,
    [Parameter(Mandatory = $true)][Xml.XmlNamespaceManager]$NamespaceManager,
    [Parameter(Mandatory = $true)][string]$XPath,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $nodes = @($Document.SelectNodes($XPath, $NamespaceManager))
  if ($nodes.Count -ne 1) {
    throw "MSIX AppxManifest must contain exactly one $Context; found $($nodes.Count)."
  }
  return $nodes[0]
}

function Get-RequiredWindowsStoreManifestAttribute {
  param(
    [Parameter(Mandatory = $true)][Xml.XmlNode]$Node,
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string]$Context
  )

  $attribute = $Node.Attributes[$Name]
  if ($null -eq $attribute -or [string]::IsNullOrWhiteSpace($attribute.Value)) {
    throw "MSIX AppxManifest $Context is missing required attribute '$Name'."
  }
  return $attribute.Value
}

function Assert-OrdinalWindowsStoreManifestValue {
  param(
    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Actual,
    [AllowEmptyString()][Parameter(Mandatory = $true)][string]$Expected,
    [Parameter(Mandatory = $true)][string]$Context
  )

  if (-not [string]::Equals($Actual, $Expected, [StringComparison]::Ordinal)) {
    throw "MSIX AppxManifest $Context mismatch. Expected '$Expected', found '$Actual'."
  }
}

function Read-WindowsStoreManifestXml {
  param([Parameter(Mandatory = $true)][string]$ManifestPath)

  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "Unpacked MSIX AppxManifest was not found: $ManifestPath"
  }

  $settings = [Xml.XmlReaderSettings]::new()
  $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $reader = [Xml.XmlReader]::Create($ManifestPath, $settings)
  try {
    $document = [Xml.XmlDocument]::new()
    $document.XmlResolver = $null
    $document.Load($reader)
    return $document
  } finally {
    $reader.Dispose()
  }
}

function Assert-MemmyWindowsStoreUnpackedManifest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$ManifestPath,
    [Parameter(Mandatory = $true)]$Profile,
    [Parameter(Mandatory = $true)][string]$ExpectedPackageVersion,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
    [Parameter(Mandatory = $true)][string]$ExpectedLegacyNsisAumid
  )

  $document = Read-WindowsStoreManifestXml -ManifestPath $ManifestPath
  $namespaceManager = [Xml.XmlNamespaceManager]::new($document.NameTable)
  $namespaceManager.AddNamespace(
    "foundation",
    "http://schemas.microsoft.com/appx/manifest/foundation/windows10"
  )
  $namespaceManager.AddNamespace(
    "uap",
    "http://schemas.microsoft.com/appx/manifest/uap/windows10"
  )
  $namespaceManager.AddNamespace(
    "rescap3",
    "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities/3"
  )
  $namespaceManager.AddNamespace(
    "rescap",
    "http://schemas.microsoft.com/appx/manifest/foundation/windows10/restrictedcapabilities"
  )
  $namespaceManager.AddNamespace(
    "desktop",
    "http://schemas.microsoft.com/appx/manifest/desktop/windows10"
  )
  $namespaceManager.AddNamespace(
    "desktop7",
    "http://schemas.microsoft.com/appx/manifest/desktop/windows10/7"
  )

  $identity = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Identity" `
    -Context "Package/Identity"
  $application = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Applications/foundation:Application" `
    -Context "Package/Applications/Application"
  $packageDisplayName = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Properties/foundation:DisplayName" `
    -Context "Package/Properties/DisplayName"
  $publisherDisplayName = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Properties/foundation:PublisherDisplayName" `
    -Context "Package/Properties/PublisherDisplayName"
  $visualElements = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Applications/foundation:Application/uap:VisualElements" `
    -Context "Application/uap:VisualElements"
  $runFullTrust = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Capabilities/rescap:Capability[@Name='runFullTrust']" `
    -Context "runFullTrust restricted capability"
  $startupExtension = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Applications/foundation:Application/foundation:Extensions/desktop:Extension[@Category='windows.startupTask']" `
    -Context "windows.startupTask desktop extension"
  $startupTask = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Applications/foundation:Application/foundation:Extensions/desktop:Extension[@Category='windows.startupTask']/desktop:StartupTask" `
    -Context "windows.startupTask/desktop:StartupTask"
  $legacyMigrationExtension = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Applications/foundation:Application/foundation:Extensions/rescap3:Extension[@Category='windows.desktopAppMigration']" `
    -Context "windows.desktopAppMigration rescap3 extension"
  $legacyMigration = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Applications/foundation:Application/foundation:Extensions/rescap3:Extension[@Category='windows.desktopAppMigration']/rescap3:DesktopAppMigration" `
    -Context "windows.desktopAppMigration/rescap3:DesktopAppMigration"
  $legacyDesktopApp = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Applications/foundation:Application/foundation:Extensions/rescap3:Extension[@Category='windows.desktopAppMigration']/rescap3:DesktopAppMigration/rescap3:DesktopApp[@AumId]" `
    -Context "windows.desktopAppMigration DesktopApp with AumId"
  $legacyShortcutNodes = @($document.SelectNodes(
    "/foundation:Package/foundation:Applications/foundation:Application/foundation:Extensions/rescap3:Extension[@Category='windows.desktopAppMigration']/rescap3:DesktopAppMigration/rescap3:DesktopApp[@ShortcutPath]",
    $namespaceManager
  ))
  if ($legacyShortcutNodes.Count -ne 2) {
    throw "MSIX AppxManifest must contain exactly two windows.desktopAppMigration DesktopApp ShortcutPath entries; found $($legacyShortcutNodes.Count)."
  }
  $legacyDesktopAppNodes = @($legacyMigration.SelectNodes("rescap3:DesktopApp", $namespaceManager))
  if ($legacyDesktopAppNodes.Count -ne 3) {
    throw "MSIX AppxManifest windows.desktopAppMigration must contain exactly one AUMID source and two ShortcutPath entries; found $($legacyDesktopAppNodes.Count) DesktopApp entries."
  }
  $desktopShortcut = Get-ExactWindowsStoreManifestNode `
    -Document $document -NamespaceManager $namespaceManager `
    -XPath "/foundation:Package/foundation:Applications/foundation:Application/foundation:Extensions/desktop7:Extension[@Category='windows.shortcut']/desktop7:Shortcut" `
    -Context "windows.shortcut desktop7:Shortcut"

  $identityName = Get-RequiredWindowsStoreManifestAttribute `
    -Node $identity -Name "Name" -Context "Package/Identity"
  $publisher = Get-RequiredWindowsStoreManifestAttribute `
    -Node $identity -Name "Publisher" -Context "Package/Identity"
  $packageVersion = Get-RequiredWindowsStoreManifestAttribute `
    -Node $identity -Name "Version" -Context "Package/Identity"
  $applicationId = Get-RequiredWindowsStoreManifestAttribute `
    -Node $application -Name "Id" -Context "Application"
  $executable = Get-RequiredWindowsStoreManifestAttribute `
    -Node $application -Name "Executable" -Context "Application"
  $applicationEntryPoint = Get-RequiredWindowsStoreManifestAttribute `
    -Node $application -Name "EntryPoint" -Context "Application"
  $visualDisplayName = Get-RequiredWindowsStoreManifestAttribute `
    -Node $visualElements -Name "DisplayName" -Context "uap:VisualElements"
  $legacyNsisAumid = Get-RequiredWindowsStoreManifestAttribute `
    -Node $legacyDesktopApp -Name "AumId" -Context "windows.desktopAppMigration DesktopApp"
  $startupExecutable = Get-RequiredWindowsStoreManifestAttribute `
    -Node $startupExtension -Name "Executable" -Context "windows.startupTask desktop extension"
  $startupEntryPoint = Get-RequiredWindowsStoreManifestAttribute `
    -Node $startupExtension -Name "EntryPoint" -Context "windows.startupTask desktop extension"
  $startupTaskId = Get-RequiredWindowsStoreManifestAttribute `
    -Node $startupTask -Name "TaskId" -Context "desktop:StartupTask"
  $startupEnabled = Get-RequiredWindowsStoreManifestAttribute `
    -Node $startupTask -Name "Enabled" -Context "desktop:StartupTask"
  $startupDisplayName = Get-RequiredWindowsStoreManifestAttribute `
    -Node $startupTask -Name "DisplayName" -Context "desktop:StartupTask"
  $desktopShortcutFile = Get-RequiredWindowsStoreManifestAttribute `
    -Node $desktopShortcut -Name "File" -Context "desktop7:Shortcut"
  $desktopShortcutIcon = Get-RequiredWindowsStoreManifestAttribute `
    -Node $desktopShortcut -Name "Icon" -Context "desktop7:Shortcut"
  $desktopShortcutDescription = Get-RequiredWindowsStoreManifestAttribute `
    -Node $desktopShortcut -Name "Description" -Context "desktop7:Shortcut"

  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $identityName -Expected $Profile.IdentityName `
    -Context "Package/Identity/Name"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $publisher -Expected $Profile.Publisher `
    -Context "Package/Identity/Publisher"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $packageVersion -Expected $ExpectedPackageVersion `
    -Context "Package/Identity/Version"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $applicationId -Expected $Profile.ApplicationId `
    -Context "Application/Id"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $executable -Expected $ExpectedExecutable `
    -Context "Application/Executable"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $applicationEntryPoint -Expected "Windows.FullTrustApplication" `
    -Context "Application/EntryPoint"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $packageDisplayName.InnerText -Expected $Profile.StoreListingDisplayName `
    -Context "Package/Properties/DisplayName"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $publisherDisplayName.InnerText -Expected $Profile.PublisherDisplayName `
    -Context "Package/Properties/PublisherDisplayName"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $visualDisplayName -Expected $Profile.WindowsDisplayName `
    -Context "uap:VisualElements/DisplayName"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $legacyNsisAumid -Expected $ExpectedLegacyNsisAumid `
    -Context "windows.desktopAppMigration DesktopApp/AumId"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $startupExecutable -Expected $ExpectedExecutable `
    -Context "windows.startupTask desktop extension/Executable"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $startupEntryPoint -Expected "Windows.FullTrustApplication" `
    -Context "windows.startupTask desktop extension/EntryPoint"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $startupTaskId -Expected "MemmyStartupTask" `
    -Context "desktop:StartupTask/TaskId"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $startupEnabled -Expected "false" `
    -Context "desktop:StartupTask/Enabled"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $startupDisplayName -Expected $Profile.WindowsDisplayName `
    -Context "desktop:StartupTask/DisplayName"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $desktopShortcutFile -Expected '$(Desktop)\Memmy.lnk' `
    -Context "desktop7:Shortcut/File"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $desktopShortcutIcon -Expected '$(Package)\app\resources\icon.ico' `
    -Context "desktop7:Shortcut/Icon"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $desktopShortcutDescription -Expected $Profile.WindowsDisplayName `
    -Context "desktop7:Shortcut/Description"

  $expectedLegacyShortcutPaths = @(
    '%USERPROFILE%\Desktop\Memmy.lnk',
    '%APPDATA%\Microsoft\Windows\Start Menu\Programs\Memmy.lnk'
  )
  $actualLegacyShortcutPaths = @($legacyShortcutNodes | ForEach-Object {
    Get-RequiredWindowsStoreManifestAttribute `
      -Node $_ -Name "ShortcutPath" `
      -Context "windows.desktopAppMigration DesktopApp"
  })
  $legacyShortcutDifferences = Compare-Object `
    -ReferenceObject $expectedLegacyShortcutPaths `
    -DifferenceObject $actualLegacyShortcutPaths `
    -CaseSensitive
  if ($legacyShortcutDifferences) {
    throw "MSIX AppxManifest windows.desktopAppMigration ShortcutPath entries do not exactly match the two legacy Memmy shortcuts."
  }

  $calculatedPackageFamilyName = `
    [Memmy.StorePublishing.PackageIdentityNative]::GetPackageFamilyName(
      $identityName,
      $publisher
    )
  $calculatedAumid = "$calculatedPackageFamilyName!$applicationId"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $calculatedPackageFamilyName -Expected $Profile.PackageFamilyName `
    -Context "calculated Package Family Name"
  Assert-OrdinalWindowsStoreManifestValue `
    -Actual $calculatedAumid -Expected $Profile.Aumid `
    -Context "calculated Store AUMID"

  return [pscustomobject]@{
    IdentityName = $identityName
    Publisher = $publisher
    PackageVersion = $packageVersion
    ApplicationId = $applicationId
    Executable = $executable
    EntryPoint = $applicationEntryPoint
    PackageFamilyName = $calculatedPackageFamilyName
    Aumid = $calculatedAumid
    LegacyNsisAumid = $legacyNsisAumid
    StartupTaskId = $startupTaskId
    RunFullTrust = $runFullTrust.Attributes["Name"].Value
    LegacyMigrationCategory = $legacyMigrationExtension.Attributes["Category"].Value
  }
}

function Assert-MemmyWindowsStoreMsixManifest {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)][string]$PackagePath,
    [Parameter(Mandatory = $true)]$Profile,
    [Parameter(Mandatory = $true)][string]$MakeAppxPath,
    [Parameter(Mandatory = $true)][string]$ExpectedPackageVersion,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
    [Parameter(Mandatory = $true)][string]$ExpectedLegacyNsisAumid
  )

  if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
    throw "MSIX artifact was not found for manifest verification: $PackagePath"
  }
  if (-not (Test-Path -LiteralPath $MakeAppxPath -PathType Leaf)) {
    throw "MakeAppx was not found for manifest verification: $MakeAppxPath"
  }

  $unpackDirectory = Join-Path `
    ([IO.Path]::GetTempPath()) `
    "memmy-store-msix-manifest-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Path $unpackDirectory | Out-Null
  try {
    & $MakeAppxPath unpack /p $PackagePath /d $unpackDirectory /o
    if ($LASTEXITCODE -ne 0) {
      throw "MakeAppx unpack failed with exit code $LASTEXITCODE for $PackagePath"
    }
    return Assert-MemmyWindowsStoreUnpackedManifest `
      -ManifestPath (Join-Path $unpackDirectory "AppxManifest.xml") `
      -Profile $Profile `
      -ExpectedPackageVersion $ExpectedPackageVersion `
      -ExpectedExecutable $ExpectedExecutable `
      -ExpectedLegacyNsisAumid $ExpectedLegacyNsisAumid
  } finally {
    Remove-Item -LiteralPath $unpackDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
