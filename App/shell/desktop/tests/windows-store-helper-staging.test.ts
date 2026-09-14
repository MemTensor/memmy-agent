import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stageWindowsStoreUnpackagedHelper } from "../src/main/windows-store-helper-staging.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(temporaryDirectories.splice(0).map((path) =>
    rm(path, { recursive: true, force: true })
  ));
});

describe("Windows Store helper staging", () => {
  it("writes the packaged helper bytes without cloning source file metadata", async () => {
    const fixture = await createFixture();
    const sourceBytes = Buffer.from("packaged-helper-bytes");
    await writeFile(fixture.sourcePath, sourceBytes);

    await stageWindowsStoreUnpackagedHelper(fixture.sourcePath, fixture.destinationPath);

    await expect(readFile(fixture.destinationPath)).resolves.toEqual(sourceBytes);
  });

  it("atomically replaces a stale helper with the current packaged bytes", async () => {
    const fixture = await createFixture();
    const sourceBytes = Buffer.from("current-packaged-helper");
    await writeFile(fixture.sourcePath, sourceBytes);
    await mkdir(join(fixture.root, "external"), { recursive: true });
    await writeFile(fixture.destinationPath, "stale-helper");

    await stageWindowsStoreUnpackagedHelper(fixture.sourcePath, fixture.destinationPath);

    await expect(readFile(fixture.destinationPath)).resolves.toEqual(sourceBytes);
  });

  it("does not replace an existing helper when staged-byte verification fails", async () => {
    const fixture = await createFixture();
    await writeFile(fixture.sourcePath, "current-packaged-helper");
    await mkdir(join(fixture.root, "external"), { recursive: true });
    await writeFile(fixture.destinationPath, "known-good-helper");

    await expect(stageWindowsStoreUnpackagedHelper(
      fixture.sourcePath,
      fixture.destinationPath,
      { readStagedFile: async () => Buffer.from("corrupt-staged-helper") }
    )).rejects.toThrow("verification failed");
    await expect(readFile(fixture.destinationPath, "utf8")).resolves.toBe("known-good-helper");
  });
});

const createFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "memmy-store-helper-staging-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "packaged"), { recursive: true });
  return {
    root,
    sourcePath: join(root, "packaged", "MemmyStoreUpdate.exe"),
    destinationPath: join(root, "external", "MemmyStoreUpdate.exe")
  };
};
