[CmdletBinding()]
param(
  [ValidateSet('x64', 'arm64')][string]$Architecture = 'x64',
  [string]$NodeHeadersDirectory,
  [string]$OutputDirectory
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$memoryRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sourcePath = Join-Path $PSScriptRoot 'memory-install-lock.cc'
$outputDirectory = if ($OutputDirectory) { $OutputDirectory } else { Join-Path $memoryRoot 'dist\native' }
$outputPath = Join-Path $outputDirectory 'memory-install-lock.node'
$nodeVersion = (& node -p 'process.versions.node').Trim()

if (-not $NodeHeadersDirectory) {
  $NodeHeadersDirectory = Join-Path $env:LOCALAPPDATA "node-gyp\Cache\$nodeVersion\include\node"
}
if (Test-Path (Join-Path $NodeHeadersDirectory 'node_api.h') -PathType Leaf) {
  $nodeInclude = $NodeHeadersDirectory
} elseif (Test-Path (Join-Path $NodeHeadersDirectory 'include\node\node_api.h') -PathType Leaf) {
  $nodeInclude = Join-Path $NodeHeadersDirectory 'include\node'
} else {
  throw "Node headers were not found: $NodeHeadersDirectory"
}
$cacheRoot = Split-Path (Split-Path $nodeInclude -Parent) -Parent
$nodeLib = Join-Path $cacheRoot "$Architecture\node.lib"
if (-not (Test-Path -LiteralPath $nodeLib -PathType Leaf)) { throw "Node import library was not found: $nodeLib" }
$hookPath = Join-Path $PSScriptRoot 'win_delay_load_hook.cc'
if (-not (Test-Path -LiteralPath $hookPath -PathType Leaf)) { throw "node-gyp delay-load hook was not found: $hookPath" }

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswhere -PathType Leaf)) { throw "Visual Studio vswhere.exe was not found: $vswhere" }
$vsPath = (& $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath).Trim()
if (-not $vsPath) { throw 'Visual Studio C++ Build Tools were not found.' }
$vcvarsName = if ($Architecture -eq 'arm64') { 'vcvarsamd64_arm64.bat' } else { 'vcvars64.bat' }
$vcvars = Join-Path $vsPath "VC\Auxiliary\Build\$vcvarsName"
if (-not (Test-Path -LiteralPath $vcvars -PathType Leaf)) { throw "VC environment script was not found: $vcvars" }
$envLines = & $env:ComSpec /d /s /c "`"$vcvars`" >nul && set"
if ($LASTEXITCODE -ne 0) { throw "VC environment setup failed: $LASTEXITCODE" }
foreach ($line in $envLines) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1), 'Process') }
}
$compiler = (Get-Command cl.exe -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
$objPath = Join-Path $outputDirectory 'memory-install-lock.obj'
Remove-Item -LiteralPath $outputPath,$objPath -Force -ErrorAction SilentlyContinue

$archFlag = "/machine:$Architecture"
& $compiler /nologo /std:c++17 /EHsc /O2 /MT /LD /DUNICODE /D_UNICODE /utf-8 `
  "/I$nodeInclude" "/Fo$outputDirectory\" $sourcePath $hookPath "/link" "/OUT:$outputPath" "/IMPLIB:$objPath.lib" $archFlag `
  '/DELAYLOAD:node.exe' delayimp.lib $nodeLib
if ($LASTEXITCODE -ne 0) { throw "Native install lock compilation failed: $LASTEXITCODE" }
if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) { throw "Native module was not created: $outputPath" }
$dumpbin = (Get-Command dumpbin.exe -ErrorAction Stop).Source
$deps = & $dumpbin /DEPENDENTS $outputPath 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { throw "Native module dependency inspection failed: $LASTEXITCODE" }
if ($deps -match 'MSVCP(?:[0-9_]+)?\.dll|VCRUNTIME(?:[0-9_]+)?\.dll') { throw "Native module unexpectedly depends on the Visual C++ redistributable." }
Remove-Item -LiteralPath $objPath,(Join-Path $outputDirectory 'win_delay_load_hook.obj'),(Join-Path $outputDirectory 'memory-install-lock.obj.lib'),(Join-Path $outputDirectory 'memory-install-lock.obj.exp') -Force -ErrorAction SilentlyContinue
Write-Host "Created $outputPath ($Architecture, Node $nodeVersion)"
