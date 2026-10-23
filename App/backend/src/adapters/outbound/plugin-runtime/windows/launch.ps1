param([Parameter(Mandatory=$true)][string]$Plan)
$ErrorActionPreference = 'Stop'
try {
  if ($env:MEMMY_SANDBOX_TRACE -eq '1') { [Console]::Error.WriteLine('Memmy AppContainer: preparing launcher') }
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Plan)) | ConvertFrom-Json
  # Compilation runs at Host privilege: never use a plugin-writable TEMP.
  # CreateProcessW resolves the AppContainer profile from the launcher's
  # LOCALAPPDATA even when an explicit child environment block is provided.
  # The Host strips inherited variables; derive this value from the current
  # user's known folder, never from the plugin's child environment.
  $localAppData = [Environment]::GetFolderPath('LocalApplicationData')
  if ([String]::IsNullOrWhiteSpace($localAppData) -or ![IO.Path]::IsPathRooted($localAppData)) { throw 'LocalApplicationData is unavailable' }
  $env:LOCALAPPDATA = $localAppData
  $compilerRoot = Join-Path $localAppData 'Memmy/SandboxCompiler'
  [IO.Directory]::CreateDirectory($compilerRoot) | Out-Null
  if (([IO.File]::GetAttributes($compilerRoot) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe compiler directory' }
  $acl = New-Object System.Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
  [IO.Directory]::SetAccessControl($compilerRoot, $acl)
  $env:TEMP = $compilerRoot
  $env:TMP = $compilerRoot
  # Cache only Host-packaged source in the private compiler directory. Reusing
  # its assembly avoids invoking the C# compiler for every document operation.
  $source = Join-Path $PSScriptRoot 'Sandbox.cs'
  $digest = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($digest.ComputeHash([IO.File]::ReadAllBytes($source))).Replace('-', '').ToLowerInvariant() }
  finally { $digest.Dispose() }
  $assembly = Join-Path $compilerRoot ("sandbox-" + $hash + '.dll')
  $mutex = [Threading.Mutex]::new($false, ("Local\MemmySandboxCompiler-" + $hash))
  $held = $false
  try {
    try { $held = $mutex.WaitOne(120000) } catch [Threading.AbandonedMutexException] { $held = $true }
    if (!$held) { throw 'Sandbox compiler cache is busy' }
    if ([IO.File]::Exists($assembly)) {
      if (([IO.File]::GetAttributes($assembly) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Unsafe compiler cache file' }
      try { [void][Reflection.AssemblyName]::GetAssemblyName($assembly) }
      catch { [IO.File]::Delete($assembly) }
    }
    if (![IO.File]::Exists($assembly)) {
      if ($env:MEMMY_SANDBOX_TRACE -eq '1') { [Console]::Error.WriteLine('Memmy AppContainer: compiling launcher') }
      [Environment]::CurrentDirectory = $compilerRoot
      Add-Type -Path $source -OutputAssembly $assembly
    }
    Add-Type -Path $assembly
  } finally {
    if ($held) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
  }
  $childEnvironment = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:MEMMY_SANDBOX_CHILD_ENV)) | ConvertFrom-Json
  $dictionary = New-Object 'System.Collections.Generic.Dictionary[string,string]'
  foreach ($property in $childEnvironment.PSObject.Properties) { $dictionary.Add($property.Name, [string]$property.Value) }
  $result = [Memmy.PluginSandbox]::Run(
    [string]$request.profile, [string]$request.command, [string[]]$request.args,
    [string]$request.cwd, [string[]]$request.readRoots, [string[]]$request.writeRoots, $dictionary)
  exit $result
} catch {
  [Console]::Error.WriteLine($_.Exception.ToString())
  exit 125
}
