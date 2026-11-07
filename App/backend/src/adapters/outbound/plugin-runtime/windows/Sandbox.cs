// Host-only AppContainer launcher. No network capabilities and no direct-launch fallback.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;

namespace Memmy {
  public static class PluginSandbox {
    [StructLayout(LayoutKind.Sequential)] struct SecurityCapabilities {
      public IntPtr Sid, Capabilities;
      public uint Count, Reserved;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
      public int cb; public string reserved, desktop, title;
      public uint x, y, xSize, ySize, xCountChars, yCountChars, fillAttribute, flags;
      public ushort showWindow, reserved2; public IntPtr reservedPtr, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo info; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process, thread; public uint processId, threadId; }
    [StructLayout(LayoutKind.Sequential)] struct SecurityAttributes { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [StructLayout(LayoutKind.Sequential)] struct BasicJobLimit {
      public long perProcessTime, perJobTime; public uint flags;
      public UIntPtr minWorkingSet, maxWorkingSet; public uint activeProcessLimit;
      public UIntPtr affinity; public uint priorityClass, schedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong rOp, wOp, oOp, rBytes, wBytes, oBytes; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedJobLimit {
      public BasicJobLimit basic; public IoCounters io;
      public UIntPtr processMemory, jobMemory, peakProcessMemory, peakJobMemory;
    }
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int CreateAppContainerProfile(string name, string display, string description, IntPtr caps, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet=CharSet.Unicode)] static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("advapi32.dll")] static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string value, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateWindowStationW(string name, uint flags, uint access, ref SecurityAttributes attributes);
    [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError=true)] static extern bool SetProcessWindowStation(IntPtr station);
    [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateDesktopW(string name, string device, IntPtr mode, uint flags, uint access, ref SecurityAttributes attributes);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr station);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref UIntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, UIntPtr attribute, IntPtr value, UIntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcessW(string application, StringBuilder command, IntPtr processSecurity, IntPtr threadSecurity, bool inherit, uint flags, IntPtr environment, string cwd, ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr security, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedJobLimit limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr GetStdHandle(int handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr source, IntPtr targetProcess, out IntPtr target, uint access, bool inherit, uint options);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    static void Check(bool success, string operation = "Win32 sandbox operation") {
      if (!success) {
        int code = Marshal.GetLastWin32Error();
        throw new Win32Exception(code, operation + " failed (Win32 " + code + "): " + new Win32Exception(code).Message);
      }
    }
    static void Trace(string stage) {
      if (Environment.GetEnvironmentVariable("MEMMY_SANDBOX_TRACE") == "1") Console.Error.WriteLine("Memmy AppContainer: " + stage);
    }

    static string IsolatedDesktop(SecurityIdentifier identity, out IntPtr station, out IntPtr desktop) {
      station = IntPtr.Zero; desktop = IntPtr.Zero;
      IntPtr descriptor = IntPtr.Zero, previous = GetProcessWindowStation();
      string name = "Memmy_" + Guid.NewGuid().ToString("N");
      // A private, non-interactive window station lets rendering libraries use
      // GDI/internal windows without access to the user's desktop or clipboard.
      string owner = WindowsIdentity.GetCurrent().User.Value;
      string security = "D:P(A;;GA;;;SY)(A;;GA;;;" + owner + ")(A;;GA;;;" + identity.Value + ")S:(ML;;NW;;;LW)";
      try {
        Check(ConvertStringSecurityDescriptorToSecurityDescriptorW(security, 1, out descriptor, IntPtr.Zero), "Private desktop security");
        var attributes = new SecurityAttributes { length = Marshal.SizeOf(typeof(SecurityAttributes)), descriptor = descriptor, inherit = false };
        station = CreateWindowStationW(name, 0, 0x10000000, ref attributes);
        Check(station != IntPtr.Zero, "CreateWindowStationW");
        Check(SetProcessWindowStation(station), "SetProcessWindowStation");
        try {
          desktop = CreateDesktopW("Office", null, IntPtr.Zero, 0, 0x10000000, ref attributes);
          Check(desktop != IntPtr.Zero, "CreateDesktopW");
        } finally { Check(SetProcessWindowStation(previous), "Restore window station"); }
        return name + "\\Office";
      } finally { if (descriptor != IntPtr.Zero) LocalFree(descriptor); }
    }
    static string Quote(string value) {
      var result = new StringBuilder("\""); int slashes = 0;
      foreach (char c in value) {
        if (c == '\\') { slashes++; continue; }
        if (c == '"') result.Append('\\', slashes * 2 + 1).Append(c);
        else result.Append('\\', slashes).Append(c);
        slashes = 0;
      }
      return result.Append('\\', slashes * 2).Append('"').ToString();
    }
    static void Grant(string directory, SecurityIdentifier sid, bool writable) {
      if (!Path.IsPathRooted(directory) || !Directory.Exists(directory)) throw new IOException("Invalid sandbox root: " + directory);
      if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("Sandbox roots must be canonical directories");
      var acl = Directory.GetAccessControl(directory);
      var rights = writable ? FileSystemRights.Modify : FileSystemRights.ReadAndExecute;
      foreach (FileSystemAccessRule rule in acl.GetAccessRules(true, true, typeof(SecurityIdentifier))) {
        var existing = (SecurityIdentifier) rule.IdentityReference;
        bool matching = existing.Equals(sid) || (!writable && existing.Value == "S-1-15-2-1");
        if (matching && rule.AccessControlType == AccessControlType.Allow && (rule.FileSystemRights & rights) == rights
            && (rule.InheritanceFlags & (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit)) == (InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit)) return;
      }
      acl.AddAccessRule(new FileSystemAccessRule(sid, rights, InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit, PropagationFlags.None, AccessControlType.Allow));
      Directory.SetAccessControl(directory, acl);
    }

    public static int Run(string profile, string command, string[] args, string cwd, string[] readRoots, string[] writeRoots, Dictionary<string, string> environment) {
      if (!profile.StartsWith("memmy.plugin.", StringComparison.Ordinal) || !Path.IsPathRooted(command) || !File.Exists(command)) throw new ArgumentException("Invalid sandbox launch plan");
      IntPtr sid = IntPtr.Zero, attributes = IntPtr.Zero, capsPointer = IntPtr.Zero, handlesPointer = IntPtr.Zero, job = IntPtr.Zero, environmentPointer = IntPtr.Zero, station = IntPtr.Zero, desktop = IntPtr.Zero;
      var inherited = new List<IntPtr>(); var process = new ProcessInfo(); bool resumed = false, attributesInitialized = false;
      try {
        Trace("creating profile");
        int status = CreateAppContainerProfile(profile, "Memmy plugin", "Memmy isolated command plugin", IntPtr.Zero, 0, out sid);
        if (status == unchecked((int)0x800700B7)) status = DeriveAppContainerSidFromAppContainerName(profile, out sid);
        if (status < 0) Marshal.ThrowExceptionForHR(status);
        var identity = new SecurityIdentifier(sid);
        Trace("granting approved roots");
        using (var mutex = new Mutex(false, "Local\\MemmyPluginSandboxPermissions")) {
          bool held = false;
          try {
            try { held = mutex.WaitOne(30000); } catch (AbandonedMutexException) { held = true; }
            if (!held) throw new TimeoutException("Sandbox ACL setup timed out");
            foreach (var root in readRoots) Grant(root, identity, false);
            foreach (var root in writeRoots) Grant(root, identity, true);
          } finally { if (held) mutex.ReleaseMutex(); }
        }
        Trace("approved roots ready");
        foreach (int number in new int[] { -10, -11, -12 }) {
          IntPtr handle;
          Check(DuplicateHandle(GetCurrentProcess(), GetStdHandle(number), GetCurrentProcess(), out handle, 0, true, 2));
          inherited.Add(handle);
        }
        UIntPtr attributeSize = UIntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref attributeSize);
        attributes = Marshal.AllocHGlobal(checked((int)attributeSize.ToUInt64()));
        Check(InitializeProcThreadAttributeList(attributes, 2, 0, ref attributeSize)); attributesInitialized = true;
        var caps = new SecurityCapabilities { Sid = sid, Capabilities = IntPtr.Zero, Count = 0, Reserved = 0 };
        capsPointer = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(SecurityCapabilities)));
        Marshal.StructureToPtr(caps, capsPointer, false);
        Check(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x00020009), capsPointer, new UIntPtr((uint)Marshal.SizeOf(typeof(SecurityCapabilities))), IntPtr.Zero, IntPtr.Zero));
        handlesPointer = Marshal.AllocHGlobal(IntPtr.Size * inherited.Count);
        for (int i=0; i<inherited.Count; i++) Marshal.WriteIntPtr(handlesPointer, i * IntPtr.Size, inherited[i]);
        Check(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x00020002), handlesPointer, new UIntPtr((uint)(IntPtr.Size * inherited.Count)), IntPtr.Zero, IntPtr.Zero));
        var startup = new StartupInfoEx(); startup.info.cb = Marshal.SizeOf(typeof(StartupInfoEx));
        Trace("creating private desktop");
        startup.info.desktop = IsolatedDesktop(identity, out station, out desktop);
        startup.info.flags = 0x100; startup.info.stdin = inherited[0]; startup.info.stdout = inherited[1]; startup.info.stderr = inherited[2]; startup.attributes = attributes;
        var line = new StringBuilder(Quote(command)); foreach (var arg in args) line.Append(' ').Append(Quote(arg));
        job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
        var limits = new ExtendedJobLimit(); limits.basic.flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedJobLimit))));
        // Windows also needs LOCALAPPDATA in an explicit environment block to
        // construct the AppContainer process. Restoring only the launcher env
        // is insufficient. Keep plugin values out of this OS bootstrap field.
        environment = new Dictionary<string, string>(environment, StringComparer.OrdinalIgnoreCase);
        string localAppData = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        if (String.IsNullOrEmpty(localAppData) || !Path.IsPathRooted(localAppData)) throw new InvalidOperationException("LocalApplicationData is unavailable");
        environment["LOCALAPPDATA"] = localAppData;
        var variables = new List<string>(environment.Keys); variables.Sort(StringComparer.OrdinalIgnoreCase);
        var block = new StringBuilder();
        foreach (var key in variables) {
          string value = environment[key];
          if (String.IsNullOrEmpty(key) || key.IndexOf('=') >= 0 || key.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0) throw new ArgumentException("Invalid child environment");
          block.Append(key).Append('=').Append(value).Append('\0');
        }
        block.Append('\0'); environmentPointer = Marshal.StringToHGlobalUni(block.ToString());
        Trace("creating child process");
        Check(CreateProcessW(command, line, IntPtr.Zero, IntPtr.Zero, true, 0x00080000 | 0x00000004 | 0x08000000 | 0x00000400, environmentPointer, cwd, ref startup, out process), "CreateProcessW(AppContainer)");
        Check(AssignProcessToJobObject(job, process.process));
        if (ResumeThread(process.thread) == uint.MaxValue) Check(false);
        resumed = true;
        Trace("child running");
        if (WaitForSingleObject(process.process, uint.MaxValue) != 0) Check(false);
        uint exitCode; Check(GetExitCodeProcess(process.process, out exitCode)); return unchecked((int)exitCode);
      } finally {
        if (process.process != IntPtr.Zero && !resumed) TerminateProcess(process.process, 125);
        if (job != IntPtr.Zero) CloseHandle(job); // Also kills descendants after cancellation/normal exit.
        if (process.thread != IntPtr.Zero) CloseHandle(process.thread);
        if (process.process != IntPtr.Zero) CloseHandle(process.process);
        foreach (var handle in inherited) CloseHandle(handle);
        if (attributes != IntPtr.Zero) { if (attributesInitialized) DeleteProcThreadAttributeList(attributes); Marshal.FreeHGlobal(attributes); }
        if (capsPointer != IntPtr.Zero) Marshal.FreeHGlobal(capsPointer);
        if (handlesPointer != IntPtr.Zero) Marshal.FreeHGlobal(handlesPointer);
        if (environmentPointer != IntPtr.Zero) Marshal.FreeHGlobal(environmentPointer);
        if (desktop != IntPtr.Zero) CloseDesktop(desktop);
        if (station != IntPtr.Zero) CloseWindowStation(station);
        if (sid != IntPtr.Zero) FreeSid(sid);
      }
    }
  }
}
