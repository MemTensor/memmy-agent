param([Parameter(Mandatory=$true)][string]$TestProfilePath,
      [Parameter(Mandatory=$true)][string]$ExecutableName,
      [Parameter(Mandatory=$true)][string]$Screenshot,
      [string]$WindowTitle='Teaching integrity /form')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TeachWindowProbe {
  public delegate bool Callback(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int length);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr target, uint flags);
}
'@
$processIds=[Collections.Generic.HashSet[uint32]]::new()
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq $ExecutableName -and $_.CommandLine -and
  $_.CommandLine.IndexOf($TestProfilePath,[StringComparison]::OrdinalIgnoreCase) -ge 0
} | ForEach-Object { [void]$processIds.Add([uint32]$_.ProcessId) }
$windows=[Collections.Generic.List[long]]::new()
$seen=[Collections.Generic.List[string]]::new()
[void][TeachWindowProbe]::EnumWindows({param($hwnd,$unused)
  [uint32]$processId=0
  [void][TeachWindowProbe]::GetWindowThreadProcessId($hwnd,[ref]$processId)
  if($processIds.Contains($processId) -and [TeachWindowProbe]::IsWindowVisible($hwnd)) {
    $title=[Text.StringBuilder]::new(1024)
    [void][TeachWindowProbe]::GetWindowText($hwnd,$title,1024)
    $seen.Add($title.ToString())
    if($title.ToString().Contains($WindowTitle)) { $windows.Add($hwnd.ToInt64()) }
  }
  return $true
},[IntPtr]::Zero)
if($windows.Count -ne 1){throw ('Teaching window lookup failed: '+(@{found=$windows.Count;processIds=@($processIds);session=(Get-Process -Id $PID).SessionId;titles=@($seen)} | ConvertTo-Json -Compress))}
$handle=[IntPtr]$windows[0]
[void][TeachWindowProbe]::SetForegroundWindow($handle)
Start-Sleep -Milliseconds 150
$element=[Windows.Automation.AutomationElement]::FromHandle($handle)
$rectangle=$element.Current.BoundingRectangle
$buttons=$element.FindAll([Windows.Automation.TreeScope]::Descendants,
  [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
$cancelButtons=@($buttons | Where-Object {
  $_.Current.Name.Trim() -match '^(\u53d6\u6d88|Cancel|\u505c\u6b62\u8c03\u8bd5|Stop debugging)$' -and
  $_.Current.BoundingRectangle.Top -lt ($rectangle.Top+220)
})
$bitmap=[Drawing.Bitmap]::new([int]$rectangle.Width,[int]$rectangle.Height)
$graphics=[Drawing.Graphics]::FromImage($bitmap)
try {
  $deviceContext=$graphics.GetHdc()
  try {
    if(-not [TeachWindowProbe]::PrintWindow($handle,$deviceContext,2)){throw 'Single-window screenshot failed'}
  } finally {$graphics.ReleaseHdc($deviceContext)}
  $bitmap.Save($Screenshot,[Drawing.Imaging.ImageFormat]::Png)
} finally {$graphics.Dispose();$bitmap.Dispose()}
if($cancelButtons.Count -ne 1){
  $topButtons=@($buttons | Where-Object {$_.Current.BoundingRectangle.Top -lt ($rectangle.Top+220)} | ForEach-Object {$_.Current.Name})
  throw ('Debugging cancel lookup failed: '+(@{found=$cancelButtons.Count;buttons=$topButtons}|ConvertTo-Json -Compress))
}
$name=$cancelButtons[0].Current.Name
$invoke=$cancelButtons[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
$invoke.Invoke()
@{clicked=$true;button=$name;testWindow=$windows[0]} | ConvertTo-Json -Compress
