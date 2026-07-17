/** Index tests. */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeRuntimeConfigFile } from "../index.js";

let tempDir: string | undefined;

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  }
});

describe("writeRuntimeConfigFile", () => {
  it("writes runtime config with owner-only file permissions", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "memmy-runtime-config-"));
    const runtimeConfigPath = join(tempDir, ".memmy", "runtime.json");

    await writeRuntimeConfigFile(
      {
        baseUrl: "http://127.0.0.1:12345",
        localToken: "runtime-token"
      },
      runtimeConfigPath
    );

    expect(statSync(join(tempDir, ".memmy")).mode & 0o777).toBe(0o700);
    expect(statSync(runtimeConfigPath).mode & 0o777).toBe(0o600);
  });
});
