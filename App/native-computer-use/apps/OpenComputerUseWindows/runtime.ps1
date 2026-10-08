param(
    [Parameter(Mandatory = $true)]
    [string]$OperationPath
)

$ErrorActionPreference = "Stop"
$DefaultTextLimit = 500
$AccessibilityTreeMaxNodeCount = 1200
$AccessibilityTreeMaxDepth = 64

# Set output encoding to UTF-8 to properly handle non-ASCII characters
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class OCUWin32 {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO {
        public UInt32 cbSize;
        public UInt32 dwTime;
    }

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern UInt32 GetWindowThreadProcessId(IntPtr hWnd, out UInt32 processId);

    [DllImport("user32.dll")]
    public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool AllowSetForegroundWindow(int processId);

    [DllImport("kernel32.dll")]
    public static extern UInt32 GetTickCount();

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool ScreenToClient(IntPtr hWnd, ref POINT point);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool PostMessage(IntPtr hWnd, UInt32 msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessage(IntPtr hWnd, UInt32 msg, IntPtr wParam, string lParam);

    [DllImport("kernel32.dll")]
    public static extern void SetLastError(UInt32 errorCode);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    public static extern IntPtr WindowFromPoint(POINT point);

    [DllImport("user32.dll")]
    public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint source, uint target, bool attach);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static extern IntPtr GetWindowLongPtr64(IntPtr hwnd, int index);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    public const uint MOUSEEVENTF_MOVE = 0x0001;
    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;
    public const uint MOUSEEVENTF_WHEEL = 0x0800;
    public const uint MOUSEEVENTF_HWHEEL = 0x01000;
    public const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    public const uint MOUSEEVENTF_VIRTUALDESK = 0x4000;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    public struct MOUSEINPUT {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct INPUTUNION {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public INPUTUNION u;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint count, INPUT[] inputs, int size);

    public static bool SendMouse(int x, int y, uint flags, uint data) {
        int originX = GetSystemMetrics(76);
        int originY = GetSystemMetrics(77);
        int width = GetSystemMetrics(78);
        int height = GetSystemMetrics(79);
        if (width <= 1 || height <= 1) return false;
        var input = new INPUT();
        input.type = 0;
        input.u.mi.dx = (int)Math.Round((x - originX) * 65535.0 / (width - 1));
        input.u.mi.dy = (int)Math.Round((y - originY) * 65535.0 / (height - 1));
        input.u.mi.mouseData = data;
        input.u.mi.dwFlags = flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;
        return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }

    public static bool SendUnicode(char value) {
        var down = new INPUT();
        down.type = 1;
        down.u.ki.wScan = value;
        down.u.ki.dwFlags = KEYEVENTF_UNICODE;
        var up = down;
        up.u.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        return SendInput(2, new[] { down, up }, Marshal.SizeOf(typeof(INPUT))) == 2;
    }

    public static bool SendVirtualKey(ushort virtualKey, bool keyUp) {
        var input = new INPUT();
        input.type = 1;
        input.u.ki.wVk = virtualKey;
        input.u.ki.dwFlags = keyUp ? KEYEVENTF_KEYUP : 0;
        return SendInput(1, new[] { input }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }
}
"@

$WM_SETTEXT = 0x000C
$WM_MOUSEMOVE = 0x0200
$WM_LBUTTONDOWN = 0x0201
$WM_LBUTTONUP = 0x0202
$WM_RBUTTONDOWN = 0x0204
$WM_RBUTTONUP = 0x0205
$WM_MBUTTONDOWN = 0x0207
$WM_MBUTTONUP = 0x0208
$WM_MOUSEWHEEL = 0x020A
$WM_MOUSEHWHEEL = 0x020E
$WM_KEYDOWN = 0x0100
$WM_KEYUP = 0x0101
$WM_CHAR = 0x0102
$EM_SETSEL = 0x00B1
$EM_REPLACESEL = 0x00C2

function Test-EnvFlagEnabled([string]$name) {
    $value = [Environment]::GetEnvironmentVariable($name)
    if ([string]::IsNullOrWhiteSpace($value)) {
        return $false
    }
    $normalized = $value.Trim().ToLowerInvariant()
    return @("1", "true", "yes", "on") -contains $normalized
}

function Stop-FocusGuard([string]$message) {
    $script:focusGuardStop = $true
    throw $message
}

function Read-FocusState {
    $foreground = [OCUWin32]::GetForegroundWindow()
    if ($foreground -eq [IntPtr]::Zero) {
        Stop-FocusGuard "Computer Use could not verify the foreground window. The action was paused."
    }
    $foregroundProcessId = [uint32]0
    if ([OCUWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId) -eq 0 -or $foregroundProcessId -eq 0) {
        Stop-FocusGuard "Computer Use could not identify the foreground window owner. The action was paused."
    }
    $lastInput = New-Object OCUWin32+LASTINPUTINFO
    $lastInput.cbSize = 8 # Two UInt32 fields; required by GetLastInputInfo.
    if (-not [OCUWin32]::GetLastInputInfo([ref]$lastInput)) {
        Stop-FocusGuard "Computer Use could not verify recent Windows input. The action was paused."
    }
    [pscustomobject]@{
        hwnd = $foreground
        processId = $foregroundProcessId
        inputTick = $lastInput.dwTime
        tick = [OCUWin32]::GetTickCount()
    }
}

function Assert-SafeBeforeAction($focus, [int]$targetProcessId) {
    # A last-input tick slightly ahead of GetTickCount is possible for injected
    # input. Treat it as recent rather than mistaking it for a 49-day idle time.
    $delta = [long]$focus.tick - [long]$focus.inputTick
    $idleMilliseconds = if ($delta -lt 0 -and $delta -gt -2147483648L) {
        0
    } else {
        (($delta + 4294967296L) % 4294967296L)
    }
    if ($focus.processId -eq $targetProcessId -and $idleMilliseconds -lt 500) {
        Stop-FocusGuard "Recent Windows input occurred while the target window was foreground. Computer Use paused before sending the action."
    }
}

function Note-InjectedInput {
    $script:agentInjectedInput = $true
    $info = New-Object OCUWin32+LASTINPUTINFO
    $info.cbSize = 8
    if ([OCUWin32]::GetLastInputInfo([ref]$info)) { $script:injectedInputTick = $info.dwTime }
}

function Test-UserInputSince($before, $after) {
    if ($after.inputTick -eq $before.inputTick) { return $false }
    if ($null -ne $script:injectedInputTick -and $after.inputTick -eq $script:injectedInputTick) { return $false }
    return $true
}

function Assert-SafeAfterAction($before, [int]$targetProcessId) {
    $after = Read-FocusState
    $injected = [bool]$script:agentInjectedInput
    $alreadyForeground = $before.processId -eq $targetProcessId
    # GetLastInputInfo is system-wide. Our own SendInput, and pointer movement
    # while the target was already the window we were allowed to operate, are
    # not the user taking that window over.
    if (-not $alreadyForeground -and -not $injected -and $after.processId -eq $targetProcessId -and (Test-UserInputSince $before $after)) {
        Stop-FocusGuard "Windows input occurred while the target window was foreground during Computer Use. Check the result before continuing."
    }
    if ($before.processId -ne $targetProcessId -and $after.processId -eq $targetProcessId) {
        # Only restore when the input tick is unchanged. Never move focus away
        # from a window the user may have just chosen.
        $restoreCheck = Read-FocusState
        $userMoved = (-not $injected) -and ((Test-UserInputSince $before $restoreCheck) -or $restoreCheck.hwnd -ne $after.hwnd)
        if ($userMoved) {
            Stop-FocusGuard "Foreground focus changed before Computer Use could restore it. Check the desktop before continuing."
        }
        Invoke-ActivateTarget $before.hwnd
        if ([OCUWin32]::GetForegroundWindow() -ne $before.hwnd) {
            # The click or keystrokes already landed. Discarding the result
            # leaves PowerPoint in front and stops the task anyway.
            $script:focusNote = "The target window stayed in front because the previous window could not be restored."
        }
    }
}

function New-Frame($x, $y, $width, $height) {
    if ($width -lt 0 -or $height -lt 0) {
        return $null
    }
    [pscustomobject]@{
        x = [double]$x
        y = [double]$y
        width = [double]$width
        height = [double]$height
    }
}

function ConvertTo-LParam([int]$x, [int]$y) {
    $packed = (($y -band 0xffff) -shl 16) -bor ($x -band 0xffff)
    [IntPtr]$packed
}

function ConvertTo-WheelWParam([int]$delta) {
    $packed = (($delta -band 0xffff) -shl 16)
    [IntPtr]$packed
}

function Assert-NotBlockedByUipi([int]$errorCode) {
    if ($errorCode -eq 5) {
        throw [System.UnauthorizedAccessException]::new(
            "Windows blocked Memmy Computer Use from controlling this elevated window (UIPI). A UAC secure desktop also cannot be controlled by Memmy."
        )
    }
}

function Post-WindowMessage([IntPtr]$hwnd, [UInt32]$message, [IntPtr]$wParam, [IntPtr]$lParam) {
    [OCUWin32]::SetLastError(0)
    if ([OCUWin32]::PostMessage($hwnd, $message, $wParam, $lParam)) { return }
    $errorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    Assert-NotBlockedByUipi $errorCode
    throw "Windows could not deliver input to the target window (Win32 error $errorCode)."
}

function Get-WindowRectFrame([IntPtr]$hwnd) {
    $rect = New-Object OCUWin32+RECT
    if ([OCUWin32]::GetWindowRect($hwnd, [ref]$rect)) {
        return New-Frame $rect.Left $rect.Top ($rect.Right - $rect.Left) ($rect.Bottom - $rect.Top)
    }
    return $null
}

function Get-ElementFrame($element, $windowBounds) {
    try {
        $rect = $element.Current.BoundingRectangle
        if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) {
            return $null
        }
        if ($null -ne $windowBounds) {
            return New-Frame ($rect.X - $windowBounds.x) ($rect.Y - $windowBounds.y) $rect.Width $rect.Height
        }
        return New-Frame $rect.X $rect.Y $rect.Width $rect.Height
    } catch {
        return $null
    }
}

function Get-ScreenPoint($localFrame, $windowBounds) {
    if ($null -eq $localFrame -or $null -eq $windowBounds) {
        return $null
    }
    [pscustomobject]@{
        x = [int][math]::Round($windowBounds.x + $localFrame.x + ($localFrame.width / 2))
        y = [int][math]::Round($windowBounds.y + $localFrame.y + ($localFrame.height / 2))
    }
}

function Test-FrameClose($live, $expected) {
    if ($null -eq $live -or $null -eq $expected) { return $false }
    return ([math]::Abs($live.x - $expected.x) -le 24 -and [math]::Abs($live.y - $expected.y) -le 24 -and [math]::Abs($live.width - $expected.width) -le 24 -and [math]::Abs($live.height - $expected.height) -le 24)
}

function Test-ToolWindow([IntPtr]$hwnd) {
    if ($hwnd -eq [IntPtr]::Zero) { return $true }
    $style = [OCUWin32]::GetWindowLongPtr64($hwnd, -20).ToInt64()
    if (($style -band 0x80) -ne 0) { return $true }
    $frame = Get-WindowRectFrame $hwnd
    return $null -eq $frame -or $frame.width -lt 40 -or $frame.height -lt 40
}

function Get-DialogWindow($process) {
    $main = [IntPtr]$process.MainWindowHandle
    $foreground = [OCUWin32]::GetForegroundWindow()
    if ($foreground -eq [IntPtr]::Zero -or $foreground -eq $main) { return $main }
    $ownerPid = [uint32]0
    [void][OCUWin32]::GetWindowThreadProcessId($foreground, [ref]$ownerPid)
    if ($ownerPid -ne [uint32]$process.Id -or (Test-ToolWindow $foreground)) { return $main }
    return $foreground
}

function Resolve-ActionWindow($process, $expectedBounds) {
    $main = [IntPtr]$process.MainWindowHandle
    $dialog = Get-DialogWindow $process
    $mainFrame = Get-WindowRectFrame $main
    $dialogFrame = Get-WindowRectFrame $dialog
    if ($null -eq $expectedBounds) {
        if ($dialog -ne [IntPtr]::Zero) { return $dialog }
        return $main
    }
    $mainMatches = Test-FrameClose $mainFrame $expectedBounds
    $dialogMatches = Test-FrameClose $dialogFrame $expectedBounds
    if ($dialogMatches -and -not $mainMatches) { return $dialog }
    if ($mainMatches) { return $main }
    if ($dialogMatches) { return $dialog }
    throw "The target window moved or changed size. Run get_app_state again."
}

function Invoke-ActivateTarget([IntPtr]$hwnd) {
    if ([OCUWin32]::IsIconic($hwnd)) { [void][OCUWin32]::ShowWindow($hwnd, 9) }
    [void][OCUWin32]::AllowSetForegroundWindow(-1)
    $foreground = [OCUWin32]::GetForegroundWindow()
    $unused = [uint32]0
    $foregroundThread = [OCUWin32]::GetWindowThreadProcessId($foreground, [ref]$unused)
    $current = [OCUWin32]::GetCurrentThreadId()
    if ($foregroundThread -ne 0) { [void][OCUWin32]::AttachThreadInput($current, $foregroundThread, $true) }
    [void][OCUWin32]::BringWindowToTop($hwnd)
    [void][OCUWin32]::SetForegroundWindow($hwnd)
    if ($foregroundThread -ne 0) { [void][OCUWin32]::AttachThreadInput($current, $foregroundThread, $false) }
    Start-Sleep -Milliseconds 80
}

function Test-ScreenPointInProcess([IntPtr]$hwnd, [int]$x, [int]$y) {
    $point = New-Object OCUWin32+POINT
    $point.X = $x
    $point.Y = $y
    $hit = [OCUWin32]::WindowFromPoint($point)
    if ($hit -eq [IntPtr]::Zero) { return $false }
    $root = [OCUWin32]::GetAncestor($hit, 2)
    if ($root -eq [IntPtr]::Zero) { $root = $hit }
    $hitPid = [uint32]0
    $targetPid = [uint32]0
    [void][OCUWin32]::GetWindowThreadProcessId($root, [ref]$hitPid)
    [void][OCUWin32]::GetWindowThreadProcessId($hwnd, [ref]$targetPid)
    return $hitPid -ne 0 -and $hitPid -eq $targetPid
}

function Assert-PointOnTarget([IntPtr]$hwnd, [int]$x, [int]$y) {
    if (Test-ScreenPointInProcess $hwnd $x $y) { return }
    Invoke-ActivateTarget $hwnd
    Start-Sleep -Milliseconds 120
    if (-not (Test-ScreenPointInProcess $hwnd $x $y)) {
        throw "The click point is not on the target window. The action was not sent. Run get_app_state again."
    }
}

function Send-MouseClick([IntPtr]$hwnd, [int]$screenX, [int]$screenY, [string]$button, [int]$count) {
    Assert-PointOnTarget $hwnd $screenX $screenY
    $down = [OCUWin32]::MOUSEEVENTF_LEFTDOWN
    $up = [OCUWin32]::MOUSEEVENTF_LEFTUP
    if ($button -eq "right") {
        $down = [OCUWin32]::MOUSEEVENTF_RIGHTDOWN
        $up = [OCUWin32]::MOUSEEVENTF_RIGHTUP
    } elseif ($button -eq "middle") {
        $down = [OCUWin32]::MOUSEEVENTF_MIDDLEDOWN
        $up = [OCUWin32]::MOUSEEVENTF_MIDDLEUP
    }
    $repeat = [math]::Max(1, $count)
    for ($i = 0; $i -lt $repeat; $i++) {
        if (-not [OCUWin32]::SendMouse($screenX, $screenY, [OCUWin32]::MOUSEEVENTF_MOVE, 0)) { throw "Windows could not move the pointer to the target window." }
        Start-Sleep -Milliseconds 20
        if (-not [OCUWin32]::SendMouse($screenX, $screenY, $down, 0)) { throw "Windows could not deliver the pointer button to the target window." }
        Start-Sleep -Milliseconds 35
        if (-not [OCUWin32]::SendMouse($screenX, $screenY, $up, 0)) { throw "Windows could not release the pointer button on the target window." }
        Start-Sleep -Milliseconds 50
    }
    Note-InjectedInput
}

function Send-Drag([IntPtr]$hwnd, [int]$fromX, [int]$fromY, [int]$toX, [int]$toY) {
    Assert-PointOnTarget $hwnd $fromX $fromY
    if (-not [OCUWin32]::SendMouse($fromX, $fromY, [OCUWin32]::MOUSEEVENTF_MOVE, 0)) { throw "Windows could not move the pointer to the drag start." }
    Start-Sleep -Milliseconds 30
    if (-not [OCUWin32]::SendMouse($fromX, $fromY, [OCUWin32]::MOUSEEVENTF_LEFTDOWN, 0)) { throw "Windows could not press the pointer for the drag." }
    $steps = 12
    for ($i = 1; $i -le $steps; $i++) {
        $x = [int][math]::Round($fromX + (($toX - $fromX) * $i / $steps))
        $y = [int][math]::Round($fromY + (($toY - $fromY) * $i / $steps))
        if (-not [OCUWin32]::SendMouse($x, $y, [OCUWin32]::MOUSEEVENTF_MOVE, 0)) { throw "Windows could not move the pointer during the drag." }
        Start-Sleep -Milliseconds 20
    }
    if (-not [OCUWin32]::SendMouse($toX, $toY, [OCUWin32]::MOUSEEVENTF_LEFTUP, 0)) { throw "Windows could not release the pointer after the drag." }
    Note-InjectedInput
}

function Send-Scroll([IntPtr]$hwnd, [int]$screenX, [int]$screenY, [string]$direction, [double]$pages) {
    Assert-PointOnTarget $hwnd $screenX $screenY
    $delta = [int][math]::Round(120 * $pages)
    $flags = [OCUWin32]::MOUSEEVENTF_WHEEL
    if ($direction -eq "down" -or $direction -eq "right") { $delta = -1 * $delta }
    if ($direction -eq "left" -or $direction -eq "right") { $flags = [OCUWin32]::MOUSEEVENTF_HWHEEL }
    $wheel = [uint32](([int]$delta -band 0xFFFF) -shl 16)
    if (-not [OCUWin32]::SendMouse($screenX, $screenY, $flags, $wheel)) {
        throw "Windows could not deliver the scroll to the target window."
    }
    Note-InjectedInput
}

function Send-Text([IntPtr]$hwnd, [string]$text) {
    Invoke-ActivateTarget $hwnd
    foreach ($char in $text.ToCharArray()) {
        if (-not [OCUWin32]::SendUnicode($char)) { throw "Windows could not type into the target window." }
        Start-Sleep -Milliseconds 8
    }
    Note-InjectedInput
}

function Send-TextToEditHandle([IntPtr]$hwnd, [string]$text, $element) {
    if ($hwnd -eq [IntPtr]::Zero) {
        return $false
    }

    $selectionSent = $false
    $selectionError = 0
    try {
        [OCUWin32]::SetLastError(0)
        [void][OCUWin32]::SendMessage($hwnd, $EM_SETSEL, [IntPtr](-1), [IntPtr](-1))
        $selectionError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $selectionSent = $true
    } catch {}
    Assert-NotBlockedByUipi $selectionError
    if ($selectionSent) {
        $replaceSent = $false
        $replaceError = 0
        try {
            [OCUWin32]::SetLastError(0)
            [void][OCUWin32]::SendMessage($hwnd, $EM_REPLACESEL, [IntPtr]1, $text)
            $replaceError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
            $replaceSent = $true
        } catch {}
        Assert-NotBlockedByUipi $replaceError
        if ($replaceSent) { return $true }
    }

    $setTextSent = $false
    $setTextError = 0
    try {
        $current = ""
        if ($null -ne $element) {
            $current = Get-ElementValue $element
        }
        [OCUWin32]::SetLastError(0)
        [void][OCUWin32]::SendMessage($hwnd, $WM_SETTEXT, [IntPtr]::Zero, ($current + $text))
        $setTextError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $setTextSent = $true
    } catch {
    }
    Assert-NotBlockedByUipi $setTextError
    return $setTextSent
}

function Get-VirtualKey([string]$key) {
    $normalized = $key.ToLowerInvariant()
    $map = @{
        "return" = 0x0D; "enter" = 0x0D; "tab" = 0x09; "escape" = 0x1B; "esc" = 0x1B
        "backspace" = 0x08; "back_space" = 0x08; "delete" = 0x2E; "space" = 0x20
        "left" = 0x25; "up" = 0x26; "right" = 0x27; "down" = 0x28
        "home" = 0x24; "end" = 0x23; "page_up" = 0x21; "prior" = 0x21; "page_down" = 0x22; "next" = 0x22
    }
    if ($map.ContainsKey($normalized)) {
        return $map[$normalized]
    }
    if ($normalized -match "^f([1-9]|1[0-2])$") {
        return 0x70 + [int]$Matches[1] - 1
    }
    if ($normalized -match "^kp_([0-9])$") {
        return 0x60 + [int]$Matches[1]
    }
    if ($normalized.Length -eq 1) {
        $code = [int][char]$normalized.ToUpperInvariant()[0]
        if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) {
            return $code
        }
    }
    throw "Unsupported key: $key"
}

function Send-Key([IntPtr]$hwnd, [string]$key) {
    Invoke-ActivateTarget $hwnd
    $parts = $key -split "\+"
    $main = $parts[$parts.Length - 1]
    $modifiers = @()
    for ($i = 0; $i -lt $parts.Length - 1; $i++) {
        switch ($parts[$i].ToLowerInvariant()) {
            "ctrl" { $modifiers += 0x11 }
            "control" { $modifiers += 0x11 }
            "shift" { $modifiers += 0x10 }
            "alt" { $modifiers += 0x12 }
            "super" { $modifiers += 0x5B }
            "win" { $modifiers += 0x5B }
            "cmd" { $modifiers += 0x5B }
        }
    }
    foreach ($modifier in $modifiers) {
        if (-not [OCUWin32]::SendVirtualKey([uint16]$modifier, $false)) { throw "Windows could not press a modifier on the target window." }
    }
    $vk = Get-VirtualKey $main
    if (-not [OCUWin32]::SendVirtualKey([uint16]$vk, $false)) { throw "Windows could not press the key on the target window." }
    Start-Sleep -Milliseconds 25
    if (-not [OCUWin32]::SendVirtualKey([uint16]$vk, $true)) { throw "Windows could not release the key on the target window." }
    [array]::Reverse($modifiers)
    foreach ($modifier in $modifiers) {
        if (-not [OCUWin32]::SendVirtualKey([uint16]$modifier, $true)) { throw "Windows could not release a modifier on the target window." }
    }
    Note-InjectedInput
}

function Resolve-App([string]$query) {
    $normalized = $query.Trim()
    $processQuery = $normalized
    if ($processQuery.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        $processQuery = $processQuery.Substring(0, $processQuery.Length - 4)
    }
    $processes = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 })
    $pidValue = 0
    if ([int]::TryParse($normalized, [ref]$pidValue)) {
        $match = $processes | Where-Object { $_.Id -eq $pidValue } | Select-Object -First 1
        if ($null -ne $match) {
            return $match
        }
    }

    $match = $processes | Where-Object {
        $_.ProcessName -ieq $processQuery -or
        "$($_.ProcessName).exe" -ieq $normalized -or
        $_.MainWindowTitle -ieq $normalized -or
        $_.MainWindowTitle -ilike "*$normalized*"
    } | Select-Object -First 1
    if ($null -ne $match) {
        return $match
    }

    if (Test-EnvFlagEnabled "OPEN_COMPUTER_USE_WINDOWS_ALLOW_APP_LAUNCH") {
        try {
            $started = Start-Process -FilePath $normalized -PassThru
            for ($i = 0; $i -lt 20; $i++) {
                Start-Sleep -Milliseconds 250
                $candidate = Get-Process -Id $started.Id -ErrorAction SilentlyContinue
                if ($null -ne $candidate -and $candidate.MainWindowHandle -ne 0) {
                    return $candidate
                }
            }
        } catch {
        }
    }

    throw "appNotFound(`"$query`")"
}

function Get-MainElement($process) {
    if ($process.MainWindowHandle -ne 0) {
        return [Windows.Automation.AutomationElement]::FromHandle([IntPtr]$process.MainWindowHandle)
    }
    $condition = New-Object Windows.Automation.PropertyCondition ([Windows.Automation.AutomationElement]::ProcessIdProperty), $process.Id
    $children = [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $condition)
    if ($children.Count -gt 0) {
        return $children.Item(0)
    }
    throw "No top-level UI Automation window is available for $($process.ProcessName). Run the Windows runtime in the signed-in desktop session."
}

function Get-WindowBounds($process, $element) {
    $hwnd = [IntPtr]$process.MainWindowHandle
    if ($hwnd -ne [IntPtr]::Zero) {
        $fromWin32 = Get-WindowRectFrame $hwnd
        if ($null -ne $fromWin32) {
            return $fromWin32
        }
    }
    try {
        $rect = $element.Current.BoundingRectangle
        if (-not $rect.IsEmpty -and $rect.Width -gt 0 -and $rect.Height -gt 0) {
            return New-Frame $rect.X $rect.Y $rect.Width $rect.Height
        }
    } catch {
    }
    return $null
}

function Get-PatternNames($element) {
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($pattern in $element.GetSupportedPatterns()) {
        $programmatic = $pattern.ProgrammaticName
        if ($programmatic -like "InvokePatternIdentifiers.Pattern") { $names.Add("Invoke") }
        elseif ($programmatic -like "TogglePatternIdentifiers.Pattern") { $names.Add("Toggle") }
        elseif ($programmatic -like "SelectionItemPatternIdentifiers.Pattern") { $names.Add("Select") }
        elseif ($programmatic -like "ExpandCollapsePatternIdentifiers.Pattern") {
            try {
                $state = $element.GetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern).Current.ExpandCollapseState
                if ($state -eq [Windows.Automation.ExpandCollapseState]::Collapsed) { $names.Add("Expand") }
                elseif ($state -eq [Windows.Automation.ExpandCollapseState]::Expanded) { $names.Add("Collapse") }
            } catch {
                $names.Add("Expand")
                $names.Add("Collapse")
            }
        }
        elseif ($programmatic -like "ScrollItemPatternIdentifiers.Pattern") { $names.Add("ScrollIntoView") }
        elseif ($programmatic -like "ScrollPatternIdentifiers.Pattern") { $names.Add("Scroll") }
        elseif ($programmatic -like "ValuePatternIdentifiers.Pattern") { $names.Add("SetValue") }
    }
    if ($names.Count -gt 0) {
        return @($names | Select-Object -Unique)
    }
    return @()
}

function Get-ElementString($element, [string]$propertyName) {
    try {
        $value = $element.Current.$propertyName
        if ($null -eq $value) {
            return ""
        }
        return [string]$value
    } catch {
        return ""
    }
}

function Get-ElementInt64($element, [string]$propertyName) {
    try {
        return [int64]$element.Current.$propertyName
    } catch {
        return 0
    }
}

function Get-ElementControlTypeName($element) {
    try {
        $controlType = $element.Current.ControlType
        if ($null -eq $controlType) {
            return ""
        }
        return [string]$controlType.ProgrammaticName
    } catch {
        return ""
    }
}

function Resolve-TextLimit($Value) {
    if ($null -eq $Value) {
        return $script:DefaultTextLimit
    }
    if ($Value -is [string] -and $Value.Trim().ToLowerInvariant() -eq "max") {
        return $null
    }
    if ($Value -is [bool]) {
        return $script:DefaultTextLimit
    }
    try {
        $integer = [int]$Value
        if ($integer -gt 0) {
            return $integer
        }
    } catch {
    }
    return $script:DefaultTextLimit
}

function Limit-Text([string]$Text, $TextLimit = $script:DefaultTextLimit) {
    if ($null -eq $Text) {
        return ""
    }
    if ($null -eq $TextLimit) {
        return $Text
    }
    $effectiveTextLimit = [int]$TextLimit
    if ($Text.Length -gt $effectiveTextLimit) {
        return $Text.Substring(0, $effectiveTextLimit) + "..."
    }
    return $Text
}

function Get-ElementValue($element, $TextLimit = $script:DefaultTextLimit) {
    try {
        $valuePattern = $element.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern)
        $value = $valuePattern.Current.Value
        if ($null -eq $value) {
            return ""
        }
        $text = [string]$value
        return Limit-Text $text $TextLimit
    } catch {
        return ""
    }
}

function Get-ElementRecord($element, [int]$index, $windowBounds, $TextLimit = $script:DefaultTextLimit) {
    $frame = Get-ElementFrame $element $windowBounds
    $runtimeId = @()
    try { $runtimeId = @($element.GetRuntimeId()) } catch {}
    [pscustomobject]@{
        index = $index
        runtimeId = $runtimeId
        automationId = Get-ElementString $element "AutomationId"
        name = Limit-Text (Get-ElementString $element "Name") $TextLimit
        controlType = Get-ElementControlTypeName $element
        localizedControlType = Get-ElementString $element "LocalizedControlType"
        className = Get-ElementString $element "ClassName"
        value = Get-ElementValue $element $TextLimit
        nativeWindowHandle = Get-ElementInt64 $element "NativeWindowHandle"
        frame = $frame
        actions = @(Get-PatternNames $element)
    }
}

function Get-ElementTitle($record) {
    if (-not [string]::IsNullOrWhiteSpace($record.name)) {
        return $record.name
    }
    if (-not [string]::IsNullOrWhiteSpace($record.automationId)) {
        return "ID: $($record.automationId)"
    }
    return ""
}

function Render-Tree($element, $windowBounds, $TextLimit = $script:DefaultTextLimit, [int]$MaxTreeNodes = $script:AccessibilityTreeMaxNodeCount, [int]$MaxTreeDepth = $script:AccessibilityTreeMaxDepth) {
    $records = New-Object System.Collections.Generic.List[object]
    $lines = New-Object System.Collections.Generic.List[string]
    $visited = New-Object System.Collections.Generic.HashSet[string]
    $nextIndex = 0
    $effectiveMaxTreeNodes = if ($MaxTreeNodes -gt 0) { $MaxTreeNodes } else { $script:AccessibilityTreeMaxNodeCount }
    $effectiveMaxTreeDepth = if ($MaxTreeDepth -gt 0) { $MaxTreeDepth } else { $script:AccessibilityTreeMaxDepth }

    function Visit($node, [int]$depth) {
        if ($script:nextIndex -ge $script:MaxTreeNodes -or $depth -gt $script:MaxTreeDepth) {
            return
        }
        $runtime = ""
        try { $runtime = (@($node.GetRuntimeId()) -join ".") } catch { $runtime = [guid]::NewGuid().ToString() }
        if (-not $script:visited.Add($runtime)) {
            return
        }

        $index = $script:nextIndex
        $script:nextIndex++
        $record = Get-ElementRecord $node $index $script:windowBounds $TextLimit
        $script:records.Add($record)

        $role = $record.localizedControlType
        if ([string]::IsNullOrWhiteSpace($role)) {
            $role = $record.controlType
        }
        $title = Get-ElementTitle $record
        $actionsSegment = ""
        if ($record.actions.Count -gt 0) {
            $actionsSegment = " Secondary Actions: " + ($record.actions -join ", ")
        }
        $valueSegment = ""
        if (-not [string]::IsNullOrWhiteSpace($record.value) -and $record.value -ne $title) {
            $safeValue = (($record.value -replace "`r", "\\r") -replace "`n", "\\n")
            $valueSegment = " Value: $safeValue"
        }
        $frameSegment = ""
        if ($null -ne $record.frame) {
            $frameSegment = " Frame: {{x: {0}, y: {1}, width: {2}, height: {3}}}" -f [int][math]::Round($record.frame.x), [int][math]::Round($record.frame.y), [int][math]::Round($record.frame.width), [int][math]::Round($record.frame.height)
        }
        $script:lines.Add(("`t" * ($depth + 1)) + "$index $role $title$valueSegment$actionsSegment$frameSegment")

        try {
            $children = $node.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
            for ($i = 0; $i -lt $children.Count; $i++) {
                Visit $children.Item($i) ($depth + 1)
            }
        } catch {
        }
    }

    $script:records = $records
    $script:lines = $lines
    $script:visited = $visited
    $script:nextIndex = $nextIndex
    $script:windowBounds = $windowBounds
    $script:MaxTreeNodes = $effectiveMaxTreeNodes
    $script:MaxTreeDepth = $effectiveMaxTreeDepth
    Visit $element 0

    [pscustomobject]@{
        records = $records.ToArray()
        lines = $lines.ToArray()
    }
}

function Test-BitmapMostlyBlank($bitmap) {
    $width = $bitmap.Width
    $height = $bitmap.Height
    if ($width -lt 2 -or $height -lt 2) { return $true }
    $blank = 0
    $samples = 0
    $stepX = [math]::Max(1, [int]($width / 6))
    $stepY = [math]::Max(1, [int]($height / 6))
    for ($y = 0; $y -lt $height; $y += $stepY) {
        for ($x = 0; $x -lt $width; $x += $stepX) {
            $color = $bitmap.GetPixel($x, $y)
            $samples++
            if ($color.A -lt 16 -or ($color.R -lt 8 -and $color.G -lt 8 -and $color.B -lt 8)) { $blank++ }
        }
    }
    return $samples -gt 0 -and $blank -ge ($samples * 0.9)
}

function Capture-WindowPngBase64([IntPtr]$hwnd, $bounds) {
    if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0) {
        return $null
    }
    $bitmap = $null
    $graphics = $null
    try {
        $bitmap = New-Object System.Drawing.Bitmap ([int][math]::Round($bounds.width)), ([int][math]::Round($bounds.height))
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $captured = $false
        if ($hwnd -ne [IntPtr]::Zero) {
            $hdc = $graphics.GetHdc()
            try { $captured = [OCUWin32]::PrintWindow($hwnd, $hdc, 2) } finally { $graphics.ReleaseHdc($hdc) }
            if ($captured -and (Test-BitmapMostlyBlank $bitmap)) { $captured = $false }
        }
        if (-not $captured) {
            $graphics.Clear([System.Drawing.Color]::Transparent)
            $graphics.CopyFromScreen([int][math]::Round($bounds.x), [int][math]::Round($bounds.y), 0, 0, $bitmap.Size)
        }
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return [Convert]::ToBase64String($stream.ToArray())
    } catch {
        return $null
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
}

function Get-FocusedSummary($processId, $TextLimit = $script:DefaultTextLimit) {
    try {
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $focused -and $focused.Current.ProcessId -eq $processId) {
            $role = $focused.Current.LocalizedControlType
            $name = Limit-Text $focused.Current.Name $TextLimit
            if ([string]::IsNullOrWhiteSpace($name)) {
                return $role
            }
            return "$role $name"
        }
    } catch {
    }
    return $null
}

function Get-SelectedText($processId, $TextLimit = $script:DefaultTextLimit) {
    try {
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($null -eq $focused -or $focused.Current.ProcessId -ne $processId) {
            return $null
        }
        $textPattern = $focused.GetCurrentPattern([Windows.Automation.TextPattern]::Pattern)
        $selection = $textPattern.GetSelection()
        if ($selection.Count -gt 0) {
            $maxLength = if ($null -eq $TextLimit) { -1 } else { [int]$TextLimit + 1 }
            return Limit-Text ($selection.Item(0).GetText($maxLength)) $TextLimit
        }
    } catch {
    }
    return $null
}

function Build-Snapshot([string]$query, $TextLimit = $script:DefaultTextLimit, [int]$MaxTreeNodes = $script:AccessibilityTreeMaxNodeCount, [int]$MaxTreeDepth = $script:AccessibilityTreeMaxDepth) {
    $process = Resolve-App $query
    $hwnd = Get-DialogWindow $process
    $element = $null
    if ($hwnd -ne [IntPtr]::Zero) {
        try { $element = [Windows.Automation.AutomationElement]::FromHandle($hwnd) } catch { $element = $null }
    }
    if ($null -eq $element) { $element = Get-MainElement $process }
    $bounds = Get-WindowRectFrame $hwnd
    if ($null -eq $bounds) { $bounds = Get-WindowBounds $process $element }
    $rendered = Render-Tree $element $bounds $TextLimit $MaxTreeNodes $MaxTreeDepth
    [pscustomobject]@{
        app = [pscustomobject]@{
            name = $process.ProcessName
            bundleIdentifier = $process.ProcessName
            pid = [int]$process.Id
        }
        windowTitle = Limit-Text $process.MainWindowTitle $TextLimit
        windowBounds = $bounds
        screenshotPngBase64 = Capture-WindowPngBase64 $hwnd $bounds
        treeLines = @($rendered.lines)
        focusedSummary = Get-FocusedSummary $process.Id $TextLimit
        selectedText = Get-SelectedText $process.Id $TextLimit
        elements = @($rendered.records)
    }
}

function List-Apps {
    $lines = New-Object System.Collections.Generic.List[string]
    foreach ($process in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Sort-Object ProcessName, Id)) {
        $title = $process.MainWindowTitle
        if ([string]::IsNullOrWhiteSpace($title)) {
            $title = "untitled"
        }
        $lines.Add(("{0} -- {1} [running, pid={2}, window={3}]" -f $process.ProcessName, $process.ProcessName, $process.Id, $title))
    }
    return ($lines -join "`n")
}

function Same-RuntimeId($left, $right) {
    if ($null -eq $left -or $null -eq $right -or $left.Count -ne $right.Count) {
        return $false
    }
    for ($i = 0; $i -lt $left.Count; $i++) {
        if ([int]$left[$i] -ne [int]$right[$i]) {
            return $false
        }
    }
    return $true
}

function Get-AllElements($root) {
    $items = New-Object System.Collections.Generic.List[object]
    $items.Add($root)
    try {
        $descendants = $root.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
        for ($i = 0; $i -lt $descendants.Count; $i++) {
            $items.Add($descendants.Item($i))
        }
    } catch {
    }
    return $items.ToArray()
}

function Find-Element($process, $record) {
    if ($null -eq $record) {
        return $null
    }
    $root = Get-MainElement $process
    foreach ($element in (Get-AllElements $root)) {
        try {
            if (Same-RuntimeId @($element.GetRuntimeId()) @($record.runtimeId)) {
                return $element
            }
        } catch {
        }
    }
    foreach ($element in (Get-AllElements $root)) {
        try {
            $sameAutomationId = -not [string]::IsNullOrWhiteSpace($record.automationId) -and $element.Current.AutomationId -eq $record.automationId
            $sameName = -not [string]::IsNullOrWhiteSpace($record.name) -and $element.Current.Name -eq $record.name
            $sameType = $element.Current.ControlType.ProgrammaticName -eq $record.controlType
            if (($sameAutomationId -or $sameName) -and $sameType) {
                return $element
            }
        } catch {
        }
    }
    return $null
}

function Get-CurrentPatternOrNull($element, $pattern) {
    try {
        return $element.GetCurrentPattern($pattern)
    } catch {
        return $null
    }
}

function Invoke-PreferredClick($element) {
    $invoke = Get-CurrentPatternOrNull $element ([Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $invoke) {
        $invoke.Invoke()
        return $true
    }
    $selection = Get-CurrentPatternOrNull $element ([Windows.Automation.SelectionItemPattern]::Pattern)
    if ($null -ne $selection) {
        $selection.Select()
        return $true
    }
    $toggle = Get-CurrentPatternOrNull $element ([Windows.Automation.TogglePattern]::Pattern)
    if ($null -ne $toggle) {
        $toggle.Toggle()
        return $true
    }
    return $false
}

function Invoke-SecondaryAction($element, [string]$action) {
    switch ($action.ToLowerInvariant()) {
        "invoke" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.InvokePattern]::Pattern)
            if ($null -ne $pattern) { $pattern.Invoke(); return }
        }
        "toggle" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.TogglePattern]::Pattern)
            if ($null -ne $pattern) { $pattern.Toggle(); return }
        }
        "select" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.SelectionItemPattern]::Pattern)
            if ($null -ne $pattern) { $pattern.Select(); return }
        }
        "expand" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -ne $pattern) { $pattern.Expand(); return }
        }
        "collapse" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -ne $pattern) { $pattern.Collapse(); return }
        }
        "scrollintoview" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ScrollItemPattern]::Pattern)
            if ($null -ne $pattern) { $pattern.ScrollIntoView(); return }
        }
        "setfocus" {
            if (-not (Test-EnvFlagEnabled "OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOCUS_ACTIONS")) {
                throw "SetFocus is disabled by default to avoid stealing user focus; set OPEN_COMPUTER_USE_WINDOWS_ALLOW_FOCUS_ACTIONS=1 to enable it."
            }
            $element.SetFocus()
            return
        }
    }
    throw "$action is not a valid secondary action for $($operation.element.index)"
}

function Invoke-Scroll($element, [string]$direction, [double]$pages) {
    $scroll = Get-CurrentPatternOrNull $element ([Windows.Automation.ScrollPattern]::Pattern)
    if ($null -eq $scroll) {
        return $false
    }
    $horizontal = [Windows.Automation.ScrollAmount]::NoAmount
    $vertical = [Windows.Automation.ScrollAmount]::NoAmount
    if ($direction -eq "up") { $vertical = [Windows.Automation.ScrollAmount]::LargeDecrement }
    elseif ($direction -eq "down") { $vertical = [Windows.Automation.ScrollAmount]::LargeIncrement }
    elseif ($direction -eq "left") { $horizontal = [Windows.Automation.ScrollAmount]::LargeDecrement }
    elseif ($direction -eq "right") { $horizontal = [Windows.Automation.ScrollAmount]::LargeIncrement }
    $repeat = [math]::Max(1, [int][math]::Ceiling($pages))
    for ($i = 0; $i -lt $repeat; $i++) {
        $scroll.Scroll($horizontal, $vertical)
        Start-Sleep -Milliseconds 40
    }
    return $true
}

function Find-TextEntryElement($process) {
    try {
        $focused = [Windows.Automation.AutomationElement]::FocusedElement
        if ($null -ne $focused -and $focused.Current.ProcessId -eq $process.Id) {
            $focusedValue = Get-CurrentPatternOrNull $focused ([Windows.Automation.ValuePattern]::Pattern)
            if ($null -ne $focusedValue -and -not $focusedValue.Current.IsReadOnly) {
                return $focused
            }
        }
    } catch {
    }

    $root = Get-MainElement $process
    foreach ($element in (Get-AllElements $root)) {
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -eq $valuePattern -or $valuePattern.Current.IsReadOnly) {
            continue
        }
        $controlType = Get-ElementControlTypeName $element
        if ($controlType -like "*Edit*" -or $controlType -like "*Document*") {
            return $element
        }
    }

    foreach ($element in (Get-AllElements $root)) {
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) {
            return $element
        }
    }

    return $null
}

function Get-NativeWindowHandle($element) {
    $handle = Get-ElementInt64 $element "NativeWindowHandle"
    if ($handle -le 0) {
        return [IntPtr]::Zero
    }
    return [IntPtr]$handle
}

function Test-TextWindowHandleCandidate($process, $element) {
    if ($null -eq $element) {
        return $false
    }
    $handle = Get-NativeWindowHandle $element
    if ($handle -eq [IntPtr]::Zero -or $handle -eq [IntPtr]$process.MainWindowHandle) {
        return $false
    }
    $controlType = Get-ElementControlTypeName $element
    $className = Get-ElementString $element "ClassName"
    return (
        $controlType -like "*Edit*" -or
        $controlType -like "*Document*" -or
        $className -like "*Edit*" -or
        $className -like "*Rich*" -or
        $className -like "*Text*"
    )
}

function Find-TextEntryWindowHandle($process, $preferredElement) {
    if (Test-TextWindowHandleCandidate $process $preferredElement) {
        return Get-NativeWindowHandle $preferredElement
    }

    $root = Get-MainElement $process
    foreach ($element in (Get-AllElements $root)) {
        if (-not (Test-TextWindowHandleCandidate $process $element)) {
            continue
        }
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) {
            return Get-NativeWindowHandle $element
        }
    }

    foreach ($element in (Get-AllElements $root)) {
        if (Test-TextWindowHandleCandidate $process $element) {
            return Get-NativeWindowHandle $element
        }
    }

    return [IntPtr]::Zero
}

function Invoke-TypeText($process, [string]$text) {
    $element = Find-TextEntryElement $process
    $targetHwnd = Find-TextEntryWindowHandle $process $element
    if ($targetHwnd -ne [IntPtr]::Zero -and (Send-TextToEditHandle $targetHwnd $text $element)) {
        return $true
    }

    if ($null -ne $element) {
        $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $valuePattern -and -not $valuePattern.Current.IsReadOnly) {
            if (-not (Test-EnvFlagEnabled "OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK")) {
                throw "UIA ValuePattern text fallback is disabled by default because it may bring the target app to the foreground; set OPEN_COMPUTER_USE_WINDOWS_ALLOW_UIA_TEXT_FALLBACK=1 to enable it."
            }
            $current = ""
            try { $current = [string]$valuePattern.Current.Value } catch {}
            $valuePattern.SetValue($current + $text)
            return $true
        }
    }
    return $false
}

# Read the operation file as UTF-8 explicitly. Windows PowerShell 5.1's
# Get-Content defaults to the system ANSI code page (e.g. GBK on Chinese
# systems) for files without a BOM, which corrupts non-ASCII input such as
# Chinese text passed to set_value/type_text.
$operationJson = [System.IO.File]::ReadAllText($OperationPath, [System.Text.Encoding]::UTF8)
$operation = $operationJson | ConvertFrom-Json
$script:focusGuardStop = $false
$script:injectedInputTick = $null
$script:agentInjectedInput = $false
$script:focusNote = $null

try {
    if ($operation.tool -eq "list_apps") {
        $response = [pscustomobject]@{ ok = $true; text = (List-Apps) }
    } elseif ($operation.tool -eq "get_app_state") {
        $response = [pscustomobject]@{ ok = $true; snapshot = (Build-Snapshot $operation.app (Resolve-TextLimit $operation.text_limit) ([int]$operation.max_tree_nodes) ([int]$operation.max_tree_depth)) }
    } else {
        $process = Resolve-App $operation.app
        $windowBounds = $operation.windowBounds
        $hwnd = Resolve-ActionWindow $process $windowBounds
        $element = Find-Element $process $operation.element

        $focusBefore = Read-FocusState
        Assert-SafeBeforeAction $focusBefore $process.Id

        try {
          switch ($operation.tool) {
            "click" {
                $clickMethod = [string]$operation.click_method
                if ([string]::IsNullOrWhiteSpace($clickMethod)) { $clickMethod = "auto" }

                if ($clickMethod -eq "accessibility") {
                    if ($null -eq $element) { throw "click_method 'accessibility' requires element_index" }
                    if ($operation.mouse_button -eq "right" -or $operation.mouse_button -eq "middle") {
                        throw "click_method 'accessibility' does not support mouse_button '$($operation.mouse_button)'"
                    }
                    if (-not (Invoke-PreferredClick $element)) {
                        throw "click_method 'accessibility' could not click the requested element"
                    }
                } elseif ($clickMethod -eq "app_post") {
                    if ($null -ne $operation.element -and $null -ne $operation.element.frame) {
                        $point = Get-ScreenPoint $operation.element.frame $windowBounds
                    } else {
                        $point = [pscustomobject]@{
                            x = [int][math]::Round($windowBounds.x + [double]$operation.x)
                            y = [int][math]::Round($windowBounds.y + [double]$operation.y)
                        }
                    }
                    Send-MouseClick $hwnd $point.x $point.y $operation.mouse_button ([int]$operation.click_count)
                } elseif ($clickMethod -eq "global") {
                    throw "click_method 'global' is not supported on Windows"
                } elseif ($clickMethod -eq "sky_click") {
                    throw "click_method 'sky_click' is not supported on Windows"
                } elseif ($clickMethod -eq "auto") {
                    $handled = $false
                    if ($null -ne $element -and $operation.mouse_button -ne "right" -and $operation.mouse_button -ne "middle") {
                        $handled = Invoke-PreferredClick $element
                    }
                    if (-not $handled) {
                        if ($null -ne $operation.element -and $null -ne $operation.element.frame) {
                            $point = Get-ScreenPoint $operation.element.frame $windowBounds
                        } else {
                            $point = [pscustomobject]@{
                                x = [int][math]::Round($windowBounds.x + [double]$operation.x)
                                y = [int][math]::Round($windowBounds.y + [double]$operation.y)
                            }
                        }
                        Send-MouseClick $hwnd $point.x $point.y $operation.mouse_button ([int]$operation.click_count)
                    }
                } else {
                    throw "Invalid click_method '$clickMethod'"
                }
            }
            "perform_secondary_action" {
                if ($null -eq $element) { throw "unknown element_index '$($operation.element.index)'" }
                Invoke-SecondaryAction $element $operation.action
            }
            "scroll" {
                $handled = $false
                if ($null -ne $element) {
                    $handled = Invoke-Scroll $element $operation.direction ([double]$operation.pages)
                }
                if (-not $handled) {
                    if ($null -ne $element) {
                        $point = Get-ScreenPoint $operation.element.frame $windowBounds
                    } else {
                        $point = [pscustomobject]@{
                            x = [int][math]::Round($windowBounds.x + [double]$operation.x)
                            y = [int][math]::Round($windowBounds.y + [double]$operation.y)
                        }
                    }
                    Send-Scroll $hwnd $point.x $point.y $operation.direction ([double]$operation.pages)
                }
            }
            "drag" {
                Send-Drag $hwnd ([int][math]::Round($windowBounds.x + [double]$operation.from_x)) ([int][math]::Round($windowBounds.y + [double]$operation.from_y)) ([int][math]::Round($windowBounds.x + [double]$operation.to_x)) ([int][math]::Round($windowBounds.y + [double]$operation.to_y))
            }
            "type_text" {
                if (-not (Invoke-TypeText $process $operation.text)) {
                    Send-Text $hwnd $operation.text
                }
            }
            "press_key" {
                Send-Key $hwnd $operation.key
            }
            "set_value" {
                if ($null -eq $element) { throw "unknown element_index '$($operation.element.index)'" }
                $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
                if ($null -eq $valuePattern) {
                    throw "Cannot set a value for an element that is not settable"
                }
                $valuePattern.SetValue($operation.value)
            }
            default {
                throw "unsupportedTool(`"$($operation.tool)`")"
            }
          }

          Start-Sleep -Milliseconds 500
          $snapshot = Build-Snapshot $operation.app
        } finally {
          Assert-SafeAfterAction $focusBefore $process.Id
        }
        if (-not [string]::IsNullOrWhiteSpace($script:focusNote)) {
            $snapshot.focusedSummary = ((@($snapshot.focusedSummary, $script:focusNote) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }) -join ". ")
        }
        $response = [pscustomobject]@{ ok = $true; snapshot = $snapshot }
    }
} catch {
    $message = $_.Exception.Message
    if (-not $script:focusGuardStop -and -not [string]::IsNullOrWhiteSpace($_.ScriptStackTrace)) {
        $message = "$message at $($_.ScriptStackTrace)"
    }
    $response = [pscustomobject]@{ ok = $false; error = $message; focusGuardStop = $script:focusGuardStop }
}

$response | ConvertTo-Json -Depth 50 -Compress
