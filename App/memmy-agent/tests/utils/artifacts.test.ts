import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setConfigPath } from "../../src/config/loader.js";
import {
  ArtifactError,
  decodeImageDataUrl,
  storeGeneratedImageArtifact,
} from "../../src/utils/artifacts.js";

const PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";

const originalConfig = process.env.MEMMY_CONFIG;
const originalDataDir = process.env.MEMMY_AGENT_DATA_DIR;
const roots: string[] = [];

function tmpRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  setConfigPath(null);
  if (originalConfig === undefined) delete process.env.MEMMY_CONFIG;
  else process.env.MEMMY_CONFIG = originalConfig;
  if (originalDataDir === undefined) delete process.env.MEMMY_AGENT_DATA_DIR;
  else process.env.MEMMY_AGENT_DATA_DIR = originalDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("artifact helpers", () => {
  it("decodes and validates image data URLs", () => {
    const [raw, mime] = decodeImageDataUrl(PNG_DATA_URL);
    expect(raw.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(mime).toBe("image/png");
    expect(() => decodeImageDataUrl("data:image/png;base64,not-base64")).toThrow(ArtifactError);
  });

  it("writes generated image artifacts and sidecar metadata", () => {
    const root = tmpRoot("memmy-artifacts-");
    delete process.env.MEMMY_AGENT_DATA_DIR;
    setConfigPath(path.join(root, "config.yaml"));
    const createdAt = new Date("2026-05-08T12:00:00.000Z");

    const artifact = storeGeneratedImageArtifact(PNG_DATA_URL, {
      prompt: "draw a tiny pixel",
      model: "openai/gpt-5.4-image-2",
      sourceImages: ["/tmp/ref.png"],
      saveDir: "generated",
      createdAt,
    });

    expect(fs.existsSync(artifact.path)).toBe(true);
    expect(path.dirname(artifact.path)).toBe(path.join(root, "media", "generated", "2026-05-08"));
    expect(artifact.id).toMatch(/^img_/);
    expect(artifact.mime).toBe("image/png");
    const sidecar = JSON.parse(fs.readFileSync(artifact.path.replace(/\.png$/, ".json"), "utf8"));
    expect(sidecar.path).toBe(artifact.path);
    expect(sidecar.source_images).toEqual(["/tmp/ref.png"]);
  });

  it("writes generated image artifacts under MEMMY_AGENT_DATA_DIR media when configured", () => {
    const root = tmpRoot("memmy-artifacts-");
    const dataDir = path.join(root, "stable-data");
    process.env.MEMMY_AGENT_DATA_DIR = dataDir;
    setConfigPath(path.join(root, "tmp-config", "config.yaml"));

    const artifact = storeGeneratedImageArtifact(PNG_DATA_URL, {
      prompt: "draw a tiny pixel",
      model: "openai/gpt-5.4-image-2",
      saveDir: "generated",
      createdAt: new Date("2026-05-08T12:00:00.000Z"),
    });

    expect(path.dirname(artifact.path)).toBe(path.join(dataDir, "media", "generated", "2026-05-08"));
  });

  it("rejects unsafe save directories", () => {
    const root = tmpRoot("memmy-artifacts-");
    setConfigPath(path.join(root, "config.yaml"));
    expect(() => storeGeneratedImageArtifact(PNG_DATA_URL, { prompt: "x", model: "m", saveDir: "../outside" })).toThrow(
      ArtifactError,
    );
  });
});
