param(
  [string]$Version = $(if ($env:MEMMY_MEMORY_VERSION) { $env:MEMMY_MEMORY_VERSION } else { "2.1.0" }),
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$InstallArguments
)
$ErrorActionPreference = "Stop"
$arch = if ([System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq "Arm64") { "arm64" } else { "x64" }
$target = "windows-$arch"
$asset = "memmy-memory-$Version-$target.tar.gz"
$releases = if ($env:MEMMY_MEMORY_RELEASES_URL) { $env:MEMMY_MEMORY_RELEASES_URL.TrimEnd("/") } else { "https://github.com/MemTensor/memmy-agent/releases" }
$base = "$releases/download/memory-v$Version"
$memoryHome = if ($env:MEMMY_MEMORY_HOME) { $env:MEMMY_MEMORY_HOME } else { Join-Path $HOME ".memmy" }
$temporary = Join-Path ([System.IO.Path]::GetTempPath()) ("memmy-memory-install-" + [guid]::NewGuid())

try {
  New-Item -ItemType Directory -Path $temporary | Out-Null
  Invoke-WebRequest "$base/$asset" -OutFile (Join-Path $temporary $asset)
  Invoke-WebRequest "$base/SHA256SUMS" -OutFile (Join-Path $temporary "SHA256SUMS")
  $checksumLine = Get-Content (Join-Path $temporary "SHA256SUMS") | Where-Object { $_ -match "\s+$([regex]::Escape($asset))$" } | Select-Object -First 1
  if (-not $checksumLine) { throw "Checksum for $asset is missing" }
  $expected = ($checksumLine -split "\s+")[0].ToLowerInvariant()
  $actual = (Get-FileHash (Join-Path $temporary $asset) -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $expected) { throw "Checksum verification failed for $asset" }

  $cliDirectory = Join-Path $memoryHome "cli\versions\$Version\$target"
  $binDirectory = Join-Path $memoryHome "bin"
  New-Item -ItemType Directory -Force -Path $cliDirectory, $binDirectory | Out-Null
  tar -xzf (Join-Path $temporary $asset) -C $cliDirectory
  $stableCommand = Join-Path $binDirectory "memmy-memory.cmd"
  Copy-Item (Join-Path $cliDirectory "memmy-memory.cmd") $stableCommand -Force
  & $stableCommand install @InstallArguments
  exit $LASTEXITCODE
} finally {
  if (Test-Path $temporary) { Remove-Item -Recurse -Force $temporary }
}
