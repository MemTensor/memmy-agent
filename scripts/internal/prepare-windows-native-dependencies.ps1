[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$RuntimeRoot,
  [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
  [switch]$VerifyOnly,
  [string]$ReportPath
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$runtimeDirectory = (Resolve-Path -LiteralPath $RuntimeRoot).Path
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$visualStudio = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $visualStudio) { throw 'Visual Studio C++ build tools were not found.' }
$toolsDirectory = Get-ChildItem -LiteralPath (Join-Path $visualStudio 'VC/Tools/MSVC') -Directory |
  Where-Object Name -Match '^\d+\.\d+\.\d+$' | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$dumpbin = Join-Path $toolsDirectory.FullName 'bin/Hostx64/x64/dumpbin.exe'
$redistDirectory = Get-ChildItem -LiteralPath (Join-Path $visualStudio 'VC/Redist/MSVC') -Directory |
  Where-Object Name -Match '^\d+\.\d+\.\d+$' | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
$crtDirectories = @(Get-ChildItem -LiteralPath (Join-Path $redistDirectory.FullName $Architecture) -Directory |
  Where-Object Name -Match '^Microsoft\.VC\d+\.CRT$')
if ($crtDirectories.Count -ne 1) { throw "Cannot identify the release CRT directory for $Architecture in $($redistDirectory.FullName)." }
$crtDirectory = $crtDirectories[0].FullName
$expectedMachine = if ($Architecture -eq 'x64') { 0x8664 } else { 0xaa64 }
$vcPattern = '^(?:msvcp|vcruntime|concrt|vcomp)\d[\w.]*\.dll$'

function Get-PeMachine([string]$FilePath) {
  $stream = [IO.File]::OpenRead($FilePath)
  $reader = [IO.BinaryReader]::new($stream)
  try {
    if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5a4d) { return 0 }
    $stream.Position = 0x3c
    $offset = $reader.ReadUInt32()
    if ($offset + 6 -gt $stream.Length) { return 0 }
    $stream.Position = $offset
    if ($reader.ReadUInt32() -ne 0x4550) { return 0 }
    return $reader.ReadUInt16()
  } finally { $reader.Dispose(); $stream.Dispose() }
}

function Get-VcDependencies([string]$FilePath) {
  $output = & $dumpbin /NOLOGO /DEPENDENTS $FilePath 2>&1
  if ($LASTEXITCODE -ne 0) { throw "Cannot inspect native dependencies: $FilePath" }
  @($output | ForEach-Object { $_.ToString().Trim() } | Where-Object { $_ -match $vcPattern } | Sort-Object -Unique)
}

$nativeFiles = @([IO.Directory]::EnumerateFiles($runtimeDirectory, '*', [IO.SearchOption]::AllDirectories) |
  Where-Object { [IO.Path]::GetExtension($_) -in @('.exe', '.dll', '.node') })
$queue = [Collections.Generic.Queue[string]]::new()
foreach ($file in $nativeFiles) { if ((Get-PeMachine $file) -eq $expectedMachine) { $queue.Enqueue($file) } }
$visited = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
$records = [Collections.Generic.List[object]]::new()
while ($queue.Count -gt 0) {
  $file = $queue.Dequeue()
  if (-not $visited.Add($file)) { continue }
  foreach ($dependency in @(Get-VcDependencies $file)) {
    $destination = Join-Path (Split-Path -Parent $file) $dependency
    if (-not $VerifyOnly) {
      # Use the redistributable release files, never a DLL from this machine's System32.
      $source = Join-Path $crtDirectory $dependency
      if (-not (Test-Path -LiteralPath $source -PathType Leaf) -or (Get-PeMachine $source) -ne $expectedMachine) {
        throw "Missing matching redistributable $Architecture library: $source"
      }
      if (-not (Test-Path -LiteralPath $destination -PathType Leaf) -or
          (Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) {
        Copy-Item -LiteralPath $source -Destination $destination -Force
      }
    }
    if (-not (Test-Path -LiteralPath $destination -PathType Leaf) -or (Get-PeMachine $destination) -ne $expectedMachine) {
      throw "Native module requires an unbundled runtime library: $file -> $dependency"
    }
    $records.Add([pscustomobject]@{ Module = $file; Dependency = $dependency; BundledPath = $destination })
    $queue.Enqueue($destination)
  }
}
$report = [pscustomobject]@{
  RuntimeRoot = $runtimeDirectory
  Architecture = $Architecture
  NativeFilesInspected = $visited.Count
  BundledRuntimeDependencies = @($records.ToArray())
  VerifyOnly = [bool]$VerifyOnly
}
if ($ReportPath) {
  $report | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $ReportPath -Encoding UTF8
}
Write-Output "Verified $($visited.Count) $Architecture native binaries; $($records.Count) VC runtime dependency references resolve beside their modules."
