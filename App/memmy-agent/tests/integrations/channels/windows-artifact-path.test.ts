import path from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeLocalPath, pathIsInside } from "../../../src/integrations/channels/websocket.js";

describe("windows artifact paths", () => {
  it("treats extended-length paths as the same file as the drive path", () => {
    const root = "C:\\Users\\vm\\proj";
    const extendedFile = "\\\\?\\C:\\Users\\vm\\proj\\demo_toolkit.py";
    expect(pathIsInside(extendedFile, root, path.win32)).toBe(true);
    expect(pathIsInside(root, extendedFile, path.win32)).toBe(false);
    expect(pathIsInside("\\\\?\\C:\\Users\\vm\\other\\demo_toolkit.py", root, path.win32)).toBe(false);
  });

  it("keeps UNC shared-folder paths absolute", () => {
    expect(normalizeLocalPath("\\\\?\\UNC\\vmware-host\\Shared Folders\\proj\\demo_toolkit.py", "win32"))
      .toBe("//vmware-host/Shared Folders/proj/demo_toolkit.py");
    expect(pathIsInside(
      "\\\\?\\UNC\\vmware-host\\Shared Folders\\proj\\demo_toolkit.py",
      "\\\\vmware-host\\Shared Folders\\proj",
      path.win32,
    )).toBe(true);
    expect(normalizeLocalPath("/C:/Users/vm/proj/demo_toolkit.py", "win32")).toBe("C:/Users/vm/proj/demo_toolkit.py");
  });
});
