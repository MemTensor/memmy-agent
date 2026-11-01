import { utimes, mkdir, mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  configDirectoryFor,
  fileMentions,
  locateRecordFile,
  matchSnippet,
  readCoversSubmitted,
  readGenericRecord,
  readRecordFile,
  turnsOf
} from "../collab-record-file.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "collab-record-"));
  roots.push(root);
  return root;
}

/** 一份 Pi 格式的会话：`{"type":"session"}` 打头，之后每行是一条 `{"type":"message"}`。 */
function piSession(question: string, reply: string, at = "2026-11-01T02:00:00.000Z"): string {
  return [
    JSON.stringify({ type: "session", version: 3, id: "s-1", timestamp: at, cwd: "/repo" }),
    JSON.stringify({ type: "message", id: "m-1", timestamp: at, message: { role: "user", content: [{ type: "text", text: question }] } }),
    JSON.stringify({ type: "message", id: "m-2", timestamp: at, message: { role: "assistant", content: [{ type: "text", text: reply }] } })
  ].join("\n");
}

describe("locating a task's record file", () => {
  it("finds the file that carries the submitted question", async () => {
    const root = await tempDir();
    const sessions = join(root, "sessions");
    await mkdir(sessions);
    await writeFile(join(sessions, "a.jsonl"), piSession("重试几次比较合适？", "两次就够。"));
    await writeFile(join(sessions, "b.jsonl"), piSession("完全不相关的一句话。", "嗯。"));

    const found = await locateRecordFile({
      skillDirectory: join(root, "skills"),
      configDirectory: root,
      submitted: [{ question: "重试几次比较合适？", reply: "两次就够。" }]
    });

    expect(found?.path).toBe(join(sessions, "a.jsonl"));
    // Pi 格式的文件由 Pi 读取器读，绑定里记的就是它。
    expect(found?.reader).toBe("pi");
  });

  it("ignores files older than two days, and files too large to read", async () => {
    const root = await tempDir();
    const old = join(root, "old.jsonl");
    await writeFile(old, piSession("重试几次比较合适？", "两次就够。"));
    const aged = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    await utimes(old, aged, aged);
    const huge = join(root, "huge.jsonl");
    await writeFile(huge, piSession("重试几次比较合适？", "两次就够。"));
    // 稀疏文件：大小超过 50 MB，但不会真的占满磁盘。
    await truncate(huge, 51 * 1024 * 1024);

    expect(await locateRecordFile({
      skillDirectory: join(root, "skills"),
      configDirectory: root,
      submitted: [{ question: "重试几次比较合适？", reply: "两次就够。" }]
    })).toBeNull();
  });

  it("recognizes the question when the record escapes it as JSON", async () => {
    const root = await tempDir();
    // 中文写成 \uXXXX、换行写成 \n：真实记录里很常见。
    const escaped = JSON.stringify({ role: "user", content: "重试几次比较合适？\n先看文档。" }).replace(/[\u0080-\uffff]/gu, (char) =>
      `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`
    );
    await writeFile(join(root, "escaped.jsonl"), `${escaped}\n`);

    const found = await locateRecordFile({
      skillDirectory: join(root, "skills"),
      configDirectory: root,
      submitted: [{ question: "重试几次比较合适？\n先看文档。", reply: "好。" }]
    });
    expect(found?.path).toBe(join(root, "escaped.jsonl"));
    // 没有内置读取器认得这份格式，落到通用读取器。
    expect(found?.reader).toBe("generic");
  });

  it("checks only the file the agent named, without searching", async () => {
    const root = await tempDir();
    const given = join(root, "given.jsonl");
    await writeFile(given, piSession("重试几次比较合适？", "两次就够。"));
    await writeFile(join(root, "decoy.jsonl"), piSession("重试几次比较合适？", "两次就够。"));

    const found = await locateRecordFile({
      skillDirectory: join(root, "skills"),
      configDirectory: root,
      sourcePath: given,
      submitted: [{ question: "重试几次比较合适？", reply: "两次就够。" }]
    });
    expect(found?.path).toBe(given);

    // 给的文件里没有这段原文时，不绑定，也不去搜别的文件。
    await writeFile(given, piSession("另一件事。", "嗯。"));
    expect(await locateRecordFile({
      skillDirectory: join(root, "skills"),
      configDirectory: root,
      sourcePath: given,
      submitted: [{ question: "重试几次比较合适？", reply: "两次就够。" }]
    })).toBeNull();
  });

  it("does not bind when no reader can see the submitted question", async () => {
    const root = await tempDir();
    // 内容里有原文，但结构上解析不出轮次：读不出提问就不绑定。
    await writeFile(join(root, "blob.jsonl"), JSON.stringify({ note: "重试几次比较合适？" }));

    expect(await locateRecordFile({
      skillDirectory: join(root, "skills"),
      configDirectory: root,
      submitted: [{ question: "重试几次比较合适？", reply: "两次就够。" }]
    })).toBeNull();
  });
});

describe("reading a record file", () => {
  it("reads a generic JSONL conversation into turns, skipping tool output", () => {
    const raw = [
      JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "重试几次？" }] }, _createdAt: 1 }),
      JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "工具输出" }] } }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "两次。" }] } })
    ].join("\n");

    // 毫秒时间戳也认（Proma 的旧记录就是这样）。
    expect(turnsOf(readGenericRecord(raw))).toEqual([
      { question: "重试几次？", reply: "两次。", at: new Date(1).toISOString() }
    ]);
  });

  it("reads a whole JSON document that wraps its messages", () => {
    const raw = JSON.stringify({ messages: [
      { role: "user", content: "重试几次？" },
      { role: "assistant", content: "两次。" }
    ] });
    expect(turnsOf(readGenericRecord(raw))).toEqual([{ question: "重试几次？", reply: "两次。" }]);
  });

  it("still matches when the agent stripped the host's context from the question", async () => {
    const root = await tempDir();
    const path = join(root, "a.jsonl");
    // 记录里的提问带着宿主注入：时间戳、工作区说明、附件清单。
    await writeFile(path, piSession(
      "**当前时间: Sunday, November 1, 2026**\n\n<workspace_state>项目: MemOS产品</workspace_state>\n\n继续这个 cursor 的会话，先看 @file:/tmp/a.png 这张图，然后把界面重做一遍。",
      "好。"
    ));
    const turns = await readRecordFile(path, "pi");

    // Agent 交上来的是清理过的原话：中间少了几段注入内容，不再互相包含。
    expect(readCoversSubmitted(turns, [{
      question: "继续这个 cursor 的会话，先看 这张图，然后把界面重做一遍。",
      reply: "好。"
    }])).toBe(true);
  });

  it("counts a read as covering the submission only when every question came back", async () => {
    const root = await tempDir();
    const path = join(root, "a.jsonl");
    await writeFile(path, piSession("重试几次？", "两次。"));
    const turns = await readRecordFile(path, "pi");

    expect(readCoversSubmitted(turns, [{ question: "重试几次？", reply: "" }])).toBe(true);
    // 读取器常把系统附加内容一起读出来，前后多出的部分不算错。
    expect(readCoversSubmitted(turns, [{ question: "几次？", reply: "" }])).toBe(true);
    expect(readCoversSubmitted(turns, [{ question: "超时呢？", reply: "" }])).toBe(false);
  });
});

describe("record matching helpers", () => {
  it("takes one continuous line of the question as the snippet", () => {
    expect(matchSnippet("第一行很短\n这是比较长的一行提问内容用于匹配")).toBe("这是比较长的一行提问内容用于匹配");
    expect(fileMentions(JSON.stringify({ text: "这是比较长的一行提问内容用于匹配" }), ["第一行很短\n这是比较长的一行提问内容用于匹配"]))
      .toBe(true);
  });

  it("derives the config directory from the skills folder", () => {
    const home = process.env.HOME ?? "";
    expect(configDirectoryFor(`${home}/.proma/default-skills`)).toBe(`${home}/.proma`);
    // 不在用户目录下时取上一级，不猜更深的位置。
    expect(configDirectoryFor("/opt/tools/foo/skills")).toBe("/opt/tools/foo");
  });
});
