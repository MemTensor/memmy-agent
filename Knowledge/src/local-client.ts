import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { KnowledgeError, record, text } from "./types.js";
import { parseEvidence, type KnowledgeRecallClient } from "./client.js";

/** Agent access uses the existing local backend token; no cloud credential enters the Agent hook. */
export function createLocalKnowledgeClient(
  runtimeFile = path.join(
    process.env.MEMMY_HOME || path.join(os.homedir(), ".memmy"),
    "runtime.json",
  ),
  fetcher: typeof fetch = fetch,
): KnowledgeRecallClient {
  return {
    async recall(query, signal) {
      let runtime: Record<string, unknown>;
      try {
        runtime = record(JSON.parse(await fs.readFile(runtimeFile, "utf8")));
      } catch {
        return { enabled: false, evidence: [] };
      }
      const base = new URL(text(runtime.baseUrl));
      if (
        base.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
        base.username ||
        base.password
      )
        throw new KnowledgeError("知识库本地服务地址无效");
      const timeout = AbortSignal.timeout(25_000);
      try {
        const response = await fetcher(new URL("/api/knowledge/recall", base), {
          method: "POST",
          redirect: "error",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: {
            "Content-Type": "application/json",
            "x-memmy-local-token": text(runtime.localToken),
          },
          body: JSON.stringify({ query }),
        });
        if (!response.ok) throw new KnowledgeError("知识库服务暂时不可用", 503);
        const data = record(await response.json());
        return {
          enabled: data.enabled === true,
          evidence: parseEvidence(data.evidence),
        };
      } catch {
        throw new KnowledgeError("知识库服务暂时不可用", 503);
      }
    },
  };
}

/** Remove legacy local credentials without transferring them to any account or cloud endpoint. */
export async function removeLegacyKnowledgeCredentials(
  hostConfigPath: string,
): Promise<void> {
  const file = path.join(
    path.dirname(path.resolve(hostConfigPath)),
    "knowledge.json",
  );
  let value: Record<string, unknown>;
  try {
    value = record(JSON.parse(await fs.readFile(file, "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new KnowledgeError("旧知识库配置清理失败", 500);
  }
  if (!("apiKey" in value) && !("baseUrl" in value)) return;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(
      temporary,
      JSON.stringify({ enabled: false, bases: [] }) + "\n",
      { mode: 0o600, flag: "wx" },
    );
    await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
