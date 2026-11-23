import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readModelCapabilityCatalog, resolveDefaultModelCapabilityCatalogPath, writeModelCapabilityCatalog } from "../index.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>()
}));

const catalog = {
  catalogVersion: 21,
  models: {
    "gpt-4o": { inputModalities: ["text", "image"], contextWindowTokens: 128000, maxTokens: 16384 },
    "gpt-6-astra": {
      inputModalities: ["text", "image"], contextWindowTokens: 1050000, maxTokens: 128000,
      thinking: { switchable: false, defaultEnabled: true, levels: ["low", "medium", "high", "xhigh", "max"], defaultLevel: "medium" }
    }
  }
};

describe("model capability catalog file", () => {
  let directory: string;
  let filePath: string;
  beforeEach(async () => {
    directory = await fs.mkdtemp(join(tmpdir(), "memmy-model-catalog-"));
    filePath = resolveDefaultModelCapabilityCatalogPath(directory);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("resolves models.json independently of the runtime YAML configuration", () => {
    expect(filePath).toBe(join(directory, ".memmy", "models.json"));
  });

  it("returns null for a missing file without creating it", async () => {
    expect(await readModelCapabilityCatalog(filePath)).toBeNull();
    expect(await fs.readdir(directory)).toEqual([]);
  });

  it("creates the directory, persists a complete catalog and preserves omitted thinking", async () => {
    expect(await writeModelCapabilityCatalog(catalog, filePath)).toEqual(catalog);
    expect(await readModelCapabilityCatalog(filePath)).toEqual(catalog);
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).models["gpt-4o"]).not.toHaveProperty("thinking");
    expect(await fs.readdir(dirname(filePath))).toEqual(["models.json"]);
  });

  it("replaces the whole catalog so removed models do not survive", async () => {
    await writeModelCapabilityCatalog(catalog, filePath);
    const next = { catalogVersion: 22, models: { "gpt-4o": catalog.models["gpt-4o"] } };
    await writeModelCapabilityCatalog(next, filePath);
    expect(await readModelCapabilityCatalog(filePath)).toEqual(next);
  });

  it.each(["", "{", JSON.stringify({ ...catalog, catalogVersion: 0 }), JSON.stringify({
    ...catalog, models: { ...catalog.models, invalid: { ...catalog.models["gpt-4o"], thinking: null } }
  })])("rejects the whole invalid local file without rewriting it", async (content) => {
    await fs.mkdir(dirname(filePath));
    await fs.writeFile(filePath, content);
    expect(await readModelCapabilityCatalog(filePath)).toBeNull();
    expect(await fs.readFile(filePath, "utf8")).toBe(content);
  });

  it("rejects invalid updates before touching the valid local file", async () => {
    await writeModelCapabilityCatalog(catalog, filePath);
    const before = await fs.readFile(filePath, "utf8");
    await expect(writeModelCapabilityCatalog({ ...catalog, models: {
      ...catalog.models, invalid: { ...catalog.models["gpt-4o"], maxTokens: "16384" }
    } }, filePath)).rejects.toThrow();
    expect(await fs.readFile(filePath, "utf8")).toBe(before);
    expect(await fs.readdir(dirname(filePath))).toEqual(["models.json"]);
  });

  it("keeps the old catalog until rename and removes the temporary file if replacement fails", async () => {
    await writeModelCapabilityCatalog(catalog, filePath);
    const error = new Error("replacement failed");
    vi.spyOn(fs, "rename").mockImplementationOnce(async (source, target) => {
      expect(target).toBe(filePath);
      expect(dirname(source.toString())).toBe(dirname(filePath));
      expect(await readModelCapabilityCatalog(filePath)).toEqual(catalog);
      expect(JSON.parse(await fs.readFile(source, "utf8")).catalogVersion).toBe(22);
      throw error;
    });
    await expect(writeModelCapabilityCatalog({ ...catalog, catalogVersion: 22 }, filePath)).rejects.toBe(error);
    expect(await readModelCapabilityCatalog(filePath)).toEqual(catalog);
    expect(await fs.readdir(dirname(filePath))).toEqual(["models.json"]);
  });

  it("propagates read I/O failures instead of reporting an invalid catalog", async () => {
    const error = Object.assign(new Error("permission denied"), { code: "EACCES" });
    vi.spyOn(fs, "readFile").mockRejectedValueOnce(error);
    await expect(readModelCapabilityCatalog(filePath)).rejects.toBe(error);
  });

  it("keeps the old catalog and cleans up when flushing the update fails", async () => {
    await writeModelCapabilityCatalog(catalog, filePath);
    const originalOpen = fs.open;
    const error = Object.assign(new Error("disk full"), { code: "ENOSPC" });
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const file = await originalOpen(...args);
      vi.spyOn(file, "sync").mockRejectedValueOnce(error);
      return file;
    });
    await expect(writeModelCapabilityCatalog({ ...catalog, catalogVersion: 22 }, filePath)).rejects.toBe(error);
    expect(await readModelCapabilityCatalog(filePath)).toEqual(catalog);
    expect(await fs.readdir(dirname(filePath))).toEqual(["models.json"]);
  });

  it("flushes and closes the temporary file before replacement", async () => {
    const originalOpen = fs.open;
    const events: string[] = [];
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const file = await originalOpen(...args);
      const sync = file.sync.bind(file);
      const close = file.close.bind(file);
      vi.spyOn(file, "sync").mockImplementation(async () => { await sync(); events.push("sync"); });
      vi.spyOn(file, "close").mockImplementation(async () => { await close(); events.push("close"); });
      return file;
    });
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementationOnce(async (...args) => {
      expect(events).toEqual(["sync", "close"]);
      await rename(...args);
    });
    await writeModelCapabilityCatalog(catalog, filePath);
  });
});
