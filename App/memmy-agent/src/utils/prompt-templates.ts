import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as nunjucks from "nunjucks";

const templatesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../templates");

const templateEnv = new nunjucks.Environment(
  new nunjucks.FileSystemLoader(templatesRoot, { noCache: true }),
  {
    autoescape: false,
    lstripBlocks: true,
    trimBlocks: true,
    throwOnUndefined: false,
  },
);

function templatePath(nameOrPath: string): string {
  return path.isAbsolute(nameOrPath) ? nameOrPath : path.join(templatesRoot, nameOrPath);
}

function formatTemplateError(name: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  return new Error(`Template render failed for ${name}: ${message}`);
}

export function loadTemplate(nameOrPath: string): string {
  const candidate = templatePath(nameOrPath);
  if (!fs.existsSync(candidate)) throw new Error(`Template not found: ${nameOrPath}`);
  return fs.readFileSync(candidate, "utf8");
}

export function renderTemplate(
  name: string,
  options: Record<string, any> & { strip?: boolean } = {},
): string {
  const { strip = false, ...vars } = options;
  try {
    const text = path.isAbsolute(name)
      ? templateEnv.renderString(loadTemplate(name), vars)
      : templateEnv.render(name, vars);
    return strip ? text.replace(/\s+$/g, "") : text;
  } catch (error) {
    if (error instanceof Error && /template not found/i.test(error.message))
      throw new Error(`Template not found: ${name}`);
    throw formatTemplateError(name, error);
  }
}
