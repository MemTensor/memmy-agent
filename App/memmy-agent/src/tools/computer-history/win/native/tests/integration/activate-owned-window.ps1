param([long]$Window, [int]$Owner)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class OwnedTestWindow {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
 [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
}
'@
$target = [IntPtr]$Window
$windowOwner = [uint32]0
[void][OwnedTestWindow]::GetWindowThreadProcessId($target, [ref]$windowOwner)
if ($windowOwner -ne $Owner) { throw 'Test window owner changed' }
$currentThread = [OwnedTestWindow]::GetCurrentThreadId()
$foregroundOwner = [uint32]0
$foregroundThread = [OwnedTestWindow]::GetWindowThreadProcessId([OwnedTestWindow]::GetForegroundWindow(), [ref]$foregroundOwner)
$attached = [OwnedTestWindow]::AttachThreadInput($currentThread, $foregroundThread, $true)
try {
 [void][OwnedTestWindow]::ShowWindow($target, 9)
 [void][OwnedTestWindow]::BringWindowToTop($target)
 [void][OwnedTestWindow]::SetForegroundWindow($target)
 if ([OwnedTestWindow]::GetForegroundWindow() -ne $target) { throw 'Interactive foreground unavailable' }
} finally {
 if ($attached) { [void][OwnedTestWindow]::AttachThreadInput($currentThread, $foregroundThread, $false) }
}
