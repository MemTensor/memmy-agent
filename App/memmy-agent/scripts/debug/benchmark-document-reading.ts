// Run with: node --import tsx scripts/debug/benchmark-document-reading.ts docx 1000000
// Or:       node --import tsx scripts/debug/benchmark-document-reading.ts pdf 96
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { ReadFileTool } from "../../src/core/agent-runtime/tools/filesystem.js";
import { extractText } from "../../src/utils/document.js";
import { reportText, writeDocx, writePdf } from "../../tests/helpers/long-document-fixtures.js";

const kind = process.argv[2];
const size = Number(process.argv[3]);
if (!["docx", "pdf"].includes(kind) || !Number.isSafeInteger(size) || size < 1) {
  throw new Error("Expected docx <text chars> or pdf <pages>");
}
const root = await fs.mkdtemp(path.join(os.tmpdir(), "memmy-document-benchmark-"));
try {
  const file = kind === "docx" ? await writeDocx(root, reportText(size)) : await writePdf(root, size);
  const tool = new ReadFileTool({ workspace: root });
  const durations: number[] = [];
  const hash = createHash("sha256");
  const rssBeforeMiB = process.memoryUsage().rss / 1024 ** 2;
  let offset = 0;
  let complete = false;
  const started = performance.now();
  for (let turn = 0; turn < 300; turn += 1) {
    const start = performance.now();
    const result = await tool.execute({ path: file, char_offset: offset });
    durations.push(performance.now() - start);
    const marker = result.lastIndexOf("\n\n[Document read:");
    if (marker < 0 || result.length > ReadFileTool.MAX_CHARS) throw new Error("Invalid document response");
    hash.update(result.slice(0, marker));
    const next = /Continue with char_offset=(\d+)/.exec(result);
    if (!next) {
      complete = result.includes("End of document");
      break;
    }
    if (Number(next[1]) <= offset) throw new Error("Non-progressing cursor");
    offset = Number(next[1]);
  }
  const totalMs = performance.now() - started;
  const peakRssMiB = process.resourceUsage().maxRSS / 1024;
  const referenceStart = performance.now();
  const expected = await extractText(file, { maxChars: null });
  const singleExtractionMs = performance.now() - referenceStart;
  if (!expected || !complete || hash.digest("hex") !== createHash("sha256").update(expected).digest("hex")) {
    throw new Error("Paginated content does not match complete extraction");
  }
  const sorted = [...durations].sort((a, b) => a - b);
  console.log(JSON.stringify({
    kind, size, fileBytes: (await fs.stat(file)).size, extractedChars: expected.length,
    calls: durations.length, firstReadMs: durations[0],
    medianReadMs: sorted[Math.floor(sorted.length / 2)], totalReadMs: totalMs,
    singleExtractionMs, rssBeforeMiB, peakRssMiB,
    exactContentMatch: true, node: process.version,
    note: "One synthetic sample per process; peak RSS includes imports and fixture creation. No model/network latency.",
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
