param([Parameter(Mandatory = $true)][string]$IdsBase64)

$ErrorActionPreference = 'Stop'

# The only caller-supplied values are bounded History process ids. File paths
# come from Windows' running processes or Start Menu shortcuts, never the API.
try {
  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($IdsBase64))
  # Windows PowerShell 5.1 emits a parsed JSON array as one pipeline object.
  # Flatten it before checking each History application id.
  $ids = @($json | ConvertFrom-Json | ForEach-Object { $_ })
} catch { exit 2 }
if ($ids.Count -gt 48) { exit 2 }
$wanted = @{}
foreach ($id in $ids) {
  if ($id -isnot [string] -or $id -cnotmatch '^win32\.[a-z0-9._-]{1,128}$') { exit 2 }
  $wanted[$id] = $true
}

Add-Type -AssemblyName System.Drawing
$iconSource = @'
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public static class MemmyWindowsHistoryIcon {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct SHFILEINFO {
        public IntPtr hIcon;
        public int iIcon;
        public uint dwAttributes;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szDisplayName;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 80)] public string szTypeName;
    }

    [DllImport("shell32.dll", EntryPoint = "SHGetFileInfoW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern IntPtr SHGetFileInfo(string path, uint attributes,
        ref SHFILEINFO info, uint size, uint flags);

    [DllImport("shell32.dll", EntryPoint = "SHDefExtractIconW", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int SHDefExtractIcon(string path, int index, uint flags,
        out IntPtr largeIcon, IntPtr smallIcon, uint size);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DestroyIcon(IntPtr icon);

    private static IntPtr ExtractResource64(string path, int index) {
        string resource = Environment.ExpandEnvironmentVariables(path ?? "").Trim('"');
        string extension = Path.GetExtension(resource).ToLowerInvariant();
        if (resource.Length < 3 || !Char.IsLetter(resource[0]) || resource[1] != ':'
            || (resource[2] != '\\' && resource[2] != '/')
            || (extension != ".exe" && extension != ".dll" && extension != ".ico")
            || !File.Exists(resource)) return IntPtr.Zero;
        IntPtr extracted;
        int result = SHDefExtractIcon(resource, index, 0, out extracted, IntPtr.Zero, 64);
        if (result == 0 && extracted != IntPtr.Zero) return extracted;
        if (extracted != IntPtr.Zero) DestroyIcon(extracted);
        return IntPtr.Zero;
    }

    private static IntPtr Extract64(string path) {
        // SHGFI_LARGEICON uses the system metric (often 32px), not the PNG's
        // desired size. Resolve the Shell's resource/index first, including a
        // shortcut's .ico/.dll IconLocation, then request a real 64px HICON.
        SHFILEINFO location = new SHFILEINFO();
        if (SHGetFileInfo(path, 0, ref location, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), 0x1000) != IntPtr.Zero) {
            IntPtr resourceIcon = ExtractResource64(location.szDisplayName, location.iIcon);
            if (resourceIcon != IntPtr.Zero) return resourceIcon;
        }
        // Executable handlers can report a successful but empty IconLocation.
        // Their primary resource is still extractable at the requested size.
        if (String.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase)) {
            IntPtr executableIcon = ExtractResource64(path, 0);
            if (executableIcon != IntPtr.Zero) return executableIcon;
        }

        // Some Shell handlers do not expose a file-backed resource. Preserve
        // their registered icon instead of turning a quality miss into no icon.
        SHFILEINFO info = new SHFILEINFO();
        if (SHGetFileInfo(path, 0, ref info, (uint)Marshal.SizeOf(typeof(SHFILEINFO)), 0x100) == IntPtr.Zero
            || info.hIcon == IntPtr.Zero) return IntPtr.Zero;
        return info.hIcon;
    }

    public static string Png64(string path) {
        IntPtr handle = Extract64(path);
        if (handle == IntPtr.Zero) return null;
        try {
            using (Icon icon = (Icon)Icon.FromHandle(handle).Clone())
            using (Bitmap output = new Bitmap(64, 64, PixelFormat.Format32bppArgb))
            using (MemoryStream stream = new MemoryStream()) {
                // DrawIcon preserves the HICON alpha/mask. Icon.ToBitmap can
                // lose transparency for some Windows icon resources.
                using (Graphics graphics = Graphics.FromImage(output)) {
                    graphics.Clear(Color.Transparent);
                    graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
                    graphics.SmoothingMode = SmoothingMode.HighQuality;
                    graphics.DrawIcon(icon, new Rectangle(0, 0, 64, 64));
                }
                output.Save(stream, ImageFormat.Png);
                return Convert.ToBase64String(stream.ToArray());
            }
        } finally {
            DestroyIcon(handle);
        }
    }
}
'@
Add-Type -TypeDefinition $iconSource -ReferencedAssemblies @('System.Drawing.dll')

function AppId([string]$name) {
  return 'win32.' + ($name.ToLowerInvariant() -replace '[^a-z0-9._-]', '-')
}

$runningCandidates = @{}
$shortcutCandidates = @{}
function Remember([hashtable]$candidates, [string]$id, [string]$candidatePath) {
  if (-not $wanted.ContainsKey($id) -or -not $candidatePath) { return }
  try {
    $expanded = [Environment]::ExpandEnvironmentVariables($candidatePath.Trim('"'))
    # IsPathRooted also accepts C:relative.exe and \root-relative.exe.
    # Only a local, drive-absolute executable or shortcut can be read.
    if ($expanded -notmatch '^[A-Za-z]:[\\/]' -or -not [IO.Path]::IsPathRooted($expanded)) { return }
    $full = [IO.Path]::GetFullPath($expanded)
    if ([IO.Path]::GetExtension($full) -notin @('.exe', '.lnk')) { return }
    if (-not (Test-Path -LiteralPath $full -PathType Leaf)) { return }
    if (-not $candidates.ContainsKey($id)) { $candidates[$id] = @{} }
    $candidates[$id][$full] = $full
  } catch { return }
}

# Explorer and other desktop apps can own visible windows without reporting a
# MainWindowHandle through Get-Process. Match requested process names first;
# inspect their executable paths only for those names.
foreach ($process in @(Get-Process)) {
  try {
    $id = AppId $process.ProcessName
    if ($wanted.ContainsKey($id) -and $process.Path) { Remember $runningCandidates $id $process.Path }
  } catch { continue }
}

# The app picker also contains apps that are installed but not running. Reuse
# its Start Menu identity rule, including Squirrel --processStart shortcuts.
try {
  $shell = New-Object -ComObject WScript.Shell
  $menus = @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu')) |
    Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
  foreach ($menu in $menus) {
    foreach ($shortcut in @(Get-ChildItem -LiteralPath $menu -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)) {
      try {
        $link = $shell.CreateShortcut($shortcut.FullName)
        $target = [string]$link.TargetPath
        if ([IO.Path]::GetExtension($target) -ine '.exe') { continue }
        $processName = [IO.Path]::GetFileNameWithoutExtension($target)
        if ($processName -ieq 'Update' -and $link.Arguments -match '--processStart\s+"?([^\s"]+\.exe)') {
          $processName = [IO.Path]::GetFileNameWithoutExtension($Matches[1])
          # Update.exe is a launcher, not the app's icon. Squirrel normally
          # points IconLocation at the real app executable. If it does not,
          # the Shell can still resolve the local shortcut's chosen icon.
          $iconPath = ([string]$link.IconLocation) -replace ',\s*-?\d+\s*$', ''
          # Remember accepts executables and shortcuts, not .ico/.dll files.
          # Let the Shell resolve those through the shortcut's IconLocation.
          if ([IO.Path]::GetExtension($iconPath) -ieq '.exe' -and
              [IO.Path]::GetFileNameWithoutExtension($iconPath) -ieq $processName -and
              (Test-Path -LiteralPath $iconPath -PathType Leaf)) {
            Remember $shortcutCandidates (AppId $processName) $iconPath
          } else {
            Remember $shortcutCandidates (AppId $processName) $shortcut.FullName
          }
        } elseif ($processName) {
          Remember $shortcutCandidates (AppId $processName) $target
        }
      } catch { continue }
    }
  }
} catch { }

$icons = @{}
foreach ($id in $wanted.Keys) {
  $icons[$id] = $null
  # A running window's executable is the best available match for History.
  # Start Menu links can point at old app versions or an Update.exe launcher,
  # so use them only when the app is not running. Within either source, a
  # process-name collision stays unresolved rather than picking at random.
  $source = if ($runningCandidates.ContainsKey($id)) { $runningCandidates[$id] } elseif ($shortcutCandidates.ContainsKey($id)) { $shortcutCandidates[$id] } else { $null }
  if ($null -eq $source -or $source.Count -ne 1) { continue }
  try {
    $onlyPath = @($source.Values)[0]
    $icons[$id] = [MemmyWindowsHistoryIcon]::Png64($onlyPath)
  } catch { }
}
ConvertTo-Json -InputObject $icons -Compress -Depth 3
