import { execFile as execFileCallback } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, {
    recursive: true,
    force: true
  })));
});

describe("package logging", () => {
  it("captures command output and marks failures raised inside shell functions", async () => {
    const repositoryRoot = resolve(import.meta.dirname, "..");
    const parent = join(repositoryRoot, ".tmp");
    await mkdir(parent, { recursive: true });
    const temporaryDirectory = await mkdtemp(join(parent, "memmy-package-logging-"));
    temporaryDirectories.push(temporaryDirectory);
    const logPath = join(temporaryDirectory, "package.log");
    const bashLogPath = relative(repositoryRoot, logPath).replaceAll("\\", "/");
    const script = [
      "set -euo pipefail",
      "source scripts/internal/shared/package-logging.sh",
      `MEMMY_PACKAGE_LOG_FILE='${bashLogPath.replaceAll("'", "'\\''")}'`,
      "export MEMMY_PACKAGE_LOG_FILE",
      "package_log_init test-package-logging .",
      "package_install_error_trap",
      "package_step_start nested-function",
      "fail_nested() {",
      "  printf 'REAL_STDOUT\\n'",
      "  printf 'REAL_STDERR\\n' >&2",
      "  return 23",
      "}",
      "invoke_nested() { fail_nested; }",
      "invoke_nested"
    ].join("\n");

    let failure;
    try {
      await execFile("bash", ["-c", script], {
        cwd: repositoryRoot
      });
    } catch (error) {
      failure = error;
    }
    expect({ code: failure?.code, stdout: failure?.stdout, stderr: failure?.stderr }).toMatchObject({ code: 23 });
    expect(failure?.stdout).toContain("REAL_STDOUT");
    expect(failure?.stderr).toContain("REAL_STDERR");

    const log = await readFile(logPath, "utf8");
    expect(log).toContain("REAL_STDOUT");
    expect(log).toContain("REAL_STDERR");
    expect(log).toContain("FAILED: nested-function");
    expect(log).toContain("with exit code 23");
  });
});
