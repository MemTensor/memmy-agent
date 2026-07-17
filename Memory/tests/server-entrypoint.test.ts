import { describe, expect, it } from "vitest";
import { isDirectRun } from "../src/server/index.js";

describe("memmy memory server entrypoint", () => {
  it("recognizes Windows packaged paths as direct server execution", () => {
    const entry = "C:\\Users\\tester\\AppData\\Local\\Programs\\Memmy\\resources\\app.asar\\dist\\runtime\\memory\\src\\server\\index.js";

    expect(isDirectRun(entry, entry)).toBe(true);
    expect(isDirectRun(
      "C:\\Users\\tester\\AppData\\Local\\Programs\\Memmy\\resources\\app.asar\\dist\\runtime\\memory\\src\\cli\\index.js",
      entry
    )).toBe(false);
  });
});
