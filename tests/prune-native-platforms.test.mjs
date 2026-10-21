import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { pruneNativePlatforms as pruneNodePtyPlatforms } from "../scripts/internal/shared/prune-native-platforms-lib.mjs";

const roots = [];
const targets = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

describe("packaged node-pty target selection", () => {
  it.each(targets)("keeps %s and the JS wrapper in nested runtime packages", async target => {
    const { root, scopes } = fixture();
    const [platform, arch] = target.split("-");
    const result = await pruneNodePtyPlatforms({ platform, arch, runtimeRoot: root });
    expect(result.removedPackages).toHaveLength(scopes.length * 5);
    for (const scope of scopes) {
      for (const candidate of targets) {
        expect(existsSync(join(scope, `node-pty-${candidate}`))).toBe(candidate === target);
      }
      expect(readFileSync(join(scope, "node-pty", "lib", "index.js"), "utf8")).toBe("wrapper");
      expect(existsSync(join(scope, "node-pty-darwin-arm64-extra", "index.js"))).toBe(true);
    }
    expect(await pruneNodePtyPlatforms({ platform, arch, runtimeRoot: root }))
      .toMatchObject({ removedPackages: [] });
  });

  it("rejects a missing later nested target before deleting from earlier scopes", async () => {
    const { root, scopes } = fixture();
    rmSync(join(scopes.at(-1), "node-pty-darwin-arm64"), { recursive: true });
    await expect(pruneNodePtyPlatforms({ platform: "darwin", arch: "arm64", runtimeRoot: root }))
      .rejects.toThrow(/Missing native (directory|path)/u);
    for (const scope of scopes) expect(existsSync(join(scope, "node-pty-linux-x64"))).toBe(true);
  });

  it("rejects foreign CPU native payloads before deleting optional packages", async () => {
    const { root, scopes } = fixture();
    const binary = join(scopes.at(-1), "node-pty-darwin-arm64", "prebuilds", "darwin-arm64", "pty.node");
    writeFileSync(binary, nativeHeader("linux", "x64"));
    await expect(pruneNodePtyPlatforms({ platform: "darwin", arch: "arm64", runtimeRoot: root }))
      .rejects.toThrow(/Wrong native payload/u);
    expect(existsSync(join(scopes[0], "node-pty-linux-x64"))).toBe(true);
  });

  it("requires the Windows DLL and console executable with matching CPU", async () => {
    const { root, scopes } = fixture();
    const binary = join(scopes[0], "node-pty-win32-x64", "prebuilds", "win32-x64", "conpty", "OpenConsole.exe");
    writeFileSync(binary, nativeHeader("win32", "arm64"));
    await expect(pruneNodePtyPlatforms({ platform: "win32", arch: "x64", runtimeRoot: root }))
      .rejects.toThrow(/Wrong native payload/u);
    expect(existsSync(join(scopes[0], "node-pty-darwin-arm64"))).toBe(true);
  });

  it.each(["target", "incompatible", "payload", "nested node_modules", "scope", "root"])(
    "refuses a %s symlink without touching external data", async kind => {
      const { root, scopes } = fixture();
      const external = newRoot();
      writeFileSync(join(external, "keep.txt"), "external-data");
      let link;
      if (kind === "target") link = join(scopes.at(-1), "node-pty-darwin-arm64");
      if (kind === "incompatible") link = join(scopes.at(-1), "node-pty-linux-x64");
      if (kind === "payload") link = join(scopes.at(-1), "node-pty-darwin-arm64", "prebuilds");
      if (kind === "nested node_modules") link = dirname(scopes.at(-1));
      if (kind === "scope") link = scopes.at(-1);
      if (kind === "root") link = join(newRoot(), "runtime-link");
      if (kind !== "root") rmSync(link, { recursive: true });
      symlinkSync(kind === "root" ? root : external, link, process.platform === "win32" ? "junction" : "dir");
      await expect(pruneNodePtyPlatforms({
        platform: "darwin", arch: "arm64", runtimeRoot: kind === "root" ? link : root,
      })).rejects.toThrow(/symbolic link/u);
      expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("external-data");
      expect(existsSync(join(scopes[0], "node-pty-linux-x64"))).toBe(true);
    },
  );

  it("does not follow unrelated npm package links", async () => {
    const { root, scopes } = fixture();
    const external = newRoot();
    const externalScope = join(external, "node_modules", "@lydell");
    populateScope(externalScope);
    symlinkSync(external, join(root, "memmy-agent", "node_modules", "linked-package"), process.platform === "win32" ? "junction" : "dir");
    await pruneNodePtyPlatforms({ platform: "darwin", arch: "arm64", runtimeRoot: root });
    expect(existsSync(join(externalScope, "node-pty-linux-x64"))).toBe(true);
    expect(existsSync(join(scopes[0], "node-pty-linux-x64"))).toBe(false);
  });

  it("executes the CLI wired before packaging on Mac and Windows", () => {
    const { root } = fixture();
    const cli = fileURLToPath(new URL("../scripts/internal/shared/prune-native-platforms.mjs", import.meta.url));
    const result = spawnSync(process.execPath, [cli, "--platform", "darwin", "--arch", "arm64", "--runtime-root", root], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).removedPackages).toHaveLength(15);
    for (const path of ["../scripts/internal/mac/build-dmg.sh", "../scripts/internal/win/build-nsis.sh"]) {
      const source = readFileSync(new URL(path, import.meta.url), "utf8");
      expect(source.indexOf("prune-native-platforms.mjs")).toBeGreaterThan(-1);
      expect(source.indexOf("prune-native-platforms.mjs")).toBeLessThan(source.lastIndexOf("npx electron-builder"));
    }
  });

  it("rejects a relative runtime root", async () => {
    await expect(pruneNodePtyPlatforms({ platform: "darwin", arch: "arm64", runtimeRoot: "runtime" }))
      .rejects.toThrow(/absolute path/u);
  });
});

describe("other bounded native dependency layouts", () => {
  it.each(targets)("preserves %s parser, SQLite and terminal native features", async target => {
    const { root } = fixture();
    const [platform, arch] = target.split("-");
    const nodeModules = join(root, "memmy-agent", "node_modules", "openclaw", "node_modules");
    const paths = populateOtherLayouts(nodeModules);
    await pruneNodePtyPlatforms({ platform, arch, runtimeRoot: root });
    for (const candidate of targets) {
      const [candidatePlatform, candidateArch] = candidate.split("-");
      expect(existsSync(join(paths.tree, "prebuilds", candidate))).toBe(candidate === target);
      const sqliteName = `sqlite-vec-${candidatePlatform === "win32" ? "windows" : candidatePlatform}-${candidateArch}`;
      expect(existsSync(join(nodeModules, sqliteName))).toBe(candidate === target);
      if (candidatePlatform !== "linux") {
        expect(existsSync(join(paths.tui, "native", candidatePlatform, "prebuilds", candidate))).toBe(candidate === target);
      }
    }
    for (const path of [join(paths.tree, "bindings/node/index.js"), join(paths.tui, "dist/index.js"), join(nodeModules, "sqlite-vec", "index.js")]) {
      expect(readFileSync(path, "utf8")).toBe("wrapper");
    }
    expect(existsSync(join(paths.tree, "prebuilds", "unknown-platform", "keep.txt"))).toBe(true);
  });

  it.each(["tree", "SQLite", "terminal"])("fails before any deletion when %s target payload is missing", async kind => {
    const { root, scopes } = fixture();
    const nodeModules = join(root, "memmy-agent", "node_modules", "openclaw", "node_modules");
    const paths = populateOtherLayouts(nodeModules);
    const missing = kind === "tree" ? join(paths.tree, "prebuilds/darwin-arm64/tree-sitter-bash.node")
      : kind === "SQLite" ? join(nodeModules, "sqlite-vec-darwin-arm64/vec0.dylib")
        : join(paths.tui, "native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node");
    rmSync(missing);
    await expect(pruneNodePtyPlatforms({ platform: "darwin", arch: "arm64", runtimeRoot: root }))
      .rejects.toThrow(/Missing native path/u);
    expect(existsSync(join(scopes[0], "node-pty-linux-x64"))).toBe(true);
    expect(existsSync(join(paths.tree, "prebuilds", "win32-x64"))).toBe(true);
    expect(existsSync(join(paths.tui, "native", "win32"))).toBe(true);
  });

  it("refuses an unexpected package identity or a Win-only subtree symlink before pruning", async () => {
    const { root, scopes } = fixture();
    const nodeModules = join(root, "memmy-agent", "node_modules", "openclaw", "node_modules");
    const paths = populateOtherLayouts(nodeModules);
    writeFileSync(join(paths.tui, "package.json"), JSON.stringify({ name: "other-package" }));
    await expect(pruneNodePtyPlatforms({ platform: "darwin", arch: "arm64", runtimeRoot: root }))
      .rejects.toThrow(/Wrong native package identity/u);
    writeFileSync(join(paths.tui, "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui" }));
    const external = newRoot();
    writeFileSync(join(external, "keep.txt"), "external-data");
    rmSync(join(paths.tui, "native", "win32"), { recursive: true });
    symlinkSync(external, join(paths.tui, "native", "win32"), process.platform === "win32" ? "junction" : "dir");
    await expect(pruneNodePtyPlatforms({ platform: "darwin", arch: "arm64", runtimeRoot: root }))
      .rejects.toThrow(/symbolic link/u);
    expect(readFileSync(join(external, "keep.txt"), "utf8")).toBe("external-data");
    expect(existsSync(join(scopes[0], "node-pty-linux-x64"))).toBe(true);
  });
});

function newRoot() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "memmy-node-pty-prune-"));
  roots.push(root);
  return root;
}

function fixture() {
  const root = newRoot();
  const scopes = [
    join(root, "memory", "node_modules", "@lydell"),
    join(root, "memmy-agent", "node_modules", "openclaw", "node_modules", "@lydell"),
    join(root, "memmy-agent", "node_modules", "@scope", "nested", "node_modules", "@lydell"),
  ];
  scopes.forEach(populateScope);
  return { root, scopes };
}

function populateScope(scope) {
  for (const target of targets) {
    const [platform, arch] = target.split("-");
    const payload = join(scope, `node-pty-${target}`, "prebuilds", target);
    mkdirSync(payload, { recursive: true });
    writeFileSync(join(dirname(dirname(payload)), "package.json"), JSON.stringify({ name: `@lydell/node-pty-${target}` }));
    const files = platform === "win32"
      ? ["conpty.node", "conpty_console_list.node", "conpty/conpty.dll", "conpty/OpenConsole.exe"]
      : platform === "darwin" ? ["pty.node", "spawn-helper"] : ["pty.node"];
    for (const file of files) {
      const path = join(payload, file);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, nativeHeader(platform, arch));
    }
  }
  for (const name of ["node-pty", "node-pty-darwin-arm64-extra"]) {
    const file = join(scope, name, name === "node-pty" ? "lib/index.js" : "index.js");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "wrapper");
  }
}

function nativeHeader(platform, arch) {
  const bytes = Buffer.alloc(128);
  if (platform === "darwin") {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(arch === "arm64" ? 0x0100000c : 0x01000007, 4);
  } else if (platform === "win32") {
    bytes.write("MZ");
    bytes.writeUInt32LE(64, 0x3c);
    bytes.writeUInt32LE(0x00004550, 64);
    bytes.writeUInt16LE(arch === "arm64" ? 0xaa64 : 0x8664, 68);
  } else {
    bytes.write("7f454c46", 0, "hex");
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(arch === "arm64" ? 183 : 62, 18);
  }
  return bytes;
}

function populateOtherLayouts(nodeModules) {
  const tree = join(nodeModules, "tree-sitter-bash");
  const tui = join(nodeModules, "@earendil-works", "pi-tui");
  for (const [path, name] of [[tree, "tree-sitter-bash"], [tui, "@earendil-works/pi-tui"]]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name }));
  }
  for (const target of targets) {
    const [platform, arch] = target.split("-");
    const treeFile = join(tree, "prebuilds", target, "tree-sitter-bash.node");
    mkdirSync(dirname(treeFile), { recursive: true });
    writeFileSync(treeFile, nativeHeader(platform, arch));
    const sqliteName = `sqlite-vec-${platform === "win32" ? "windows" : platform}-${arch}`;
    const sqlite = join(nodeModules, sqliteName);
    mkdirSync(sqlite, { recursive: true });
    writeFileSync(join(sqlite, "package.json"), JSON.stringify({ name: sqliteName }));
    writeFileSync(join(sqlite, `vec0.${platform === "darwin" ? "dylib" : platform === "win32" ? "dll" : "so"}`), nativeHeader(platform, arch));
    if (platform !== "linux") {
      const file = join(tui, "native", platform, "prebuilds", target,
        platform === "darwin" ? "darwin-modifiers.node" : "win32-console-mode.node");
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, nativeHeader(platform, arch));
    }
  }
  for (const path of [join(tree, "bindings/node/index.js"), join(tui, "dist/index.js"), join(nodeModules, "sqlite-vec", "index.js"), join(tree, "prebuilds/unknown-platform/keep.txt")]) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "wrapper");
  }
  return { tree, tui };
}
