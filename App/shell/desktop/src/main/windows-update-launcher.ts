/**
 * Creates the CMD script that launches the Windows update helper hidden.
 *
 * A CMD launcher replaces the historical .vbs launcher so systems with
 * VBScript / Windows Script Host disabled (e.g. Windows Feature removal or GPO)
 * no longer surface the "There is no script engine for file extension '.vbs'"
 * dialog after an update.
 *
 * The generated batch delegates to PowerShell via -EncodedCommand so localized
 * paths and arguments round-trip through UTF-16 without depending on the host
 * console code page.
 *
 * @param command The PowerShell helper launch command and arguments.
 * @returns The CMD script content.
 */
const createWindowsUpdateLauncherScript = (command: string[]): string => {
  const [powershellPath, ...rest] = command;
  const targetPath = powershellPath ?? "powershell.exe";
  const startProcess = [
    "Start-Process",
    "-FilePath",
    quotePowerShellSingleQuoted(targetPath),
    "-ArgumentList",
    quotePowerShellArgumentList(rest),
    "-WindowStyle",
    "Hidden"
  ].join(" ");
  const encodedCommand = Buffer.from(startProcess, "utf16le").toString("base64");
  return [
    "@echo off",
    `start "" /B "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${encodedCommand}`,
    '(goto) 2>nul & del "%~f0"',
    ""
  ].join("\r\n");
};

/**
 * Creates a Windows launcher file that does not depend on Windows Script Host.
 *
 * The launcher is a CMD batch that hands off to PowerShell via -EncodedCommand
 * so non-ASCII install paths survive the OEM console code page. The batch
 * deletes itself once dispatched.
 */
export const createWindowsUpdateLauncherFile = (command: string[]): Buffer => {
  const script = createWindowsUpdateLauncherScript(command);
  return Buffer.from(script, "utf8");
};

const quotePowerShellArgumentList = (values: string[]): string => {
  if (values.length === 0) {
    return "@()";
  }
  return values.map(quotePowerShellSingleQuoted).join(",");
};

const quotePowerShellSingleQuoted = (value: string): string => {
  return `'${value.replace(/'/g, "''")}'`;
};
