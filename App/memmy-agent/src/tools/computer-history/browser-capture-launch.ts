import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Open the ordinary installed browser; never change its profile or enable remote debugging. */
export async function launchTeachingBrowser(browser: "chrome" | "edge", platform = process.platform): Promise<void> {
  let executable: string, args: string[], wait = false;
  if (platform === "darwin") {
    executable = "/usr/bin/open"; args = ["-a", browser === "chrome" ? "Google Chrome" : "Microsoft Edge"]; wait = true;
  } else if (platform === "win32") {
    const product = browser === "chrome" ? ["Google", "Chrome"] : ["Microsoft", "Edge"];
    const binary = browser === "chrome" ? "chrome.exe" : "msedge.exe";
    const roots = [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA].filter((root): root is string => !!root);
    const found = roots.map(root => path.win32.join(root, ...product, "Application", binary)).find(file => fs.existsSync(file));
    if (!found) throw new Error("browser_capture_browser_not_installed");
    executable = found; args = [];
  } else throw new Error("browser_capture_platform_unsupported");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: "ignore", windowsHide: false });
    const timer = setTimeout(() => reject(new Error("browser_capture_browser_launch_timeout")), 8_000);
    const done = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); };
    child.once("error", () => done(new Error("browser_capture_browser_launch_failed")));
    if (wait) child.once("exit", code => done(code === 0 ? undefined : new Error("browser_capture_browser_launch_failed")));
    else child.once("spawn", () => { child.unref(); done(); });
  });
}
