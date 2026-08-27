import { describe, expect, it } from "vitest";
import { imageGenerationPrompt } from "../../src/utils/image-generation-intent.js";

describe("imageGenerationPrompt", () => {
  it("ignores plain messages", () => {
    expect(imageGenerationPrompt("hello", {})).toBe("hello");
  });

  it("uses auto aspect instruction", () => {
    const prompt = imageGenerationPrompt("Draw a poster", { image_generation: { enabled: true, aspect_ratio: null } });
    expect(prompt).toContain("Draw a poster");
    expect(prompt).toContain("Use the generate_image tool");
    expect(prompt).toContain("Choose the most suitable aspect_ratio yourself");
  });

  it("uses selected aspect ratio", () => {
    expect(imageGenerationPrompt("Draw a banner", { image_generation: { enabled: true, aspect_ratio: "16:9" } })).toContain(
      "aspect_ratio='16:9'",
    );
  });
});
