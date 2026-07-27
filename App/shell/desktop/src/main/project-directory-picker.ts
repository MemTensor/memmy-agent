import {
  dialog,
  type BrowserWindow,
  type OpenDialogOptions,
} from "electron";
import type { DesktopProjectDirectorySelection } from "@memmy/desktop-interface";

async function selectDirectory(
  owner: BrowserWindow | null,
  properties: OpenDialogOptions["properties"],
): Promise<DesktopProjectDirectorySelection> {
  if (!owner || owner.isDestroyed()) return { canceled: true };
  const result = await dialog.showOpenDialog(owner, { properties });
  const selectedPath = result.filePaths[0];
  if (result.canceled || !selectedPath) return { canceled: true };
  return { canceled: false, path: selectedPath };
}

export function selectProjectDirectory(
  owner: BrowserWindow | null,
): Promise<DesktopProjectDirectorySelection> {
  return selectDirectory(owner, ["openDirectory", "createDirectory"]);
}

export function selectEmptyProjectDirectory(
  owner: BrowserWindow | null,
): Promise<DesktopProjectDirectorySelection> {
  return selectDirectory(owner, ["openDirectory", "createDirectory"]);
}
