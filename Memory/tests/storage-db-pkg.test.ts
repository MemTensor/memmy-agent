import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryDb } from "../src/storage/db.js";

const fixture = vi.hoisted(() => ({
  systemTmp: "",
  root: "",
  temp: "",
  modulePath: "",
  vectorSource: "",
  interleave: undefined as undefined | { asset: string; run(): void },
  renameConflict: undefined as undefined | { publishCompleteAsset: boolean },
  bindings: [] as Array<{ path?: string; bytes?: Buffer; readonly: boolean }>,
  extensions: [] as Array<{ path: string; bytes?: Buffer }>,
  writes: [] as string[],
}));

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  fixture.systemTmp = original.tmpdir();
  return { ...original, tmpdir: () => fixture.temp };
});

vi.mock("node:url", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:url")>(),
  // The compatibility branch assumes a compiled repository-layout snapshot.
  fileURLToPath: () => fixture.modulePath,
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  function interleaveWrite(target: string, bytes: Buffer): void {
    fixture.writes.push(target);
    const interleave = fixture.interleave;
    if (!interleave || !target.includes(interleave.asset)) return;
    fixture.interleave = undefined;
    original.writeFileSync(target, bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
    interleave.run();
  }
  return {
    ...original,
    copyFileSync: vi.fn((source: string, target: string) => {
      interleaveWrite(target, original.readFileSync(source));
      original.copyFileSync(source, target);
    }),
    renameSync: vi.fn((source: string, target: string) => {
      const conflict = fixture.renameConflict;
      if (conflict) {
        fixture.renameConflict = undefined;
        if (conflict.publishCompleteAsset) original.copyFileSync(source, target);
        throw Object.assign(new Error("native cache publication denied"), { code: "EACCES" });
      }
      original.renameSync(source, target);
    }),
    writeFileSync: vi.fn((target: string, contents: string | Buffer, options?: import("node:fs").WriteFileOptions) => {
      if (target.startsWith(join(fixture.temp, "memmy-memory-native"))) {
        const bytes = Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
        const interleaved = fixture.interleave && target.includes(fixture.interleave.asset);
        interleaveWrite(target, bytes);
        // Finish the same simulated write after a second process observes the filesystem.
        if (interleaved) {
          original.writeFileSync(target, contents, typeof options === "object" ? { ...options, flag: "w" } : options);
          return;
        }
      }
      original.writeFileSync(target, contents, options);
    }),
  };
});

vi.mock("better-sqlite3", () => ({
  default: vi.fn(function (_path: string, options: { nativeBinding?: string; readonly: boolean }) {
    fixture.bindings.push({
      path: options.nativeBinding,
      bytes: options.nativeBinding ? readFileSync(options.nativeBinding) : undefined,
      readonly: options.readonly,
    });
    return {
      loadExtension(path: string) {
        fixture.extensions.push({ path, bytes: existsSync(path) ? readFileSync(path) : undefined });
      },
      prepare: () => ({ get: () => ({ version: "v0.1.9" }) }),
      pragma: vi.fn(),
      close: vi.fn(),
    };
  }),
}));
vi.mock("sqlite-vec", () => ({ getLoadablePath: () => fixture.vectorSource }));
vi.mock("../src/storage/schema.js", () => ({ getSchemaVersion: vi.fn(), migrate: vi.fn(), SCHEMA_VERSION: 1 }));
vi.mock("../src/storage/sqlite-vec-store.js", () => ({ SQLITE_VEC_VERSION: "0.1.9" }));

const processWithPkg = process as NodeJS.Process & { pkg?: unknown };
let originalPkg: PropertyDescriptor | undefined;
let bindingSource: string;
const bindingBytes = Buffer.from("fixture sqlite binding version one");
const vectorBytes = Buffer.from("fixture vector extension version one");

beforeEach(() => {
  fixture.root = mkdtempSync(join(fixture.systemTmp, "memmy-storage-pkg-test-"));
  fixture.temp = join(fixture.root, "tmp");
  fixture.modulePath = join(fixture.root, "snapshot", "product", "Memory", "dist", "src", "storage", "db.js");
  bindingSource = join(fixture.root, "snapshot", "product", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
  fixture.vectorSource = join(fixture.root, "snapshot", "product", "node_modules", "sqlite-vec-test", "vec0.dylib");
  for (const path of [bindingSource, fixture.vectorSource]) mkdirSync(dirname(path), { recursive: true });
  writeFileSync(bindingSource, bindingBytes);
  writeFileSync(fixture.vectorSource, vectorBytes);
  fixture.bindings = [];
  fixture.extensions = [];
  fixture.writes = [];
  originalPkg = Object.getOwnPropertyDescriptor(process, "pkg");
  Object.defineProperty(process, "pkg", { configurable: true, writable: true, value: { entrypoint: "fixture" } });
});

afterEach(() => {
  fixture.interleave = undefined;
  fixture.renameConflict = undefined;
  if (originalPkg) Object.defineProperty(process, "pkg", originalPkg);
  else delete processWithPkg.pkg;
  rmSync(fixture.root, { recursive: true, force: true });
  vi.clearAllMocks();
});

function openDatabase(): MemoryDb {
  return new MemoryDb({ path: join(fixture.root, "memory.sqlite"), readonly: true });
}

describe("Memory SQLite assets in a pkg snapshot", () => {
  it("extracts the compiled-layout binding and vector extension before passing them to SQLite", () => {
    openDatabase().close();
    expect(fixture.bindings).toHaveLength(1);
    expect(fixture.bindings[0]).toMatchObject({ readonly: true, bytes: bindingBytes });
    expect(fixture.extensions[0]?.bytes).toEqual(vectorBytes);
    for (const path of [fixture.bindings[0]?.path, fixture.extensions[0]?.path]) {
      expect(path?.startsWith(join(fixture.temp, "memmy-memory-native"))).toBe(true);
    }
  });

  it("reuses a complete extraction when source bytes are unchanged", () => {
    openDatabase().close();
    const firstWrites = [...fixture.writes];
    openDatabase().close();
    expect(fixture.bindings[1]?.path).toBe(fixture.bindings[0]?.path);
    expect(fixture.extensions[1]?.path).toBe(fixture.extensions[0]?.path);
    expect(fixture.writes).toEqual(firstWrites);
  });

  it.each(["memory-package", "standalone-bundle"])("resolves the %s binding without losing content-addressed extraction", (layout) => {
    const packageRoot = join(fixture.root, "snapshot", "standalone");
    const moduleDirectory = layout === "memory-package"
      ? join(packageRoot, "dist", "src", "storage")
      : join(packageRoot, "bundle");
    fixture.modulePath = join(moduleDirectory, "db.js");
    const nativeRoot = layout === "memory-package" ? packageRoot : moduleDirectory;
    const nativeSource = join(nativeRoot, "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node");
    mkdirSync(dirname(nativeSource), { recursive: true });
    writeFileSync(nativeSource, bindingBytes);
    openDatabase().close();
    expect(fixture.bindings[0]?.bytes).toEqual(bindingBytes);
    expect(fixture.bindings[0]?.path?.startsWith(join(fixture.temp, "memmy-memory-native"))).toBe(true);
  });

  it("uses new source bytes after an upgrade without overwriting assets used by an older process", () => {
    openDatabase().close();
    const oldBinding = fixture.bindings[0]!.path!;
    const oldVector = fixture.extensions[0]!.path;
    const upgradedBinding = Buffer.from("fixture sqlite binding version two");
    const upgradedVector = Buffer.from("fixture vector extension version two");
    writeFileSync(bindingSource, upgradedBinding);
    writeFileSync(fixture.vectorSource, upgradedVector);
    openDatabase().close();
    expect(fixture.bindings[1]?.bytes).toEqual(upgradedBinding);
    expect(fixture.extensions[1]?.bytes).toEqual(upgradedVector);
    expect(fixture.bindings[1]?.path).not.toBe(oldBinding);
    expect(fixture.extensions[1]?.path).not.toBe(oldVector);
    expect(readFileSync(oldBinding)).toEqual(bindingBytes);
    expect(readFileSync(oldVector)).toEqual(vectorBytes);
  });

  it("ignores old shared basename caches", () => {
    const oldCache = join(fixture.temp, "memmy-memory-native");
    mkdirSync(oldCache, { recursive: true });
    writeFileSync(join(oldCache, "better_sqlite3.node"), "old binding");
    writeFileSync(join(oldCache, "vec0.dylib"), "old vector");
    openDatabase().close();
    expect(fixture.bindings[0]?.bytes).toEqual(bindingBytes);
    expect(fixture.extensions[0]?.bytes).toEqual(vectorBytes);
  });

  it("repairs an existing incomplete extraction before loading it", () => {
    openDatabase().close();
    writeFileSync(fixture.bindings[0]!.path!, "incomplete binding");
    writeFileSync(fixture.extensions[0]!.path, "incomplete vector");
    openDatabase().close();
    expect(fixture.bindings[1]?.bytes).toEqual(bindingBytes);
    expect(fixture.extensions[1]?.bytes).toEqual(vectorBytes);
  });

  it.each(["better_sqlite3.node", "vec0.dylib"])("never exposes an incomplete %s to a concurrent opener", (asset) => {
    fixture.interleave = { asset, run: () => openDatabase().close() };
    openDatabase().close();
    expect(fixture.interleave).toBeUndefined();
    expect(fixture.bindings).toHaveLength(2);
    expect(fixture.bindings.every((entry) => entry.bytes?.equals(bindingBytes))).toBe(true);
    expect(fixture.extensions.every((entry) => entry.bytes?.equals(vectorBytes))).toBe(true);
    expect(readdirSync(join(fixture.temp, "memmy-memory-native"), { recursive: true }).some((path) => String(path).endsWith(".tmp"))).toBe(false);
  });

  it("uses an identical asset published by another process if replacement is denied", () => {
    fixture.renameConflict = { publishCompleteAsset: true };
    openDatabase().close();
    expect(fixture.renameConflict).toBeUndefined();
    expect(fixture.bindings[0]?.bytes).toEqual(bindingBytes);
    expect(fixture.extensions[0]?.bytes).toEqual(vectorBytes);
    expect(readdirSync(join(fixture.temp, "memmy-memory-native"), { recursive: true }).some((path) => String(path).endsWith(".tmp"))).toBe(false);
  });

  it("fails a denied publication without loading an incomplete asset or leaving temporary files", () => {
    fixture.renameConflict = { publishCompleteAsset: false };
    expect(openDatabase).toThrow("native cache publication denied");
    expect(fixture.bindings).toEqual([]);
    expect(readdirSync(join(fixture.temp, "memmy-memory-native"), { recursive: true }).some((path) => String(path).endsWith(".tmp"))).toBe(false);
  });

  it("preserves native loader fallback when snapshot assets are absent", () => {
    rmSync(bindingSource);
    rmSync(fixture.vectorSource);
    openDatabase().close();
    expect(fixture.bindings[0]?.path).toBeUndefined();
    expect(fixture.extensions[0]?.path).toBe(fixture.vectorSource);
    expect(existsSync(join(fixture.temp, "memmy-memory-native"))).toBe(false);
  });

  it("keeps ordinary Node native resolution and the original vector path", () => {
    delete processWithPkg.pkg;
    openDatabase().close();
    expect(fixture.bindings[0]?.path).toBeUndefined();
    expect(fixture.extensions[0]?.path).toBe(fixture.vectorSource);
    expect(existsSync(join(fixture.temp, "memmy-memory-native"))).toBe(false);
  });

  it("keeps Electron's existing app.asar.unpacked vector preference", () => {
    delete processWithPkg.pkg;
    fixture.vectorSource = join(fixture.root, "Memmy.app", "app.asar", "node_modules", "sqlite-vec-test", "vec0.dylib");
    const unpacked = fixture.vectorSource.replace("app.asar", "app.asar.unpacked");
    mkdirSync(dirname(unpacked), { recursive: true });
    writeFileSync(unpacked, vectorBytes);
    openDatabase().close();
    expect(fixture.bindings[0]?.path).toBeUndefined();
    expect(fixture.extensions[0]?.path).toBe(unpacked);
    expect(existsSync(join(fixture.temp, "memmy-memory-native"))).toBe(false);
  });
});
