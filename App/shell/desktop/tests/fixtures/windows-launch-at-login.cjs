const { app } = require('electron');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  getWindowsLaunchAtLogin,
  repairWindowsLaunchAtLogin,
  resolveWindowsLoginItemCommand,
  setWindowsLaunchAtLogin,
} = require(process.env.MEMMY_LOGIN_FIXTURE_ADAPTER);

const root = process.env.MEMMY_LOGIN_FIXTURE_ROOT;
const itemName = process.env.MEMMY_LOGIN_FIXTURE_ITEM_NAME;
assert.match(itemName, /^memmy-login-probe-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
const unrelatedName = `${itemName}-unrelated`;
const productionName = 'cn.memtensor.memmy';
const powershell = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const wscript = path.join(process.env.SystemRoot, 'System32', 'wscript.exe');
const localAppData = path.join(root, 'Local AppData 中文');
const launcherPath = path.join(localAppData, 'Memmy', 'launcher', 'MemmyLauncher.vbs');
const markerPath = path.join(root, 'WSH_PROBE_OK.txt');
const environment = {
  platform: 'win32', isPackaged: true, executablePath: process.execPath,
  localAppDataPath: localAppData, systemRootPath: process.env.SystemRoot,
};

app.setPath('userData', path.join(root, 'profile'));
app.setAppUserModelId(itemName);

// Only the temporary AppUserModelId is visible as Memmy to the product adapter.
// Writes always force the temporary name, even if the adapter supplies a name.
const application = {
  getLoginItemSettings(options) {
    const settings = app.getLoginItemSettings(options);
    return { ...settings, launchItems: settings.launchItems.map(item => ({
      ...item, name: item.name === itemName ? productionName : item.name,
    })) };
  },
  setLoginItemSettings(options) {
    assert.ok(!options.name || options.name === productionName);
    app.setLoginItemSettings({ ...options, name: itemName });
  },
};

function cleanup() {
  app.setLoginItemSettings({ openAtLogin: false, name: itemName });
  app.setLoginItemSettings({ openAtLogin: false, name: unrelatedName });
}

const timeout = setTimeout(() => {
  try { cleanup(); } finally { console.error('Windows startup fixture timed out'); app.exit(1); }
}, 65_000);

function runPowerShell(source, extraEnvironment = {}) {
  return execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(`$ErrorActionPreference = 'Stop'\n${source}`, 'utf16le').toString('base64')], {
    env: { ...process.env, ...extraEnvironment }, encoding: 'utf8', windowsHide: true,
    timeout: 12_000, maxBuffer: 1024 * 1024,
  });
}

function readSystemRunCommand() {
  // Read the system-facing WMI view, rather than relying only on a process-local registry view.
  return runPowerShell(`
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$result = Invoke-CimMethod -Namespace root/default -ClassName StdRegProv -MethodName GetStringValue -Arguments @{
  hDefKey = [uint32]2147483649
  sSubKeyName = 'Software\\Microsoft\\Windows\\CurrentVersion\\Run'
  sValueName = $env:MEMMY_LOGIN_ITEM_NAME
}
if ($result.ReturnValue -ne 0 -or [string]::IsNullOrWhiteSpace($result.sValue)) { throw 'Temporary startup entry not found in WMI registry view' }
[Console]::Write($result.sValue)
`, { MEMMY_LOGIN_ITEM_NAME: itemName }).replace(/^\uFEFF/, '');
}

function executeRegisteredCommand() {
  const command = readSystemRunCommand();
  assert.equal(command, `"${wscript}" "${launcherPath}"`);
  fs.rmSync(markerPath, { force: true });
  // ProcessStartInfo consumes the exact registry argument tail without a shell adding another escape layer.
  runPowerShell(`
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $env:MEMMY_LOGIN_SCRIPT_HOST
$start.Arguments = $env:MEMMY_LOGIN_ARGUMENTS
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
$process = [System.Diagnostics.Process]::Start($start)
try {
  if (-not $process.WaitForExit(10000)) { $process.Kill(); throw 'Registered startup command did not exit' }
  if ($process.ExitCode -ne 0) { throw "Registered startup command failed: $($process.ExitCode)" }
} finally { $process.Dispose() }
`, { MEMMY_LOGIN_SCRIPT_HOST: wscript, MEMMY_LOGIN_ARGUMENTS: command.slice(`"${wscript}" `.length) });
  assert.equal(fs.readFileSync(markerPath, 'utf8'), 'WSH_PROBE_OK');
}

async function main() {
  await app.whenReady();
  fs.mkdirSync(path.dirname(launcherPath), { recursive: true });
  const script = `Set fso = CreateObject("Scripting.FileSystemObject")\r\nSet marker = fso.CreateTextFile("${markerPath.replaceAll('"', '""')}", True)\r\nmarker.Write "WSH_PROBE_OK"\r\nmarker.Close\r\nWScript.Quit 0\r\n`;
  fs.writeFileSync(launcherPath, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(script, 'utf16le')]));
  fs.writeFileSync(path.join(root, 'other.vbs'), 'WScript.Quit 0\r\n');
  const command = resolveWindowsLoginItemCommand(environment);
  assert.deepEqual(command, { path: wscript, args: [launcherPath] });
  assert.equal(setWindowsLaunchAtLogin(application, environment, true), true);
  executeRegisteredCommand();
  assert.equal(repairWindowsLaunchAtLogin(application, environment), false);

  const migrations = [];
  for (const enabled of [true, false]) {
    app.setLoginItemSettings({ ...command, args: [`"${launcherPath}"`], openAtLogin: true, enabled });
    // An enabled entry for the same host must not override the disabled Memmy entry.
    app.setLoginItemSettings({ path: wscript, args: [path.join(root, 'other.vbs')],
      name: unrelatedName, openAtLogin: true, enabled: true });
    assert.notEqual(readSystemRunCommand(), `"${wscript}" "${launcherPath}"`);
    assert.equal(repairWindowsLaunchAtLogin(application, environment), true);
    const settings = app.getLoginItemSettings(command);
    const item = settings.launchItems.find(value => value.name === itemName && value.scope === 'user');
    assert.ok(item);
    assert.deepEqual(item.args, [launcherPath]);
    assert.equal(item.enabled, enabled);
    assert.equal(settings.openAtLogin, true);
    assert.equal(getWindowsLaunchAtLogin(application, environment), enabled);
    executeRegisteredCommand();
    assert.equal(repairWindowsLaunchAtLogin(application, environment), false);
    migrations.push({ enabled, executed: true });
  }

  assert.equal(setWindowsLaunchAtLogin(application, environment, false), false);
  assert.equal(repairWindowsLaunchAtLogin(application, environment), false);
  assert.equal(app.getLoginItemSettings(command).openAtLogin, false);
  console.log('MEMMY_ELECTRON_LOGIN_RESULT ' + JSON.stringify({
    rawCommandExecuted: true, migrations, disabledPreservedWithUnrelatedEntry: true,
    idempotent: true, closedStartupPreserved: true,
  }));
}

main().then(() => { cleanup(); clearTimeout(timeout); app.exit(0); }, error => {
  console.error(error);
  try { cleanup(); } finally { clearTimeout(timeout); app.exit(1); }
});
