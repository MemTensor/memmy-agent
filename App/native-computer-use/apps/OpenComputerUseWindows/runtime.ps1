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

# Keep the native surface HWND-targeted. Real input is used only by an explicit
# foreground click, type_text or press_key; no attached input queues are used,
# and activation is restricted to reveal, strict focus undo and that input.
Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class OCUWin32 {
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public UInt32 cbSize, dwTime; }
    [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
        public uint cbSize, flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr value);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern UInt32 GetWindowThreadProcessId(IntPtr hwnd, out UInt32 pid);
    [DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("kernel32.dll")] public static extern UInt32 GetTickCount();
    [DllImport("kernel32.dll", SetLastError=true)] private static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, ExactSpelling=true)] private static extern int GetApplicationUserModelId(IntPtr process, ref uint length, StringBuilder appId);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowUnicode(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsChild(IntPtr parent, IntPtr child);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool ScreenToClient(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetTopWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern IntPtr ChildWindowFromPointEx(IntPtr hwnd, POINT point, uint flags);
    [DllImport("user32.dll", SetLastError=true)] public static extern bool GetGUIThreadInfo(uint thread, ref GUITHREADINFO info);
    [DllImport("user32.dll")] public static extern IntPtr GetKeyboardLayout(uint thread);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern uint MapVirtualKeyEx(uint code, uint kind, IntPtr layout);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendTextMessageTimeout(IntPtr hwnd, uint msg, IntPtr wp, string text, uint flags, uint timeout, out UIntPtr result);
    [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern IntPtr SendReadMessageTimeout(IntPtr hwnd, uint msg, IntPtr wp, IntPtr lp, uint flags, uint timeout, out UIntPtr result);
    [DllImport("kernel32.dll")] public static extern void SetLastError(uint code);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr value);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hwnd, int command);
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll", EntryPoint="GetWindowLongW")] private static extern int GetWindowLong(IntPtr hwnd, int index);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string className, string title);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);
    [DllImport("shlwapi.dll", CharSet=CharSet.Unicode)] private static extern int SHLoadIndirectString(string source, StringBuilder output, int size, IntPtr reserved);
    public static string LoadIndirectString(string source) {
        var text = new StringBuilder(1024);
        return SHLoadIndirectString(source, text, text.Capacity, IntPtr.Zero) == 0 ? text.ToString() : null;
    }

    // A window the user can switch to. Explorer's desktop and tool windows such
    // as the taskbar stay visible while the app has no window to act on.
    public static bool IsAppWindowStyle(bool visible, IntPtr owner, int extendedStyle, bool desktop) {
        return visible && owner == IntPtr.Zero && !desktop && (extendedStyle & 0x80) == 0;
    }
    public static bool IsAppWindow(IntPtr hwnd) {
        string className = WindowClass(hwnd);
        // The shell window and its WorkerW siblings host the wallpaper and desktop icons.
        bool desktop = hwnd == GetShellWindow() || className == "WorkerW"
            || (className == "Windows.UI.Core.CoreWindow" && IsSuspendedAppWindow(hwnd));
        return IsAppWindowStyle(IsWindowVisible(hwnd), GetWindow(hwnd, 4), GetWindowLong(hwnd, -20), desktop);
    }
    // A packaged app's CoreWindow leaves its frame and is cloaked while the app is
    // minimized or suspended. It keeps WS_VISIBLE, but the user cannot see it.
    public static bool IsSuspendedAppWindow(IntPtr hwnd) {
        int cloaked;
        return GetAncestor(hwnd, 2) == hwnd && WindowClass(hwnd) == "Windows.UI.Core.CoreWindow"
            && DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) == 0 && cloaked != 0;
    }
    public static IntPtr FirstAppWindow(uint pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            uint owner;
            if (GetWindowThreadProcessId(hwnd, out owner) == 0 || owner != pid || !IsAppWindow(hwnd)) return true;
            found = hwnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    // A packaged app draws into a CoreWindow inside a frame that the shared
    // ApplicationFrameHost process owns. That CoreWindow belongs to the app's
    // own process, so it is the app's window; the frame only contains it.
    public static bool IsHostedAppWindow(IntPtr hwnd) {
        if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || WindowClass(hwnd) != "Windows.UI.Core.CoreWindow") return false;
        IntPtr frame = GetAncestor(hwnd, 1);
        uint framePID, appPID;
        return frame != IntPtr.Zero && GetAncestor(hwnd, 2) == frame && WindowClass(frame) == "ApplicationFrameWindow"
            && GetWindowThreadProcessId(frame, out framePID) != 0 && GetWindowThreadProcessId(hwnd, out appPID) != 0
            && framePID != appPID;
    }
    public static IntPtr HostedAppWindowIn(IntPtr frame) {
        if (frame == IntPtr.Zero || WindowClass(frame) != "ApplicationFrameWindow") return IntPtr.Zero;
        IntPtr hosted = FindWindowEx(frame, IntPtr.Zero, "Windows.UI.Core.CoreWindow", null);
        return IsHostedAppWindow(hosted) ? hosted : IntPtr.Zero;
    }
    public static IntPtr FirstHostedAppWindow(uint pid) {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            IntPtr hosted = HostedAppWindowIn(hwnd);
            uint owner;
            if (hosted == IntPtr.Zero || GetWindowThreadProcessId(hosted, out owner) == 0 || owner != pid || !IsAppWindow(hwnd)) return true;
            found = hosted;
            return false;
        }, IntPtr.Zero);
        return found;
    }
    // Ordinary targets are top-level windows; a hosted app window is the frame's direct child.
    public static bool IsTargetRootWindow(IntPtr hwnd) {
        return GetAncestor(hwnd, 2) == hwnd || IsHostedAppWindow(hwnd);
    }
    // The top-level window Windows shows, minimizes and activates for a target.
    public static IntPtr ActivationWindow(IntPtr hwnd) {
        return IsHostedAppWindow(hwnd) ? GetAncestor(hwnd, 2) : hwnd;
    }
    // The foreground window as the target it stands for: an app frame in front
    // means its hosted app window, which belongs to the app's process.
    public static IntPtr ForegroundAppWindow() {
        IntPtr foreground = GetForegroundWindow();
        IntPtr hosted = HostedAppWindowIn(foreground);
        return hosted != IntPtr.Zero ? hosted : foreground;
    }

    public static IntPtr[] WindowsForProcess(uint pid) {
        var windows = new List<IntPtr>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            uint owner;
            if (!IsWindowVisible(hwnd) || GetWindowThreadProcessId(hwnd, out owner) == 0) return true;
            if (owner == pid) {
                if (!IsSuspendedAppWindow(hwnd)) windows.Add(hwnd);
                return true;
            }
            IntPtr hosted = HostedAppWindowIn(hwnd);
            uint hostedOwner;
            if (hosted != IntPtr.Zero && GetWindowThreadProcessId(hosted, out hostedOwner) != 0 && hostedOwner == pid)
                windows.Add(hosted);
            return true;
        }, IntPtr.Zero);
        return windows.ToArray();
    }
    // The ID comes from the running process, never its window/document title.
    // QUERY_LIMITED_INFORMATION does not require elevation for ordinary apps.
    public static string ApplicationUserModelId(uint pid) {
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero) return null;
        try {
            uint length = 0;
            if (GetApplicationUserModelId(process, ref length, null) != 122 || length < 2 || length > 257) return null;
            var result = new StringBuilder((int)length);
            if (GetApplicationUserModelId(process, ref length, result) != 0) return null;
            return result.ToString();
        } finally { CloseHandle(process); }
    }
    public sealed class CaptureWindow {
        public long ID, Owner;
        public uint PID;
        public RECT Bounds;
        public bool Visible, Minimized;
        public int ZOrder;
    }
    // Snapshot window-server ownership and ordering, rather than guessing from
    // titles, process membership or intersecting document geometry.
    public static CaptureWindow[] ReadCaptureWindows() {
        var result = new List<CaptureWindow>();
        var seen = new HashSet<long>();
        var hwnd = GetTopWindow(IntPtr.Zero);
        while (hwnd != IntPtr.Zero) {
            if (result.Count >= 2048 || !seen.Add(hwnd.ToInt64()))
                throw new InvalidOperationException("Window ordering changed during capture discovery.");
            var next = GetWindow(hwnd, 2); // GW_HWNDNEXT, top to bottom
            uint pid; RECT bounds;
            GetWindowThreadProcessId(hwnd, out pid);
            GetWindowRect(hwnd, out bounds);
            bool minimized = IsIconic(hwnd);
            result.Add(new CaptureWindow { ID = hwnd.ToInt64(), Owner = GetWindow(hwnd, 4).ToInt64(),
                PID = pid, Bounds = bounds, Visible = IsWindowVisible(hwnd), Minimized = minimized, ZOrder = result.Count });
            // A hosted app window is captured as its own root, directly beneath its frame.
            var hosted = HostedAppWindowIn(hwnd);
            if (hosted != IntPtr.Zero && seen.Add(hosted.ToInt64())) {
                GetWindowThreadProcessId(hosted, out pid);
                GetWindowRect(hosted, out bounds);
                result.Add(new CaptureWindow { ID = hosted.ToInt64(), Owner = GetWindow(hosted, 4).ToInt64(),
                    PID = pid, Bounds = bounds, Visible = IsWindowVisible(hosted), Minimized = minimized, ZOrder = result.Count });
            }
            hwnd = next;
        }
        return result.ToArray();
    }
    private static bool ValidCaptureBounds(RECT bounds) {
        return bounds.Right > bounds.Left && bounds.Bottom > bounds.Top;
    }
    // Pure ownership policy, also exercised without loading User32 in tests.
    public static CaptureWindow[] SelectOwnedPopupWindows(CaptureWindow[] windows, long root, uint pid) {
        var byID = new Dictionary<long, CaptureWindow>();
        foreach (var window in windows) {
            if (window.ID <= 0 || byID.ContainsKey(window.ID))
                throw new InvalidOperationException("Ambiguous capture window identity.");
            byID.Add(window.ID, window);
        }
        CaptureWindow target;
        if (pid == 0 || !byID.TryGetValue(root, out target) || target.PID != pid
            || !target.Visible || target.Minimized || !ValidCaptureBounds(target.Bounds))
            throw new InvalidOperationException("The capture root is unavailable.");
        var result = new List<CaptureWindow>();
        foreach (var window in windows) {
            if (window.ID == root || window.PID != pid || !window.Visible || window.Minimized
                || !ValidCaptureBounds(window.Bounds) || window.ZOrder >= target.ZOrder
                || window.Bounds.Right <= target.Bounds.Left || window.Bounds.Left >= target.Bounds.Right
                || window.Bounds.Bottom <= target.Bounds.Top || window.Bounds.Top >= target.Bounds.Bottom) continue;
            var current = window;
            var seen = new HashSet<long>();
            for (var depth = 0; depth < 64 && seen.Add(current.ID); depth++) {
                if (current.Owner == root) { result.Add(window); break; }
                if (!byID.TryGetValue(current.Owner, out current) || current.PID != pid) break;
            }
        }
        if (result.Count > 64) throw new InvalidOperationException("Too many owned popup windows to capture reliably.");
        result.Sort(delegate(CaptureWindow first, CaptureWindow second) { return second.ZOrder.CompareTo(first.ZOrder); });
        return result.ToArray();
    }
    public static bool SameCaptureGroup(CaptureWindow[] first, CaptureWindow[] second) {
        if (first.Length != second.Length) return false;
        for (var i = 0; i < first.Length; i++) {
            var a = first[i]; var b = second[i];
            if (a.ID != b.ID || a.PID != b.PID || a.Owner != b.Owner || a.Visible != b.Visible || a.Minimized != b.Minimized
                || a.Bounds.Left != b.Bounds.Left || a.Bounds.Top != b.Bounds.Top
                || a.Bounds.Right != b.Bounds.Right || a.Bounds.Bottom != b.Bounds.Bottom) return false;
        }
        return true;
    }
    public static long PointCaptureWindow(CaptureWindow[] popups, long root, int x, int y) {
        // The capture policy returns back to front; input hits the frontmost
        // verified popup covering this screenshot point.
        for (var i = popups.Length - 1; i >= 0; i--) {
            var b = popups[i].Bounds;
            if (x >= b.Left && x < b.Right && y >= b.Top && y < b.Bottom) return popups[i].ID;
        }
        return root;
    }
    public static bool BelongsToCaptureRoot(IntPtr hwnd, IntPtr root, uint pid) {
        if (BelongsToRoot(hwnd, root, pid)) return true;
        uint receiverPID;
        if (!IsWindow(hwnd) || GetWindowThreadProcessId(hwnd, out receiverPID) == 0 || receiverPID != pid) return false;
        var current = GetAncestor(hwnd, 2);
        var seen = new HashSet<long>();
        for (var depth = 0; current != IntPtr.Zero && depth < 64 && seen.Add(current.ToInt64()); depth++) {
            uint ownerPID;
            if (!IsWindow(current) || GetWindowThreadProcessId(current, out ownerPID) == 0 || ownerPID != pid) return false;
            if (current == root) return true;
            current = GetWindow(current, 4);
        }
        return false;
    }
    public static string WindowTitle(IntPtr hwnd) {
        var text = new StringBuilder(4096); GetWindowText(hwnd, text, text.Capacity); return text.ToString();
    }
    public static string WindowClass(IntPtr hwnd) {
        var text = new StringBuilder(256); GetClassName(hwnd, text, text.Capacity); return text.ToString();
    }
    public static bool MatchesUIAHandle(IntPtr hwnd, int nativeHandle) {
        return unchecked((uint)hwnd.ToInt64()) == unchecked((uint)nativeHandle);
    }
    // EM_GETSEL is a read-only system message. Supply both DWORD pointers so
    // selections beyond 65535 are not truncated by its packed return value.
    public static int[] ReadEditSelection(IntPtr hwnd) {
        IntPtr start = Marshal.AllocHGlobal(4), end = Marshal.AllocHGlobal(4);
        try {
            Marshal.WriteInt32(start, -1); Marshal.WriteInt32(end, -1);
            UIntPtr result;
            SetLastError(0);
            if (SendReadMessageTimeout(hwnd, 0x00b0, start, end, 0x22, 1000, out result) == IntPtr.Zero)
                throw new InvalidOperationException("The edit selection could not be observed reliably.");
            int first = Marshal.ReadInt32(start), last = Marshal.ReadInt32(end);
            if (first < 0 || last < first) throw new InvalidOperationException("The edit selection is unavailable.");
            return new int[] { first, last };
        } finally { Marshal.FreeHGlobal(start); Marshal.FreeHGlobal(end); }
    }
    public static bool BelongsToRoot(IntPtr hwnd, IntPtr root, uint pid) {
        uint owner, rootOwner;
        return hwnd != IntPtr.Zero && root != IntPtr.Zero && IsWindow(hwnd) && IsWindow(root)
            && GetWindowThreadProcessId(hwnd, out owner) != 0 && owner == pid
            && GetWindowThreadProcessId(root, out rootOwner) != 0 && rootOwner == pid
            && (GetAncestor(hwnd, 2) == root || IsHostedAppWindow(root)) && (hwnd == root || IsChild(root, hwnd));
    }
    // The message formats use signed 16-bit coordinates, including on a
    // multi-monitor desktop. Reject unrepresentable positions rather than wrap.
    public static IntPtr PointLParam(int x, int y) {
        if (x < short.MinValue || x > short.MaxValue || y < short.MinValue || y > short.MaxValue)
            throw new ArgumentOutOfRangeException("point", "Window-message coordinates exceed signed 16-bit limits.");
        return new IntPtr(unchecked((int)(((uint)(ushort)y << 16) | (ushort)x)));
    }
    public static IntPtr WheelWParam(int delta) {
        if (delta < short.MinValue || delta > short.MaxValue) throw new ArgumentOutOfRangeException("delta");
        return new IntPtr(unchecked((int)((uint)(ushort)delta << 16)));
    }
    public static IntPtr KeyLParam(uint scanCode, bool extended, bool keyUp) {
        uint value = 1 | ((scanCode & 0xff) << 16) | (extended ? 0x01000000u : 0);
        if (keyUp) value |= 0xc0000000u;
        return new IntPtr(unchecked((int)value));
    }
    public static uint InputIdleMilliseconds(uint tick, uint inputTick) {
        uint delta = unchecked(tick - inputTick);
        // Input timestamps can be non-monotonic. A slightly future timestamp
        // must be treated as recent, while ordinary 32-bit tick wrap is valid.
        return delta > int.MaxValue ? 0 : delta;
    }
}

// Real input is reserved for explicit foreground input. Chromium pages and
// other controls ignore posted mouse and key messages, and only native edit
// controls take posted text; every other path stays HWND-targeted.
public static class OCUForegroundInput {
    [StructLayout(LayoutKind.Sequential)] private struct MOUSEINPUT {
        public int dx, dy;
        public uint mouseData, dwFlags, time;
        public IntPtr dwExtraInfo;
    }
    [StructLayout(LayoutKind.Sequential)] private struct INPUT { public uint type; public MOUSEINPUT mi; }
    [StructLayout(LayoutKind.Sequential)] private struct KEYBDINPUT {
        public ushort wVk, wScan;
        public uint dwFlags, time;
        public IntPtr dwExtraInfo;
        // INPUT is a union sized by MOUSEINPUT on every architecture.
        public uint padding1, padding2;
    }
    [StructLayout(LayoutKind.Sequential)] private struct KEYINPUT { public uint type; public KEYBDINPUT ki; }
    [DllImport("user32.dll", SetLastError=true)] private static extern uint SendInput(uint count, INPUT[] inputs, int size);
    [DllImport("user32.dll", EntryPoint="SendInput", SetLastError=true)] private static extern uint SendKeyInput(uint count, KEYINPUT[] inputs, int size);
    [DllImport("user32.dll")] private static extern uint MapVirtualKey(uint code, uint kind);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out OCUWin32.POINT point);
    [DllImport("user32.dll")] private static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] private static extern IntPtr WindowFromPoint(OCUWin32.POINT point);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern int GetSystemMetrics(int index);
    private const uint MOVE = 0x0001, ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
    private static readonly int[] Buttons = { 0x01, 0x02, 0x04, 0x05, 0x06 };
    private static readonly int[] Modifiers = { 0x10, 0x11, 0x12, 0x5B, 0x5C };

    private static bool Held(int[] keys) {
        foreach (var key in keys) if ((GetAsyncKeyState(key) & 0x8000) != 0) return true;
        return false;
    }
    public static bool ButtonHeld() { return Held(Buttons); }
    // A held button or modifier would combine with the injected click.
    public static bool InputHeld() { return Held(Buttons) || Held(Modifiers); }
    public static int[] CursorPosition() {
        OCUWin32.POINT point;
        return GetCursorPos(out point) ? new int[] { point.X, point.Y } : null;
    }
    public static bool MoveCursor(int x, int y) { return SetCursorPos(x, y); }
    public static IntPtr WindowAt(int x, int y) {
        var point = new OCUWin32.POINT();
        point.X = x; point.Y = y;
        return WindowFromPoint(point);
    }
    // An empty input makes this process the source of the last input event,
    // which SetForegroundWindow requires of a background caller.
    public static bool ClaimForeground() {
        return SendInput(1, new INPUT[] { new INPUT() }, Marshal.SizeOf(typeof(INPUT))) == 1;
    }
    public static int NormalizedCoordinate(int value, int origin, int extent) {
        if (extent <= 0 || value < origin || value >= origin + extent)
            throw new ArgumentOutOfRangeException("value", "The click point is outside the virtual desktop.");
        long scaled = ((long)(value - origin) * 65536 + extent - 1) / extent;
        return (int)Math.Min(65535L, scaled);
    }
    // A single SendInput call is never interleaved with the user's own input.
    public static bool Click(int x, int y, string button, int count) {
        uint down = 0x0002, up = 0x0004;
        if (button == "right") { down = 0x0008; up = 0x0010; }
        else if (button == "middle") { down = 0x0020; up = 0x0040; }
        int dx = NormalizedCoordinate(x, GetSystemMetrics(76), GetSystemMetrics(78));
        int dy = NormalizedCoordinate(y, GetSystemMetrics(77), GetSystemMetrics(79));
        var inputs = new List<INPUT>();
        inputs.Add(Mouse(dx, dy, 0));
        for (var index = 0; index < count; index++) {
            inputs.Add(Mouse(dx, dy, down));
            inputs.Add(Mouse(dx, dy, up));
        }
        return SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf(typeof(INPUT))) == inputs.Count;
    }
    private static INPUT Mouse(int dx, int dy, uint buttonFlags) {
        var input = new INPUT();
        input.mi.dx = dx;
        input.mi.dy = dy;
        input.mi.dwFlags = MOVE | ABSOLUTE | VIRTUALDESK | buttonFlags;
        return input;
    }
    private const uint EXTENDEDKEY = 0x0001, KEYUP = 0x0002, UNICODE = 0x0004;
    private static KEYINPUT Key(ushort vk, ushort scan, uint flags) {
        var input = new KEYINPUT();
        input.type = 1;
        input.ki.wVk = vk;
        input.ki.wScan = scan;
        input.ki.dwFlags = flags;
        return input;
    }
    private static bool SendKeys(List<KEYINPUT> inputs) {
        int size = Marshal.SizeOf(typeof(KEYINPUT));
        if (size != Marshal.SizeOf(typeof(INPUT))) return false;
        return SendKeyInput((uint)inputs.Count, inputs.ToArray(), size) == inputs.Count;
    }
    // Each character arrives as itself, whatever the keyboard layout or input
    // method; line breaks and tabs arrive as their keys.
    public static bool TypeText(string text) {
        var inputs = new List<KEYINPUT>();
        foreach (char c in text.Replace("\r\n", "\n")) {
            ushort vk = c == '\n' || c == '\r' ? (ushort)0x0D : c == '\t' ? (ushort)0x09 : (ushort)0;
            if (vk != 0) {
                ushort scan = (ushort)MapVirtualKey(vk, 0);
                inputs.Add(Key(vk, scan, 0));
                inputs.Add(Key(vk, scan, KEYUP));
            } else {
                inputs.Add(Key(0, c, UNICODE));
                inputs.Add(Key(0, c, UNICODE | KEYUP));
            }
        }
        return SendKeys(inputs);
    }
    public static bool PressKeys(ushort[] modifiers, ushort key, bool extended) {
        var inputs = new List<KEYINPUT>();
        foreach (var modifier in modifiers) inputs.Add(Key(modifier, (ushort)MapVirtualKey(modifier, 0), 0));
        uint keyFlags = extended ? EXTENDEDKEY : 0;
        ushort scan = (ushort)MapVirtualKey(key, 0);
        inputs.Add(Key(key, scan, keyFlags));
        inputs.Add(Key(key, scan, keyFlags | KEYUP));
        for (int index = modifiers.Length - 1; index >= 0; index--)
            inputs.Add(Key(modifiers[index], (ushort)MapVirtualKey(modifiers[index], 0), KEYUP));
        return SendKeys(inputs);
    }
}
"@

# UIA bounds and the captured bitmap use physical pixels on mixed-DPI monitors.
try { [void][OCUWin32]::SetThreadDpiAwarenessContext([IntPtr](-4)) } catch {}

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

function Yield-UserInput([string]$message) {
    $script:focusGuardYield = $true
    throw $message
}

function Get-EpochMilliseconds {
    # Subtract works on the .NET runtime used by Windows PowerShell 5.1 too.
    $epoch = [DateTimeOffset]::new(1970, 1, 1, 0, 0, 0, [TimeSpan]::Zero)
    return [long][math]::Floor(([DateTimeOffset]::UtcNow - $epoch).TotalMilliseconds)
}

function Assert-OperationDeadline([switch]$CleanupOnly) {
    $now = Get-EpochMilliseconds
    $deadline = [long]$operation.deadline_epoch_ms
    if ($deadline -gt $now) { return }
    if ($CleanupOnly -and $deadline -gt 0 -and ($now - $deadline) -le 500) { return }
    throw "The Computer Use operation expired or was cancelled. No further action was sent."
}

function Read-OwnedCaptureGroup([IntPtr]$root, [int]$processId) {
    $windows = [OCUWin32]::ReadCaptureWindows()
    $popups = @([OCUWin32]::SelectOwnedPopupWindows($windows, $root.ToInt64(), [uint32]$processId))
    [pscustomobject]@{ root = @($windows | Where-Object { $_.ID -eq $root.ToInt64() })[0]; popups = $popups }
}

function Get-CaptureGroupProof($root, $popups) {
    # Omit absolute z-order positions of unrelated windows; ordered popup
    # identity, ownership and geometry bind input to the actual captured pixels.
    $records = @(@($root) + @($popups) | ForEach-Object {
        [pscustomobject][ordered]@{ id = $_.ID; processId = $_.PID; owner = $_.Owner
            left = $_.Bounds.Left; top = $_.Bounds.Top; right = $_.Bounds.Right; bottom = $_.Bounds.Bottom
            visible = $_.Visible; minimized = $_.Minimized }
    })
    return ConvertTo-Json -InputObject $records -Depth 4 -Compress
}

function Test-ReceiverInRoot([IntPtr]$receiver, [IntPtr]$root, [int]$processId) {
    return [OCUWin32]::BelongsToRoot($receiver, $root, [uint32]$processId)
}

function Test-CaptureRootMembership([IntPtr]$hwnd, [IntPtr]$root, [int]$processId) {
    return [OCUWin32]::BelongsToCaptureRoot($hwnd, $root, [uint32]$processId)
}

function Test-WindowVisible([IntPtr]$hwnd) { return [OCUWin32]::IsWindowVisible($hwnd) }

function Assert-ReceiverBelongsToTarget([IntPtr]$receiver, [switch]$CleanupOnly) {
    if ($null -ne $script:pointCaptureGroup -and -not $CleanupOnly) {
        $fresh = Read-OwnedCaptureGroup $script:targetWindow $script:targetProcessId
        if (-not [OCUWin32]::SameCaptureGroup(@($script:pointCaptureGroup.root) + @($script:pointCaptureGroup.popups), @($fresh.root) + @($fresh.popups))) {
            throw "The observed popup group changed before dispatch. No further action was sent."
        }
    }
    $root = if ($null -ne $script:pointCaptureGroup) { $script:pointReceiverRoot } else { $script:targetWindow }
    if (-not (Test-ReceiverInRoot $receiver $root $script:targetProcessId) -or
        -not (Test-CaptureRootMembership $root $script:targetWindow $script:targetProcessId) -or
        (-not $CleanupOnly -and (-not (Test-WindowVisible $root) -or -not (Test-WindowEnabled $root)))) {
        throw "The message receiver does not belong to the observed target window. No further action was sent."
    }
}

function Read-FocusState {
    $foreground = [OCUWin32]::ForegroundAppWindow()
    $foregroundProcessId = [uint32]0
    if ($foreground -eq [IntPtr]::Zero -or
        [OCUWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId) -eq 0 -or $foregroundProcessId -eq 0) {
        throw "Computer Use could not verify the foreground window. No further action was sent."
    }
    $lastInput = New-Object OCUWin32+LASTINPUTINFO
    $lastInput.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($lastInput)
    if (-not [OCUWin32]::GetLastInputInfo([ref]$lastInput)) {
        throw "Computer Use could not verify recent Windows input. No further action was sent."
    }
    $tick = [OCUWin32]::GetTickCount()
    [pscustomobject]@{ hwnd = $foreground; processId = $foregroundProcessId
        inputTick = $lastInput.dwTime; tick = $tick
        idleMilliseconds = [OCUWin32]::InputIdleMilliseconds($tick, $lastInput.dwTime) }
}

function Test-TargetForeground($focus, [int]$targetProcessId, [IntPtr]$targetWindow) {
    if ($focus.processId -ne $targetProcessId) { return $false }
    if ($focus.hwnd -eq $targetWindow) { return $true }
    return @($operation.related_window_ids).Contains($focus.hwnd.ToInt64()) -and
        (Test-CaptureRootMembership $focus.hwnd $targetWindow $targetProcessId)
}

function Assert-SafeBeforeAction($focus, [int]$targetProcessId, [IntPtr]$targetWindow) {
    if ((Test-TargetForeground $focus $targetProcessId $targetWindow) -and
        ($focus.idleMilliseconds -lt 5000 -or
         ($null -ne $script:focusBefore -and $focus.inputTick -ne $script:focusBefore.inputTick))) {
        Yield-UserInput "You are using the target window. Computer Use yielded; observe again before continuing."
    }
}

function Assert-DispatchSafe([IntPtr]$receiver) {
    Assert-OperationDeadline
    if (-not [string]::IsNullOrEmpty([string]$operation.expected_app_id)) {
        $currentProcess = Get-Process -Id $script:targetProcessId -ErrorAction SilentlyContinue
        Assert-ExpectedAppIdentity $currentProcess ([string]$operation.expected_app_id)
    }
    Assert-TargetWindow $script:targetWindow $script:targetProcessId
    if ($null -ne $script:expectedWindowBounds -and -not (Test-FrameClose (Get-WindowRectFrame $script:targetWindow) $script:expectedWindowBounds)) {
        throw "The target window moved or changed size before dispatch. No further action was sent."
    }
    Assert-ReceiverBelongsToTarget $receiver
    Assert-SafeBeforeAction (Read-FocusState) $script:targetProcessId $script:targetWindow
}

function Assert-SafeAfterAction($before, [int]$targetProcessId, [IntPtr]$targetWindow) {
    $after = Read-FocusState
    if ((Test-TargetForeground $after $targetProcessId $targetWindow) -and $after.inputTick -ne $before.inputTick) {
        Yield-UserInput "You used the target window during Computer Use. An action may have been sent; observe its result before continuing."
    }
    if ($after.hwnd -eq $before.hwnd -or $after.processId -ne $targetProcessId) { return }
    $script:focusChangedByApp = $true
    # Undo a provider's foreground side effect only if every identity/input
    # check still matches. Never activate the target as an input fallback.
    if ($after.inputTick -ne $before.inputTick -or -not [OCUWin32]::IsWindow($before.hwnd)) { return }
    $previousPID = [uint32]0
    if ([OCUWin32]::GetWindowThreadProcessId($before.hwnd, [ref]$previousPID) -eq 0 -or
        $previousPID -ne $before.processId) { return }
    $check = Read-FocusState
    if ($check.hwnd -ne $after.hwnd -or $check.processId -ne $targetProcessId -or $check.inputTick -ne $before.inputTick) { return }
    $previousPID = [uint32]0
    if (-not [OCUWin32]::IsWindow($before.hwnd) -or
        [OCUWin32]::GetWindowThreadProcessId($before.hwnd, [ref]$previousPID) -eq 0 -or $previousPID -ne $before.processId) { return }
    Assert-OperationDeadline
    if ([OCUWin32]::SetForegroundWindow([OCUWin32]::ActivationWindow($before.hwnd))) { $script:focusChangedByApp = $false }
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

function ConvertTo-LParam([int]$x, [int]$y) { [OCUWin32]::PointLParam($x, $y) }
function ConvertTo-WheelWParam([int]$delta) { [OCUWin32]::WheelWParam($delta) }

function Assert-NotBlockedByUipi([int]$errorCode) {
    if ($errorCode -eq 5) {
        throw [System.UnauthorizedAccessException]::new(
            "Windows blocked the target window message (UIPI). Memmy does not bypass elevation or UAC."
        )
    }
}

function Send-NativeWindowMessage([IntPtr]$hwnd, [UInt32]$message, [IntPtr]$wParam, [IntPtr]$lParam) {
    [OCUWin32]::SetLastError(0)
    $sent = [OCUWin32]::PostMessage($hwnd, $message, $wParam, $lParam)
    $errorCode = if ($sent) { 0 } else { [Runtime.InteropServices.Marshal]::GetLastWin32Error() }
    [pscustomobject]@{ sent = $sent; errorCode = $errorCode }
}

function Get-PairedReleaseKey([IntPtr]$hwnd, [UInt32]$message, [IntPtr]$wParam) {
    $up = switch ($message) {
        { $_ -eq 0x0201 -or $_ -eq 0x0203 -or $_ -eq 0x0202 } { 0x0202; break }
        { $_ -eq 0x0204 -or $_ -eq 0x0206 -or $_ -eq 0x0205 } { 0x0205; break }
        { $_ -eq 0x0207 -or $_ -eq 0x0209 -or $_ -eq 0x0208 } { 0x0208; break }
        { $_ -eq 0x0100 -or $_ -eq 0x0101 } { 0x0101; break }
        default { return $null }
    }
    $key = if ($up -eq 0x0101) { $wParam.ToInt64() } else { 0L }
    return "$($hwnd.ToInt64())|$up|$key"
}

function Post-WindowMessage([IntPtr]$hwnd, [UInt32]$message, [IntPtr]$wParam, [IntPtr]$lParam, [switch]$ReleaseOnly) {
    $releaseKey = Get-PairedReleaseKey $hwnd $message $wParam
    $isUp = @(0x0101, 0x0202, 0x0205, 0x0208).Contains([int]$message)
    if ($ReleaseOnly) {
        $pending = if ($null -ne $releaseKey) { $script:pendingReleases[$releaseKey] } else { $null }
        if (-not $isUp -or $null -eq $pending -or $pending.root -ne $script:targetWindow -or
            $pending.processId -ne $script:targetProcessId) {
            throw "Cleanup may only release a matching press already queued to the original target."
        }
        Assert-OperationDeadline -CleanupOnly
        Assert-TargetWindow $script:targetWindow $script:targetProcessId
        Assert-ReceiverBelongsToTarget $hwnd -CleanupOnly
    } else {
        if ($message -ne 0x0200 -and -not $script:targetElementValidated -and $null -ne $operation.element) {
            # Revalidate the exact semantic target immediately before the first
            # pointer mutation, including element-to-coordinate fallbacks.
            [void](Find-Element $script:targetRoot $operation.element $script:expectedWindowBounds)
        }
        Assert-DispatchSafe $hwnd
    }
    Assert-OperationDeadline -CleanupOnly:$ReleaseOnly
    $delivery = Send-NativeWindowMessage $hwnd $message $wParam $lParam
    if ($delivery.sent) {
        $script:dispatched = $true
        if (-not $ReleaseOnly -and $message -ne 0x0200) { $script:targetElementValidated = $true }
        if ($null -ne $releaseKey) {
            if ($isUp) { $script:pendingReleases.Remove($releaseKey) }
            else { $script:pendingReleases[$releaseKey] = [pscustomobject]@{ root = $script:targetWindow; processId = $script:targetProcessId } }
        }
        return
    }
    Assert-NotBlockedByUipi $delivery.errorCode
    throw "Windows could not queue the target window message (Win32 error $($delivery.errorCode)). No activation fallback was attempted."
}

function Invoke-UIAMutation([scriptblock]$action, $liveElement = $null) {
    if ($null -ne $liveElement) {
        if (-not (Test-ElementInRoot $liveElement $script:targetRoot)) {
            throw "The UIA action target moved outside the observed root. No further action was sent."
        }
        if (-not $script:dispatched -and $null -ne $operation.element) {
            Assert-ElementRecordMatches (Get-ElementRecord $liveElement ([int]$operation.element.index) $script:expectedWindowBounds (Resolve-TextLimit $operation.text_limit)) $operation.element
        }
    }
    Assert-DispatchSafe $script:targetWindow
    # A provider exception/timeout cannot prove that it did not execute. Mark
    # before entering the provider and propagate errors; never try a second path.
    $script:dispatched = $true
    & $action
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
        if ($rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { return $null }
        if ($null -ne $windowBounds) {
            return New-Frame ($rect.X - $windowBounds.x) ($rect.Y - $windowBounds.y) $rect.Width $rect.Height
        }
        return New-Frame $rect.X $rect.Y $rect.Width $rect.Height
    } catch { return $null }
}

function Get-ScreenPoint($localFrame, $windowBounds) {
    if ($null -eq $localFrame -or $null -eq $windowBounds) { return $null }
    [pscustomobject]@{ x = [int][math]::Round($windowBounds.x + $localFrame.x + ($localFrame.width / 2))
        y = [int][math]::Round($windowBounds.y + $localFrame.y + ($localFrame.height / 2)) }
}

function Test-FrameClose($live, $expected) {
    if ($null -eq $live -or $null -eq $expected) { return $false }
    return ([math]::Abs($live.x - $expected.x) -le 0 -and [math]::Abs($live.y - $expected.y) -le 0 -and
        [math]::Abs($live.width - $expected.width) -le 0 -and [math]::Abs($live.height - $expected.height) -le 0)
}

function Get-AvailableWindows([int]$processId) {
    $foreground = [OCUWin32]::ForegroundAppWindow()
    @([OCUWin32]::WindowsForProcess([uint32]$processId) | ForEach-Object {
        [pscustomobject]@{ windowID = $_.ToInt64(); title = [OCUWin32]::WindowTitle($_); isFocused = ($_ -eq $foreground) }
    })
}

function Set-TargetUnavailable([long]$windowID, [int]$processId) {
    $script:targetWindowUnavailable = $true
    $script:requestedWindowID = $windowID
    $script:requestedPID = $processId
    $script:availableWindows = @(Get-AvailableWindows $processId)
    throw "The observed target window is unavailable. Choose an available window with get_app_state; no action was retargeted."
}

function Assert-TargetWindow([IntPtr]$hwnd, [int]$processId) {
    $ownerPID = [uint32]0
    if ($hwnd -eq [IntPtr]::Zero -or -not [OCUWin32]::IsWindow($hwnd) -or
        [OCUWin32]::GetWindowThreadProcessId($hwnd, [ref]$ownerPID) -eq 0 -or
        $ownerPID -ne [uint32]$processId -or -not [OCUWin32]::IsTargetRootWindow($hwnd)) {
        Set-TargetUnavailable $hwnd.ToInt64() $processId
    }
}

function Resolve-TargetWindow($process, $windowID, $expectedBounds = $null, [switch]$AllowDisabled) {
    if ($null -ne $windowID -and [long]$windowID -gt 0) {
        $hwnd = [IntPtr]([long]$windowID)
    } else {
        $foreground = [OCUWin32]::ForegroundAppWindow()
        $ownerPID = [uint32]0
        [void][OCUWin32]::GetWindowThreadProcessId($foreground, [ref]$ownerPID)
        if ($ownerPID -eq [uint32]$process.Id -and [OCUWin32]::IsTargetRootWindow($foreground) -and
            [OCUWin32]::IsAppWindow([OCUWin32]::ActivationWindow($foreground))) {
            $hwnd = $foreground
        } else { $hwnd = Get-AppWindow $process }
    }
    Assert-TargetWindow $hwnd $process.Id
    $script:requestedWindowID = $hwnd.ToInt64()
    $script:requestedPID = [int]$process.Id
    if ([OCUWin32]::IsIconic([OCUWin32]::ActivationWindow($hwnd)) -or -not [OCUWin32]::IsWindowVisible($hwnd) -or
        [OCUWin32]::IsSuspendedAppWindow($hwnd)) {
        Set-TargetUnavailable $hwnd.ToInt64() $process.Id
    }
    if (-not $AllowDisabled -and -not [OCUWin32]::IsWindowEnabled($hwnd)) { throw "The target window is disabled, possibly by a modal dialog. Observe that dialog's window_id before continuing." }
    if ($null -ne $expectedBounds -and -not (Test-FrameClose (Get-WindowRectFrame $hwnd) $expectedBounds)) {
        throw "The target window moved or changed size. Run get_app_state again."
    }
    return $hwnd
}

function Resolve-ActionWindow($process, $expectedBounds, $windowID) {
    if ($null -eq $windowID -or [long]$windowID -le 0) { throw "Mutation requires the previously observed window_id. No action was sent." }
    $ownedPointInput = @("click", "scroll", "drag").Contains([string]$operation.tool) -and $null -eq $operation.element
    Resolve-TargetWindow $process $windowID $expectedBounds -AllowDisabled:$ownedPointInput
}

function Get-RootElement($process, [IntPtr]$hwnd) {
    Assert-TargetWindow $hwnd $process.Id
    $root = [Windows.Automation.AutomationElement]::FromHandle($hwnd)
    if ($null -eq $root -or $root.Current.ProcessId -ne $process.Id -or -not [OCUWin32]::MatchesUIAHandle($hwnd, $root.Current.NativeWindowHandle)) {
        throw "UI Automation could not resolve the exact HWND/PID target root. No action was sent."
    }
    return $root
}

function Test-WindowEnabled([IntPtr]$hwnd) { return [OCUWin32]::IsWindowEnabled($hwnd) }

function Resolve-PointCaptureRoot([IntPtr]$root, [int]$screenX, [int]$screenY) {
    $group = Read-OwnedCaptureGroup $root $script:targetProcessId
    if ([string]::IsNullOrEmpty($operation.observed_capture_group_proof) -or
        (Get-CaptureGroupProof $group.root $group.popups) -cne $operation.observed_capture_group_proof) {
        throw "The captured popup identity, ownership or geometry changed before input. No action was sent."
    }
    $expected = @($operation.related_window_ids | Where-Object { $null -ne $_ })
    $actual = @($group.popups | ForEach-Object { $_.ID })
    if ($expected.Count -ne $actual.Count -or (@($expected | Where-Object { -not $actual.Contains([long]$_) })).Count -gt 0) {
        throw "The owned popup scope differs from the observed screenshot. No action was sent."
    }
    $current = [IntPtr][OCUWin32]::PointCaptureWindow($group.popups, $root.ToInt64(), $screenX, $screenY)
    if (-not (Test-WindowEnabled $current)) {
        throw "The requested point belongs to a disabled window. Observe the enabled owned popup before continuing."
    }
    $receiverRoot = $current
    $script:pointCaptureGroup = $group
    $script:pointReceiverRoot = $receiverRoot
    return $receiverRoot
}

function Resolve-PointReceiver([IntPtr]$root, [int]$screenX, [int]$screenY) {
    $receiverRoot = Resolve-PointCaptureRoot $root $screenX $screenY
    $current = $receiverRoot
    for ($depth = 0; $depth -lt 64; $depth++) {
        $point = New-Object OCUWin32+POINT
        $point.X = $screenX; $point.Y = $screenY
        if (-not [OCUWin32]::ScreenToClient($current, [ref]$point)) { throw "The target's client coordinates are unavailable." }
        $client = New-Object OCUWin32+RECT
        if (-not [OCUWin32]::GetClientRect($current, [ref]$client) -or
            $point.X -lt $client.Left -or $point.X -ge $client.Right -or $point.Y -lt $client.Top -or $point.Y -ge $client.Bottom) {
            throw "The requested point is outside the target client area. Use a UIA element for non-client controls."
        }
        $child = [OCUWin32]::ChildWindowFromPointEx($current, $point, 7)
        if ($child -eq [IntPtr]::Zero) { throw "Windows could not resolve a target-owned point receiver." }
        if ($child -eq $current) {
            [void](ConvertTo-LParam $point.X $point.Y)
            return [pscustomobject]@{ hwnd = $current; x = $point.X; y = $point.Y }
        }
        if (-not [OCUWin32]::BelongsToRoot($child, $receiverRoot, [uint32]$script:targetProcessId)) {
            throw "The point receiver belongs to a different HWND/PID root. No action was sent."
        }
        $current = $child
    }
    throw "The target's child window depth exceeded the safety limit."
}

function Point-InReceiver([IntPtr]$receiver, [int]$screenX, [int]$screenY) {
    $point = New-Object OCUWin32+POINT
    $point.X = $screenX; $point.Y = $screenY
    if (-not [OCUWin32]::ScreenToClient($receiver, [ref]$point)) { throw "The target's client coordinates are unavailable." }
    ConvertTo-LParam $point.X $point.Y
}

function Send-MouseClick([IntPtr]$hwnd, [int]$screenX, [int]$screenY, [string]$button, [int]$count) {
    $receiver = Resolve-PointReceiver $hwnd $screenX $screenY
    $down = 0x0201; $up = 0x0202; $double = 0x0203; $held = 1
    switch ($button) {
        "right" { $down = 0x0204; $up = 0x0205; $double = 0x0206; $held = 2 }
        "middle" { $down = 0x0207; $up = 0x0208; $double = 0x0209; $held = 16 }
        "left" {}
        default { throw "Unsupported mouse button '$button'." }
    }
    if ($count -lt 1 -or $count -gt 2) { throw "Background click supports click_count 1 or 2." }
    $position = ConvertTo-LParam $receiver.x $receiver.y
    # Resolve the complete sequence before the first message. A double-click's
    # second press is WM_*BUTTONDBLCLK rather than a second independently retried tool.
    $buttonDown = $false
    try {
        Post-WindowMessage $receiver.hwnd $WM_MOUSEMOVE ([IntPtr]::Zero) $position
        for ($index = 0; $index -lt $count; $index++) {
            $press = if ($index -eq 0) { $down } else { $double }
            Post-WindowMessage $receiver.hwnd $press ([IntPtr]$held) $position
            $buttonDown = $true
            Post-WindowMessage $receiver.hwnd $up ([IntPtr]::Zero) $position
            $buttonDown = $false
        }
    } finally {
        if ($buttonDown) { try { Post-WindowMessage $receiver.hwnd $up ([IntPtr]::Zero) $position -ReleaseOnly } catch {} }
    }
}

# Native boundaries of explicit foreground input. They are separate so the
# safety tests can drive a simulated desktop and confine real input here.
function Read-ForegroundClickState {
    $foreground = [OCUWin32]::ForegroundAppWindow()
    $foregroundProcessId = [uint32]0
    if ($foreground -ne [IntPtr]::Zero) { [void][OCUWin32]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId) }
    $lastInput = New-Object OCUWin32+LASTINPUTINFO
    $lastInput.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($lastInput)
    if (-not [OCUWin32]::GetLastInputInfo([ref]$lastInput)) {
        throw "Computer Use could not verify recent Windows input. Nothing was sent."
    }
    $tick = [OCUWin32]::GetTickCount()
    [pscustomobject]@{ hwnd = $foreground; processId = [int]$foregroundProcessId; inputTick = $lastInput.dwTime
        idleMilliseconds = [OCUWin32]::InputIdleMilliseconds($tick, $lastInput.dwTime) }
}
function Test-ForegroundInputHeld { [OCUForegroundInput]::InputHeld() }
function Test-ForegroundButtonHeld { [OCUForegroundInput]::ButtonHeld() }
function Test-ForegroundOwner([IntPtr]$hwnd, [int]$processId) {
    $ownerPID = [uint32]0
    return [OCUWin32]::IsWindow($hwnd) -and [OCUWin32]::GetWindowThreadProcessId($hwnd, [ref]$ownerPID) -ne 0 -and $ownerPID -eq [uint32]$processId
}
function Read-PointerPosition { [OCUForegroundInput]::CursorPosition() }
function Restore-PointerPosition([int]$x, [int]$y) { [void][OCUForegroundInput]::MoveCursor($x, $y) }
function Get-TopWindowAtPoint([int]$x, [int]$y) { [OCUForegroundInput]::WindowAt($x, $y) }
function Send-ForegroundClaim { [OCUForegroundInput]::ClaimForeground() }
function Send-RealPointerClick([int]$x, [int]$y, [string]$button, [int]$count) { [OCUForegroundInput]::Click($x, $y, $button, $count) }
function Send-RealText([string]$text) { [OCUForegroundInput]::TypeText($text) }
function Send-RealKeys([uint16[]]$modifiers, [uint16]$key, [bool]$extended) { [OCUForegroundInput]::PressKeys($modifiers, $key, $extended) }
function Set-ForegroundWindowTo([IntPtr]$hwnd) { [void][OCUWin32]::SetForegroundWindow([OCUWin32]::ActivationWindow($hwnd)) }
# Real keys go to the foreground thread's focus, which must be inside the target.
function Test-ForegroundKeyboardFocus([IntPtr]$hwnd) {
    $ownerPID = [uint32]0
    $thread = [OCUWin32]::GetWindowThreadProcessId($hwnd, [ref]$ownerPID)
    $info = New-Object OCUWin32+GUITHREADINFO
    $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
    return $thread -ne 0 -and $ownerPID -eq [uint32]$script:targetProcessId -and
        [OCUWin32]::GetGUIThreadInfo($thread, [ref]$info) -and $info.hwndFocus -ne [IntPtr]::Zero -and
        [OCUWin32]::BelongsToRoot($info.hwndFocus, $hwnd, [uint32]$script:targetProcessId)
}
function Wait-ForegroundClickStep([int]$milliseconds) { Start-Sleep -Milliseconds $milliseconds }

# Injected input reaches GetLastInputInfo asynchronously, as it does the
# foreground-rights check. Let this helper's own event settle before its tick
# becomes the baseline for detecting the user's input.
function Wait-OwnInputSettled($before) {
    for ($waited = 0; $waited -lt 100; $waited += 10) {
        $state = Read-ForegroundClickState
        if ($state.inputTick -ne $before.inputTick) { return $state }
        Wait-ForegroundClickStep 10
    }
    return Read-ForegroundClickState
}

# Taking the foreground in the middle of a burst of typing would split it
# between two windows, so wait for a pause with no button or modifier held.
function Wait-ForegroundClickPause {
    $pauseMilliseconds = 1000
    $deadline = (Get-EpochMilliseconds) + 4000
    while ($true) {
        Assert-OperationDeadline
        $state = Read-ForegroundClickState
        if ($state.idleMilliseconds -ge $pauseMilliseconds -and -not (Test-ForegroundInputHeld)) { return $state }
        $remaining = $deadline - (Get-EpochMilliseconds)
        if ($remaining -le 0) {
            Yield-UserInput "You are using the keyboard or mouse, so Computer Use did not bring the target window to the front. Nothing was sent."
        }
        Wait-ForegroundClickStep ([int][math]::Max(20, [math]::Min([math]::Min(250, $remaining), $pauseMilliseconds - $state.idleMilliseconds)))
    }
}

function Get-ForegroundClickReadiness($session) {
    $state = Read-ForegroundClickState
    if ($state.inputTick -ne $session.inputTick) { return "userInput" }
    if (-not (Test-FrameClose (Get-WindowRectFrame $script:targetWindow) $script:expectedWindowBounds)) { return "windowChanged" }
    if ($state.hwnd -eq $script:targetWindow) { return "ready" }
    if ($state.hwnd -eq [IntPtr]::Zero -or $state.hwnd -eq $session.previous.hwnd) { return "waiting" }
    return "foregroundTaken"
}

function Assert-ForegroundClickReady([string]$readiness) {
    switch ($readiness) {
        "ready" { return }
        "windowChanged" { throw "The target window moved or closed when it was brought to the front. Nothing was sent. Run get_app_state again." }
        "waiting" { throw "The target window could not be made the foreground window. Nothing was sent. Run get_app_state before another action." }
        default { Yield-UserInput "You used the keyboard or mouse, or another window came to the front, so Computer Use sent nothing. Observe the target again before continuing." }
    }
}

# Typing or moving the pointer does not choose the target, so the user's window
# comes back. A held button, or another app now in front, is their choice.
function Get-ForegroundClickReturn($session) {
    $state = Read-ForegroundClickState
    if ($state.hwnd -eq $session.previous.hwnd) { return "alreadyReturned" }
    if ($state.hwnd -eq [IntPtr]::Zero) { return "waiting" }
    if ($state.processId -ne $script:targetProcessId -or (Test-ForegroundButtonHeld)) { return "leaveForUser" }
    if (-not (Test-ForegroundOwner $session.previous.hwnd $session.previous.processId)) { return "previousGone" }
    return "restore"
}

# Lets the target handle the click while it is in front, returns the pointer if
# the user has not touched it, then hands the foreground back. A click that
# opens a window can bring the target forward again, so a sent click is watched
# for the whole return window and handed back at most twice.
function Complete-ForegroundClick($session) {
    if ($session.clickSent) {
        # Keys still being delivered would reach the user's window after the hand-back.
        Wait-ForegroundClickStep 200
        if ($null -ne $session.pointer -and (Read-ForegroundClickState).inputTick -eq $session.inputTick -and
            -not (Test-ForegroundButtonHeld)) {
            Restore-PointerPosition $session.pointer[0] $session.pointer[1]
        }
    }
    if (-not $session.activated) { return "notNeeded" }
    $deadline = (Get-EpochMilliseconds) + 500
    $attempts = 0
    $lastAttempt = $null
    while ($true) {
        $decision = Get-ForegroundClickReturn $session
        if ($decision -eq "leaveForUser") { return "keptForUser" }
        if ($decision -eq "previousGone") { return "notReturned" }
        $now = Get-EpochMilliseconds
        if ($decision -eq "alreadyReturned" -and (-not $session.clickSent -or $now -ge $deadline)) { return "returned" }
        if ($now -ge $deadline) { return "notReturned" }
        if ($decision -eq "restore" -and $attempts -lt 2 -and ($null -eq $lastAttempt -or $now - $lastAttempt -ge 250)) {
            # The user's own input since the click revokes the right to set the foreground.
            $beforeClaim = Read-ForegroundClickState
            [void](Send-ForegroundClaim)
            [void](Wait-OwnInputSettled $beforeClaim)
            Set-ForegroundWindowTo $session.previous.hwnd
            $attempts++
            $lastAttempt = $now
        }
        Wait-ForegroundClickStep 30
    }
}

# Waits for the user's pause, unless the target is already in front, and starts
# a session that hands the foreground back when it completes.
function Start-ForegroundSession([IntPtr]$hwnd) {
    $start = Read-ForegroundClickState
    $alreadyActive = $start.hwnd -eq $hwnd
    if ($alreadyActive) {
        if (Test-ForegroundInputHeld) { Yield-UserInput "A mouse button or modifier key is held, so Computer Use sent nothing. Observe the target again before continuing." }
    } else {
        $start = Wait-ForegroundClickPause
    }
    [pscustomobject]@{ previous = $start; pointer = $null; inputTick = $start.inputTick
        alreadyActive = $alreadyActive; activated = $false; clickSent = $false }
}

function Enter-ForegroundSession($session, [IntPtr]$hwnd) {
    if (-not $session.alreadyActive) {
        Assert-OperationDeadline
        $beforeClaim = Read-ForegroundClickState
        if (-not (Send-ForegroundClaim)) { throw "Windows did not accept input from Computer Use. Nothing was sent." }
        $session.inputTick = (Wait-OwnInputSettled $beforeClaim).inputTick
        $session.activated = $true
        Set-ForegroundWindowTo $hwnd
        $deadline = (Get-EpochMilliseconds) + 800
        $readiness = Get-ForegroundClickReadiness $session
        while ($readiness -eq "waiting" -and (Get-EpochMilliseconds) -lt $deadline) {
            Wait-ForegroundClickStep 30
            $readiness = Get-ForegroundClickReadiness $session
        }
        Assert-ForegroundClickReady $readiness
    }
    Assert-ForegroundClickReady (Get-ForegroundClickReadiness $session)
}

# Window messages never reach controls that accept only system input, such as
# Chromium pages. This click briefly makes the observed window the foreground
# window, clicks with real input, then returns the pointer and the foreground.
function Send-ForegroundClick([IntPtr]$hwnd, [int]$screenX, [int]$screenY, [string]$button, [int]$count) {
    if ($count -lt 1 -or $count -gt 2) { throw "Foreground click supports click_count 1 or 2." }
    if (-not @("left", "right", "middle").Contains($button)) { throw "Unsupported mouse button '$button'." }
    [void](Resolve-PointReceiver $hwnd $screenX $screenY)
    $session = Start-ForegroundSession $hwnd
    if ($null -ne $operation.element) { [void](Find-Element $script:targetRoot $operation.element $script:expectedWindowBounds) }
    $session.pointer = Read-PointerPosition
    if ($null -eq $session.pointer) { throw "Computer Use could not read the pointer position. No click was sent." }
    try {
        Enter-ForegroundSession $session $hwnd
        $hit = Get-TopWindowAtPoint $screenX $screenY
        if ($hit -eq [IntPtr]::Zero -or -not (Test-ReceiverInRoot $hit $script:pointReceiverRoot $script:targetProcessId)) {
            throw "Another window covers the click point. No click was sent. Observe the target again before continuing."
        }
        if (Test-ForegroundInputHeld) { Yield-UserInput "A mouse button or modifier key is held, so Computer Use did not click. Observe the target again before continuing." }
        Assert-OperationDeadline
        # A rejected or partial injection cannot prove the app saw nothing.
        $script:dispatched = $true
        $session.clickSent = $true
        $beforeClick = Read-ForegroundClickState
        $sent = Send-RealPointerClick $screenX $screenY $button $count
        $session.inputTick = (Wait-OwnInputSettled $beforeClick).inputTick
        if (-not $sent) { throw "Windows did not accept the whole click input." }
    } finally {
        try { $script:foregroundClick = Complete-ForegroundClick $session } catch { $script:foregroundClick = "notReturned" }
    }
}

function Get-ForegroundKeyChord([string]$key) {
    $modifierKeys = @{ "ctrl" = 0x11; "control" = 0x11; "shift" = 0x10; "alt" = 0x12; "option" = 0x12
        "win" = 0x5B; "super" = 0x5B; "cmd" = 0x5B; "meta" = 0x5B }
    $parts = @($key.Split("+") | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($parts.Count -eq 0) { throw "Unsupported key: $key" }
    $modifiers = New-Object 'Collections.Generic.List[uint16]'
    for ($index = 0; $index -lt $parts.Count - 1; $index++) {
        $code = $modifierKeys[$parts[$index].ToLowerInvariant()]
        if ($null -eq $code) { throw "Unsupported modifier '$($parts[$index])' in key: $key" }
        $modifiers.Add([uint16]$code)
    }
    $vk = [uint16](Get-VirtualKey $parts[-1])
    [pscustomobject]@{ modifiers = $modifiers.ToArray(); key = $vk
        extended = @(0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E).Contains([int]$vk) }
}

# Window messages carry text only into native edit controls and carry no
# modifier state. This briefly makes the observed window the foreground window,
# types or presses with real input into its own focus, then returns the
# foreground; the pointer does not move.
function Send-ForegroundKeyboard([IntPtr]$hwnd, [string]$text, [string]$key) {
    $chord = if ($key) { Get-ForegroundKeyChord $key } else { $null }
    $session = Start-ForegroundSession $hwnd
    try {
        Enter-ForegroundSession $session $hwnd
        if (-not (Test-ForegroundKeyboardFocus $hwnd)) {
            throw "The target window has no keyboard focus inside it. Nothing was sent. Click the intended field first."
        }
        if (Test-ForegroundInputHeld) { Yield-UserInput "A mouse button or modifier key is held, so Computer Use sent nothing. Observe the target again before continuing." }
        Assert-OperationDeadline
        $script:dispatched = $true
        $session.clickSent = $true
        $beforeInput = Read-ForegroundClickState
        $sent = if ($null -ne $chord) { Send-RealKeys $chord.modifiers $chord.key $chord.extended } else { Send-RealText $text }
        $session.inputTick = (Wait-OwnInputSettled $beforeInput).inputTick
        if (-not $sent) { throw "Windows did not accept the whole keyboard input." }
    } finally {
        try { $script:foregroundClick = Complete-ForegroundClick $session } catch { $script:foregroundClick = "notReturned" }
    }
}

function Send-Drag([IntPtr]$hwnd, [int]$fromX, [int]$fromY, [int]$toX, [int]$toY) {
    $receiver = Resolve-PointReceiver $hwnd $fromX $fromY
    $startRoot = $script:pointReceiverRoot
    $startGroup = $script:pointCaptureGroup
    [void](Resolve-PointReceiver $hwnd $toX $toY)
    if ($script:pointReceiverRoot -ne $startRoot) { throw "A drag cannot cross between the target document and an owned popup. No action was sent." }
    $script:pointReceiverRoot = $startRoot
    $script:pointCaptureGroup = $startGroup
    $positions = @()
    for ($step = 0; $step -le 12; $step++) {
        $x = [int][math]::Round($fromX + (($toX - $fromX) * $step / 12))
        $y = [int][math]::Round($fromY + (($toY - $fromY) * $step / 12))
        $positions += Point-InReceiver $receiver.hwnd $x $y
    }
    $buttonDown = $false
    try {
        Post-WindowMessage $receiver.hwnd $WM_MOUSEMOVE ([IntPtr]::Zero) $positions[0]
        Post-WindowMessage $receiver.hwnd $WM_LBUTTONDOWN ([IntPtr]1) $positions[0]
        $buttonDown = $true
        for ($step = 1; $step -lt $positions.Count; $step++) {
            Post-WindowMessage $receiver.hwnd $WM_MOUSEMOVE ([IntPtr]1) $positions[$step]
            Start-Sleep -Milliseconds 10
        }
        Post-WindowMessage $receiver.hwnd $WM_LBUTTONUP ([IntPtr]::Zero) $positions[-1]
        $buttonDown = $false
    } finally {
        if ($buttonDown) { try { Post-WindowMessage $receiver.hwnd $WM_LBUTTONUP ([IntPtr]::Zero) $positions[-1] -ReleaseOnly } catch {} }
    }
}

function Send-Scroll([IntPtr]$hwnd, [int]$screenX, [int]$screenY, [string]$direction, [double]$pages) {
    if (-not @("up", "down", "left", "right").Contains($direction) -or
        [double]::IsNaN($pages) -or [double]::IsInfinity($pages) -or $pages -le 0 -or $pages -gt 100) {
        throw "Invalid background scroll direction or pages."
    }
    $receiver = Resolve-PointReceiver $hwnd $screenX $screenY
    $delta = [int][math]::Round(120 * $pages)
    if ($direction -eq "down" -or $direction -eq "left") { $delta = -$delta }
    $message = if ($direction -eq "left" -or $direction -eq "right") { $WM_MOUSEHWHEEL } else { $WM_MOUSEWHEEL }
    # Wheel coordinates are screen coordinates; button/move coordinates are
    # client coordinates. Posting a second message to the parent would duplicate it.
    $position = ConvertTo-LParam $screenX $screenY
    Post-WindowMessage $receiver.hwnd $message (ConvertTo-WheelWParam $delta) $position
}

function Read-KeyboardObservation([IntPtr]$root, [int]$processId, $rootElement) {
    $empty = [pscustomobject]@{ receiverID = 0L; runtimeID = @(); state = ""; element = $null }
    try {
        $ownerPID = [uint32]0
        $thread = [OCUWin32]::GetWindowThreadProcessId($root, [ref]$ownerPID)
        $info = New-Object OCUWin32+GUITHREADINFO
        $info.cbSize = [Runtime.InteropServices.Marshal]::SizeOf($info)
        if ($thread -eq 0 -or $ownerPID -ne [uint32]$processId -or
            -not [OCUWin32]::GetGUIThreadInfo($thread, [ref]$info) -or $info.hwndFocus -eq $root -or
            -not [OCUWin32]::BelongsToRoot($info.hwndFocus, $root, [uint32]$processId)) { return $empty }
        $focused = [Windows.Automation.AutomationElement]::FromHandle($info.hwndFocus)
        if ($null -eq $focused -or $focused.Current.ProcessId -ne $processId -or
            -not [OCUWin32]::MatchesUIAHandle($info.hwndFocus, $focused.Current.NativeWindowHandle) -or
            -not (Test-ElementInRoot $focused $rootElement)) { return $empty }
        $runtimeID = @($focused.GetRuntimeId())
        if ($runtimeID.Count -eq 0) { return $empty }
        $className = [OCUWin32]::WindowClass($info.hwndFocus)
        $controlType = $focused.Current.ControlType.ProgrammaticName
        $selection = $null
        if ($className -match "^(Edit|RichEdit.*)$" -and $controlType -match "\.(Edit|Document)$") {
            $selection = [OCUWin32]::ReadEditSelection($info.hwndFocus)
        } elseif ($className -notmatch "^(Button|ComboBox|ListBox|SysListView32|SysTreeView32|SysTabControl32)$" -or
                  $controlType -notmatch "\.(Button|CheckBox|RadioButton|ComboBox|List|Tree|Tab)$") {
            # A render-host HWND can contain many windowless logical fields.
            # Its thread focus is not proof of a particular caret/receiver.
            return $empty
        }
        $valueDigest = $null
        $valuePattern = Get-CurrentPatternOrNull $focused ([Windows.Automation.ValuePattern]::Pattern)
        if ($null -ne $valuePattern) {
            $hash = [Security.Cryptography.SHA256]::Create()
            try { $valueDigest = [Convert]::ToBase64String($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$valuePattern.Current.Value))) }
            finally { $hash.Dispose() }
        }
        $context = Get-ElementContextProof $focused -ForKeyboard
        $state = [ordered]@{ className = $className; controlType = $controlType
            selection = $selection; valueDigest = $valueDigest
            contextProof = $context.proof; hasDocumentContext = $context.hasDocumentContext } | ConvertTo-Json -Depth 4 -Compress
        [pscustomobject]@{ receiverID = $info.hwndFocus.ToInt64(); runtimeID = $runtimeID
            state = $state; element = $focused }
    } catch { return $empty }
}

function Assert-KeyboardObservationMatches($live) {
    # Input goes to the exact receiver that was focused when it was observed.
    # Its text, caret and surrounding document change as the user and the app
    # work; those changes do not redirect the input.
    if ([long]$operation.observed_keyboard_receiver_id -le 0 -or [long]$live.receiverID -le 0 -or
        [long]$live.receiverID -ne [long]$operation.observed_keyboard_receiver_id -or
        @($live.runtimeID).Count -eq 0 -or
        -not (Same-RuntimeId @($live.runtimeID) @($operation.observed_keyboard_receiver_runtime_id))) {
        throw "The target's observed keyboard receiver is unavailable or changed. No further key/text input was sent; run get_app_state or use an exact UIA element."
    }
}

function Get-KeyboardReceiver([IntPtr]$root) {
    Assert-OperationDeadline
    $observation = Read-KeyboardObservation $root $script:targetProcessId $script:targetRoot
    Assert-KeyboardObservationMatches $observation
    return [IntPtr]([long]$observation.receiverID)
}

function Send-TextToEditHandle([IntPtr]$hwnd, [string]$text) {
    if ((Get-KeyboardReceiver $script:targetWindow) -ne $hwnd) {
        throw "The edit receiver changed before text dispatch. No text was sent."
    }
    Assert-DispatchSafe $hwnd
    if (-not [OCUWin32]::IsWindowUnicode($hwnd)) {
        throw "This target uses an ANSI edit window; Unicode background text delivery is unsupported. No text was sent."
    }
    [OCUWin32]::SetLastError(0)
    $messageResult = [UIntPtr]::Zero
    # EM_REPLACESEL preserves the existing caret/selection. Do not send EM_SETSEL,
    # append a truncated UIA value, or retry via WM_SETTEXT after an uncertain send.
    $script:dispatched = $true
    $sent = [OCUWin32]::SendTextMessageTimeout($hwnd, $EM_REPLACESEL, [IntPtr]1, $text, 0x22, 1000, [ref]$messageResult)
    if ($sent -eq [IntPtr]::Zero) {
        $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        Assert-NotBlockedByUipi $code
        throw "The target edit message failed or timed out (Win32 error $code). Its result is uncertain; it was not retried. Observe again."
    }
}

function Get-VirtualKey([string]$key) {
    $normalized = $key.ToLowerInvariant()
    $map = @{
        "return" = 0x0D; "enter" = 0x0D; "tab" = 0x09; "escape" = 0x1B; "esc" = 0x1B
        "backspace" = 0x08; "back_space" = 0x08; "delete" = 0x2E; "space" = 0x20
        "left" = 0x25; "up" = 0x26; "right" = 0x27; "down" = 0x28
        "home" = 0x24; "end" = 0x23; "page_up" = 0x21; "prior" = 0x21; "page_down" = 0x22; "next" = 0x22
    }
    if ($map.ContainsKey($normalized)) { return $map[$normalized] }
    if ($normalized -match "^f([1-9]|1[0-2])$") { return 0x70 + [int]$Matches[1] - 1 }
    if ($normalized -match "^kp_([0-9])$") { return 0x60 + [int]$Matches[1] }
    if ($normalized.Length -eq 1) {
        $code = [int][char]$normalized.ToUpperInvariant()[0]
        if (($code -ge 0x30 -and $code -le 0x39) -or ($code -ge 0x41 -and $code -le 0x5A)) { return $code }
    }
    throw "Unsupported key: $key"
}

function Get-KeyMessageWords([IntPtr]$receiver, [uint32]$vk) {
    $owner = [uint32]0
    $thread = [OCUWin32]::GetWindowThreadProcessId($receiver, [ref]$owner)
    if ($thread -eq 0 -or $owner -ne [uint32]$script:targetProcessId) {
        throw "The keyboard receiver's thread is unavailable. No key was sent."
    }
    $scan = [OCUWin32]::MapVirtualKeyEx($vk, 0, [OCUWin32]::GetKeyboardLayout($thread))
    $extended = @(0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2D,0x2E).Contains([int]$vk)
    [pscustomobject]@{ down = [OCUWin32]::KeyLParam($scan, $extended, $false)
        up = [OCUWin32]::KeyLParam($scan, $extended, $true) }
}

function Send-Key([IntPtr]$hwnd, [string]$key) {
    if ($key.Contains("+")) {
        throw "Background modifier shortcuts are unsupported: window messages do not establish GetKeyState/GetAsyncKeyState. No key was sent. press_key with foreground=true sends it with real keyboard input; an exact UIA command also works in the background."
    }
    $vk = [uint32](Get-VirtualKey $key)
    $receiver = Get-KeyboardReceiver $hwnd
    $words = Get-KeyMessageWords $receiver $vk
    $keyDown = $false
    try {
        [void](Get-KeyboardReceiver $hwnd)
        Post-WindowMessage $receiver $WM_KEYDOWN ([IntPtr]$vk) $words.down
        $keyDown = $true
        [void](Get-KeyboardReceiver $hwnd)
        Post-WindowMessage $receiver $WM_KEYUP ([IntPtr]$vk) $words.up
        $keyDown = $false
    } finally {
        if ($keyDown) { try { Post-WindowMessage $receiver $WM_KEYUP ([IntPtr]$vk) $words.up -ReleaseOnly } catch {} }
    }
}

function Resolve-App([string]$query, [int]$expectedPID = 0) {
    if ($expectedPID -gt 0) {
        $exact = Get-Process -Id $expectedPID -ErrorAction SilentlyContinue
        if ($null -eq $exact) { Set-TargetUnavailable ([long]$operation.window_id) $expectedPID }
        Assert-ExpectedAppIdentity $exact ([string]$operation.expected_app_id)
        return $exact
    }
    $normalized = $query.Trim()
    $processQuery = $normalized
    if ($processQuery.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        $processQuery = $processQuery.Substring(0, $processQuery.Length - 4)
    }
    $processes = @(Get-WindowedProcesses)
    $pidValue = 0
    if ([int]::TryParse($normalized, [ref]$pidValue)) {
        $match = $processes | Where-Object { $_.Id -eq $pidValue } | Select-Object -First 1
        if ($null -ne $match) {
            Assert-ExpectedAppIdentity $match ([string]$operation.expected_app_id)
            return $match
        }
    }

    $matchedProcesses = @($processes | Where-Object {
        $_.ProcessName -ieq $processQuery -or
        "$($_.ProcessName).exe" -ieq $normalized
    })
    if ($matchedProcesses.Count -eq 0) {
        $installed = @(Get-InstalledApps)
        $matchedProcesses = @($processes | Where-Object {
            $identity = Get-RunningAppIdentity $_ $installed
            $null -ne $identity -and ($identity.appId -ieq $normalized -or $identity.displayName -ieq $normalized -or
                @($identity.aliases | Where-Object { $_ -ieq $normalized }).Count -gt 0)
        })
    }
    if ($matchedProcesses.Count -gt 1) { throw "The app selector matches multiple running processes. Select the exact process ID; no action was sent." }
    if ($matchedProcesses.Count -eq 1) {
        Assert-ExpectedAppIdentity $matchedProcesses[0] ([string]$operation.expected_app_id)
        return $matchedProcesses[0]
    }

    # No window to act on: open the Start menu entry as the user would. A
    # running app without a window shows it again when opened this way.
    $entries = @($installed | Where-Object { $_.appId -ieq $normalized -or $_.displayName -ieq $normalized -or $_.launchId -ieq $normalized })
    if ($entries.Count -eq 0) {
        $entries = @($installed | Where-Object { @(Get-InstalledAppAliases $_) -contains $normalized })
    }
    if (@($entries | ForEach-Object { $_.appId.ToLowerInvariant() } | Sort-Object -Unique).Count -gt 1) {
        throw "The app selector matches multiple installed apps. Use the exact app identifier; nothing was opened."
    }
    if ($entries.Count -gt 0) { return Open-InstalledApp $entries[0] }

    throw "appNotFound(`"$query`")"
}

function Get-WindowedProcesses {
    return @(Get-Process | Where-Object { (Get-AppWindow $_) -ne [IntPtr]::Zero -and (Test-DiscoverableProcess $_) })
}

function Open-InstalledApp($entry) {
    $expected = [string]$operation.expected_app_id
    if (-not (Test-AllowedAppId $entry.appId) -or (-not [string]::IsNullOrEmpty($expected) -and $entry.appId -ine $expected)) {
        throw "The installed app does not match the approved app identity. Nothing was opened."
    }
    Assert-OperationDeadline
    Start-InstalledApp $entry.launchId
    $deadline = [math]::Min((Get-EpochMilliseconds) + 15000, [long]$operation.deadline_epoch_ms - 3000)
    while ((Get-EpochMilliseconds) -lt $deadline) {
        Start-Sleep -Milliseconds 250
        $opened = @(Get-Process | Where-Object { (Test-DiscoverableProcess $_) -and (Get-ProcessNativeAppId $_) -ieq $entry.appId -and
            (Get-AppWindow $_) -ne [IntPtr]::Zero })
        if ($opened.Count -gt 0) {
            Assert-ExpectedAppIdentity $opened[0] $expected
            return $opened[0]
        }
    }
    throw "$($entry.displayName) was opened, but its window did not appear in time. Run get_app_state again."
}

function Start-InstalledApp([string]$launchId) {
    # This helper runs in a kill-on-close job. WMI starts the app outside it,
    # so the user's app keeps running after the helper exits.
    $commandLine = '"' + (Join-Path $env:SystemRoot "explorer.exe") + '" "shell:AppsFolder\' + $launchId + '"'
    $started = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $commandLine }
    if ($started.ReturnValue -ne 0) { throw "Windows could not open the app (code $($started.ReturnValue)). No action was sent." }
}

# Read-only: names the app get_app_state would act on, so it can be approved
# before anything is opened. A running process without a window counts only
# when its Start menu entry can show it again.
function Resolve-AppIdentity([string]$query) {
    $wanted = $query.Trim()
    $processQuery = $wanted
    if ($processQuery.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) {
        $processQuery = $processQuery.Substring(0, $processQuery.Length - 4)
    }
    $installed = @(Get-InstalledApps)
    $running = @(Get-Process | Where-Object { Test-DiscoverableProcess $_ })
    $ids = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($process in $running) {
        $appId = Get-ProcessNativeAppId $process
        if ($process.ProcessName -ine $processQuery -and [string]$process.Id -ne $wanted -and $appId -ine $wanted) { continue }
        if ((Get-AppWindow $process) -ne [IntPtr]::Zero -or @($installed | Where-Object { $_.appId -ieq $appId }).Count -gt 0) {
            [void]$ids.Add($appId)
        }
    }
    if ($ids.Count -eq 0) {
        foreach ($app in $installed) {
            if ($app.displayName -ieq $wanted -or $app.appId -ieq $wanted -or $app.launchId -ieq $wanted) { [void]$ids.Add($app.appId) }
        }
    }
    if ($ids.Count -eq 0) {
        foreach ($app in $installed) {
            if (@(Get-InstalledAppAliases $app) -contains $wanted) { [void]$ids.Add($app.appId) }
        }
    }
    if ($ids.Count -eq 0) { return [pscustomobject]@{ status = "not-found" } }
    if ($ids.Count -gt 1) { return [pscustomobject]@{ status = "ambiguous" } }
    $appId = @($ids)[0]
    if (-not (Test-AllowedAppId $appId)) { return [pscustomobject]@{ status = "blocked" } }
    $windowed = @($running | Where-Object { (Get-ProcessNativeAppId $_) -ieq $appId -and (Get-AppWindow $_) -ne [IntPtr]::Zero })
    if ($windowed.Count -gt 1) { return [pscustomobject]@{ status = "ambiguous" } }
    $names = @($installed | Where-Object { $_.appId -ieq $appId } | ForEach-Object { $_.displayName })
    $displayName = if ($names.Count -gt 0) { $names[0] } else { $appId }
    $resolved = [pscustomobject]@{ status = "resolved"; app = [pscustomobject]@{ appId = $appId; displayName = $displayName } }
    if ($windowed.Count -eq 1) { $resolved | Add-Member -NotePropertyName pid -NotePropertyValue ([int]$windowed[0].Id) }
    return $resolved
}

function Test-ElementInRoot($element, $root) {
    if ($null -eq $element -or $null -eq $root) { return $false }
    try {
        if ($element.Current.ProcessId -ne $root.Current.ProcessId) { return $false }
        $rootID = @($root.GetRuntimeId())
        if ($rootID.Count -eq 0) { return $false }
        $current = $element
        for ($depth = 0; $depth -lt 64 -and $null -ne $current; $depth++) {
            if (Same-RuntimeId @($current.GetRuntimeId()) $rootID) { return $true }
            $current = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)
        }
    } catch { return $false }
    return $false
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

function Get-StateDigest($state) {
    $hash = [Security.Cryptography.SHA256]::Create()
    try {
        $json = ConvertTo-Json -InputObject $state -Depth 12 -Compress
        return [Convert]::ToBase64String($hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))
    } finally { $hash.Dispose() }
}

function Get-ElementStateSignature($element) {
    try {
        # Hash complete provider state separately from the text-limited display.
        # Never expose untruncated names/values through an observation or log.
        $state = [ordered]@{ name = [string]$element.Current.Name; enabled = [bool]$element.Current.IsEnabled
            keyboardFocusable = [bool]$element.Current.IsKeyboardFocusable; patterns = [ordered]@{} }
        foreach ($pattern in @($element.GetSupportedPatterns() | Sort-Object ProgrammaticName)) {
            $name = [string]$pattern.ProgrammaticName
            if ($name -notin @("ValuePatternIdentifiers.Pattern", "RangeValuePatternIdentifiers.Pattern", "TogglePatternIdentifiers.Pattern",
                "SelectionItemPatternIdentifiers.Pattern", "SelectionPatternIdentifiers.Pattern", "ExpandCollapsePatternIdentifiers.Pattern", "TextPatternIdentifiers.Pattern")) { continue }
            $live = $element.GetCurrentPattern($pattern)
            switch ($name) {
                "ValuePatternIdentifiers.Pattern" { $state.patterns[$name] = [ordered]@{ value = [string]$live.Current.Value; readOnly = [bool]$live.Current.IsReadOnly } }
                "RangeValuePatternIdentifiers.Pattern" { $state.patterns[$name] = [ordered]@{ value = $live.Current.Value; readOnly = $live.Current.IsReadOnly
                    minimum = $live.Current.Minimum; maximum = $live.Current.Maximum; smallChange = $live.Current.SmallChange; largeChange = $live.Current.LargeChange } }
                "TogglePatternIdentifiers.Pattern" { $state.patterns[$name] = [string]$live.Current.ToggleState }
                "SelectionItemPatternIdentifiers.Pattern" {
                    $container = $live.Current.SelectionContainer
                    $state.patterns[$name] = [ordered]@{ selected = [bool]$live.Current.IsSelected
                        container = if ($null -ne $container) { @($container.GetRuntimeId()) } else { @() } }
                }
                "SelectionPatternIdentifiers.Pattern" {
                    $selected = @($live.GetCurrentSelection() | ForEach-Object {
                        $id = @($_.GetRuntimeId())
                        if ($id.Count -eq 0) { throw "Selected UIA item identity is unavailable." }
                        Get-StateDigest ([ordered]@{ runtimeID = $id; name = [string]$_.Current.Name })
                    } | Sort-Object)
                    $state.patterns[$name] = [ordered]@{ selected = $selected; multiple = $live.Current.CanSelectMultiple; required = $live.Current.IsSelectionRequired }
                }
                "ExpandCollapsePatternIdentifiers.Pattern" { $state.patterns[$name] = [string]$live.Current.ExpandCollapseState }
                "TextPatternIdentifiers.Pattern" {
                    $state.patterns[$name] = [ordered]@{ text = [string]$live.DocumentRange.GetText(-1)
                        selections = @($live.GetSelection() | ForEach-Object { [string]$_.GetText(-1) }) }
                }
            }
        }
        return Get-StateDigest $state
    } catch { return "" }
}

function Complete-ElementContextProof($chain, [bool]$HasDocumentContext, [switch]$ForKeyboard) {
    $records = @($chain.ToArray())
    if (-not $ForKeyboard -and $null -ne $script:renderContextChains) {
        # Reuse ancestor identities during one rendered snapshot. No provider
        # values or caches survive into the final native action revalidation.
        for ($index = 0; $index -lt $records.Count; $index++) {
            $key = (@($records[$index].runtimeID) -join ".")
            $script:renderContextChains[$key] = @($records[$index..($records.Count - 1)])
        }
    }
    return [pscustomobject]@{ proof = (Get-StateDigest $records); hasDocumentContext = $HasDocumentContext }
}

function Get-ElementContextProof($element, [switch]$ForKeyboard, [string]$OwnStateSignature = "") {
    $empty = [pscustomobject]@{ proof = ""; hasDocumentContext = $false }
    try {
        $chain = New-Object 'Collections.Generic.List[object]'
        $current = $element
        $hasDocument = $false
        for ($depth = 0; $depth -lt 64 -and $null -ne $current; $depth++) {
            $id = @($current.GetRuntimeId())
            if ($id.Count -eq 0) { return $empty }
            $key = ($id -join ".")
            if (-not $ForKeyboard -and $null -ne $script:renderContextChains -and $script:renderContextChains.ContainsKey($key)) {
                foreach ($ancestor in @($script:renderContextChains[$key])) { $chain.Add($ancestor) }
                $hasDocument = @($chain.ToArray() | Where-Object { -not [string]::IsNullOrEmpty($_.documentState) }).Count -gt 0
                return Complete-ElementContextProof $chain $hasDocument
            }
            $type = [string]$current.Current.ControlType.ProgrammaticName
            $context = [ordered]@{ runtimeID = $id; controlType = $type; nativeWindowHandle = $current.Current.NativeWindowHandle
                automationID = [string]$current.Current.AutomationId; name = [string]$current.Current.Name }
            if ($type -eq "ControlType.Document") {
                $contentPatterns = @($current.GetSupportedPatterns() | Where-Object { $_.ProgrammaticName -in @("ValuePatternIdentifiers.Pattern", "TextPatternIdentifiers.Pattern") })
                if ($contentPatterns.Count -eq 0) { return $empty }
                $context["documentState"] = if ($depth -eq 0 -and -not [string]::IsNullOrEmpty($OwnStateSignature)) { $OwnStateSignature } else { Get-ElementStateSignature $current }
                if ([string]::IsNullOrEmpty($context["documentState"])) { return $empty }
                $hasDocument = $true
            }
            $chain.Add($context)
            if ($type -eq "ControlType.Window" -and [long]$current.Current.NativeWindowHandle -ne 0) {
                return Complete-ElementContextProof $chain $hasDocument -ForKeyboard:$ForKeyboard
            }
            $current = [Windows.Automation.TreeWalker]::RawViewWalker.GetParent($current)
        }
    } catch {}
    return $empty
}

function Get-ElementRecord($element, [int]$index, $windowBounds, $TextLimit = $script:DefaultTextLimit) {
    $frame = Get-ElementFrame $element $windowBounds
    $runtimeId = @()
    try { $runtimeId = @($element.GetRuntimeId()) } catch {}
    $stateSignature = Get-ElementStateSignature $element
    $context = Get-ElementContextProof $element -OwnStateSignature $stateSignature
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
        stateSignature = $stateSignature
        contextProof = $context.proof
        contextScoped = $context.hasDocumentContext
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
            $script:treeComplete = $false
            return
        }
        $runtime = ""
        try { $runtime = (@($node.GetRuntimeId()) -join ".") } catch { $runtime = [guid]::NewGuid().ToString(); $script:treeComplete = $false }
        if ([string]::IsNullOrEmpty($runtime)) { $script:treeComplete = $false }
        if (-not $script:visited.Add($runtime)) {
            $script:treeComplete = $false
            return
        }

        $index = $script:nextIndex
        $script:nextIndex++
        $record = Get-ElementRecord $node $index $script:windowBounds $TextLimit
        if (@($record.runtimeId).Count -eq 0 -or [string]::IsNullOrEmpty($record.stateSignature)) { $script:treeComplete = $false }
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
            $script:treeComplete = $false
        }
    }

    $script:records = $records
    $script:lines = $lines
    $script:visited = $visited
    $script:nextIndex = $nextIndex
    $script:treeComplete = $true
    $script:windowBounds = $windowBounds
    $script:MaxTreeNodes = $effectiveMaxTreeNodes
    $script:MaxTreeDepth = $effectiveMaxTreeDepth
    $script:renderContextChains = @{}
    try { Visit $element 0 }
    finally { $script:renderContextChains = $null }

    [pscustomobject]@{
        records = $records.ToArray()
        lines = $lines.ToArray()
        complete = $script:treeComplete
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

function Capture-WindowBitmap([IntPtr]$hwnd, $bounds) {
    # A maximized window extends past the monitor by its resize border, so a
    # 4096-pixel-wide display has wider windows. These limits match the observation decoder.
    if ($null -eq $bounds -or $bounds.width -le 0 -or $bounds.height -le 0 -or
        $bounds.width -gt 8192 -or $bounds.height -gt 8192 -or ($bounds.width * $bounds.height) -gt 33554432) {
        return $null
    }
    $bitmap = $null
    $graphics = $null
    $keepBitmap = $false
    try {
        $bitmap = New-Object System.Drawing.Bitmap ([int][math]::Round($bounds.width)), ([int][math]::Round($bounds.height))
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        $captured = $false
        if ($hwnd -ne [IntPtr]::Zero) {
            $hdc = $graphics.GetHdc()
            try { $captured = [OCUWin32]::PrintWindow($hwnd, $hdc, 2) } finally { $graphics.ReleaseHdc($hdc) }
            if ($captured -and (Test-BitmapMostlyBlank $bitmap)) { $captured = $false }
        }
        # A screen copy would contain whichever app covers this HWND. Return no
        # image when the app cannot provide a trustworthy window-only capture.
        if (-not $captured) { return $null }
        $keepBitmap = $true
        return $bitmap
    } catch {
        return $null
    } finally {
        if ($null -ne $graphics) { $graphics.Dispose() }
        if (-not $keepBitmap -and $null -ne $bitmap) { $bitmap.Dispose() }
    }
}

function Capture-WindowPngBase64([IntPtr]$hwnd, $bounds, $popups = @()) {
    $bitmap = $null; $graphics = $null; $stream = $null
    try {
        $bitmap = Capture-WindowBitmap $hwnd $bounds
        if ($null -eq $bitmap) { return $null }
        $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
        # Owned popups are ordered back to front and drawn into the exact root
        # crop. A refused/blank popup must never return a plausible root-only PNG.
        foreach ($popup in $popups) {
            Assert-OperationDeadline
            $popupBounds = [pscustomobject]@{ x = $popup.Bounds.Left; y = $popup.Bounds.Top
                width = ([long]$popup.Bounds.Right - $popup.Bounds.Left); height = ([long]$popup.Bounds.Bottom - $popup.Bounds.Top) }
            $overlay = $null
            try {
                $overlay = Capture-WindowBitmap ([IntPtr]$popup.ID) $popupBounds
                if ($null -eq $overlay) { return $null }
                $graphics.DrawImageUnscaled($overlay, [int]($popupBounds.x - $bounds.x), [int]($popupBounds.y - $bounds.y))
            } finally { if ($null -ne $overlay) { $overlay.Dispose() } }
        }
        $graphics.Dispose(); $graphics = $null
        $stream = New-Object System.IO.MemoryStream
        $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Png)
        return [Convert]::ToBase64String($stream.ToArray())
    } catch { return $null }
    finally {
        if ($null -ne $stream) { $stream.Dispose() }
        if ($null -ne $graphics) { $graphics.Dispose() }
        if ($null -ne $bitmap) { $bitmap.Dispose() }
    }
}

function Get-FocusedSummary($root, $TextLimit = $script:DefaultTextLimit, $focused = $null) {
    try {
        if ($null -eq $focused) { $focused = [Windows.Automation.AutomationElement]::FocusedElement }
        if ($null -ne $focused -and (Test-ElementInRoot $focused $root)) {
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

function Get-SelectedText($root, $TextLimit = $script:DefaultTextLimit, $focused = $null) {
    try {
        if ($null -eq $focused) { $focused = [Windows.Automation.AutomationElement]::FocusedElement }
        if ($null -eq $focused -or -not (Test-ElementInRoot $focused $root)) {
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

function Build-Snapshot([string]$query, $TextLimit = $script:DefaultTextLimit,
    [int]$MaxTreeNodes = $script:AccessibilityTreeMaxNodeCount, [int]$MaxTreeDepth = $script:AccessibilityTreeMaxDepth,
    $WindowID = $null, [int]$ExpectedPID = 0) {
    [void](Read-FocusState)
    $process = Resolve-App $query $ExpectedPID
    $hwnd = Resolve-TargetWindow $process $WindowID -AllowDisabled
    $element = Get-RootElement $process $hwnd
    $bounds = Get-WindowRectFrame $hwnd
    if ($null -eq $bounds) { throw "The exact target window bounds are unavailable." }
    $rendered = Render-Tree $element $bounds $TextLimit $MaxTreeNodes $MaxTreeDepth
    Assert-TargetWindow $hwnd $process.Id
    $captureWindows = [OCUWin32]::ReadCaptureWindows()
    $popups = @([OCUWin32]::SelectOwnedPopupWindows($captureWindows, $hwnd.ToInt64(), [uint32]$process.Id))
    $captureRoot = @($captureWindows | Where-Object { $_.ID -eq $hwnd.ToInt64() })
    if ($captureRoot[0].Bounds.Left -ne $bounds.x -or $captureRoot[0].Bounds.Top -ne $bounds.y -or
        ([long]$captureRoot[0].Bounds.Right - $captureRoot[0].Bounds.Left) -ne $bounds.width -or
        ([long]$captureRoot[0].Bounds.Bottom - $captureRoot[0].Bounds.Top) -ne $bounds.height) {
        throw "The target window geometry changed before capture. Run get_app_state again."
    }
    $image = Capture-WindowPngBase64 $hwnd $bounds $popups
    Assert-TargetWindow $hwnd $process.Id
    if (-not (Test-FrameClose (Get-WindowRectFrame $hwnd) $bounds)) {
        throw "The target window geometry changed during observation. Run get_app_state again."
    }
    $freshWindows = [OCUWin32]::ReadCaptureWindows()
    $freshPopups = @([OCUWin32]::SelectOwnedPopupWindows($freshWindows, $hwnd.ToInt64(), [uint32]$process.Id))
    $freshRoot = @($freshWindows | Where-Object { $_.ID -eq $hwnd.ToInt64() })
    if (-not [OCUWin32]::SameCaptureGroup(($captureRoot + $popups), ($freshRoot + $freshPopups))) {
        throw "The target or its owned popup windows changed during capture. Run get_app_state again."
    }
    $keyboard = Read-KeyboardObservation $hwnd $process.Id $element
    [pscustomobject]@{
        app = [pscustomobject]@{ name = $process.ProcessName; bundleIdentifier = $process.ProcessName; pid = [int]$process.Id }
        targetWindowID = $hwnd.ToInt64()
        relatedWindowIDs = @($popups | ForEach-Object { $_.ID })
        captureGroupProof = Get-CaptureGroupProof $captureRoot $popups
        availableWindows = @(Get-AvailableWindows $process.Id)
        windowTitle = Limit-Text ([OCUWin32]::WindowTitle($hwnd)) $TextLimit
        windowBounds = $bounds
        screenshotPngBase64 = $image
        screenshotIsolated = (-not [string]::IsNullOrEmpty($image))
        accessibilityTreeComplete = $rendered.complete
        treeLines = @($rendered.lines)
        keyboardReceiverID = $keyboard.receiverID
        keyboardReceiverRuntimeID = @($keyboard.runtimeID)
        keyboardReceiverState = $keyboard.state
        focusedSummary = Get-FocusedSummary $element $TextLimit $keyboard.element
        selectedText = Get-SelectedText $element $TextLimit $keyboard.element
        elements = @($rendered.records)
    }
}

function Test-NativeAppId([string]$value) {
    return (-not [string]::IsNullOrEmpty($value) -and $value.Length -le 256 -and $value -cmatch '^[A-Za-z0-9_.!-]+$')
}

function Test-AllowedAppId([string]$appId) {
    if (-not (Test-NativeAppId $appId)) { return $false }
    # Shared UWP hosts cannot authorize one hosted application by process name.
    # Until each HWND has a separately verified package binding, omit the host.
    return (-not @('applicationframehost', 'cmd', 'powershell', 'pwsh', 'wt', 'windowsterminal', 'chatgpt').Contains($appId.ToLowerInvariant()))
}

function Test-DiscoverableProcess($process) {
    return ($null -ne $process -and [int]$process.Id -gt 0 -and (Test-AllowedAppId ([string]$process.ProcessName)))
}

function Get-AppWindow($process) {
    if ($null -eq $process) { return [IntPtr]::Zero }
    if ($process.MainWindowHandle -ne 0) {
        $hwnd = [OCUWin32]::FirstAppWindow([uint32]$process.Id)
        if ($hwnd -ne [IntPtr]::Zero) { return $hwnd }
    }
    # A packaged app's visible window sits in a frame of the shared host process.
    return [OCUWin32]::FirstHostedAppWindow([uint32]$process.Id)
}

function Get-ProcessAppUserModelId($process) {
    try { return [OCUWin32]::ApplicationUserModelId([uint32]$process.Id) } catch { return $null }
}

function Get-ProcessNativeAppId($process) {
    if (-not (Test-DiscoverableProcess $process)) { return $null }
    $appId = Get-ProcessAppUserModelId $process
    if (Test-NativeAppId $appId) { return $appId }
    return [string]$process.ProcessName
}

function Assert-ExpectedAppIdentity($process, [string]$expectedAppId) {
    if ([string]::IsNullOrEmpty($expectedAppId)) { return }
    $currentId = Get-ProcessNativeAppId $process
    if (-not (Test-NativeAppId $expectedAppId) -or [string]::IsNullOrEmpty($currentId) -or $currentId -ine $expectedAppId) {
        throw "The target process application identity changed or is unavailable. No further action was sent; discover and approve the app again."
    }
}

# Start menu entries from the shell Apps folder, with the program a desktop
# shortcut starts.
function Read-InstalledAppEntries {
    try {
        $folder = (New-Object -ComObject Shell.Application).NameSpace("shell:::{4234d49b-0245-4df3-b780-3893943456e1}")
        return @($folder.Items() | ForEach-Object {
            $target = $null; $packageRoot = $null
            try { $target = [string]$_.ExtendedProperty("System.Link.TargetParsingPath") } catch {}
            if (([string]$_.Path).Contains("!")) {
                try { $packageRoot = [string]$_.ExtendedProperty("System.AppUserModel.PackageInstallPath") } catch {}
            }
            [pscustomobject]@{ name = [string]$_.Name; launchId = [string]$_.Path; target = $target; packageRoot = $packageRoot }
        })
    } catch { return @() }
}

# Names the app's own files give it besides its Start menu name: the display
# name in its package's main resources, and its executable's version names. A
# packaged app's main resources usually hold its default-language name; the
# user's language comes from a separate resource pack.
function Read-InstalledAppMetadataNames($app) {
    $names = New-Object 'Collections.Generic.List[string]'
    try {
        $launchId = [string]$app.launchId
        $executable = [string]$app.target
        if ($launchId.Contains("!")) {
            $root = [string]$app.packageRoot
            if ([string]::IsNullOrWhiteSpace($root)) { return @() }
            [xml]$manifest = [IO.File]::ReadAllText((Join-Path $root "AppxManifest.xml"))
            $applicationId = $launchId.Substring($launchId.IndexOf("!") + 1)
            $application = @($manifest.Package.Applications.Application | Where-Object { $_.Id -eq $applicationId })[0]
            if ($null -eq $application) { return @() }
            $visual = @($application.ChildNodes | Where-Object { $_.LocalName -eq "VisualElements" })[0]
            $displayName = if ($null -ne $visual) { [string]$visual.GetAttribute("DisplayName") } else { "" }
            if ($displayName.StartsWith("ms-resource:")) {
                $resource = $displayName.Substring(12)
                $package = [string]$manifest.Package.Identity.Name
                $keys = if ($resource.StartsWith("//")) { @("ms-resource:$resource") }
                    elseif ($resource.StartsWith("/")) { @("ms-resource://$package$resource") }
                    else { @("ms-resource://$package/Resources/$resource", "ms-resource://$package/$resource") }
                $resources = Join-Path $root "resources.pri"
                foreach ($key in $keys) {
                    $value = [OCUWin32]::LoadIndirectString("@{${resources}?${key}}")
                    if ($null -ne $value) { $names.Add($value); break }
                }
            } elseif ($displayName) { $names.Add($displayName) }
            $executable = if ($application.Executable) { Join-Path $root ([string]$application.Executable) } else { $null }
        }
        if (-not [string]::IsNullOrWhiteSpace($executable) -and
            $executable.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath $executable -PathType Leaf)) {
            $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($executable)
            $names.Add([string]$version.FileDescription)
            $names.Add([string]$version.ProductName)
        }
    } catch {}
    return @($names.ToArray())
}

function Get-InstalledAppAliases($app) {
    $aliases = New-Object 'Collections.Generic.List[string]'
    foreach ($value in @(Read-InstalledAppMetadataNames $app)) {
        $alias = ConvertTo-AppAlias $value
        if ($null -ne $alias -and $alias -ine [string]$app.displayName -and
            @($aliases | Where-Object { $_ -ieq $alias }).Count -eq 0 -and $aliases.Count -lt 16) { $aliases.Add($alias) }
    }
    return @($aliases.ToArray())
}

# The identity the opened app's process will report: a packaged app keeps its
# AUMID, a desktop program runs under its executable name.
function Get-InstalledAppIdentity([string]$launchId, [string]$target) {
    if ($launchId.Contains("!")) {
        if (Test-NativeAppId $launchId) { return $launchId }
        return $null
    }
    foreach ($path in @($target, $launchId)) {
        if ([string]::IsNullOrWhiteSpace($path) -or -not $path.EndsWith(".exe", [System.StringComparison]::OrdinalIgnoreCase)) { continue }
        $file = $path.Substring($path.LastIndexOfAny([char[]]@('\', '/')) + 1)
        $name = $file.Substring(0, $file.Length - 4)
        if (Test-NativeAppId $name) { return $name }
    }
    return $null
}

function Get-InstalledApps {
    $apps = New-Object 'Collections.Generic.List[object]'
    foreach ($entry in @(Read-InstalledAppEntries)) {
        $name = ConvertTo-AppAlias $entry.name
        $launchId = [string]$entry.launchId
        if ($null -eq $name -or [string]::IsNullOrWhiteSpace($launchId) -or $launchId -match '["\x00-\x1f\x7f]') { continue }
        $appId = Get-InstalledAppIdentity $launchId ([string]$entry.target)
        if ($null -ne $appId) { $apps.Add([pscustomobject]@{ appId = $appId; displayName = $name; launchId = $launchId
            target = $entry.target; packageRoot = $entry.packageRoot }) }
    }
    return @($apps.ToArray())
}

function Get-ProcessVersionNames($process) {
    try {
        # Path is the running process's executable, not a model-supplied path.
        $executablePath = [string]$process.Path
        if ([string]::IsNullOrWhiteSpace($executablePath)) { return @() }
        $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($executablePath)
        return @($version.FileDescription, $version.ProductName)
    } catch { return @() }
}

function ConvertTo-AppAlias($value) {
    if ($value -isnot [string]) { return $null }
    $alias = $value.Trim()
    if ([string]::IsNullOrEmpty($alias) -or $alias.Length -gt 256 -or $alias -match '[\x00-\x1f\x7f]') { return $null }
    return $alias
}

function Get-RunningAppIdentity($process, $installedApps) {
    $appId = Get-ProcessNativeAppId $process
    if ([string]::IsNullOrEmpty($appId)) { return $null }
    $aliases = New-Object 'Collections.Generic.List[string]'
    $displayName = [string]$process.ProcessName
    $installedEntries = @($installedApps | Where-Object { [string]$_.appId -ieq $appId })
    $installedNames = @($installedEntries | ForEach-Object { ConvertTo-AppAlias $_.displayName } | Where-Object { $null -ne $_ } | Sort-Object -Unique)
    if ($installedNames.Count -eq 1) { $displayName = $installedNames[0] }
    $installedAliases = @($installedEntries | ForEach-Object { Get-InstalledAppAliases $_ })
    foreach ($value in @($installedNames) + @(Get-ProcessVersionNames $process) + $installedAliases) {
        $alias = ConvertTo-AppAlias $value
        if ($null -ne $alias -and -not $aliases.Contains($alias) -and $aliases.Count -lt 16) { $aliases.Add($alias) }
    }
    if ($displayName -eq [string]$process.ProcessName -and $aliases.Count -gt 0) { $displayName = $aliases[0] }
    return [pscustomobject]@{ appId = $appId; displayName = $displayName; processName = [string]$process.ProcessName
        pid = [int]$process.Id; aliases = @($aliases.ToArray()) }
}

function List-Apps {
    $lines = New-Object 'Collections.Generic.List[string]'
    $apps = New-Object 'Collections.Generic.List[object]'
    $installed = @(Get-InstalledApps)
    foreach ($process in (Get-Process | Where-Object { (Get-AppWindow $_) -ne [IntPtr]::Zero } | Sort-Object ProcessName, Id)) {
        $app = Get-RunningAppIdentity $process $installed
        if ($null -eq $app) { continue }
        $apps.Add($app)
        $lines.Add(("{0} -- {1} [running, pid={2}, process={3}]" -f $app.displayName, $app.appId, $app.pid, $app.processName))
    }
    return [pscustomobject]@{ text = ($lines -join "`n"); runningApps = [pscustomobject]@{ version = 1; apps = @($apps.ToArray()) } }
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

function Assert-ElementRecordMatches($live, $observed) {
    # Find-Element has already matched the exact runtime ID inside this window.
    # Its label, value, state and document text legitimately change; only a
    # different kind of element, host HWND or position redirects the input.
    if ([string]$live.controlType -cne [string]$observed.controlType) {
        throw "The observed UIA element changed before dispatch (controlType). Run get_app_state again; no further action was sent."
    }
    if ([int64]$live.nativeWindowHandle -ne [int64]$observed.nativeWindowHandle) {
        throw "The observed UIA element HWND changed before dispatch. No further action was sent."
    }
    # A pointer fallback clicks the center of the observed frame.
    if ($null -ne $observed.frame) {
        $x = $observed.frame.x + ($observed.frame.width / 2)
        $y = $observed.frame.y + ($observed.frame.height / 2)
        if ($null -eq $live.frame -or $x -lt $live.frame.x -or $y -lt $live.frame.y -or
            $x -ge ($live.frame.x + $live.frame.width) -or $y -ge ($live.frame.y + $live.frame.height)) {
            throw "The observed UIA element moved before dispatch. Run get_app_state again; no further action was sent."
        }
    }
}

function Find-Element($root, $record, $windowBounds) {
    if ($null -eq $record) { return $null }
    if ($null -eq $record.runtimeId -or $record.runtimeId.Count -eq 0) {
        throw "The observed UIA element has no exact runtime ID. No action was sent."
    }
    foreach ($element in (Get-AllElements $root)) {
        try {
            if ((Same-RuntimeId @($element.GetRuntimeId()) @($record.runtimeId)) -and (Test-ElementInRoot $element $root)) {
                $freshRecord = Get-ElementRecord $element ([int]$record.index) $windowBounds (Resolve-TextLimit $operation.text_limit)
                Assert-ElementRecordMatches $freshRecord $record
                return $element
            }
        } catch { throw }
    }
    # A same-name/AutomationId control can be a different document or a new
    # control after rerendering. Never substitute it for the observed runtime ID.
    throw "The observed UIA element is no longer inside this exact window. Run get_app_state again."
}

function Find-PointClickElement($root, [int]$screenX, [int]$screenY) {
    # The root UIA tree can expose a button underneath a separate owned popup.
    # Coordinate auto-click must hit the same surface as the composed pixels.
    if ((Resolve-PointCaptureRoot $script:targetWindow $screenX $screenY) -ne $script:targetWindow) { return $null }
    $candidates = @()
    foreach ($candidate in (Get-AllElements $root)) {
        if (-not (Test-ElementInRoot $candidate $root)) { continue }
        $frame = Get-ElementFrame $candidate $null
        if ($null -eq $frame -or $screenX -lt $frame.x -or $screenY -lt $frame.y -or
            $screenX -ge ($frame.x + $frame.width) -or $screenY -ge ($frame.y + $frame.height)) { continue }
        if ((Get-ElementControlTypeName $candidate) -like "*Window") { continue }
        $actions = @(Get-PatternNames $candidate)
        if ($actions -contains "Invoke" -or $actions -contains "Select" -or $actions -contains "Toggle") {
            $candidates += [pscustomobject]@{ element = $candidate; area = $frame.width * $frame.height }
        }
    }
    $best = $candidates | Sort-Object area | Select-Object -First 1
    if ($null -ne $best) { return $best.element }
    return $null
}

function Get-CurrentPatternOrNull($element, $pattern) {
    try {
        return $element.GetCurrentPattern($pattern)
    } catch [System.InvalidOperationException] {
        return $null
    }
}

function Invoke-PreferredClick($element, [int]$clickCount = 1) {
    # Invoke is one semantic action, not a native double-click. Two Invoke calls
    # can create two documents while the first asynchronous action is still pending.
    if ($clickCount -gt 1) { return $false }
    $invoke = Get-CurrentPatternOrNull $element ([Windows.Automation.InvokePattern]::Pattern)
    if ($null -ne $invoke) {
        Invoke-UIAMutation { $invoke.Invoke() } $element
        return $true
    }
    $selection = Get-CurrentPatternOrNull $element ([Windows.Automation.SelectionItemPattern]::Pattern)
    if ($null -ne $selection) {
        Invoke-UIAMutation { $selection.Select() } $element
        return $true
    }
    $toggle = Get-CurrentPatternOrNull $element ([Windows.Automation.TogglePattern]::Pattern)
    if ($null -ne $toggle) {
        Invoke-UIAMutation { $toggle.Toggle() } $element
        return $true
    }
    return $false
}

function Invoke-SecondaryAction($element, [string]$action) {
    switch ($action.ToLowerInvariant()) {
        "invoke" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.InvokePattern]::Pattern)
            if ($null -ne $pattern) { Invoke-UIAMutation { $pattern.Invoke() } $element; return }
        }
        "toggle" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.TogglePattern]::Pattern)
            if ($null -ne $pattern) { Invoke-UIAMutation { $pattern.Toggle() } $element; return }
        }
        "select" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.SelectionItemPattern]::Pattern)
            if ($null -ne $pattern) { Invoke-UIAMutation { $pattern.Select() } $element; return }
        }
        "expand" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -ne $pattern) { Invoke-UIAMutation { $pattern.Expand() } $element; return }
        }
        "collapse" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ExpandCollapsePattern]::Pattern)
            if ($null -ne $pattern) { Invoke-UIAMutation { $pattern.Collapse() } $element; return }
        }
        "scrollintoview" {
            $pattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ScrollItemPattern]::Pattern)
            if ($null -ne $pattern) { Invoke-UIAMutation { $pattern.ScrollIntoView() } $element; return }
        }
        "setfocus" {
            throw "SetFocus is unsupported for background input. Explicitly open the target window to reveal it."
        }
    }
    throw "$action is not a valid secondary action for $($operation.element.index)"
}

function Invoke-Scroll($element, [string]$direction, [double]$pages) {
    if (-not @("up", "down", "left", "right").Contains($direction) -or
        [double]::IsNaN($pages) -or [double]::IsInfinity($pages) -or $pages -le 0 -or $pages -gt 100) {
        throw "Invalid background scroll direction or pages."
    }
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
        Invoke-UIAMutation { $scroll.Scroll($horizontal, $vertical) } $element
        Start-Sleep -Milliseconds 40
    }
    return $true
}

function Invoke-TypeText([IntPtr]$hwnd, [string]$text) {
    $receiver = Get-KeyboardReceiver $hwnd
    $className = [OCUWin32]::WindowClass($receiver)
    if ($className -match "^(Edit|RichEdit.*)$") {
        Send-TextToEditHandle $receiver $text
        return
    }
    throw "The observed receiver has no verified native Edit/RichEdit caret, so background insertion is unsupported. No text was sent. type_text with foreground=true types it with real keyboard input into the window's focus; set_value writes an exact writable UIA element."
}

function Reveal-Window([long]$windowID, [int]$expectedPID) {
    Assert-OperationDeadline
    [void](Read-FocusState)
    $hwnd = [IntPtr]$windowID
    Assert-TargetWindow $hwnd $expectedPID
    $script:requestedWindowID = $windowID
    $script:requestedPID = $expectedPID
    $shown = [OCUWin32]::ActivationWindow($hwnd)
    if ([OCUWin32]::IsIconic($shown) -or -not [OCUWin32]::IsWindowVisible($hwnd)) {
        Assert-OperationDeadline
        [void][OCUWin32]::ShowWindow($shown, 9)
    }
    Assert-TargetWindow $hwnd $expectedPID
    Assert-OperationDeadline
    return [OCUWin32]::SetForegroundWindow($shown)
}

# Read UTF-8 explicitly: Windows PowerShell 5.1 otherwise uses the ANSI code page.
$operationJson = [System.IO.File]::ReadAllText($OperationPath, [System.Text.Encoding]::UTF8)
$operation = $operationJson | ConvertFrom-Json
$script:focusGuardYield = $false
$script:dispatched = $false
$script:targetWindowUnavailable = $false
$script:requestedWindowID = 0L
$script:requestedPID = 0
$script:availableWindows = @()
$script:focusBefore = $null
$script:focusChangedByApp = $false
$script:targetWindow = [IntPtr]::Zero
$script:pointCaptureGroup = $null
$script:pointReceiverRoot = [IntPtr]::Zero
$script:targetProcessId = 0
$script:targetRoot = $null
$script:expectedWindowBounds = $null
$script:pendingReleases = @{}
$script:targetElementValidated = $false
$script:pointerDelivery = $null
$script:foregroundClick = $null

try {
    if ($operation.tool -eq "list_apps") {
        $listing = List-Apps
        $response = [pscustomobject]@{ ok = $true; text = $listing.text; runningApps = $listing.runningApps }
    } elseif ($operation.tool -eq "resolve_app") {
        $response = [pscustomobject]@{ ok = $true; resolution = (Resolve-AppIdentity ([string]$operation.app)) }
    } elseif ($operation.tool -eq "focus_snapshot") {
        $focus = Read-FocusState
        $response = [pscustomobject]@{ ok = $true; focusState = [pscustomobject]@{
            pid = [int]$focus.processId; windowID = $focus.hwnd.ToInt64(); inputIdle = $focus.idleMilliseconds / 1000.0 } }
    } elseif ($operation.tool -eq "reveal_window") {
        if ([long]$operation.window_id -le 0 -or [int]$operation.expected_pid -le 0) { throw "Reveal requires an exact window_id and expected_pid." }
        $response = [pscustomobject]@{ ok = $true; success = (Reveal-Window ([long]$operation.window_id) ([int]$operation.expected_pid)) }
    } elseif ($operation.tool -eq "get_app_state") {
        $response = [pscustomobject]@{ ok = $true; snapshot = (Build-Snapshot $operation.app (Resolve-TextLimit $operation.text_limit) ([int]$operation.max_tree_nodes) ([int]$operation.max_tree_depth) $operation.window_id ([int]$operation.expected_pid)) }
    } else {
        Assert-OperationDeadline
        if (-not @("click", "perform_secondary_action", "scroll", "drag", "type_text", "press_key", "set_value").Contains([string]$operation.tool)) {
            throw "unsupportedTool(`"$($operation.tool)`")"
        }
        if ([int]$operation.expected_pid -le 0) { throw "Mutation requires the observed expected_pid. No action was sent." }
        $process = Resolve-App $operation.app ([int]$operation.expected_pid)
        $windowBounds = $operation.windowBounds
        if ($null -eq $windowBounds) { throw "Mutation requires the observed window bounds. No action was sent." }
        $hwnd = Resolve-ActionWindow $process $windowBounds $operation.window_id
        $script:targetWindow = $hwnd
        $script:targetProcessId = [int]$process.Id
        $script:expectedWindowBounds = $windowBounds
        $script:focusBefore = Read-FocusState
        Assert-SafeBeforeAction $script:focusBefore $process.Id $hwnd
        try {
            $root = Get-RootElement $process $hwnd
            $script:targetRoot = $root
            $element = Find-Element $root $operation.element $windowBounds
            switch ($operation.tool) {
                "click" {
                    $clickMethod = [string]$operation.click_method
                    if ([string]::IsNullOrWhiteSpace($clickMethod)) { $clickMethod = "auto" }
                    if (@("global", "sky_click").Contains($clickMethod)) { throw "click_method '$clickMethod' is unsupported on Windows; no foreground fallback is available." }
                    if (-not @("auto", "accessibility", "app_post").Contains($clickMethod)) { throw "Invalid click_method '$clickMethod'." }
                    $clickCount = [int]$operation.click_count
                    if ($clickCount -lt 1 -or $clickCount -gt 2) { throw "Background click supports click_count 1 or 2." }
                    $handled = $false
                    if ($operation.foreground -eq $true) {
                        if ($clickMethod -eq "accessibility") { throw "foreground=true sends a pointer click; use click_method auto or app_post." }
                        $point = if ($null -ne $operation.element) {
                            Get-ScreenPoint $operation.element.frame $windowBounds
                        } else {
                            if ($null -eq $operation.x -or $null -eq $operation.y) { throw "Click requires an element or x/y." }
                            [pscustomobject]@{ x = [int][math]::Round($windowBounds.x + [double]$operation.x)
                                y = [int][math]::Round($windowBounds.y + [double]$operation.y) }
                        }
                        if ($null -eq $point) { throw "The observed element has no target-local frame for a pointer click." }
                        $script:pointerDelivery = "foreground_input"
                        Send-ForegroundClick $hwnd $point.x $point.y ([string]$operation.mouse_button) $clickCount
                        # The click's own input and hand-back are not the user taking over.
                        $script:focusBefore = Read-FocusState
                        $handled = $true
                    } elseif ($clickMethod -ne "app_post" -and $null -ne $element -and
                        $operation.mouse_button -ne "right" -and $operation.mouse_button -ne "middle") {
                        $handled = Invoke-PreferredClick $element $clickCount
                        if ($handled) { $script:pointerDelivery = "uia" }
                    }
                    if (-not $handled) {
                        if ($clickMethod -eq "accessibility") { throw "The exact UIA element has no supported click action." }
                        $point = if ($null -ne $operation.element) {
                            Get-ScreenPoint $operation.element.frame $windowBounds
                        } else {
                            if ($null -eq $operation.x -or $null -eq $operation.y) { throw "Click requires an element or x/y." }
                            [pscustomobject]@{ x = [int][math]::Round($windowBounds.x + [double]$operation.x)
                                y = [int][math]::Round($windowBounds.y + [double]$operation.y) }
                        }
                        if ($null -eq $point) { throw "The observed element has no target-local frame for background pointer input." }
                        if ($null -eq $element -and $clickMethod -eq "auto" -and
                            $operation.mouse_button -ne "right" -and $operation.mouse_button -ne "middle") {
                            $pointElement = Find-PointClickElement $root $point.x $point.y
                            if ($null -ne $pointElement) { $handled = Invoke-PreferredClick $pointElement $clickCount }
                            if ($handled) { $script:pointerDelivery = "uia" }
                        }
                        if (-not $handled) {
                            $script:pointerDelivery = "window_message"
                            Send-MouseClick $hwnd $point.x $point.y ([string]$operation.mouse_button) $clickCount
                        }
                    }
                }
                "perform_secondary_action" {
                    if ($null -eq $element) { throw "Secondary action requires an observed UIA element." }
                    Invoke-SecondaryAction $element $operation.action
                }
                "scroll" {
                    $handled = $false
                    if ($null -ne $element) { $handled = Invoke-Scroll $element $operation.direction ([double]$operation.pages) }
                    if (-not $handled) {
                        $point = if ($null -ne $element) { Get-ScreenPoint $operation.element.frame $windowBounds } else {
                            if ($null -eq $operation.x -or $null -eq $operation.y) { throw "Scroll requires an element or x/y." }
                            [pscustomobject]@{ x = [int][math]::Round($windowBounds.x + [double]$operation.x)
                                y = [int][math]::Round($windowBounds.y + [double]$operation.y) }
                        }
                        if ($null -eq $point) { throw "The observed element has no target-local frame." }
                        Send-Scroll $hwnd $point.x $point.y $operation.direction ([double]$operation.pages)
                    }
                }
                "drag" {
                    Send-Drag $hwnd ([int][math]::Round($windowBounds.x + [double]$operation.from_x)) ([int][math]::Round($windowBounds.y + [double]$operation.from_y)) ([int][math]::Round($windowBounds.x + [double]$operation.to_x)) ([int][math]::Round($windowBounds.y + [double]$operation.to_y))
                }
                "type_text" {
                    if ($operation.foreground -eq $true) { Send-ForegroundKeyboard $hwnd $operation.text $null; $script:focusBefore = Read-FocusState }
                    else { Invoke-TypeText $hwnd $operation.text }
                }
                "press_key" {
                    if ($operation.foreground -eq $true) { Send-ForegroundKeyboard $hwnd $null $operation.key; $script:focusBefore = Read-FocusState }
                    else { Send-Key $hwnd $operation.key }
                }
                "set_value" {
                    if ($null -eq $element) { throw "Set value requires an observed UIA element." }
                    $valuePattern = Get-CurrentPatternOrNull $element ([Windows.Automation.ValuePattern]::Pattern)
                    if ($null -eq $valuePattern -or $valuePattern.Current.IsReadOnly) { throw "The exact UIA element has no writable ValuePattern." }
                    Invoke-UIAMutation { $valuePattern.SetValue($operation.value) } $element
                }
            }
            Assert-SafeAfterAction $script:focusBefore $process.Id $hwnd
            Start-Sleep -Milliseconds 200
            $snapshot = Build-Snapshot $operation.app (Resolve-TextLimit $operation.text_limit) ([int]$operation.max_tree_nodes) ([int]$operation.max_tree_depth) $hwnd.ToInt64() $process.Id
        } finally {
            Assert-SafeAfterAction $script:focusBefore $process.Id $hwnd
        }
        $response = [pscustomobject]@{ ok = $true; snapshot = $snapshot; dispatched = $script:dispatched
            focusChangedByApp = $script:focusChangedByApp; pointerDelivery = $script:pointerDelivery
            foregroundClick = $script:foregroundClick }
    }
} catch {
    $message = $_.Exception.Message
    if ($script:dispatched -and -not $script:focusGuardYield -and -not $script:targetWindowUnavailable) {
        $message = "$message An action may already have been sent. Do not replay it; run get_app_state to observe its result."
    }
    $response = [pscustomobject]@{ ok = $false; error = $message
        focusGuardYield = $script:focusGuardYield; dispatched = $script:dispatched
        targetWindowUnavailable = $script:targetWindowUnavailable
        requestedWindowID = $script:requestedWindowID; pid = $script:requestedPID
        availableWindows = @($script:availableWindows); focusChangedByApp = $script:focusChangedByApp }
}

$response | ConvertTo-Json -Depth 50 -Compress
