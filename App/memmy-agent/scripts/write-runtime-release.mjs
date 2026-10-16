import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export async function writeAgentRuntimeRelease(archive, version, target) {
  // Hash the finished archive, including native dependencies, rather than its version or source files.
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  const asset = { name: basename(archive), sha256: hash.digest("hex"), size: (await stat(archive)).size };
  await writeFile(`${archive}.sha256`, `${asset.sha256}  ${asset.name}\n`);
  await writeFile(join(dirname(archive), `agent-release-${target}.json`), `${JSON.stringify({
    version, assets: { [target]: asset }
  }, null, 2)}\n`);
  return asset;
}
