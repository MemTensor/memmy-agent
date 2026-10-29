param([switch]$List, [switch]$SelfTest, [switch]$Sample, [string]$Fixture = '',
  [int]$ParentProcessId = 0, [long]$ParentStartTimeTicks = 0)

# Protocol fixtures exercise the real worker deadline without observing a desktop.
if ($Fixture) {
  if ($Fixture -eq 'timeout') { Start-Sleep -Seconds 15; exit 0 }
  if ($Fixture -eq 'failure') { exit 7 }
  if ($Fixture -eq 'healthy') { '{"ok":true,"skipped":true,"readFailures":0}'; exit 0 }
  exit 8
}

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
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class MemmyHistoryWindow {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int capacity);
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
public static class MemmyHistoryWorkerJob {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimits {
    public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
    public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
    public uint ActiveProcessLimit;
    public UIntPtr Affinity;
    public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters {
    public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount;
    public ulong ReadTransferCount, WriteTransferCount, OtherTransferCount;
  }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimits {
    public BasicLimits BasicLimitInformation;
    public IoCounters IoInfo;
    public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(SafeFileHandle job, int infoClass, ref ExtendedLimits info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(SafeFileHandle job, IntPtr process);
  public static SafeFileHandle Create() {
    var job = CreateJobObject(IntPtr.Zero, null);
    if (job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
    var info = new ExtendedLimits();
    info.BasicLimitInformation.LimitFlags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if (!SetInformationJobObject(job, 9, ref info, (uint)Marshal.SizeOf(info))) {
      int error = Marshal.GetLastWin32Error(); job.Dispose(); throw new Win32Exception(error);
    }
    return job;
  }
  public static bool Add(SafeFileHandle job, Process process) { return AssignProcessToJobObject(job, process.Handle); }
}
public static class MemmyHistoryParentWatchdog {
  static System.Threading.Timer timer;
  public static void Start(int parentId, long startedAt) {
    Action check = delegate {
      try {
        using (var parent = Process.GetProcessById(parentId)) {
          if (!parent.HasExited && parent.StartTime.ToUniversalTime().Ticks == startedAt) return;
        }
      } catch { }
      Process.GetCurrentProcess().Kill();
    };
    check();
    if (timer != null) timer.Dispose();
    // Covers the small Process.Start -> AssignProcessToJobObject race. Runs
    // independently of the UIA provider thread, with no captured user data.
    timer = new System.Threading.Timer(delegate { check(); }, null, 250, 250);
  }
}
'@

function AppId([string]$name) {
  return 'win32.' + ($name.ToLowerInvariant() -replace '[^a-z0-9._-]', '-')
}

function ApplicationCatalogJson([object[]]$apps) {
  if ($apps.Count -eq 0) { return '[]' }
  $json = ConvertTo-Json -InputObject $apps -Compress -Depth 4
  # Explicit InputObject arrays already retain their brackets. A pipeline or
  # older serializer may emit a bare singleton; wrap only that representation.
  if ($json.TrimStart().StartsWith('[')) { return $json }
  return "[$json]"
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
  ApplicationCatalogJson $apps
  exit 0
}

function Clean([object]$value, [int]$limit = 320) {
  if ($null -eq $value) { return '' }
  $s = [string]$value
  $s = $s.Replace('|', '/').Replace("`r", ' ').Replace("`n", ' ').Trim()
  if ($s.Length -gt $limit) { return $s.Substring(0, $limit) }
  return $s
}

# Same sampled tree as the macOS recorder: breadth-first over at most 400
# elements and 24 children per element, at any depth. Qt and Chromium windows
# keep their content many levels below the frame. Each UIA read crosses into
# the target process, so a deadline returns a partial tree before the worker's
# hard timeout would discard it.
function Snapshot([IntPtr]$hwnd, [int]$budgetMs = 2000) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) { return @{ text = ''; ok = $false; readFailures = 1; truncated = $false } }
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $queue = New-Object System.Collections.Queue
  $queue.Enqueue($root)
  $lines = New-Object 'System.Collections.Generic.List[string]'
  $visited = 0
  $readable = 0
  $readFailures = 0
  $truncated = $false
  $deadline = [DateTime]::UtcNow.AddMilliseconds($budgetMs)
  while ($queue.Count -gt 0 -and $visited -lt 400) {
    if ([DateTime]::UtcNow -ge $deadline) { $truncated = $true; break }
    $element = [System.Windows.Automation.AutomationElement]$queue.Dequeue()
    $visited++
    try {
      $current = $element.Current
      $readable++
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
      if ($subrole -or $name -or $identifier -or $value) { $lines.Add("$role|$subrole|$name||$identifier|$value") }
      $child = $walker.GetFirstChild($element)
      $children = 0
      while ($null -ne $child -and $children -lt 24) {
        $queue.Enqueue($child)
        $children++
        $child = $walker.GetNextSibling($child)
      }
      if ($null -ne $child) { $truncated = $true }
    } catch { $readFailures++; continue }
  }
  if ($queue.Count -gt 0) { $truncated = $true }
  return @{ text = [string]::Join("`n", $lines); ok = ($readable -gt 0); readFailures = $readFailures; truncated = $truncated }
}


function UnicodeText([int[]]$points) { return ([char[]]$points) -join '' }
# A cheap pre-filter so a blatantly private window's accessibility tree never
# leaves this helper. The full, data-driven privacy decision (every locale's
# markers, the private avatar control, and the authoritative browser-extension
# tab stream) lives in the Node layer; keep this list a subset aligned with
# PRIVATE_TITLE_MARKERS in ../browser-privacy.ts.
$privateTitleMarkers = @('incognito', 'inprivate', 'private browsing',
  '[inprivate]', '[incognito]', '[guest]', '[private]',
  (UnicodeText @(0x65E0,0x75D5)), (UnicodeText @(0x9690,0x79C1,0x6D4F,0x89C8)),
  (UnicodeText @(0x79C1,0x5BC6,0x6D4F,0x89C8)), (UnicodeText @(0x7121,0x75D5)),
  ('[' + (UnicodeText @(0x8BBF,0x5BA2)) + ']'), ('[' + (UnicodeText @(0x8A2A,0x5BA2)) + ']'))

# The Node layer resolves a browser window's real URL and privacy from the full
# tree and the extension bridge. The helper only drops a window whose title
# itself plainly marks a private session, so that tree is never captured.
function IsBlatantlyPrivateTitle([string]$title) {
  if (-not $title) { return $false }
  $lower = $title.ToLowerInvariant()
  foreach ($marker in $privateTitleMarkers) { if ($lower.Contains($marker.ToLowerInvariant())) { return $true } }
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

function CaptureWindowSample {
  $hwnd = [MemmyHistoryWindow]::GetForegroundWindow()
  if ($hwnd -eq [IntPtr]::Zero) { return @{ ok = $true; skipped = $true; readFailures = 0; observed = $false } }
  [uint32]$processId = 0
  [void][MemmyHistoryWindow]::GetWindowThreadProcessId($hwnd, [ref]$processId)
  $process = Get-Process -Id $processId -ErrorAction Stop
  $name = Clean $process.ProcessName 128
  $id = AppId $name
  $memmyHome = if ($env:MEMMY_HOME -and $env:MEMMY_HOME.Trim()) { $env:MEMMY_HOME } else { Join-Path $env:USERPROFILE '.memmy' }
  $consent = Join-Path $memmyHome 'computer-history\wechat\consent.json'
  $wechatAllowed = $false
  if (Test-Path -LiteralPath $consent) {
    try {
      $state = Get-Content -LiteralPath $consent -Raw -ErrorAction Stop | ConvertFrom-Json
      $wechatAllowed = ($state.version -eq 1) -and ($state.enabled -eq $true) -and $state.consentId
    } catch { }
  }
  if (($id -eq 'win32.wechat' -or $id -eq 'win32.weixin') -and -not $wechatAllowed) {
    return @{ ok = $true; skipped = $true; readFailures = 0; observed = $false }
  }
  $titleBuffer = New-Object System.Text.StringBuilder 1024
  [void][MemmyHistoryWindow]::GetWindowText($hwnd, $titleBuffer, $titleBuffer.Capacity)
  $title = Clean ($titleBuffer.ToString()) 500
  $browser = $name -match '^(msedge|chrome|firefox|brave|vivaldi|opera|chromium|arc|quark)$'
  if ($browser -and (IsBlatantlyPrivateTitle $title)) {
    # The Node layer makes the full privacy decision from the tree and the
    # extension bridge, but a title that plainly marks a private session is
    # dropped here so that window's tree is never captured at all.
    return @{ ok = $true; skipped = $true; privacyUnknown = $false; readFailures = 0; observed = $false }
  }
  $snapshot = Snapshot $hwnd
  # UIA can outlive a focus switch. Never attribute a stale tree to the new app.
  if ([MemmyHistoryWindow]::GetForegroundWindow() -ne $hwnd) { return @{ ok = $true; skipped = $true; readFailures = 0 } }
  [uint32]$currentProcessId = 0
  [void][MemmyHistoryWindow]::GetWindowThreadProcessId($hwnd, [ref]$currentProcessId)
  if ($currentProcessId -ne $processId) { return @{ ok = $true; skipped = $true; readFailures = 0 } }
  $event = @{
    timestamp = [DateTime]::UtcNow.ToString('o')
    app = @{ name = $name; bundleIdentifier = $id; secureInput = $false }
    # A browser window carries no URL or privacy flag here: the Node recorder
    # resolves both from the tree below and the authoritative extension bridge.
    window = @{ title = $title; browser = [bool]$browser }
    ax = @{ mode = 'fullTree'; windowKey = "$processId`:$hwnd`:$title"; text = $snapshot.text }
  }
  return @{ ok = $snapshot.ok; skipped = $false; observed = $snapshot.ok; event = $event;
    foregroundWindow = $hwnd.ToInt64().ToString(); foregroundProcessId = [int]$processId;
    readFailures = $snapshot.readFailures; truncated = $snapshot.truncated }
}

# UIA calls can block inside a provider. A short-lived child process, rather
# than Thread.Abort or a loop-only deadline, gives each sample a hard boundary.
function NormalizeWorkerSample([object]$result) {
  $invalid = @{ ok = $false; reason = 'protocol' }
  if ($null -eq $result -or $result -is [array] -or $result.ok -isnot [bool]) { return $invalid }
  if (-not $result.ok) { return @{ ok = $false; reason = 'uia'; readFailures = 1 } }
  if ($result.skipped -isnot [bool] -or
    ($result.readFailures -isnot [int] -and $result.readFailures -isnot [long]) -or
    $result.readFailures -lt 0 -or $result.readFailures -gt 10000) { return $invalid }
  foreach ($field in @('observed', 'truncated', 'privacyUnknown')) {
    if ($null -ne $result.$field -and $result.$field -isnot [bool]) { return $invalid }
  }
  $sample = @{ ok = $true; skipped = $result.skipped; readFailures = $result.readFailures;
    observed = ($result.observed -eq $true); truncated = ($result.truncated -eq $true); privacyUnknown = ($result.privacyUnknown -eq $true) }
  if ($result.skipped) { return $sample }
  $event = $result.event
  if ($null -eq $event -or $event -is [array] -or
    $event.timestamp -isnot [string] -or $event.timestamp -notmatch '^\d{4}-\d{2}-\d{2}T' -or $event.timestamp.Length -gt 64 -or
    $event.app.name -isnot [string] -or $event.app.name.Length -gt 128 -or
    $event.app.bundleIdentifier -isnot [string] -or $event.app.bundleIdentifier -notmatch '^win32\.[a-z0-9._-]{1,128}$' -or
    $event.window.title -isnot [string] -or $event.window.title.Length -gt 500 -or $event.window.browser -isnot [bool] -or
    $event.ax.mode -ne 'fullTree' -or $event.ax.windowKey -isnot [string] -or $event.ax.windowKey.Length -gt 600 -or
    $event.ax.text -isnot [string] -or $event.ax.text.Length -gt 300000 -or
    $result.foregroundWindow -isnot [string] -or $result.foregroundWindow -notmatch '^-?\d{1,19}$' -or
    ($result.foregroundProcessId -isnot [int] -and $result.foregroundProcessId -isnot [long]) -or
    $result.foregroundProcessId -le 0 -or $result.foregroundProcessId -gt [int]::MaxValue) { return $invalid }
  $timestamp = [DateTime]::MinValue
  if (-not [DateTime]::TryParse($event.timestamp, [ref]$timestamp)) { return $invalid }
  $projected = @{ timestamp = $event.timestamp;
    app = @{ name = $event.app.name; bundleIdentifier = $event.app.bundleIdentifier; secureInput = $false };
    window = @{ title = $event.window.title; browser = $event.window.browser };
    ax = @{ mode = 'fullTree'; windowKey = $event.ax.windowKey; text = $event.ax.text } }
  if ($null -ne $event.window.url) {
    if ($event.window.url -isnot [string] -or $event.window.url.Length -gt 2000 -or
      (SanitizeUrl $event.window.url) -ne $event.window.url) { return $invalid }
    $projected.window.url = $event.window.url
  }
  $sample.event = $projected
  $sample.foregroundWindow = $result.foregroundWindow; $sample.foregroundProcessId = [int]$result.foregroundProcessId
  return $sample
}

function InvokeHistorySample([string]$fixture = '', [int]$timeoutMs = 4000) {
  $info = New-Object System.Diagnostics.ProcessStartInfo
  $info.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $info.Arguments = '-NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File "' + $PSCommandPath + '" -Sample'
  $parentTicks = (Get-Process -Id $PID).StartTime.ToUniversalTime().Ticks
  $info.Arguments += ' -ParentProcessId ' + $PID + ' -ParentStartTimeTicks ' + $parentTicks
  if ($fixture) { $info.Arguments += ' -Fixture ' + $fixture }
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $info.StandardOutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $info.StandardErrorEncoding = New-Object System.Text.UTF8Encoding($false)
  $worker = New-Object System.Diagnostics.Process
  $worker.StartInfo = $info
  $job = $null
  try {
    # The OS closes this non-inherited handle even if Node forcibly stops the
    # supervisor. Any outstanding UIA worker is then killed, not orphaned.
    $job = [MemmyHistoryWorkerJob]::Create()
    if (-not $worker.Start()) { return @{ ok = $false; reason = 'start' } }
    if (-not [MemmyHistoryWorkerJob]::Add($job, $worker)) {
      try { $worker.Kill() } catch { }
      return @{ ok = $false; reason = 'job' }
    }
    $stdout = $worker.StandardOutput.ReadToEndAsync()
    $stderr = $worker.StandardError.ReadToEndAsync()
    if (-not $worker.WaitForExit($timeoutMs)) {
      try { $worker.Kill(); [void]$worker.WaitForExit(500) } catch { }
      return @{ ok = $false; reason = 'timeout' }
    }
    if ($worker.ExitCode -ne 0) { return @{ ok = $false; reason = 'exit' } }
    $raw = $stdout.GetAwaiter().GetResult()
    if ($raw.Length -gt 1024 * 1024) { return @{ ok = $false; reason = 'protocol' } }
    $result = $raw | ConvertFrom-Json -ErrorAction Stop
    return NormalizeWorkerSample $result
  } catch { return @{ ok = $false; reason = 'worker' } }
  finally {
    if ($null -ne $job) { $job.Dispose() }
    $worker.Dispose()
  }
}

$diagnosticLastAt = @{}
$diagnosticCounts = @{}
function RecorderDiagnostic([string]$code, [int]$count = 0, [int]$minimumSeconds = 10) {
  $now = [DateTime]::UtcNow
  if ($count -gt 0) { $diagnosticCounts[$code] = [int]$diagnosticCounts[$code] + $count }
  if ($diagnosticLastAt.ContainsKey($code) -and ($now - $diagnosticLastAt[$code]).TotalSeconds -lt $minimumSeconds) { return }
  $diagnosticLastAt[$code] = $now
  $payload = @{ type = 'recorder.diagnostic'; timestamp = $now.ToString('o'); code = $code }
  if ($diagnosticCounts[$code] -gt 0) { $payload.count = $diagnosticCounts[$code]; $diagnosticCounts[$code] = 0 }
  ConvertTo-Json -InputObject $payload -Compress
}

function UpdateObserverHealth([hashtable]$state, [object]$sample) {
  if (-not $sample.ok -or $sample.readFailures -gt 0) {
    $state.failures++
    if ($sample.reason -eq 'timeout') { RecorderDiagnostic 'ax_snapshot_budget_exceeded' 1 }
    if ($state.failures -ge 2) { RecorderDiagnostic 'observer_unavailable' 1; $state.ready = $false }
  } elseif ($sample.observed -eq $true) {
    # An excluded app/private window or absent foreground window cannot prove
    # recovery from a UIA failure. Only a completed UIA observation can.
    $state.failures = 0
    if (-not $state.ready) { RecorderDiagnostic 'observer_ready' 0 0; $state.ready = $true }
  }
  if ($sample.truncated) { RecorderDiagnostic 'ax_snapshot_budget_exceeded' 1 }
  if ($sample.privacyUnknown) { RecorderDiagnostic 'privacy_unknown' 1 }
}

function SampleStillForeground([object]$sample) {
  $currentWindow = [MemmyHistoryWindow]::GetForegroundWindow()
  if ($currentWindow.ToInt64().ToString() -ne $sample.foregroundWindow) { return $false }
  [uint32]$currentProcessId = 0
  [void][MemmyHistoryWindow]::GetWindowThreadProcessId($currentWindow, [ref]$currentProcessId)
  return $currentProcessId -eq $sample.foregroundProcessId
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
    $probe = Snapshot $form.Handle
    $snapshot = $probe.text
    if ($snapshot -notmatch [regex]::Escape($probeText)) { throw 'UIA did not read the visible probe' }
    if ($snapshot -notmatch 'ControlType\.(Text|Pane)\|') { throw 'UIA did not expose a content role' }
    if ($snapshot -match 'SecretHistoryProbe') { throw 'UIA exposed password text' }
    if ($snapshot -notmatch 'AXSecureTextField') { throw 'UIA did not classify the password control' }
    # Edge titles contain U+200B, which no ANSI code page can represent.
    $form.Text = 'Memmy' + [char]0x200B + ' History UIA probe'
    $titleBuffer = New-Object System.Text.StringBuilder 256
    [void][MemmyHistoryWindow]::GetWindowText($form.Handle, $titleBuffer, $titleBuffer.Capacity)
    if ($titleBuffer.ToString() -cne $form.Text) { throw 'Window title was not read as Unicode' }
    foreach ($size in 0..2) {
      $catalog = @()
      for ($index = 0; $index -lt $size; $index++) { $catalog += @{ bundleId = 'win32.probe' + $index; name = 'Probe' + $index } }
      $catalogJson = ApplicationCatalogJson $catalog
      if ($catalogJson -notmatch '^\[' -or $catalogJson -match '^\[\s*\[') { throw 'Application catalog was not a flat array' }
      # Windows PowerShell 5.1 emits a parsed JSON array as one pipeline object.
      $catalogRoundtrip = @($catalogJson | ConvertFrom-Json | ForEach-Object { $_ })
      if ($catalogRoundtrip.Count -ne $size) { throw 'Application catalog lost a row' }
      foreach ($entry in $catalogRoundtrip) { if (-not $entry.bundleId) { throw 'Application catalog nested a row' } }
    }
    $deepRoot = New-Object System.Windows.Forms.Panel
    $deepRoot.AccessibleName = 'budget-group-0'
    $deepRoot.AccessibleRole = [System.Windows.Forms.AccessibleRole]::Grouping
    $parentPanel = $deepRoot
    foreach ($index in 1..6) {
      $panel = New-Object System.Windows.Forms.Panel
      $panel.AccessibleName = 'budget-group-' + $index
      $panel.AccessibleRole = [System.Windows.Forms.AccessibleRole]::Grouping
      $parentPanel.Controls.Add($panel); $parentPanel = $panel
    }
    $deepLabel = New-Object System.Windows.Forms.Label
    $deepLabel.Text = 'DeepHistoryProbe'
    $parentPanel.Controls.Add($deepLabel)
    $form.Controls.Add($deepRoot)
    [System.Windows.Forms.Application]::DoEvents()
    if ((Snapshot $form.Handle).text -notmatch 'DeepHistoryProbe') { throw 'UIA did not read text below nested groups' }
    $form.Controls.Remove($deepRoot); $deepRoot.Dispose()
    $wideRoot = New-Object System.Windows.Forms.Panel
    $wideRoot.AccessibleName = 'budget-wide'
    $wideRoot.AccessibleRole = [System.Windows.Forms.AccessibleRole]::Grouping
    foreach ($index in 0..24) {
      $panel = New-Object System.Windows.Forms.Panel
      $panel.AccessibleName = 'budget-child-' + $index
      $panel.AccessibleRole = [System.Windows.Forms.AccessibleRole]::Grouping
      $wideRoot.Controls.Add($panel)
    }
    $form.Controls.Add($wideRoot)
    [System.Windows.Forms.Application]::DoEvents()
    if (-not (Snapshot $form.Handle).truncated) { throw 'Wide UIA budget did not report truncation' }
    if (-not (Snapshot $form.Handle 0).truncated) { throw 'Expired UIA deadline did not report truncation' }
    $form.Controls.Remove($wideRoot); $wideRoot.Dispose()
    # The helper only drops windows whose title plainly marks a private session;
    # the full privacy and URL decision belongs to the Node layer and is covered
    # by the browser-privacy unit tests. A normal title must pass; a worded or
    # bracketed private title must be dropped.
    $edgeBrand = ' - Microsoft' + [char]0x200B + ' Edge'
    if (IsBlatantlyPrivateTitle 'A normal-looking page title') { throw 'Normal page title was dropped as private' }
    if (IsBlatantlyPrivateTitle ('Example Domain - Google Chrome')) { throw 'Normal Chrome title was dropped as private' }
    if (-not (IsBlatantlyPrivateTitle ('Example Domain - [InPrivate]' + $edgeBrand))) { throw 'InPrivate title was not dropped' }
    if (-not (IsBlatantlyPrivateTitle ('Example - [' + (UnicodeText @(0x8BBF,0x5BA2)) + ']' + $edgeBrand))) { throw 'Guest title was not dropped' }
    if (-not (IsBlatantlyPrivateTitle ('YouTube - ' + (UnicodeText @(0x65E0,0x75D5,0x6A21,0x5F0F)) + ' - Google Chrome'))) { throw 'Incognito title was not dropped' }
    if ((InvokeHistorySample 'healthy' 4000).ok -ne $true) { throw 'Healthy protocol worker failed' }
    if ((InvokeHistorySample 'failure' 4000).ok -ne $false) { throw 'Failed protocol worker was accepted' }
    $started = [DateTime]::UtcNow
    if ((InvokeHistorySample 'timeout' 200).reason -ne 'timeout') { throw 'Blocked worker was not timed out' }
    if (([DateTime]::UtcNow - $started).TotalSeconds -gt 3) { throw 'Worker deadline did not bound the blocked call' }
    if ((NormalizeWorkerSample @{ ok = 'true' }).ok) { throw 'Invalid worker type was accepted' }
    if ((NormalizeWorkerSample @{ ok = $true; skipped = $true; readFailures = -1 }).ok) { throw 'Invalid worker count was accepted' }
    $envelope = @{ ok = $true; skipped = $false; observed = $true; readFailures = 0;
      foregroundWindow = $form.Handle.ToInt64().ToString(); foregroundProcessId = [long]$PID;
      event = @{ timestamp = [DateTime]::UtcNow.ToString('o');
        app = @{ name = 'selftest'; bundleIdentifier = 'win32.selftest' };
        window = @{ title = 'Memmy History UIA probe'; browser = $false };
        ax = @{ mode = 'fullTree'; windowKey = 'selftest'; text = $snapshot } } }
    $roundtrip = $envelope | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    $normalized = NormalizeWorkerSample $roundtrip
    if (-not $normalized.ok -or $normalized.event.ax.text -ne $snapshot) { throw 'Valid JSON worker event was rejected' }
    $roundtrip.foregroundProcessId = [long][int]::MaxValue + 1
    if ((NormalizeWorkerSample $roundtrip).ok) { throw 'Out-of-range worker PID was accepted' }
    $observer = @{ failures = 0; ready = $true }
    [void]@(UpdateObserverHealth $observer @{ ok = $false })
    if ($observer.failures -ne 1) { throw 'A worker failure was not counted' }
    $unavailable = @(UpdateObserverHealth $observer @{ ok = $false })
    if ($observer.ready -or $unavailable.Count -ne 1 -or ($unavailable[0] | ConvertFrom-Json).code -ne 'observer_unavailable') { throw 'Persistent UIA failure was not reported' }
    [void]@(UpdateObserverHealth $observer @{ ok = $true; skipped = $true; readFailures = 0; observed = $false })
    if ($observer.ready) { throw 'Excluded window falsely recovered the observer' }
    $ready = @(UpdateObserverHealth $observer @{ ok = $true; readFailures = 0; observed = $true })
    if (-not $observer.ready -or ($ready[0] | ConvertFrom-Json).code -ne 'observer_ready') { throw 'UIA recovery was not reported' }
    foreach ($line in @($unavailable) + @($ready)) {
      $signal = $line | ConvertFrom-Json
      if ($signal.type -ne 'recorder.diagnostic' -or @($signal.PSObject.Properties.Name | Where-Object { $_ -notin @('type', 'timestamp', 'code', 'count') }).Count) { throw 'Diagnostic protocol exposed extra data' }
    }
    ConvertTo-Json -InputObject @{ platform = 'Windows 11'; uia = $true; passwordRedacted = $true; unicode = $probeText;
      boundedWorker = $true; observerRecovery = $true; privacyFailClosed = $true; catalogFlatArray = $true } -Compress
  } finally {
    $form.Close()
    $form.Dispose()
  }
  exit 0
}


if ($Sample) {
  if ($ParentProcessId -le 0 -or $ParentStartTimeTicks -le 0) { exit 9 }
  [MemmyHistoryParentWatchdog]::Start($ParentProcessId, $ParentStartTimeTicks)
  try { ConvertTo-Json -InputObject (CaptureWindowSample) -Compress -Depth 10 }
  catch { '{"ok":false,"readFailures":1}' }
  exit 0
}

$lastWindow = ''; $lastSnapshot = ''; $lastUrl = ''
$lastFullAt = [DateTime]::MinValue
$observerState = @{ failures = 0; ready = $false }
RecorderDiagnostic 'heartbeat'
while ($true) {
  RecorderDiagnostic 'heartbeat'
  # PowerShell variable names are case-insensitive. The script's -Sample
  # switch retains a SwitchParameter constraint, so never reuse it for data.
  $workerSample = InvokeHistorySample
  UpdateObserverHealth $observerState $workerSample
  if (-not $workerSample.ok -or $workerSample.skipped -or $null -eq $workerSample.event) {
    $lastWindow = ''; $lastSnapshot = ''; $lastUrl = ''; $lastFullAt = [DateTime]::MinValue
  } else {
    if (-not (SampleStillForeground $workerSample)) {
      $lastWindow = ''; $lastSnapshot = ''; $lastUrl = ''; $lastFullAt = [DateTime]::MinValue
      continue
    }
    $event = $workerSample.event
    $key = $event.ax.windowKey; $text = $event.ax.text; $url = $event.window.url
    # Force a sparse refresh so a live policy change can reallow an unchanged
    # app. Node owns policy checks and deduplicates authorized writes on disk.
    if ($key -ne $lastWindow -or $text -ne $lastSnapshot -or $url -ne $lastUrl -or
      ([DateTime]::UtcNow - $lastFullAt).TotalSeconds -ge 30) {
      $event.kind = if ($key -ne $lastWindow) { 'window.changed' } else { 'accessibility.changed' }
      ConvertTo-Json -InputObject $event -Compress -Depth 10
      $lastWindow = $key; $lastSnapshot = $text; $lastUrl = $url; $lastFullAt = [DateTime]::UtcNow
    }
  }
  Start-Sleep -Milliseconds 900
}
