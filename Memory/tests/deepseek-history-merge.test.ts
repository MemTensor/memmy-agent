import { mkdtemp, mkdir, writeFile, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readDeepseekHarnessEvents, sourceTurnFromMessages } from "@memmy/agent-source-core";
import { mergeDeepseekHistorySnapshots, createDeepseekHistoryReader } from "../src/agent-source/adapters/deepseek-harness/session-history.js";
import { createDeepseekHarnessSourceAdapter } from "../src/agent-source/adapters/deepseek-harness/adapter.js";
import { streamDeepseekHarnessSession } from "../src/agent-source/adapters/deepseek-harness/session-reader.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() { const root = await mkdtemp(join(tmpdir(), "dsh-review-")); roots.push(root); return root; }
async function collect<T>(input: AsyncIterable<T>): Promise<T[]> { const rows: T[] = []; for await (const row of input) rows.push(row); return rows; }
function events({ complete = true, answer = "Answer", id = "session-a", assistantId = "a1", turn = 1 } = {}) {
  const rows = [
    { type: "session", id },
    { type: "turn/start", seq: 0, time: 4102444800000, data: { turn } },
    { type: "user/message", seq: 1, time: 4102444801000, data: { id: "q" + turn, source: { kind: "user" }, content: "Question" } },
    { type: "assistant/message", seq: 2, time: 4102444802000, data: { message: { id: assistantId, content: answer } } },
    { type: "turn/end", seq: 3, time: 4102444803000, data: { turn, reason: { kind: "completed" } } }
  ];
  return complete ? rows : rows.slice(0, -1);
}
async function snapshot(options = {}) { return (await collect(readDeepseekHarnessEvents(events(options)))).map(row => ({ ...row, workspacePath: null })); }
const jsonl = (rows: object[]) => rows.map(row => JSON.stringify(row)).join("\n");

describe("DSH snapshot reconciliation", () => {
  it.each([false, true])("preserves complete evidence regardless of order (reverse=%s), discards residual partial IDs", async reverse => {
    const complete = await snapshot();
    const partial = await snapshot({ complete: false, answer: "An", assistantId: "old-answer" });
    const copies = reverse ? [partial, complete] : [complete, partial];
    const merged = mergeDeepseekHistorySnapshots(copies);
    expect(sourceTurnFromMessages(merged)?.answer).toBe("Answer");
    expect(merged.map(row => row.messageId)).not.toContain("old-answer");
    expect(merged).toHaveLength(2);
  });
  it.each([false, true])("rejects inconsistent completed answers (reverse=%s)", async reverse => {
    const copies = [await snapshot(), await snapshot({ answer: "Different" })];
    const merged = mergeDeepseekHistorySnapshots(reverse ? copies.reverse() : copies);
    expect(sourceTurnFromMessages(merged)).toBeNull();
    expect(merged.every(row => row.rawMeta.sourceTurnReason === "source_turn_content_conflict")).toBe(true);
  });
  it("does not accept a conflicting partial or cancelled snapshot as an earlier prefix", async () => {
    const complete = await snapshot();
    const other = await snapshot({ complete: false, answer: "Unrelated" });
    expect(sourceTurnFromMessages(mergeDeepseekHistorySnapshots([other, complete]))).toBeNull();
    const cancelled = (await snapshot({ complete: false })).map(row => ({ ...row, rawMeta: { ...row.rawMeta, sourceTurnState: "turn_cancelled" } }));
    expect(sourceTurnFromMessages(mergeDeepseekHistorySnapshots([cancelled, complete]))).toBeNull();
  });
  it("compares identical raw snapshots consistently before canonical secret redaction", async () => {
    const answer = "Synthetic password=example-only";
    const merged = mergeDeepseekHistorySnapshots([
      await snapshot({ answer }), await snapshot({ answer, complete: false })
    ]);
    expect(sourceTurnFromMessages(merged)?.answer).toBe("Synthetic password=[REDACTED:password]");
  });
  it("keeps incomplete turns pending and preserves unique turns from older backups", async () => {
    expect(sourceTurnFromMessages(mergeDeepseekHistorySnapshots([await snapshot({ complete: false })]))).toBeNull();
    const merged = mergeDeepseekHistorySnapshots([await snapshot(), await snapshot({ turn: 2, assistantId: "a2" }), await snapshot()]);
    expect(new Set(merged.map(row => row.rawMeta.sourceTurnId))).toEqual(new Set(["session-a:1", "session-a:2"]));
    expect(merged).toHaveLength(4);
  });
  it("uses directory identity for headerless generations, separates distinct directories", async () => {
    const root = await fixture();
    const files = [join(root, "one", "session.v1.jsonl.bak-1"), join(root, "one", "session.v4.jsonl"), join(root, "two", "session.v4.jsonl")];
    for (const file of files) { await mkdir(join(file, ".."), { recursive: true }); await writeFile(file, jsonl(events().slice(1))); }
    const rows = await Promise.all(files.map(file => collect(streamDeepseekHarnessSession(file))));
    expect(rows[0]![0]!.conversationId).toBe(rows[1]![0]!.conversationId);
    expect(rows[0]![0]!.conversationId).not.toBe(rows[2]![0]!.conversationId);
    expect(mergeDeepseekHistorySnapshots(rows).length).toBe(4);
  });
  it("does not let rotations consume another live directory's target budget", async () => {
    const root = await fixture();
    for (const id of ["a", "b"]) { await mkdir(join(root,id)); await writeFile(join(root,id,"session.v4.jsonl"),jsonl(events({id}))); }
    for (let i=0;i<10;i++) await writeFile(join(root,"a",`session.v4.jsonl.bak-${i}`),jsonl(events({id:"a"})));
    const rows=await collect(createDeepseekHarnessSourceAdapter({sessionsRoot:root}).scan({fullHistory:true,maxScanTargets:2}));
    expect(new Set(rows.map(row=>row.conversationId))).toEqual(new Set(["a","b"]));
    expect(rows).toHaveLength(4);
  });
  it("never cuts a completed turn just before its ending evidence at a message limit", async () => {
    const root=await fixture();await writeFile(join(root,"session.jsonl"),jsonl(events()));
    const rows=await collect(createDeepseekHarnessSourceAdapter({sessionsRoot:root}).scan({fullHistory:true,maxMessages:1}));
    expect(rows).toHaveLength(2);expect(sourceTurnFromMessages(rows)).not.toBeNull();
  });
  it("incremental scan still finds a new turn rotated before the next poll", async () => {
    const root=await fixture();const file=join(root,"session.jsonl");await writeFile(file,jsonl(events()));
    const adapter=createDeepseekHarnessSourceAdapter({sessionsRoot:root});await collect(adapter.scan({fullHistory:true}));
    await writeFile(join(root,"session.jsonl.bak-2"),jsonl(events({turn:2,assistantId:"a2"})));
    const rows=await collect(adapter.scan({fullHistory:false,since:"2099-12-31T00:00:00Z"}));
    expect(new Set(rows.map(row=>row.rawMeta.sourceTurnId))).toEqual(new Set(["session-a:1","session-a:2"]));
  });
  it("reuses unchanged decoded snapshots, invalidates rewritten files even if mtime is restored", async () => {
    const root=await fixture();const file=join(root,"session.jsonl");await writeFile(file,jsonl(events()));
    const read=createDeepseekHistoryReader();const first=await read(file);expect(await read(file)).toBe(first);
    await writeFile(file,jsonl(events({answer:"Better"})));await utimes(file,new Date(0),new Date(0));
    expect(sourceTurnFromMessages(await read(file))?.answer).toBe("Better");
    const abort=new AbortController();abort.abort();await expect(read(file,abort.signal)).rejects.toThrow();
  });
});
