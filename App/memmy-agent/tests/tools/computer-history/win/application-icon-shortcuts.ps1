param([string]$HelperPath = (Join-Path $PSScriptRoot '../../../../src/tools/computer-history/win/app-icon.ps1'))

# Run the unchanged production helper with real local .lnk/.ico/.exe files and
# Shell icon extraction. Only process and Start Menu enumeration are isolated;
# no user shortcuts are changed and no fixture executable is started.
$ErrorActionPreference = 'Stop'
$HelperPath = (Resolve-Path -LiteralPath $HelperPath).Path
$fixture = Join-Path ([IO.Path]::GetTempPath()) ('memmy-icon-shortcuts-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $fixture
$shell = $null
$shortcut = $null
try {
  Add-Type -AssemblyName System.Drawing
  # Independent native oracle: request the fixture executable's primary
  # resource directly, without production's Shell-location/fallback selection.
  Add-Type -ReferencedAssemblies @('System.Drawing.dll') -TypeDefinition @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;

public static class MemmyTestNativeIcon {
    [DllImport("shell32.dll", EntryPoint = "SHDefExtractIconW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int Extract(string path, int index, uint flags, out IntPtr large, IntPtr small, uint size);
    [DllImport("user32.dll")]
    private static extern bool DestroyIcon(IntPtr handle);

    public static Bitmap Render(string path, uint size) {
        IntPtr handle;
        int result = Extract(path, 0, 0, out handle, IntPtr.Zero, size);
        try {
            if (result != 0 || handle == IntPtr.Zero) throw new InvalidOperationException("Native fixture extraction failed");
            using (Icon icon = (Icon)Icon.FromHandle(handle).Clone()) {
                Bitmap bitmap = new Bitmap(64, 64, PixelFormat.Format32bppArgb);
                using (Graphics graphics = Graphics.FromImage(bitmap)) {
                    graphics.Clear(Color.Transparent);
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.SmoothingMode = SmoothingMode.HighQuality;
                    graphics.DrawIcon(icon, new Rectangle(0, 0, 64, 64));
                }
                return bitmap;
            }
        } finally {
            if (handle != IntPtr.Zero) DestroyIcon(handle);
        }
    }
}
'@
  $lowColor = [Drawing.Color]::FromArgb(255, 220, 40, 60)
  $highColor = [Drawing.Color]::FromArgb(255, 30, 210, 150)
  $halfAlphaColor = [Drawing.Color]::FromArgb(128, 64, 128, 192)
  function New-IconFrame([int]$size, [Drawing.Color]$color) {
    $bitmap = New-Object Drawing.Bitmap($size, $size, ([Drawing.Imaging.PixelFormat]::Format32bppArgb))
    $graphics = [Drawing.Graphics]::FromImage($bitmap)
    $pngStream = New-Object IO.MemoryStream
    try {
      $graphics.Clear($color)
      if ($size -eq 64) {
        # Distinguish the true 64px resource from a 32px image enlarged to 64px.
        # A solid 64px fixture cannot detect Shell's default 32px extraction.
        for ($y = 24; $y -lt 32; $y++) {
          for ($x = 24; $x -lt 32; $x++) {
            $pixel = if (($x + $y) % 2 -eq 0) { [Drawing.Color]::White } else { [Drawing.Color]::Black }
            $bitmap.SetPixel($x, $y, $pixel)
          }
        }
        for ($y = 0; $y -lt 8; $y++) {
          for ($x = 0; $x -lt 8; $x++) { $bitmap.SetPixel($x, $y, [Drawing.Color]::Transparent) }
        }
        for ($y = 40; $y -lt 48; $y++) {
          for ($x = 40; $x -lt 48; $x++) { $bitmap.SetPixel($x, $y, $halfAlphaColor) }
        }
      }
      $bitmap.Save($pngStream, [Drawing.Imaging.ImageFormat]::Png)
      return ,$pngStream.ToArray()
    } finally {
      $pngStream.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
    }
  }

  function Write-Icon([string]$path, [object[]]$frames) {
    $writer = New-Object IO.BinaryWriter([IO.File]::Create($path))
    try {
      $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$frames.Count)
      $offset = 6 + 16 * $frames.Count
      foreach ($frame in $frames) {
        $writer.Write([byte]$frame.size); $writer.Write([byte]$frame.size)
        $writer.Write([byte]0); $writer.Write([byte]0)
        $writer.Write([uint16]1); $writer.Write([uint16]32)
        $writer.Write([uint32]$frame.png.Length); $writer.Write([uint32]$offset)
        $offset += $frame.png.Length
      }
      foreach ($frame in $frames) { $writer.Write([byte[]]$frame.png) }
    } finally { $writer.Dispose() }
  }
  $lowFrame = @{ size = 32; png = (New-IconFrame 32 $lowColor) }
  $highFrame = @{ size = 64; png = (New-IconFrame 64 $highColor) }
  # Both frames are valid PNG resources. The 32px frame deliberately has a
  # different color, while only the 64px frame contains single-pixel detail.
  $icoPath = Join-Path $fixture 'MemmySameNameIco.ico'
  Write-Icon $icoPath @($lowFrame, $highFrame)
  $smallIcoPath = Join-Path $fixture 'MemmySmallFrameIco.ico'
  Write-Icon $smallIcoPath @($lowFrame)

  $launcher = Join-Path $fixture 'Update.exe'
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Destination $launcher
  $exePath = Join-Path $fixture 'MemmySameNameExe.EXE'
  Copy-Item -LiteralPath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Destination $exePath
  $cases = @(
    @{ name = 'MemmySameNameIco'; icon = $icoPath; highResolution = $true },
    @{ name = 'MemmySameNameExe'; icon = $exePath; executable = $true },
    @{ name = 'MemmyDifferentNameIco'; icon = $icoPath; highResolution = $true },
    @{ name = 'MemmySmallFrameIco'; icon = $smallIcoPath; smallFrame = $true },
    @{ name = 'MemmyRunningExe'; icon = $exePath; executable = $true; running = $true }
  )
  $shell = New-Object -ComObject WScript.Shell
  foreach ($case in $cases) {
    if ($case.running) { continue }
    $shortcut = $shell.CreateShortcut((Join-Path $fixture ($case.name + '.lnk')))
    $shortcut.TargetPath = $launcher
    $shortcut.Arguments = '--processStart ' + $case.name + '.exe'
    $shortcut.IconLocation = $case.icon + ',0'
    $shortcut.Save()
    $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut)
    $shortcut = $null
  }

  function Get-Process { [pscustomobject]@{ ProcessName = 'MemmyRunningExe'; Path = $exePath } }
  function Get-ChildItem {
    [CmdletBinding()]
    param([string]$LiteralPath, [string]$Filter, [switch]$File, [switch]$Recurse)
    Microsoft.PowerShell.Management\Get-ChildItem -LiteralPath $fixture -Filter '*.lnk' -File
  }
  $ids = @($cases | ForEach-Object { 'win32.' + $_.name.ToLowerInvariant() })
  $json = ConvertTo-Json -InputObject $ids -Compress
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $raw = & $HelperPath -IdsBase64 $encoded
  $icons = ($raw -join "`n") | ConvertFrom-Json
  foreach ($case in $cases) {
    $id = 'win32.' + $case.name.ToLowerInvariant()
    if (-not $icons.$id) { throw "Missing shortcut icon for $($case.name)" }
    $bytes = [Convert]::FromBase64String($icons.$id)
    $stream = New-Object IO.MemoryStream(,$bytes)
    $image = $null
    try {
      $image = [Drawing.Bitmap]::FromStream($stream)
      if ($image.RawFormat.Guid -ne [Drawing.Imaging.ImageFormat]::Png.Guid -or
          $image.Width -ne 64 -or $image.Height -ne 64) { throw "Invalid PNG for $($case.name)" }
      if ($case.highResolution) {
        if ($image.GetPixel(16, 16).ToArgb() -ne $highColor.ToArgb()) {
          throw "Shortcut selected the low-resolution frame for $($case.name)"
        }
        for ($y = 24; $y -lt 32; $y++) {
          for ($x = 24; $x -lt 32; $x++) {
            $expected = if (($x + $y) % 2 -eq 0) { [Drawing.Color]::White } else { [Drawing.Color]::Black }
            if ($image.GetPixel($x, $y).ToArgb() -ne $expected.ToArgb()) {
              throw "Shortcut lost 1px detail at ($x,$y) for $($case.name)"
            }
          }
        }
        if ($image.GetPixel(4, 4).A -ne 0) { throw "Shortcut lost transparency for $($case.name)" }
        $actual = $image.GetPixel(44, 44)
        # Alpha round trips exactly. Allow at most two RGB levels for Windows'
        # premultiplied HICON representation and its unpremultiplication.
        if ($actual.A -ne $halfAlphaColor.A -or
            [Math]::Abs([int]$actual.R - [int]$halfAlphaColor.R) -gt 2 -or
            [Math]::Abs([int]$actual.G - [int]$halfAlphaColor.G) -gt 2 -or
            [Math]::Abs([int]$actual.B - [int]$halfAlphaColor.B) -gt 2) {
          throw "Shortcut lost semitransparent pixels for $($case.name): $actual"
        }
      }
      if ($case.executable) {
        $native64 = [MemmyTestNativeIcon]::Render($exePath, 64)
        $native32 = [MemmyTestNativeIcon]::Render($exePath, 32)
        try {
          $differentPixels = 0
          for ($y = 0; $y -lt 64; $y++) {
            for ($x = 0; $x -lt 64; $x++) {
              if ($image.GetPixel($x, $y).ToArgb() -ne $native64.GetPixel($x, $y).ToArgb()) {
                throw "Executable did not use the native 64px resource at ($x,$y) for $($case.name)"
              }
              if ($native32.GetPixel($x, $y).ToArgb() -ne $native64.GetPixel($x, $y).ToArgb()) {
                $differentPixels++
              }
            }
          }
          if ($differentPixels -eq 0) { throw 'Executable fixture cannot distinguish 32px and 64px resources' }
        } finally { $native64.Dispose(); $native32.Dispose() }
      }
      if ($case.smallFrame) {
        $actual = $image.GetPixel(32, 32)
        # A source that only has 32px must still render; Shell's resampling can
        # change channels slightly. It cannot gain the missing 64px detail.
        if ([Math]::Abs([int]$actual.A - [int]$lowColor.A) -gt 1 -or
            [Math]::Abs([int]$actual.R - [int]$lowColor.R) -gt 2 -or
            [Math]::Abs([int]$actual.G - [int]$lowColor.G) -gt 2 -or
            [Math]::Abs([int]$actual.B - [int]$lowColor.B) -gt 2) {
          throw "Small-only icon fallback changed: $actual"
        }
      }
    } finally {
      if ($null -ne $image) { $image.Dispose() }
      $stream.Dispose()
    }
  }
  ConvertTo-Json -InputObject @{ runtime = $PSVersionTable.PSVersion.ToString(); sameNameIco = $true;
    sameNameExe = $true; differentNameIco = $true; highResolutionFrame = $true;
    onePixelDetail = $true; transparentPixels = $true; semitransparentPixels = $true;
    smallFrameFallback = $true; directExeHighResolution = $true } -Compress
} finally {
  if ($null -ne $shortcut) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shortcut) }
  if ($null -ne $shell) { $null = [Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell) }
  Remove-Item -LiteralPath $fixture -Recurse -Force
}
