import { ModelCapabilityCatalogSchema, type ModelCapabilityCatalog } from "@memmy/local-api-contracts";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export function resolveDefaultModelCapabilityCatalogPath(homeDirectory = homedir()): string {
  return join(homeDirectory, ".memmy", "models.json");
}

export async function readModelCapabilityCatalog(
  filePath = resolveDefaultModelCapabilityCatalogPath()
): Promise<ModelCapabilityCatalog | null> {
  let content: string;
  try {
    content = await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return null;
    throw error;
  }
  const result = ModelCapabilityCatalogSchema.safeParse(value);
  return result.success ? result.data : null;
}

export async function writeModelCapabilityCatalog(
  catalog: unknown,
  filePath = resolveDefaultModelCapabilityCatalogPath()
): Promise<ModelCapabilityCatalog> {
  const validated = ModelCapabilityCatalogSchema.parse(catalog);
  const content = `${JSON.stringify(validated, null, 2)}\n`;
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporaryPath, "wx", 0o600);
    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporaryPath, filePath);
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return validated;
}
