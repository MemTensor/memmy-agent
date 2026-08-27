import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";

const electronMocks = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
}));

vi.mock("electron", () => ({
  dialog: {
    showOpenDialog: electronMocks.showOpenDialog,
  },
}));

import {
  selectEmptyProjectDirectory,
  selectProjectDirectory,
} from "../src/main/project-directory-picker.js";

const owner = {
  isDestroyed: () => false,
} as BrowserWindow;

describe("project directory picker", () => {
  beforeEach(() => {
    electronMocks.showOpenDialog.mockReset();
    electronMocks.showOpenDialog.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/new-project"],
    });
  });

  it("allows creating a folder when choosing another project directory", async () => {
    await expect(selectProjectDirectory(owner)).resolves.toEqual({
      canceled: false,
      path: "/tmp/new-project",
    });
    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(owner, {
      properties: ["openDirectory", "createDirectory"],
    });
  });

  it("keeps the blank-project picker able to create a folder", async () => {
    await selectEmptyProjectDirectory(owner);

    expect(electronMocks.showOpenDialog).toHaveBeenCalledWith(owner, {
      properties: ["openDirectory", "createDirectory"],
    });
  });
});
