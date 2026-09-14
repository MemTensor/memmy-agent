[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$sourcePath = Join-Path $root "App\shell\desktop\native\windows-store-update\MemmyStoreUpdate.cpp"
$outputDirectory = Join-Path $root "App\shell\desktop\dist\native"
$outputPath = Join-Path $outputDirectory "MemmyStoreUpdate.exe"
$objectPath = Join-Path $outputDirectory "MemmyStoreUpdate.obj"
$vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"

if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf)) {
  throw "Visual Studio Installer vswhere.exe was not found: $vswherePath"
}
$visualStudioPath = & $vswherePath `
  -latest `
  -products * `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
  -property installationPath
if (-not $visualStudioPath) {
  throw "Visual Studio C++ Build Tools were not found."
}

$vcVarsPath = Join-Path $visualStudioPath "VC\Auxiliary\Build\vcvars64.bat"
if (-not (Test-Path -LiteralPath $vcVarsPath -PathType Leaf)) {
  throw "vcvars64.bat was not found: $vcVarsPath"
}
if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
  throw "Store update helper source was not found: $sourcePath"
}

New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
Remove-Item -LiteralPath $outputPath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $objectPath -Force -ErrorAction SilentlyContinue

$vcEnvironment = & $env:ComSpec /d /s /c "`"$vcVarsPath`" >nul && set"
if ($LASTEXITCODE -ne 0) {
  throw "vcvars64.bat failed with exit code $LASTEXITCODE"
}
foreach ($line in $vcEnvironment) {
  $separator = $line.IndexOf("=")
  if ($separator -le 0) {
    continue
  }
  $name = $line.Substring(0, $separator)
  $value = $line.Substring($separator + 1)
  [Environment]::SetEnvironmentVariable($name, $value, "Process")
}

$compiler = (Get-Command cl.exe -ErrorAction Stop).Source
& $compiler `
  /nologo `
  /std:c++20 `
  /EHsc `
  /O2 `
  /MT `
  /DUNICODE `
  /D_UNICODE `
  /utf-8 `
  $sourcePath `
  "/Fe:$outputPath" `
  "/Fo:$objectPath" `
  /link `
  windowsapp.lib `
  advapi32.lib `
  ole32.lib `
  oleaut32.lib `
  shell32.lib `
  user32.lib
if ($LASTEXITCODE -ne 0) {
  throw "Store update helper compilation failed with exit code $LASTEXITCODE"
}
if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
  throw "Store update helper was not created: $outputPath"
}

$dependencyInspector = (Get-Command dumpbin.exe -ErrorAction Stop).Source
$dependencyOutput = & $dependencyInspector /DEPENDENTS $outputPath 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) {
  throw "Store update helper dependency inspection failed with exit code $LASTEXITCODE"
}
$dynamicRuntimePatterns = @(
  'MSVCP(?:[0-9_]+)?\.dll',
  'VCRUNTIME(?:[0-9_]+)?\.dll'
)
$dynamicRuntimeDependencies = $dependencyOutput |
  Select-String -Pattern ($dynamicRuntimePatterns -join "|") -AllMatches
if ($dynamicRuntimeDependencies) {
  throw "Store update helper must not depend on the Visual C++ redistributable: $($dynamicRuntimeDependencies.Line.Trim())"
}
Remove-Item -LiteralPath $objectPath -Force -ErrorAction SilentlyContinue

Write-Host "Created $outputPath"
