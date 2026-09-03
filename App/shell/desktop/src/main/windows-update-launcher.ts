/**
 * Creates the VBS script that launches the Windows update helper hidden.
 *
 * @param command The PowerShell helper launch command and arguments.
 * @returns The VBS script content.
 */
const createWindowsUpdateLauncherScript = (command: string[]): string => {
  const shellCommand = command.map(quoteWindowsShellArgument).join(" ");
  return `Set shell = CreateObject("WScript.Shell")
shell.Run "${escapeVbsString(shellCommand)}", 0, False
Set fso = CreateObject("Scripting.FileSystemObject")
On Error Resume Next
fso.DeleteFile WScript.ScriptFullName, True
`;
};

/**
 * Creates a Windows Script Host compatible launcher file.
 *
 * Windows Script Host may decode a BOM-less UTF-8 VBS file with the active
 * system code page, corrupting non-ASCII update paths before PowerShell starts.
 */
export const createWindowsUpdateLauncherFile = (command: string[]): Buffer => {
  const script = createWindowsUpdateLauncherScript(command);
  return Buffer.from(`\uFEFF${script}`, "utf16le");
};

const quoteWindowsShellArgument = (value: string): string => {
  return `"${value.replace(/"/g, "\\\"")}"`;
};

const escapeVbsString = (value: string): string => {
  return value.replace(/"/g, "\"\"");
};
