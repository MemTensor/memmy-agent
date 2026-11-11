import { describe, expect, it } from "vitest";
import { coversInputModalities, requiredInputModalities } from "../../src/providers/model-input-capabilities.js";

describe("request input modalities", () => {
  it("scans unified messages and checks required modality coverage", () => {
    const textRequired = requiredInputModalities([{ role: "user", content: "hello" }]);
    const imageRequired = requiredInputModalities([{
      role: "tool",
      content: [
        { type: "text", text: "result" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    }]);

    expect(textRequired).toEqual(["text"]);
    expect(imageRequired).toEqual(["text", "image"]);
    expect(coversInputModalities(["text", "image"], imageRequired)).toBe(true);
    expect(coversInputModalities(["text"], imageRequired)).toBe(false);
  });

});
