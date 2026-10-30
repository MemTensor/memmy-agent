<#
.SYNOPSIS
  Configure, build and optionally test the Windows Computer History native recorder.

.DESCRIPTION
  Locates Visual Studio 2022 (v143, x64) with vswhere, imports its developer environment and
  runs CMake + Ninja for App/memmy-agent/src/tools/computer-history/win/native. Build output and
  test evidence stay outside the repository by default.

  Integration tests drive a controlled fixture window and need an unlocked interactive desktop;
  cases that cannot obtain the foreground are reported as skipped by CTest, never as passed.

.EXAMPLE
  pwsh scripts/internal/win/history-recorder-native.ps1 -Configuration Release -Test
#>
[CmdletBinding()]
param(
  [ValidateSet('Release', 'Debug')] [string] $Configuration = 'Release',
  [string] $BuildRoot = (Join-Path $env:LOCALAPPDATA 'memmy-history-recorder\build'),
  [string] $ArtifactsRoot = (Join-Path $env:LOCALAPPDATA 'memmy-history-recorder\test-artifacts'),
  # Offline builds: a local copy of nlohmann/json 3.12.0 json.hpp (SHA-256 verified by CMake).
  [string] $JsonHeader = '',
  [switch] $ProductionOnly,
  [string] $StageDirectory = '',
  [switch] $Test
)

$ErrorActionPreference = 'Stop'
if ($ProductionOnly -and $Test) { throw '-ProductionOnly cannot be used with -Test.' }
if ($StageDirectory -and $Configuration -ne 'Release') { throw 'Only Release builds may be staged for packaging.' }
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$source = Join-Path $repoRoot 'App\memmy-agent\src\tools\computer-history\win\native'
$buildDir = Join-Path $BuildRoot $Configuration.ToLowerInvariant()
$artifacts = Join-Path $ArtifactsRoot $Configuration.ToLowerInvariant()

$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path $vswhere)) { throw 'vswhere.exe not found; install Visual Studio 2022 Build Tools (C++ x64).' }
$vsRoot = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsRoot) { throw 'No Visual Studio installation with the x64 C++ toolset was found.' }

# Import the x64 developer environment into this PowerShell session.
$devCmd = Join-Path $vsRoot 'Common7\Tools\VsDevCmd.bat'
$envDump = & cmd.exe /d /s /c "`"$devCmd`" -no_logo -arch=x64 -host_arch=x64 && set"
if ($LASTEXITCODE -ne 0) { throw 'VsDevCmd.bat failed.' }
# Some launchers supply both Path and PATH. Prefer the developer PATH over the
# inherited alias so a later environment line cannot hide cl.exe.
$developerPath = ($envDump | Where-Object { $_.StartsWith('PATH=') } | Select-Object -First 1)
foreach ($line in $envDump) {
  $separator = $line.IndexOf('=')
  if ($separator -gt 0) { [Environment]::SetEnvironmentVariable($line.Substring(0, $separator), $line.Substring($separator + 1)) }
}
if ($developerPath) { $env:PATH = $developerPath.Substring(5) }
$env:VSLANG = '1033'
$env:PATH = (Join-Path $vsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin') + ';' +
            (Join-Path $vsRoot 'Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja') + ';' + $env:PATH

$configureArgs = @('-S', $source, '-B', $buildDir, '-G', 'Ninja', "-DCMAKE_BUILD_TYPE=$Configuration",
                   "-DMEMMY_HISTORY_TEST_ARTIFACTS=$artifacts", "-DMEMMY_HISTORY_BUILD_TESTS=$(if ($ProductionOnly) { 'OFF' } else { 'ON' })")
if ($JsonHeader) { $configureArgs += "-DMEMMY_NLOHMANN_JSON_HPP=$JsonHeader" }
& cmake @configureArgs
if ($LASTEXITCODE -ne 0) { throw 'CMake configure failed.' }
& cmake --build $buildDir
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

$recorder = Join-Path $buildDir 'memmy-history-recorder.exe'
Write-Host ("memmy-history-recorder.exe: {0} bytes" -f (Get-Item $recorder).Length)
& dumpbin /nologo /dependents $recorder | Select-String '\.dll' | ForEach-Object { Write-Host ('  imports ' + $_.Line.Trim()) }

if ($StageDirectory) {
  New-Item -ItemType Directory -Force -Path $StageDirectory | Out-Null
  Copy-Item -LiteralPath $recorder -Destination (Join-Path $StageDirectory 'memmy-history-recorder.exe') -Force
  Copy-Item -LiteralPath (Join-Path $source 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $StageDirectory 'memmy-history-recorder.NOTICES.md') -Force
}

if ($Test) {
  & ctest --test-dir $buildDir --output-on-failure
  if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
}
