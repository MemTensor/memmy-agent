import { describe, expect, it } from "vitest";
import { desktopSaveFileName } from "../src/main/save-file-name.js";

describe("desktop save file names", () => {
  it("keeps the file name shown on the attachment card", () => {
    expect(desktopSaveFileName("00_README_交付物总览.md")).toBe("00_README_交付物总览.md");
    expect(desktopSaveFileName("/Users/lvbubu/deliverables/亿都_五项交付物.xlsx")).toBe("亿都_五项交付物.xlsx");
  });

  it("decodes a gateway media token into the original file name", () => {
    const token = Buffer.from("websocket/624ee01a9b73-00_README_交付物总览.md", "utf8").toString("base64url");
    expect(desktopSaveFileName(token)).toBe("00_README_交付物总览.md");
    expect(desktopSaveFileName(`http://127.0.0.1:18980/api/media/sig/${token}`)).toBe("00_README_交付物总览.md");
  });
});
