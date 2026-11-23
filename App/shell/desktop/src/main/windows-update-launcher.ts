import type { ChildProcess } from "node:child_process";

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
  const executable = command[0];
  if (!executable) throw new Error("Windows update helper command requires an executable");
  // Start-Process joins string[] without adding quotes. Build the Windows command
  // line ourselves, then embed it as one literal PowerShell string.
  const argumentList = command.slice(1).map(quoteWindowsArgument).join(" ");
  const argumentAssignment = command.length > 1
    ? `\n  $startArguments['ArgumentList'] = '${escapePowerShellString(argumentList)}'`
    : "";
  return `$ErrorActionPreference = 'Stop'
$launcherPath = $PSCommandPath
$exitCode = 0
try {
  $startArguments = @{ FilePath = '${escapePowerShellString(executable)}'; WindowStyle = 'Hidden'; ErrorAction = 'Stop' }${argumentAssignment}
  Start-Process @startArguments
} catch {
  $message = "Failed to start Memmy Windows update helper: $($_.Exception.Message)"
  Add-Content -LiteralPath ($launcherPath + '.log') -Value $message -Encoding UTF8 -ErrorAction SilentlyContinue
  [Console]::Error.WriteLine($message)
  $exitCode = 1
} finally {
  Remove-Item -LiteralPath $launcherPath -Force -ErrorAction SilentlyContinue
}
exit $exitCode
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
  return Buffer.from(`\uFEFF${script}`, "utf16le");
};

/** Do not quit the application until PowerShell confirms the helper was started. */
export const waitForWindowsUpdateLauncher = (
  child: Pick<ChildProcess, "once" | "removeListener" | "kill">,
  timeoutMs = 10_000
): Promise<void> => new Promise((resolve, reject) => {
  let settled = false;
  const finish = (error?: Error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.removeListener("error", onError);
    child.removeListener("close", onClose);
    if (error) reject(error); else resolve();
  };
  const onError = (error: Error) => finish(error);
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    finish(code === 0 ? undefined : new Error(`Windows update launcher exited with code ${code ?? "unknown"}${signal ? ` (${signal})` : ""}`));
  };
  const timer = setTimeout(() => {
    finish(new Error("Windows update launcher timed out before starting the helper"));
    try { child.kill(); } catch { /* The launcher may have exited at the deadline. */ }
  }, timeoutMs);
  child.once("error", onError);
  child.once("close", onClose);
});

/** Preserve quotes, empty values, and backslashes before quotes or the closing quote. */
const quoteWindowsArgument = (value: string): string => {
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1')}"`;
};

const escapePowerShellString = (value: string): string => {
  return value.replaceAll("'", "''");
};
