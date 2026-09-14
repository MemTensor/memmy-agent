import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "../../src/config/loader.js";
import { ImageGenerationToolConfig } from "../../src/config/schema.js";

const roots: string[] = [];

function tmpConfig(data: unknown): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-image-config-"));
  roots.push(root);
  const file = path.join(root, "config.yaml");
  fs.writeFileSync(file, YAML.stringify(data), "utf8");
  return file;
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("ImageGenerationToolConfig", () => {
  it("keeps only non-model tool defaults", () => {
    const config = new ImageGenerationToolConfig();

    expect(config.toObject()).toEqual({
      enabled: true,
      defaultAspectRatio: "1:1",
      defaultImageSize: "1K",
      maxImagesPerTurn: null,
      saveDir: "generated",
    });
  });

  it("honors an explicit disable", () => {
    const config = new ImageGenerationToolConfig({ enabled: false });

    expect(config.enabled).toBe(false);
    expect(config.toObject().enabled).toBe(false);
  });

  it("accepts null and positive safe integer turn limits", () => {
    expect(new ImageGenerationToolConfig({ maxImagesPerTurn: null }).maxImagesPerTurn).toBeNull();
    for (const value of [1, 24, 1000, Number.MAX_SAFE_INTEGER]) {
      const config = new ImageGenerationToolConfig({ maxImagesPerTurn: value });
      expect(config.maxImagesPerTurn).toBe(value);
      expect(config.toObject().maxImagesPerTurn).toBe(value);
    }
  });

  it("rejects invalid turn limits with a stable error", () => {
    const message = "tools.imageGeneration.maxImagesPerTurn must be null or a safe integer >= 1";
    for (const value of [0, -1, 1.5, "4", Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(() => new ImageGenerationToolConfig({ maxImagesPerTurn: value })).toThrow(message);
    }
  });

  it("round trips current non-model settings and preserves future fields", () => {
    const file = tmpConfig({
      tools: {
        imageGeneration: {
          enabled: true,
          defaultAspectRatio: "4:3",
          defaultImageSize: "2K",
          maxImagesPerTurn: 3,
          saveDir: "generated/images",
          futureImageSetting: { keep: true },
        },
      },
    });

    const loaded = loadConfig(file);
    expect(loaded.tools.imageGeneration.toObject()).toEqual({
      enabled: true,
      defaultAspectRatio: "4:3",
      defaultImageSize: "2K",
      maxImagesPerTurn: 3,
      saveDir: "generated/images",
    });
    saveConfig(loaded, file);
    expect(YAML.parse(fs.readFileSync(file, "utf8")).tools.imageGeneration).toMatchObject({
      enabled: true,
      defaultAspectRatio: "4:3",
      defaultImageSize: "2K",
      maxImagesPerTurn: 3,
      saveDir: "generated/images",
      futureImageSetting: { keep: true },
    });
  });

  it("rejects legacy image model/profile fields before runtime", () => {
    for (const legacy of [
      "activeProfile", "profiles", "provider", "model", "apiKey", "apiBase", "extraHeaders", "extraBody",
      "active_profile", "api_key", "api_base", "extra_headers", "extra_body",
    ]) {
      expect(() => new ImageGenerationToolConfig({ [legacy]: "legacy" })).toThrow(
        `does not accept legacy model field '${legacy}'`,
      );
    }
  });

  it("fails loudly when a config still contains a legacy profile", () => {
    const file = tmpConfig({
      tools: {
        imageGeneration: {
          enabled: true,
          activeProfile: "account",
          profiles: { account: { provider: "memmy_account", model: "image_gen" } },
        },
      },
    });

    expect(() => loadConfig(file)).toThrow("does not accept legacy model field 'activeProfile'");
  });
});
