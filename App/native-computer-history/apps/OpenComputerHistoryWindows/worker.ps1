param([switch]$SelfTest)
# Persistent UIA provider worker. Reads only on commands, never records images
# or converts global raw keyboard input to text. Provider hangs are killed by
# the Go supervisor's process deadline; this script's deadlines bound traversal.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName WindowsBase
$historyUIAClient=[System.Windows.Automation.AutomationElement].Assembly.Location
$historyUIATypes=[System.Windows.Automation.AutomationIdentifier].Assembly.Location
$historyWindowsBase=[System.Windows.Point].Assembly.Location
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;
public static class HistoryNative {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll", EntryPoint="GetWindowLongW")] public static extern int GetWindowLong(IntPtr hwnd, int index);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  public static bool PasswordWindow(IntPtr hwnd) {
    var text = new StringBuilder(256);
    GetClassName(hwnd, text, text.Capacity);
    return text.ToString().IndexOf("EDIT", StringComparison.OrdinalIgnoreCase) >= 0 && (GetWindowLong(hwnd,-16)&0x20)!=0;
  }
}
public static class HistorySignals {
  static long generation;
  static long scopeGeneration;
  static AutomationElement subscribed;
  static AutomationFocusChangedEventHandler focus = delegate(object sender, AutomationFocusChangedEventArgs e) { Interlocked.Increment(ref generation); };
  static AutomationPropertyChangedEventHandler value = delegate(object sender, AutomationPropertyChangedEventArgs e) {
    Interlocked.Increment(ref generation);
    try {
      var element=sender as AutomationElement;
      if (element!=null) {
        var id=element.Current.AutomationId;
        var name=element.Current.Name;
        if (id=="addressEditBox" || id=="omnibox" || id=="urlbar-input" || id=="urlbar" || name=="Address and search bar" || name=="地址和搜索栏") Interlocked.Increment(ref scopeGeneration);
      }
    } catch { Interlocked.Increment(ref scopeGeneration); }
  };
  static AutomationEventHandler selection = delegate(object sender, AutomationEventArgs e) { Interlocked.Increment(ref generation); };
  static StructureChangedEventHandler structure = delegate(object sender, StructureChangedEventArgs e) { Interlocked.Increment(ref generation); };
  public static long Generation { get { return Interlocked.Read(ref generation); } }
  public static long ScopeGeneration { get { return Interlocked.Read(ref scopeGeneration); } }
  public static void Start() { Automation.AddAutomationFocusChangedEventHandler(focus); }
  public static void Subscribe(AutomationElement root) {
    if (subscribed != null) { try { if (Automation.Compare(subscribed,root)) return; } catch {} }
    if (subscribed != null) {
      try { Automation.RemoveAutomationPropertyChangedEventHandler(subscribed,value); } catch {}
      try { Automation.RemoveAutomationEventHandler(TextPattern.TextSelectionChangedEvent,subscribed,selection); } catch {}
      try { Automation.RemoveStructureChangedEventHandler(subscribed,structure); } catch {}
    }
    subscribed=root;
    Automation.AddAutomationPropertyChangedEventHandler(root,TreeScope.Subtree,value,ValuePattern.ValueProperty,AutomationElement.NameProperty);
    Automation.AddAutomationEventHandler(TextPattern.TextSelectionChangedEvent,root,TreeScope.Subtree,selection);
    Automation.AddStructureChangedEventHandler(root,TreeScope.Subtree,structure);
  }
}
'@ -ReferencedAssemblies @('System.dll', $historyUIAClient, $historyUIATypes, $historyWindowsBase)

function Clean([object]$value, [int]$limit=320) {
  if ($null -eq $value) { return '' }
  $s=([string]$value).Replace('|','/').Replace("`r",' ').Replace("`n",' ').Trim()
  if ($s.Length -gt $limit) { return $s.Substring(0,$limit) }
  return $s
}
function Skip([string]$reason='') { return @{ok=$true;skipped=$true;reason=$reason;readFailures=0} }
function AppId([string]$name) { return 'win32.'+($name.ToLowerInvariant() -replace '[^a-z0-9._-]','-') }
function IsWeChatProcess([string]$id) {return $id -match '^win32\.(wechat|weixin)'}
function ConsentAllowed([string]$file) {
  if (-not $file) { return $false }
  try {
    # Bounded and reread for every command; a CLI flag never grants consent.
    $info=Get-Item -LiteralPath $file -ErrorAction Stop
    if ($info.Length -gt 8192) { return $false }
    $state=[IO.File]::ReadAllText($file,[Text.Encoding]::UTF8) | ConvertFrom-Json
    return $state.version -eq 1 -and $state.enabled -eq $true -and [bool]$state.consentId
  } catch { return $false }
}
function Url([string]$raw) {
  if (-not $raw) { return '' }; $raw=$raw.Trim()
  if ($raw -notmatch '^[a-z][a-z0-9+.-]*://') { if ($raw -match '^[a-z0-9.-]+\.[a-z]{2,}([/:?#].*)?$') { $raw='https://'+$raw } else {return ''} }
  try { $uri=[Uri]$raw; if ($uri.Scheme -notin @('https','http')) {return ''}
    $builder=New-Object System.UriBuilder $uri; $builder.Query='';$builder.Fragment='';$builder.UserName='';$builder.Password=''
    return $builder.Uri.GetLeftPart([System.UriPartial]::Path)
  } catch {return ''}
}
function NormalProfile([string]$name,[string]$id,[string]$class) {
  return $name -in @('You','您') -and
    ($id -match '^(avatar_button|avatarButton|profile_button|profileButton|ProfileButton|browser-profile-button)$' -or
     $class -match '^(AvatarToolbarButton|ProfileMenuButton|BrowserProfileButton)$')
}
function ChromeProof($toolbars,[bool]$complete,[string]$documentUrl='') {
  if (-not $complete -or -not $documentUrl) {return ''}
  $allowed=New-Object 'System.Collections.Generic.HashSet[string]'
  foreach ($item in $toolbars.Values) {if ($item.profile -and $item.urls.Count -eq 1) {[void]$allowed.Add(@($item.urls)[0])}}
  if ($allowed.Count -eq 1 -and @($allowed)[0] -eq $documentUrl) {return @($allowed)[0]};return ''
}
function Secure([System.Windows.Automation.AutomationElement]$element) {
  $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($level=0; $null -ne $element -and $level -lt 48; $level++) {
    try { $current=$element.Current
      if ($current.IsPassword) {return $true}
      if ($current.NativeWindowHandle -ne 0 -and [HistoryNative]::PasswordWindow([IntPtr]$current.NativeWindowHandle)) {return $true}
      $element=$walker.GetParent($element)
    } catch { return $true }
  }
  # Unknown ancestry is not proof that a field is safe.
  return $null -ne $element
}
function Belongs([System.Windows.Automation.AutomationElement]$element,[System.Windows.Automation.AutomationElement]$root,[int]$processId) {
  $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
  for ($level=0;$null -ne $element -and $level -lt 48;$level++) {
    try {if ([System.Windows.Automation.Automation]::Compare($element,$root)) {return $true};$element=$walker.GetParent($element)} catch {return $false}
  };return $false
}
function SafeNode([System.Windows.Automation.AutomationElement]$element) {
  if ($null -eq $element -or (Secure $element)) {return @{role='AXSecureTextField';subrole='AXSecureTextField'}}
  $current=$element.Current
  $role='AX'+$current.ControlType.ProgrammaticName.Replace('ControlType.','')
  if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {$role='AXTextField'}
  if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Button) {$role='AXButton'}
  $result=@{role=$role;title=(Clean $current.Name);name=(Clean $current.Name);identifier=(Clean $current.AutomationId 160);runtimeId=([string]::Join(',', $element.GetRuntimeId()))}
  try {$pattern=$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);$result.value=Clean $pattern.Current.Value 1000} catch {}
  if (-not $result.value) {try {$pattern=$element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern);$result.value=Clean ($pattern.DocumentRange.GetText(1000)) 1000} catch {}}
  return $result
}
function CachedClickTarget($cache,[string]$key,[long]$expected,[long]$current,[string]$runtimeId,[double]$x,[double]$y) {
  $unknown=@{role='AXUnknown'}
  if ($null -eq $cache -or $cache.key -ne $key -or $cache.generation -ne $expected -or $current -ne $expected -or
      ([DateTime]::UtcNow-$cache.at).TotalSeconds -gt 5 -or -not $runtimeId) {return $unknown}
  foreach ($item in $cache.targets) {
    if ($item.runtimeId -eq $runtimeId -and $x -ge $item.x -and $y -ge $item.y -and $x -lt ($item.x+$item.width) -and $y -lt ($item.y+$item.height)) {return $item.target}
  }
  return $unknown
}

function PreviousControlsAtPoint($cache,[string]$key,[bool]$originVerified,[DateTime]$actionAt,[double]$x,[double]$y) {
  if (-not $originVerified -or $null -eq $cache -or $cache.key -ne $key) {return $null}
  $actionAt=$actionAt.ToUniversalTime();$cacheAt=$cache.at.ToUniversalTime()
  if ($cacheAt -gt $actionAt -or ($actionAt-$cacheAt).TotalSeconds -gt 5) {return $null}
  $controls=@()
  foreach ($item in $cache.targets) {
    if ($x -ge $item.x -and $y -ge $item.y -and $x -lt ($item.x+$item.width) -and $y -lt ($item.y+$item.height)) {
      $control=@{}
      foreach ($field in @('role','name','title','identifier')) {
        if ($item.target[$field] -is [string]) {$control[$field]=Clean $item.target[$field] 320}
      }
      $controls+=$control
      if ($controls.Count -ge 3) {break}
    }
  }
  if ($controls.Count -eq 0) {return $null}
  return @{observedAt=$cacheAt.ToString('o');controls=$controls;
    interpretation='previously_observed_not_confirmed_target'}
}

# The observation time also binds click candidates to the exact full snapshot
# that the consumer previously authorized, rather than any native-only cache.
function SnapshotCache($event,[long]$generation,$targets) {
  $observedAt=[DateTime]::UtcNow
  $event.ax.observedAt=$observedAt.ToString('o')
  return @{key=$event.ax.windowKey;at=$observedAt;generation=$generation;targets=$targets}
}

function SnapshotText($value,[int]$limit,[ref]$truncated) {
  $text=Clean $value ([int]::MaxValue)
  if ($text.Length -gt $limit) {$truncated.Value=$true;return $text.Substring(0,$limit)}
  return $text
}

# The browser chrome is checked before any Document content is read. It is
# enumerated separately, excluding the complete Document subtree. A normal
# page title is never evidence of the committed page address.
function BrowserContext($root,[string]$title,[string]$windowId,[int]$processId,[DateTime]$deadline) {
  $context=@{url='';mode='unknown';complete=$false;windowId=$windowId;processId=$processId}
  $queue=New-Object System.Collections.Queue; $queue.Enqueue(@{node=$root;toolbarId=0;visible=$true})
  $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
  $failed=$false;$seen=0;$toolbarSequence=0;$toolbars=@{};$addressFocused=$false;$loading=$false
  $documents=New-Object 'System.Collections.Generic.HashSet[string]';$documentUnknown=$false
  $focused=[System.Windows.Automation.AutomationElement]::FocusedElement
  while ($queue.Count -gt 0 -and $seen -lt 200) {
    if ([DateTime]::UtcNow -ge $deadline) {$failed=$true;break}
    $entry=$queue.Dequeue();$element=$entry.node;$seen++
    try {
      $current=$element.Current
      $visible=$entry.visible -and -not $current.IsOffscreen
      if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Document) {
        # ValuePattern on a browser's top-level Document exposes its committed
        # URI, unlike editable omnibox text. Only metadata is read here; no
        # names, text ranges or Document descendants grant profile evidence.
        if ($visible) {
          try {$pattern=$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);$document=Url $pattern.Current.Value;if ($document) {[void]$documents.Add($document)} else {$documentUnknown=$true}} catch {$documentUnknown=$true}
        }
        continue
      }
      $toolbarId=$entry.toolbarId
      if ($current.ControlType -eq [System.Windows.Automation.ControlType]::ToolBar -and $visible) {
        $toolbarSequence++;$toolbarId=$toolbarSequence
        $toolbars[$toolbarId]=@{profile=$false;urls=(New-Object 'System.Collections.Generic.HashSet[string]')}
      }
      if ($current.IsPassword -or ($current.NativeWindowHandle -ne 0 -and [HistoryNative]::PasswordWindow([IntPtr]$current.NativeWindowHandle))) {continue}
      $name=Clean $current.Name 320;$id=Clean $current.AutomationId 160;$class=Clean $current.ClassName 160
      if ($toolbarId -gt 0 -and $current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and
          ($name -match '^(Stop|Stop loading|Stop loading this page|停止|停止加载|停止載入|停止加载此网页|停止載入此網頁)$' -or $id -match '^(stop-loading|stopButton)$')) {$loading=$true}
      # Browser-owned concrete profile controls in a toolbar. Page buttons,
      # generic names such as 'You', and address bars cannot grant permission.
      if ($toolbarId -gt 0 -and $visible -and $current.ProcessId -eq $processId -and $current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and (NormalProfile $name $id $class)) {$toolbars[$toolbarId].profile=$true}
      if ($toolbarId -gt 0 -and $visible -and $current.ProcessId -eq $processId -and $current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and
          ($id -match '^(addressEditBox|omnibox|urlbar-input|urlbar)$' -or $name -match '^(Address and search bar|Search or enter web address|Address bar|地址和搜索栏|地址及搜尋列|搜索或输入网址|搜尋或輸入網址|地址栏)$')) {
        if ($current.HasKeyboardFocus -or ($null -ne $focused -and (Belongs $focused $element $processId))) {$addressFocused=$true;continue}
        try {$pattern=$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);$candidate=Url $pattern.Current.Value;if ($candidate) {[void]$toolbars[$toolbarId].urls.Add($candidate)}} catch {$failed=$true}
      }
      $child=$walker.GetFirstChild($element);$children=0
      while ($null -ne $child -and $children -lt 24) {$queue.Enqueue(@{node=$child;toolbarId=$toolbarId;visible=$visible});$children++;$child=$walker.GetNextSibling($child)}
      if ($null -ne $child) {$failed=$true}
    } catch {$failed=$true}
  }
  if ($queue.Count -gt 0) {$failed=$true}
  if ($addressFocused -or $loading) {return $context}
  $context.complete=-not $failed
  # URL and explicit normal-profile proof must come from the same concrete
  # toolbar. A bookmark toolbar cannot grant another toolbar's address bar.
  $documentUrl=if (-not $documentUnknown -and $documents.Count -eq 1) {@($documents)[0]} else {''}
  $proved=ChromeProof $toolbars (-not $failed) $documentUrl
  if ($proved) {$context.url=$proved;$context.documentUrl=$documentUrl;$context.mode='normal'} elseif ($documentUrl) {$context.url=$documentUrl;$context.documentUrl=$documentUrl}
  return $context
}

function Snapshot($root,[DateTime]$deadline,$walker=$null) {
  $queue=New-Object System.Collections.Queue;$queue.Enqueue(@{node=$root;secure=$false})
  if ($null -eq $walker) {$walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker}
  $lines=New-Object 'System.Collections.Generic.List[string]';$length=0;$visited=0;$failures=0;$truncated=$false
  $targets=New-Object 'System.Collections.Generic.List[object]'
  while ($queue.Count -gt 0 -and $visited -lt 400) {
    if ([DateTime]::UtcNow -ge $deadline) {$truncated=$true;break}
    $entry=$queue.Dequeue();$element=$entry.node;$visited++
    try {
      $current=$element.Current
      if ($current.IsOffscreen) {continue}
      $secure=$entry.secure -or $current.IsPassword -or ($current.NativeWindowHandle -ne 0 -and [HistoryNative]::PasswordWindow([IntPtr]$current.NativeWindowHandle))
      $role=Clean $current.ControlType.ProgrammaticName 80;$subrole='';$name='';$id='';$value=''
      if ($secure) {$subrole='AXSecureTextField'} else {
        $name=SnapshotText $current.Name 320 ([ref]$truncated);$id=SnapshotText $current.AutomationId 160 ([ref]$truncated)
        try {$pattern=$element.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);$value=SnapshotText $pattern.Current.Value 1000 ([ref]$truncated)} catch {}
        if (-not $value) {try {
          $pattern=$element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
          $rawText=$pattern.DocumentRange.GetText(1001)
          if ($rawText.Length -gt 1000) {$truncated=$true}
          $value=SnapshotText $rawText 1000 ([ref]$truncated)
        } catch {}}
      }
      if ($subrole -or $name -or $id -or $value) {
        $line="$role|$subrole|$name||$id|$value"
        if ($length+$line.Length+1 -gt 120000) {$truncated=$true;break}
        $lines.Add($line);$length+=$line.Length+1
      }
      if (-not $secure -and $current.ControlType -in @([System.Windows.Automation.ControlType]::Button,[System.Windows.Automation.ControlType]::CheckBox,
          [System.Windows.Automation.ControlType]::RadioButton,[System.Windows.Automation.ControlType]::Hyperlink,[System.Windows.Automation.ControlType]::MenuItem,
          [System.Windows.Automation.ControlType]::TabItem,[System.Windows.Automation.ControlType]::Edit,[System.Windows.Automation.ControlType]::ComboBox,[System.Windows.Automation.ControlType]::ListItem)) {
        # Cache only labels/identity/bounds from this already captured state.
        # Values and text ranges are never retained in click-target cache.
        $rect=$current.BoundingRectangle
        if ($rect.Width -gt 0 -and $rect.Height -gt 0) {
          $targetRole='AX'+$current.ControlType.ProgrammaticName.Replace('ControlType.','')
          if ($current.ControlType -eq [System.Windows.Automation.ControlType]::Edit) {$targetRole='AXTextField'}
          $targets.Add(@{runtimeId=([string]::Join(',', $element.GetRuntimeId()));x=$rect.X;y=$rect.Y;width=$rect.Width;height=$rect.Height;
            target=@{role=$targetRole;title=$name;name=$name;identifier=$id}})
        }
      }
      # Never descend into a secure control; generic descendants may falsely
      # advertise IsPassword=false while exposing the same protected value.
      if ($secure) {continue}
      $child=$walker.GetFirstChild($element);$children=0
      while ($null -ne $child -and $children -lt 24) {$queue.Enqueue(@{node=$child;secure=$secure});$children++;$child=$walker.GetNextSibling($child)}
      if ($null -ne $child) {$truncated=$true}
    } catch {$failures++}
  }
  if ($queue.Count -gt 0) {$truncated=$true}
  # PowerShell 5.1's array-subexpression binder throws for List[object], even
  # when empty. That discarded every full snapshot while action reads worked.
  return @{text=[string]::Join("`n",$lines);truncated=$truncated;readFailures=$failures;targets=$targets.ToArray()}
}

if ($SelfTest) {
  # Compile the same native/UIA API declarations, then test only pure helpers.
  # Run the real Snapshot return path with process-local nodes and walker.
  # No FromHandle, foreground read, UIA subscription or global hook is used.
  $fixtureWalker=New-Object PSObject
  $fixtureWalker | Add-Member ScriptMethod GetFirstChild {param($node) return $null}
  $fixtureWalker | Add-Member ScriptMethod GetNextSibling {param($node) return $null}
  foreach ($withTarget in @($false,$true)) {
    $fixture=New-Object PSObject -Property @{Current=@{
      IsOffscreen=$false;IsPassword=$false;NativeWindowHandle=0;
      ControlType=$(if ($withTarget) {[System.Windows.Automation.ControlType]::Button} else {[System.Windows.Automation.ControlType]::Text});
      Name='PureSnapshotSentinel';AutomationId='pure-snapshot';
      BoundingRectangle=@{X=0;Y=0;Width=80;Height=24}}}
    $fixture | Add-Member ScriptMethod GetCurrentPattern {param($pattern) throw 'No pattern in pure fixture'}
    $fixture | Add-Member ScriptMethod GetRuntimeId {return [int[]]@(1,2)}
    $captured=Snapshot $fixture ([DateTime]::UtcNow.AddSeconds(10)) $fixtureWalker
    if ($captured.text -notmatch 'PureSnapshotSentinel' -or $captured.truncated -or $captured.readFailures -ne 0 -or
        $captured.targets.Count -ne [int]$withTarget) {throw 'Snapshot pure traversal or target array failed'}
    $roundtrip=ConvertTo-Json -InputObject $captured -Depth 10 -Compress | ConvertFrom-Json
    if ($roundtrip.text -ne $captured.text -or $roundtrip.targets.Count -ne [int]$withTarget) {throw 'Snapshot JSON roundtrip failed'}
  }
  $cacheFixtureEvent=@{ax=@{windowKey='pure-cache'}}
  $cacheFixture=SnapshotCache $cacheFixtureEvent 3 @()
  if ($cacheFixture.at.Kind -ne [DateTimeKind]::Utc -or
      $cacheFixtureEvent.ax.observedAt -ne $cacheFixture.at.ToString('o') -or
      $cacheFixture.key -ne $cacheFixtureEvent.ax.windowKey -or $cacheFixture.targets.Count -ne 0) {
    throw 'Snapshot cache observation binding lost'
  }
  foreach ($limit in @(160,320,1000)) {
    $clipped=$false;$exact=SnapshotText ('a'*$limit) $limit ([ref]$clipped)
    if ($clipped -or $exact.Length -ne $limit) {throw 'Exact snapshot field limit was marked truncated'}
    $clipped=$false;$over=SnapshotText ('a'*($limit+1)) $limit ([ref]$clipped)
    if (-not $clipped -or $over.Length -ne $limit) {throw 'Snapshot field truncation was not reported'}
  }
  $fixture.Current.Name='a'*321
  if (-not (Snapshot $fixture ([DateTime]::UtcNow.AddSeconds(10)) $fixtureWalker).truncated) {throw 'Snapshot Name truncation lost'}
  $fixture.Current.Name='PureSnapshotSentinel'
  $fixture | Add-Member NoteProperty FixtureValue $null
  $fixture | Add-Member NoteProperty FixtureRange $null
  $fixture | Add-Member ScriptMethod GetCurrentPattern {
    param($pattern)
    if ($pattern -eq [System.Windows.Automation.ValuePattern]::Pattern -and $null -ne $this.FixtureValue) {return @{Current=@{Value=$this.FixtureValue}}}
    if ($pattern -eq [System.Windows.Automation.TextPattern]::Pattern -and $null -ne $this.FixtureRange) {return @{DocumentRange=$this.FixtureRange}}
    throw 'No pattern in pure fixture'
  } -Force
  foreach ($patternKind in @('value','text')) {
    foreach ($length in @(1000,1001)) {
      $fixture.FixtureValue=$null;$fixture.FixtureRange=$null
      if ($patternKind -eq 'value') {$fixture.FixtureValue='a'*$length} else {
        $range=New-Object PSObject -Property @{Value=('a'*$length)}
        $range | Add-Member ScriptMethod GetText {param($limit) return $this.Value.Substring(0,[Math]::Min($limit,$this.Value.Length))}
        $fixture.FixtureRange=$range
      }
      $captured=Snapshot $fixture ([DateTime]::UtcNow.AddSeconds(10)) $fixtureWalker
      if ($captured.truncated -ne ($length -gt 1000) -or $captured.readFailures -ne 0 -or
          ($captured.text.Split('|')[-1]).Length -ne 1000) {throw 'Snapshot provider text truncation lost'}
    }
  }
  # No AutomationElement, desktop window, hooks or listener is created here.
  if ((Url 'https://user:secret@example.com/path?token=secret#fragment') -ne 'https://example.com/path') {throw 'URL sanitization failed'}
  if (Url 'chrome://settings') {throw 'Non-web URL accepted'}
  if (ConsentAllowed '') {throw 'Missing consent accepted'}
  foreach ($id in @('win32.wechat','win32.weixin','win32.wechatappex','win32.wechatbrowser')) {if (-not (IsWeChatProcess $id)) {throw 'WeChat family escaped consent'}}
  if (IsWeChatProcess 'win32.chrome') {throw 'Unrelated app excluded as WeChat'}
  if ((Clean ('a'*1500) 1000).Length -ne 1000) {throw 'Text budget failed'}
  if (-not (NormalProfile 'You' 'avatar_button' '') -or -not (NormalProfile '您' '' 'AvatarToolbarButton')) {throw 'Explicit normal proof failed'}
  foreach ($label in @('Guest','Incógnito','Privat','Alice','Profile 1','You are browsing privately')) {if (NormalProfile $label 'avatar_button' '') {throw 'Unknown profile accepted'}}
  if (NormalProfile 'You' 'page-profile-button' '') {throw 'Page label accepted'}
  $one=New-Object 'System.Collections.Generic.HashSet[string]';[void]$one.Add('https://example.com/')
  $empty=New-Object 'System.Collections.Generic.HashSet[string]'
  if ((ChromeProof @{1=@{profile=$true;urls=$one}} $true 'https://example.com/') -ne 'https://example.com/') {throw 'Chrome proof failed'}
  if (ChromeProof @{1=@{profile=$true;urls=$one}} $false 'https://example.com/') {throw 'Partial chrome accepted'}
  if (ChromeProof @{1=@{profile=$true;urls=$empty};2=@{profile=$false;urls=$one}} $true 'https://example.com/') {throw 'Different toolbar proof merged'}
  if (ChromeProof @{1=@{profile=$true;urls=$one}} $true 'https://company.example/') {throw 'Editable address authorized a different document'}
  if (ChromeProof @{1=@{profile=$true;urls=$one}} $true '') {throw 'Missing committed URI accepted'}
  $cache=@{key='1:100:https://example.com/';at=[DateTime]::UtcNow;generation=3;targets=@(@{runtimeId='old-button';x=0;y=0;width=100;height=30;target=@{role='AXButton';title='Add to cart'}})}
  if ((CachedClickTarget $cache $cache.key 3 3 'old-button' 10 10).title -ne 'Add to cart') {throw 'Original click label lost'}
  if ((CachedClickTarget $cache $cache.key 3 3 'replacement-button' 10 10).role -ne 'AXUnknown') {throw 'Replacement borrowed old click identity'}
  if ((CachedClickTarget $cache $cache.key 3 4 'old-button' 10 10).role -ne 'AXUnknown') {throw 'Renamed control reused stale proof'}
  if ((CachedClickTarget $null $cache.key 3 3 'old-button' 10 10).role -ne 'AXUnknown') {throw 'Click labeled without earlier snapshot'}
  if ((CachedClickTarget $cache '1:100:https://company.example/' 3 3 'old-button' 10 10).role -ne 'AXUnknown') {throw 'Click cache crossed URL'}
  $actionAt=[DateTime]::UtcNow
  $previous=PreviousControlsAtPoint $cache $cache.key $true $actionAt 10 10
  if ($previous.controls.Count -ne 1 -or $previous.controls[0].title -ne 'Add to cart' -or
      $previous.interpretation -ne 'previously_observed_not_confirmed_target') {throw 'Previous controls evidence lost'}
  if ($null -eq (PreviousControlsAtPoint $cache $cache.key $true ($actionAt.ToLocalTime()) 10 10)) {throw 'Local action time lost previous controls'}
  if ($null -ne (PreviousControlsAtPoint $cache 'other-window' $true $actionAt 10 10) -or
      $null -ne (PreviousControlsAtPoint $cache $cache.key $false $actionAt 10 10) -or
      $null -ne (PreviousControlsAtPoint $cache $cache.key $true ($cache.at.AddSeconds(6)) 10 10) -or
      $null -ne (PreviousControlsAtPoint $cache $cache.key $true ($cache.at.AddSeconds(-1)) 10 10)) {throw 'Previous controls crossed observation boundary'}
  $consentFixture=[IO.Path]::GetTempFileName()
  try {
    [IO.File]::WriteAllText($consentFixture,'{"version":1,"enabled":true,"consentId":"pure-test"}')
    if (-not (ConsentAllowed $consentFixture)) {throw 'Consent fixture failed'}
    [IO.File]::WriteAllText($consentFixture,'{"version":1,"enabled":false,"consentId":"pure-test"}')
    if (ConsentAllowed $consentFixture) {throw 'Revoked consent cached'}
  } finally {[IO.File]::Delete($consentFixture)}
  '{"runtimeId":"MemmyWindowsHistoryRuntimeV1","pureSelfTest":true,"desktopAccess":false,"workerApiCompiled":true,"snapshotTraversalChecked":true}'
  exit 0
}
$script:lastGeneration=0;$script:subscribedWindow='';$script:lastFull=[DateTime]::MinValue;$script:lastObservedWindow='';$script:targetCache=$null
try {[HistorySignals]::Start()} catch {}
function Capture($request) {
  # Hold the previous immutable cache. A full tree captured after this click
  # may only authorize labels for subsequent actions.
  $previousCache=$script:targetCache
  $hwnd=[HistoryNative]::GetForegroundWindow();if ($hwnd -eq [IntPtr]::Zero) {return Skip 'no_foreground'}
  [uint32]$processId=0;[void][HistoryNative]::GetWindowThreadProcessId($hwnd,[ref]$processId)
  $windowId=$hwnd.ToInt64().ToString()
  $act=$request.action
  $isAction=$act.kind -in @('mouse.click','mouse.context_menu','mouse.scroll','keyboard.keydown','selection.changed')
  if ($act.window -and ($act.window -ne $windowId -or $act.pid -ne $processId)) {return Skip 'foreground_changed'}
  if ($isAction) {
    $actionAt=[DateTime]::MinValue
    if (-not $act.originVerified -or -not [DateTime]::TryParse($act.timestamp,[ref]$actionAt)) {return Skip 'action_origin_unknown'}
    $age=([DateTime]::UtcNow-$actionAt.ToUniversalTime()).TotalMilliseconds
    $maxAge=if ($act.kind -eq 'keyboard.keydown') {1500} else {500}
    if ($age -lt 0 -or $age -gt $maxAge -or $act.expectedScope -ne [HistorySignals]::ScopeGeneration) {return Skip 'action_origin_expired'}
  }
  if ($act.kind -eq 'probe' -and -not $request.full -and $windowId -eq $script:lastObservedWindow -and [HistorySignals]::Generation -eq $script:lastGeneration) {return Skip 'unchanged'}
  $process=Get-Process -Id $processId -ErrorAction Stop;$name=Clean $process.ProcessName 128;$id=AppId $name
  if ((IsWeChatProcess $id) -and -not (ConsentAllowed $request.consentPath)) {return Skip 'wechat_consent_required'}
  $titleBuffer=New-Object System.Text.StringBuilder 1024;[void][HistoryNative]::GetWindowText($hwnd,$titleBuffer,$titleBuffer.Capacity);$title=Clean $titleBuffer.ToString() 500
  $browser=$name -match '^(msedge|chrome|firefox|brave|vivaldi|opera|chromium|arc|quark)$'
  $deadline=[DateTime]::UtcNow.AddMilliseconds(2000)
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  if ($null -eq $root) {return @{ok=$false;skipped=$true;readFailures=1}}
  $rootCurrent=$root.Current
  if ($rootCurrent.ProcessId -ne $processId -or $rootCurrent.NativeWindowHandle -ne $hwnd.ToInt64()) {return Skip 'foreground_changed'}
  $context=$null
  if ($browser) {
    $context=BrowserContext $root $title $windowId $processId ([DateTime]::UtcNow.AddMilliseconds(500))
    if ($isAction -and $act.expectedURL -ne $context.url) {return Skip 'action_origin_changed'}
  }
  $focus=[System.Windows.Automation.AutomationElement]::FocusedElement
  if ($isAction -and $act.kind -in @('keyboard.keydown','selection.changed') -and ($null -eq $focus -or -not $act.expectedFocus -or [string]::Join(',', $focus.GetRuntimeId()) -ne $act.expectedFocus)) {return Skip 'action_origin_changed'}
  if ($null -ne $focus -and (Belongs $focus $root $processId) -and (Secure $focus)) {return Skip 'secure_input'}
  if ($script:subscribedWindow -ne $windowId) {try {[HistorySignals]::Subscribe($root);$script:subscribedWindow=$windowId} catch {}}
  $generation=[HistorySignals]::Generation
  $full=[bool]$request.full -and ([DateTime]::UtcNow-$script:lastFull).TotalSeconds -ge 1
  if ($act.kind -eq 'probe' -and $generation -ne $script:lastGeneration -and ([DateTime]::UtcNow-$script:lastFull).TotalSeconds -ge 1) {$full=$true}
  $snapshotDeferred=[bool]$request.full -and -not $full
  $script:lastGeneration=$generation
  $event=@{timestamp=$(if ($isAction) {$act.timestamp} else {[DateTime]::UtcNow.ToString('o')});kind=$act.kind;
    app=@{name=$name;bundleIdentifier=$id;pid=[int]$processId;secureInput=$false};
    window=@{title=$title;browser=[bool]$browser;windowId=$windowId;processId=[int]$processId};
    ax=@{windowKey="$processId`:$windowId"}}
  if ($browser) {$event.window.browserContext=$context;$event.window.url=$context.url;$event.ax.windowKey+=':'+$context.url}
  $truncated=$false;$failures=0
  $snapshotGeneration=[HistorySignals]::Generation
  if ($full) {$script:requestSnapshotAttempted=$true;$snapshot=Snapshot $root $deadline;$event.ax.mode='fullTree';$event.ax.text=$snapshot.text;$truncated=$snapshot.truncated;$failures=$snapshot.readFailures;$script:lastFull=[DateTime]::UtcNow}
  if ($null -ne $focus -and (Belongs $focus $root $processId)) {$event.ax.focused=SafeNode $focus}
  if ($act.kind -in @('mouse.click','mouse.context_menu')) {
    $target=@{role='AXUnknown'}
    # A click can immediately change the button/page. Never label the earlier
    # action with a newly appeared control just because it occupies that point.
    if ($act.expectedContent -eq [HistorySignals]::Generation -and $null -ne $previousCache) {
      try {
        $point=New-Object System.Windows.Point ([double]$act.x),([double]$act.y);$element=[System.Windows.Automation.AutomationElement]::FromPoint($point)
        if (Belongs $element $root $processId) {
          $walker=[System.Windows.Automation.TreeWalker]::ControlViewWalker
          for ($level=0;$null -ne $element -and $level -lt 8;$level++) {
            $target=CachedClickTarget $previousCache $event.ax.windowKey $act.expectedContent ([HistorySignals]::Generation) ([string]::Join(',', $element.GetRuntimeId())) $act.x $act.y
            if ($target.role -ne 'AXUnknown') {break}
            $element=$walker.GetParent($element)
          }
        }
      } catch {}
    }
    $event.mouse=@{button=$act.button;clickCount=1;target=$target}
    $previousControls=PreviousControlsAtPoint $previousCache $event.ax.windowKey ([bool]$act.originVerified) $actionAt ([double]$act.x) ([double]$act.y)
    if ($null -ne $previousControls) {$event.mouse.previousControlsAtPoint=$previousControls}
  } elseif ($act.kind -eq 'mouse.scroll') {
    $direction=if ($act.delta -eq 0) {'none'} elseif ($act.scrollAxis -eq 'horizontal') {if ($act.delta -gt 0) {'right'} else {'left'}} elseif ($act.delta -gt 0) {'up'} else {'down'}
    $event.mouse=@{direction=$direction}
    if ($act.scrollAxis -eq 'horizontal') {$event.mouse.deltaX=[int]$act.delta} else {$event.mouse.deltaY=[int]$act.delta}
  }
  elseif ($act.kind -eq 'keyboard.keydown') {
    $category=switch ($act.key) {'[typing]' {'typing'};'[shortcut]' {'shortcut'};'Enter' {'submit'};'Backspace' {'delete'};default {'navigation'}}
    $event.keyboard=@{key=$act.key;category=$category;keyCode=[int]$act.keyCode;count=[int]$act.count;nativeActionOnly=$true}
    if ($act.modifiers) {$event.keyboard.modifiers=@($act.modifiers)}
    if ($event.ax.focused) {$event.keyboard.target=$event.ax.focused}
  } elseif ($act.kind -eq 'selection.changed') {
    if ($null -ne $focus -and (Belongs $focus $root $processId) -and -not (Secure $focus)) {
      try {$pattern=$focus.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern);$selected=@($pattern.GetSelection());if ($selected.Count -gt 0) {$text=Clean ($selected[0].GetText(2000)) 2000;if ($text) {$event.selection=@{selectedText=$text;target=$event.ax.focused}}}} catch {}
    }
  }
  if ($act.kind -eq 'probe') {$event.kind='sampling.changed'}
  # Revalidate window, process, URL and privacy after all provider calls. A
  # navigation/focus switch discards both content and action enrichment.
  if ([HistoryNative]::GetForegroundWindow() -ne $hwnd) {return Skip 'foreground_changed'}
  [uint32]$latestProcessId=0;[void][HistoryNative]::GetWindowThreadProcessId($hwnd,[ref]$latestProcessId)
  if ($latestProcessId -ne $processId) {return Skip 'foreground_changed'}
  if ($act.kind -in @('keyboard.keydown','selection.changed')) {
    $latestFocus=[System.Windows.Automation.AutomationElement]::FocusedElement
    if ($null -eq $focus -or $null -eq $latestFocus -or -not [System.Windows.Automation.Automation]::Compare($focus,$latestFocus) -or (Secure $latestFocus)) {return Skip 'focus_changed'}
  }
  if ($browser) {
    $latestBuffer=New-Object System.Text.StringBuilder 1024;[void][HistoryNative]::GetWindowText($hwnd,$latestBuffer,$latestBuffer.Capacity)
    $latest=BrowserContext $root (Clean $latestBuffer.ToString() 500) $windowId $processId ([DateTime]::UtcNow.AddMilliseconds(500))
    if ($latest.url -ne $context.url) {return Skip 'navigation_changed'}
  }
  if ((IsWeChatProcess $id) -and -not (ConsentAllowed $request.consentPath)) {return Skip 'wechat_consent_required'}
  if ($isAction -and $act.expectedScope -ne [HistorySignals]::ScopeGeneration) {return Skip 'action_origin_changed'}
  if ($act.kind -in @('mouse.click','mouse.context_menu') -and $act.expectedContent -ne [HistorySignals]::Generation) {$event.mouse.target=@{role='AXUnknown'}}
  if ($full -and $snapshotGeneration -eq [HistorySignals]::Generation) {
    $script:targetCache=SnapshotCache $event $snapshotGeneration $snapshot.targets
  }
  $event.nativeScopeGeneration=[HistorySignals]::ScopeGeneration
  $event.nativeContentGeneration=[HistorySignals]::Generation
  $script:lastObservedWindow=$windowId
  return @{ok=$true;skipped=$false;readFailures=$failures;truncated=$truncated;snapshotAttempted=$full;snapshotDeferred=$snapshotDeferred;event=$event}
}

'{"ready":true,"runtimeId":"MemmyWindowsHistoryRuntimeV1"}'
while ($null -ne ($line=[Console]::ReadLine())) {
  $request=$null
  $script:requestSnapshotAttempted=$false
  try {
    if ($line.Length -gt 8192) {exit 12}
    $request=$line | ConvertFrom-Json
    $result=Capture $request;$result.id=$request.id
    ConvertTo-Json -InputObject $result -Compress -Depth 14
  } catch {
    # Provider exceptions and labels are not diagnostic user data.
    $requestId=if ($null -ne $request) {$request.id} else {0}
    ConvertTo-Json -InputObject @{id=$requestId;ok=$false;skipped=$true;readFailures=1;snapshotAttempted=$script:requestSnapshotAttempted} -Compress
  }
}
