/**
 * Creates the PowerShell script that launches the Windows update helper hidden.
 *
 * Windows Script Host can be absent on machines where the optional VBScript
 * feature was removed, so the update helper must not go through a .vbs launcher.
 *
 * @param command The helper launch command and arguments.
 * @returns The PowerShell script content.
 */
const createWindowsUpdateLauncherScript = (command: string[]): string => {
  const argumentList = command.map((value) => `'${escapePowerShellString(value)}'`).join(", ");
  return `$ErrorActionPreference = 'Continue'
$arguments = @(${argumentList})
$launcherPath = $PSCommandPath
try {
  $startArguments = @{ FilePath = $arguments[0]; WindowStyle = 'Hidden' }
  if ($arguments.Length -gt 1) {
    $startArguments['ArgumentList'] = $arguments[1..($arguments.Length - 1)]
  }
  Start-Process @startArguments
} catch {
} finally {
  Remove-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue
}
`;
};

/**
 * Creates a Windows PowerShell compatible launcher file.
 *
 * Windows PowerShell 5 decodes a BOM-less script with the active system code page,
 * corrupting non-ASCII update paths before the helper starts.
 */
export const createWindowsUpdateLauncherFile = (command: string[]): Buffer => {
  const script = createWindowsUpdateLauncherScript(command);
  return Buffer.from(`﻿${script}`, "utf16le");
};

const escapePowerShellString = (value: string): string => {
  return value.replaceAll("'", "''");
};
