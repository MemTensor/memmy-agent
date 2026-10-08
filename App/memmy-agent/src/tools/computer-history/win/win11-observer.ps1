param([switch]$List, [switch]$SelfTest)

# A signed-in Windows 11 user's foreground UI Automation tree. The Node
# recorder applies the saved app/site policy before persisting these events.
$ErrorActionPreference = 'Stop'
# Windows PowerShell 5.1 otherwise writes redirected output using the active
# console code page. App names and UIA text must reach Node as UTF-8 JSON.
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class MemmyHistoryWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int capacity);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongW")] public static extern int GetWindowStyle(IntPtr hwnd, int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder className, int capacity);
  public static bool IsPasswordEdit(IntPtr hwnd) {
    var className = new StringBuilder(256);
    if (GetClassName(hwnd, className, className.Capacity) == 0 ||
        className.ToString().IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) < 0) return false;
    return (GetWindowStyle(hwnd, -16) & 0x20) != 0;
  }
}
'@

function AppId([string]$name) {
  return 'win32.' + ($name.ToLowerInvariant() -replace '[^a-z0-9._-]', '-')
}

if ($List) {
  # Windows has no bundle display name. The Start Menu shortcut is the name
  # the user sees ("钉钉"); the process name ("DingTalk") is only a fallback
  # for a window that has no shortcut. Helpers never belong in this list.
  $byId = @{}
  function Remember([string]$bundleId, [string]$name, [bool]$preferred) {
    if (-not $bundleId -or -not $name) { return }
    if ($byId.ContainsKey($bundleId)) {
      if ($preferred -and -not $byId[$bundleId].preferred) {
        $byId[$bundleId] = @{ name = $name; preferred = $true }
      }
      return
    }
    $byId[$bundleId] = @{ name = $name; preferred = $preferred }
  }
  function IsHelperName([string]$name) {
    return $name -match '(?i)(helper|crashpad|crashhandler|updater|renderer|gpu-process)$'
  }
  try {
    $shell = New-Object -ComObject WScript.Shell
    $menus = @([Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('CommonStartMenu')) |
      Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -Unique
    foreach ($menu in $menus) {
      foreach ($shortcut in @(Get-ChildItem -LiteralPath $menu -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)) {
        try {
          $link = $shell.CreateShortcut($shortcut.FullName)
          $target = $link.TargetPath
          if (-not $target -or [IO.Path]::GetExtension($target) -ne '.exe') { continue }
          $processName = [IO.Path]::GetFileNameWithoutExtension($target)
          if ($processName -ieq 'Update' -and $link.Arguments -match '--processStart\s+"?([^\s"]+\.exe)') {
            $processName = [IO.Path]::GetFileNameWithoutExtension($Matches[1])
          }
          if ($processName -match '^(Update|Uninstall|unins[0-9]+)$' -or (IsHelperName $processName)) { continue }
          if (-not $processName -or -not $shortcut.BaseName) { continue }
          Remember (AppId $processName) $shortcut.BaseName $true
        } catch { continue }
      }
    }
  } catch { }
  foreach ($process in @(Get-Process | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })) {
    if (IsHelperName $process.ProcessName) { continue }
    $name = $process.ProcessName
    try {
      if ($process.Path) {
        $description = [Diagnostics.FileVersionInfo]::GetVersionInfo($process.Path).FileDescription
        if ($description) { $name = $description.Trim() }
      }
    } catch { }
    if (-not $name) { continue }
    Remember (AppId $process.ProcessName) $name $false
  }
  $apps = @($byId.Keys | Sort-Object | ForEach-Object {
    [pscustomobject]@{ bundleId = $_; name = $byId[$_].name }
  })
  # Windows PowerShell 5.1 emits a bare object for a one-item array.
  if ($apps.Count -eq 0) { '[]' }
  else {
    $json = ConvertTo-Json -InputObject $apps -Compress -Depth 4
    if ($apps.Count -eq 1) { "[$json]" } else { $json }
  }
  exit 0
}

function Clean([object]$value, [int]$limit = 320) {
  if ($null -eq $value) { return '' }
  $s = [string]$value
  $s = $s.Replace('|', '/').Replace("`r", ' ').Replace("`n", ' ').Trim()
  if ($s.Length -gt $limit) { return $s.Substring(0, $limit) }
  return $s
}

function Snapshot([IntPtr]$hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { return '' }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@($root, 0))
  $lines = New-Object 'System.Collections.Generic.List[string]'
  while ($queue.Count -gt 0 -and $lines.Count -lt 200) {
    $pair = $queue.Dequeue()
    $element = [System.Windows.Automation.AutomationElement]$pair[0]
    $depth = [int]$pair[1]
    try {
      $current = $element.Current
      $isPassword = [bool]$current.IsPassword
      # Some Win32/WinForms providers report ES_PASSWORD edit controls as
      # generic panes with IsPassword=false and put their value in Name.
      $nativeHandle = [IntPtr]$current.NativeWindowHandle
      if ($nativeHandle -ne [IntPtr]::Zero) {
        if ([MemmyHistoryWindow]::IsPasswordEdit($nativeHandle)) { $isPassword = $true }
      }
      $role = Clean ($current.ControlType.ProgrammaticName) 80
      $name = if ($isPassword) { '' } else { Clean ($current.Name) }
      $identifier = if ($isPassword) { '' } else { Clean ($current.AutomationId) 160 }
      $value = ''
      if (-not $isPassword) {
        try {
          $pattern = $element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
          $value = Clean ($pattern.Current.Value) 1000
        } catch {}
        if (-not $value) {
          try {
            $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
            $value = Clean ($pattern.DocumentRange.GetText(1000)) 1000
          } catch {}
        }
      }
      $subrole = if ($isPassword) { 'AXSecureTextField' } else { '' }
      $lines.Add("$role|$subrole|$name||$identifier|$value")
      if ($depth -ge 5) { continue }
      $child = $walker.GetFirstChild($element)
      while ($null -ne $child -and ($queue.Count + $lines.Count) -lt 250) {
        $queue.Enqueue(@($child, ($depth + 1)))
        $child = $walker.GetNextSibling($child)
      }
    } catch { continue }
  }
  return [string]::Join("`n", $lines)
}

if ($SelfTest) {
  # Exercise the same UIA traversal used by the live observer on a local
  # window. This runs on a Windows CI desktop without reading user activity.
  Add-Type -AssemblyName System.Windows.Forms
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Memmy History UIA probe'
  $form.Width = 400
  $form.Height = 180
  $label = New-Object System.Windows.Forms.Label
  # PowerShell 5.1 decodes a UTF-8 script without BOM using the active ANSI
  # code page. Construct the probe text from code points so the shipped helper
  # can remain UTF-8 without BOM and still verify Unicode UIA output.
  $probeText = ([char[]]@(0x53EF, 0x89C1, 0x6D3B, 0x52A8, 0x8BB0, 0x5F55)) -join ''
  $label.Text = $probeText
  $label.AutoSize = $true
  $label.Left = 20
  $label.Top = 20
  $form.Controls.Add($label)
  $password = New-Object System.Windows.Forms.TextBox
  $password.UseSystemPasswordChar = $true
  $password.Text = 'SecretHistoryProbe'
  $password.Left = 20
  $password.Top = 55
  $form.Controls.Add($password)
  try {
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    Start-Sleep -Milliseconds 200
    $snapshot = Snapshot $form.Handle
    if ($snapshot -notmatch [regex]::Escape($probeText)) { throw 'UIA did not read the visible probe' }
    if ($snapshot -notmatch 'ControlType\.(Text|Pane)\|') { throw 'UIA did not expose a content role' }
    if ($snapshot -match 'SecretHistoryProbe') { throw 'UIA exposed password text' }
    if ($snapshot -notmatch 'AXSecureTextField') { throw 'UIA did not classify the password control' }
    ConvertTo-Json -InputObject @{ platform = 'Windows 11'; uia = $true; passwordRedacted = $true; unicode = $probeText } -Compress
  } finally {
    $form.Close()
    $form.Dispose()
  }
  exit 0
}

function IsPrivateTitle([string]$title) {
  if (-not $title) { return $null }
  $lower = $title.ToLowerInvariant()
  foreach ($marker in @('incognito', 'inprivate', '(private)', 'private browsing', '无痕', '隐私浏览', '私密浏览')) {
    if ($lower.Contains($marker)) { return $true }
  }
  return $false
}

function SanitizeUrl([string]$raw) {
  if (-not $raw) { return '' }
  $raw = $raw.Trim()
  if ($raw -notmatch '^[a-z][a-z0-9+.-]*://') {
    if ($raw -match '^[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$') { $raw = "https://$raw" } else { return '' }
  }
  try {
    $uri = [Uri]$raw
    if ($uri.Scheme -ne 'http' -and $uri.Scheme -ne 'https') { return '' }
    $builder = New-Object System.UriBuilder $uri
    $builder.Query = ''
    $builder.Fragment = ''
    $builder.UserName = ''
    $builder.Password = ''
    return $builder.Uri.GetLeftPart([System.UriPartial]::Path)
  } catch { return '' }
}

# The address bar is the page the website rule has to see. The walk is bounded
# so a browser window cannot stall the observer.
function BrowserUrl([IntPtr]$hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { return '' }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue(@($root, 0))
  $seen = 0
  $deadline = [DateTime]::UtcNow.AddMilliseconds(200)
  while ($queue.Count -gt 0 -and $seen -lt 80 -and [DateTime]::UtcNow -lt $deadline) {
    $item = $queue.Dequeue()
    $element = $item[0]
    $depth = [int]$item[1]
    $seen++
    try {
      $type = $element.Current.ControlType
      $edit = [System.Windows.Automation.ControlType]::Edit
      $combo = [System.Windows.Automation.ControlType]::ComboBox
      if ($type.Id -eq $edit.Id -or $type.Id -eq $combo.Id) {
        $label = [string]$element.Current.Name
        if ($label -match '(?i)address|omnibox|url|地址|搜索栏|网址') {
          $pattern = $null
          $value = ''
          if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
            $value = [string]$pattern.Current.Value
          }
          $sanitized = SanitizeUrl $value
          if ($sanitized) { return $sanitized }
        }
      }
      if ($depth -lt 6) {
        $child = $walker.GetFirstChild($element)
        while ($null -ne $child -and $queue.Count -lt 40) {
          $queue.Enqueue(@($child, ($depth + 1)))
          $child = $walker.GetNextSibling($child)
        }
      }
    } catch { continue }
  }
  return ''
}

$lastWindow = ''
$lastSnapshot = ''
while ($true) {
  try {
    $hwnd = [MemmyHistoryWindow]::GetForegroundWindow()
    if ($hwnd -eq [IntPtr]::Zero) { Start-Sleep -Milliseconds 900; continue }
    [uint32]$processId = 0
    [void][MemmyHistoryWindow]::GetWindowThreadProcessId($hwnd, [ref]$processId)
    $process = Get-Process -Id $processId -ErrorAction Stop
    $name = Clean $process.ProcessName 128
    $id = AppId $name
    # Personal WeChat stays out of screen History until the separate chat consent is on.
    $memmyHome = if ($env:MEMMY_HOME -and $env:MEMMY_HOME.Trim()) { $env:MEMMY_HOME } else { Join-Path $env:USERPROFILE ".memmy" }
    $consent = Join-Path $memmyHome "computer-history\wechat\consent.json"
    $wechatAllowed = $false
    if (Test-Path -LiteralPath $consent) {
      try {
        $state = Get-Content -LiteralPath $consent -Raw -ErrorAction Stop | ConvertFrom-Json
        $wechatAllowed = ($state.version -eq 1) -and ($state.enabled -eq $true) -and $state.consentId
      } catch {
        $wechatAllowed = $false
      }
    }
    if (($id -eq 'win32.wechat' -or $id -eq 'win32.weixin') -and -not $wechatAllowed) {
      $lastWindow = ''
      $lastSnapshot = ''
      Start-Sleep -Milliseconds 900
      continue
    }
    $titleBuffer = New-Object System.Text.StringBuilder 1024
    [void][MemmyHistoryWindow]::GetWindowText($hwnd, $titleBuffer, $titleBuffer.Capacity)
    $title = Clean ($titleBuffer.ToString()) 500
    $windowKey = "$processId`:$hwnd`:$title"
    $browser = $name -match '^(msedge|chrome|firefox|brave|vivaldi|opera|chromium|arc|quark)$'
    # A title that names private mode is excluded outright. An empty title cannot
    # prove the window is a normal one, so it stays unknown and is not recorded.
    # A normal window carries its address so a saved website rule can drop that
    # page without dropping every other page.
    $private = $null
    $url = ''
    if ($browser) {
      $private = IsPrivateTitle $title
      if ($private -eq $false) { $url = BrowserUrl $hwnd }
    }
    $snapshot = if ($browser -and $private -ne $false) { '' } else { Snapshot $hwnd }
    if ($windowKey -ne $lastWindow -or $snapshot -ne $lastSnapshot) {
      $kind = if ($windowKey -ne $lastWindow) { 'window.changed' } else { 'accessibility.changed' }
      $window = @{ title = $title; browser = [bool]$browser }
      if ($url) { $window.url = $url }
      if ($private -eq $true) { $window.privateBrowsing = $true }
      elseif ($browser -and $null -eq $private) { $window.privateBrowsingUnknown = $true }
      $event = @{
        kind = $kind
        timestamp = [DateTime]::UtcNow.ToString('o')
        app = @{ name = $name; bundleIdentifier = $id; secureInput = $false }
        window = $window
        ax = @{ mode = 'fullTree'; windowKey = $windowKey; text = $snapshot }
      }
      ConvertTo-Json -InputObject $event -Compress -Depth 8
      $lastWindow = $windowKey
      $lastSnapshot = $snapshot
    }
  } catch {
    # Foreground windows can disappear between Win32 and UIA calls. Retry the
    # next window rather than terminating the whole observation session.
  }
  Start-Sleep -Milliseconds 900
}
