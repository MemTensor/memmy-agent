import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

async function checkedFile(root, file) {
  if (typeof file !== "string" || isAbsolute(file) || file.split(/[\\/]/).some(part => part === ".." || part === ".")) {
    throw new Error("Invalid notice source path");
  }
  const base = await realpath(root), target = resolve(base, file), inside = relative(base, target);
  if (!inside || inside.startsWith(`..${sep}`) || isAbsolute(inside)) throw new Error("Notice source escapes its root");
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(target) !== target) throw new Error("Notice source must be a canonical regular file");
  return readFile(target);
}

const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const publisherFile = name => /^(?:licen[cs]e|copying|copyright)(?:[._-][a-z0-9._-]+)?$/i.test(name)
  && !/\.(?:[cm]?js|tsx?|map|svg|png|jpe?g)$/i.test(name);

/** Preserve publisher material; supplemental reference terms never replace it. */
export async function collectThirdPartyNotices(root) {
  const lock = JSON.parse(await readFile(resolve(root, "package-lock.json"), "utf8"));
  const licenses = resolve(root, "licenses");
  const registry = JSON.parse(await readFile(resolve(licenses, "supplements.json"), "utf8"));
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.supplements)) throw new Error("Invalid notice supplement registry");
  const supplements = new Map();
  for (const item of registry.supplements) {
    if (!item.name || supplements.has(item.name) || !item.version || !item.license || !item.integrity || !Array.isArray(item.files)) {
      throw new Error("Invalid or duplicate notice supplement identity");
    }
    const included = [];
    for (const file of item.files) {
      if (!/^[a-f0-9]{64}$/.test(file.sha256)) throw new Error(`Invalid notice supplement hash: ${item.name}`);
      const bytes = await checkedFile(licenses, file.path);
      if (digest(bytes) !== file.sha256) throw new Error(`Notice supplement hash mismatch: ${item.name}/${file.path}`);
      if (file.includeInNotices === true) included.push(bytes.toString("utf8"));
    }
    if (!included.length) throw new Error(`Notice supplement has no included material: ${item.name}`);
    supplements.set(item.name, { ...item, included });
  }
  const notices = ["Third-party libraries bundled in Memmy Office.\n"];
  const used = new Set();
  for (const [directory, metadata] of Object.entries(lock.packages ?? {})) {
    if (!directory.startsWith("node_modules/") || metadata.dev) continue;
    const packageRoot = resolve(root, directory);
    const info = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
    if (metadata.version && metadata.version !== info.version) throw new Error(`Installed notice version differs from lockfile: ${info.name}`);
    const declaration = info.license ?? info.licenses;
    notices.push(`\n--- ${info.name}@${info.version} (${typeof declaration === "string" ? declaration : "see publisher declaration"}) ---\n`);
    notices.push(`Publisher license metadata (preserved without inference): ${JSON.stringify(declaration ?? null)}\n`);
    const names = (await readdir(packageRoot, { withFileTypes: true })).filter(entry => publisherFile(entry.name)).map(entry => entry.name).sort();
    for (const name of names) {
      const bytes = await checkedFile(packageRoot, name);
      notices.push(`Publisher file: ${name}\n${bytes.toString("utf8")}\n`);
    }
    const supplement = supplements.get(info.name);
    if (info.name === "fontkit" && !supplement) throw new Error("The pinned fontkit notice supplement is required");
    if (supplement) {
      if (info.version !== supplement.version || info.license !== supplement.license || metadata.integrity !== supplement.integrity) {
        throw new Error(`Notice supplement package identity mismatch: ${info.name}`);
      }
      for (const [file, hash] of Object.entries(supplement.installedFiles ?? {})) {
        if (digest(await checkedFile(packageRoot, file)) !== hash) throw new Error(`Notice supplement installed source hash mismatch: ${info.name}/${file}`);
      }
      notices.push(...supplement.included);
      used.add(info.name);
    } else if (!names.length) {
      notices.push("The installed package supplies no recognized publisher license file. Metadata above is retained without inferred license terms; human review is required.\n");
    }
  }
  for (const name of supplements.keys()) if (!used.has(name)) throw new Error(`Notice supplement does not match a bundled package: ${name}`);
  return notices.join("\n");
}
