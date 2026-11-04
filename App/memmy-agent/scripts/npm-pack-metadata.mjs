// npm 11 returns an array; npm 12 returns an object keyed by package name.
export function parsePackFilename(stdout, packageRoot) {
  const parsed = JSON.parse(stdout);
  const entries = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === "object"
      ? typeof parsed.filename === "string" ? [parsed] : Object.values(parsed)
      : [];
  const metadata = entries.at(-1);
  if (typeof metadata?.filename !== "string" || !metadata.filename) {
    throw new Error(`npm pack did not return a filename for ${packageRoot}; stdout: ${stdout}`);
  }
  return metadata.filename;
}
