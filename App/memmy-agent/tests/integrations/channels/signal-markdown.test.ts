import { describe, expect, it } from "vitest";
import { markdownToSignal, partitionStyles } from "../../../src/integrations/channels/signal.js";
import { splitMessage } from "../../../src/utils/helpers.js";

function stylesFor(plain: string, textStyles: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const entry of textStyles) {
    const [startRaw, lengthRaw, style] = entry.split(":", 3);
    const start = Number(startRaw);
    const length = Number(lengthRaw);
    const span = plain.slice(start, start + length);
    (result[span] ??= []).push(style);
  }
  return result;
}

function expectWithinUtf16Bounds(plain: string, textStyles: string[]): void {
  for (const entry of textStyles) {
    const [startRaw, lengthRaw] = entry.split(":", 2);
    const start = Number(startRaw);
    const length = Number(lengthRaw);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(start + length).toBeLessThanOrEqual(plain.length);
  }
}

function resolveChunkStyles(text: string, maxLen: number): [string[], string[][]] {
  const [plain, styles] = markdownToSignal(text);
  const chunks = plain ? splitMessage(plain, maxLen) : [""];
  return [chunks, partitionStyles(plain, chunks, styles)];
}

describe("Signal markdown", () => {
  it("converts empty markdown to empty text and no styles", () => {
    expect(markdownToSignal("")).toEqual(["", []]);
  });

  it("leaves plain text unstyled", () => {
    expect(markdownToSignal("hello world")).toEqual(["hello world", []]);
  });

  it("converts star bold to Signal BOLD ranges", () => {
    const [plain, styles] = markdownToSignal("say **hello** now");

    expect(plain).toBe("say hello now");
    expect(stylesFor(plain, styles)).toEqual({ hello: ["BOLD"] });
  });

  it("converts underscore bold to Signal BOLD ranges", () => {
    const [plain, styles] = markdownToSignal("say __hello__ now");

    expect(plain).toBe("say hello now");
    expect(stylesFor(plain, styles)).toEqual({ hello: ["BOLD"] });
  });

  it("converts star italic to Signal ITALIC ranges", () => {
    const [plain, styles] = markdownToSignal("say *hello* now");

    expect(plain).toBe("say hello now");
    expect(stylesFor(plain, styles)).toEqual({ hello: ["ITALIC"] });
  });

  it("converts underscore italic to Signal ITALIC ranges", () => {
    const [plain, styles] = markdownToSignal("say _hello_ now");

    expect(plain).toBe("say hello now");
    expect(stylesFor(plain, styles)).toEqual({ hello: ["ITALIC"] });
  });

  it("converts strikethrough to Signal STRIKETHROUGH ranges", () => {
    const [plain, styles] = markdownToSignal("say ~~hello~~ now");

    expect(plain).toBe("say hello now");
    expect(stylesFor(plain, styles)).toEqual({ hello: ["STRIKETHROUGH"] });
  });

  it("converts inline code to monospace and removes backticks", () => {
    const [plain, styles] = markdownToSignal("run `ls -la` here");

    expect(plain).toBe("run ls -la here");
    expect(stylesFor(plain, styles)).toEqual({ "ls -la": ["MONOSPACE"] });
  });

  it("converts fenced code blocks to monospace", () => {
    const [plain, styles] = markdownToSignal("```\nprint('hi')\n```");

    expect(plain).toContain("print('hi')");
    expect(styles.some((style) => style.endsWith(":MONOSPACE"))).toBe(true);
  });

  it("converts language-tagged code blocks to monospace without the language tag", () => {
    const [plain, styles] = markdownToSignal("```typescript\ncode\n```");

    expect(plain).toBe("code\n");
    expect(styles).toEqual(["0:5:MONOSPACE"]);
  });

  it("does not process markdown inside fenced code blocks", () => {
    const [plain, styles] = markdownToSignal("```\n**not bold**\n```");

    expect(plain).toContain("**not bold**");
    expect(styles.every((style) => !style.endsWith(":BOLD"))).toBe(true);
  });

  it("does not process markdown inside inline code", () => {
    const [plain, styles] = markdownToSignal("use `**raw**` please");

    expect(plain).toBe("use **raw** please");
    expect(styles.every((style) => !style.endsWith(":BOLD"))).toBe(true);
    expect(stylesFor(plain, styles)).toEqual({ "**raw**": ["MONOSPACE"] });
  });

  it("turns H1 headers into bold text", () => {
    const [plain, styles] = markdownToSignal("# My Title");

    expect(plain).toBe("My Title");
    expect(stylesFor(plain, styles)).toEqual({ "My Title": ["BOLD"] });
  });

  it("turns H2 headers into bold text", () => {
    const [plain, styles] = markdownToSignal("## Sub-section");

    expect(plain).toBe("Sub-section");
    expect(stylesFor(plain, styles)).toEqual({ "Sub-section": ["BOLD"] });
  });

  it("strips blockquote markers", () => {
    expect(markdownToSignal("> some quote")).toEqual(["some quote", []]);
  });

  it("turns dash bullets into bullet characters", () => {
    expect(markdownToSignal("- item one")[0]).toBe("• item one");
  });

  it("turns star bullets into bullet characters", () => {
    expect(markdownToSignal("* item two")[0]).toBe("• item two");
  });

  it("preserves numbered list labels", () => {
    const [plain] = markdownToSignal("1. first\n2. second");

    expect(plain).toContain("1. first");
    expect(plain).toContain("2. second");
  });

  it("expands links when text differs from URL", () => {
    expect(markdownToSignal("[Click here](https://example.com)")).toEqual(["Click here (https://example.com)", []]);
  });

  it("keeps links as URL when text equals URL", () => {
    expect(markdownToSignal("[https://example.com](https://example.com)")).toEqual(["https://example.com", []]);
  });

  it("keeps links as URL when text equals URL without scheme", () => {
    expect(markdownToSignal("[example.com](https://example.com)")).toEqual(["https://example.com", []]);
  });

  it("converts markdown to plain text and style ranges", () => {
    const [plain, styles] = markdownToSignal("**bold** and `code`");

    expect(plain).toBe("bold and code");
    expect(styles.some((style) => style.includes("BOLD"))).toBe(true);
    expect(styles.some((style) => style.includes("MONOSPACE"))).toBe(true);
  });

  it("converts adjacent bold and italic spans", () => {
    const [plain, styles] = markdownToSignal("**bold** and *italic*");
    const sd = stylesFor(plain, styles);

    expect(plain).toBe("bold and italic");
    expect(sd.bold).toEqual(["BOLD"]);
    expect(sd.italic).toEqual(["ITALIC"]);
  });

  it("combines header bold with inline code monospace", () => {
    const [plain, styles] = markdownToSignal("# Use `grep`");
    const sd = stylesFor(plain, styles);

    expect(plain).toBe("Use grep");
    expect(styles.some((style) => style.endsWith(":BOLD"))).toBe(true);
    expect(sd.grep).toContain("MONOSPACE");
  });

  it("handles multiline mixed markdown", () => {
    const [plain, styles] = markdownToSignal("**Title**\n\nSome *italic* text.\n\n- bullet\n- another");
    const sd = stylesFor(plain, styles);

    expect(plain).toContain("Title");
    expect(plain).toContain("italic");
    expect(plain).toContain("• bullet");
    expect(sd.Title).toContain("BOLD");
    expect(sd.italic).toContain("ITALIC");
  });

  it("renders markdown tables as monospace text", () => {
    const [plain, styles] = markdownToSignal("| A | B |\n| - | - |\n| 1 | 2 |");

    expect(plain).toContain("A");
    expect(plain).toContain("B");
    expect(styles.some((style) => style.endsWith(":MONOSPACE"))).toBe(true);
  });

  it("emits style ranges in start length style format", () => {
    const [, styles] = markdownToSignal("**bold** text");

    for (const entry of styles) {
      const parts = entry.split(":");
      expect(parts).toHaveLength(3);
      expect(Number.isInteger(Number(parts[0]))).toBe(true);
      expect(Number.isInteger(Number(parts[1]))).toBe(true);
      expect(["BOLD", "ITALIC", "STRIKETHROUGH", "MONOSPACE", "SPOILER"]).toContain(parts[2]);
    }
  });

  it("keeps style ranges inside UTF-16 text bounds", () => {
    const [plain, styles] = markdownToSignal("hello **world** end");

    expectWithinUtf16Bounds(plain, styles);
  });

  it("uses UTF-16 offsets for bold text containing emoji", () => {
    const [plain, styles] = markdownToSignal("**hi 🎉 bye**");

    expect(plain).toBe("hi 🎉 bye");
    expect(stylesFor(plain, styles)).toEqual({ "hi 🎉 bye": ["BOLD"] });
    expectWithinUtf16Bounds(plain, styles);
  });

  it("uses UTF-16 offsets for italic text with trailing emoji", () => {
    const [plain, styles] = markdownToSignal("*bye 🎉*");

    expect(plain).toBe("bye 🎉");
    expect(stylesFor(plain, styles)).toEqual({ "bye 🎉": ["ITALIC"] });
    expectWithinUtf16Bounds(plain, styles);
  });

  it("uses UTF-16 offsets for styled text after an emoji prefix", () => {
    const [plain, styles] = markdownToSignal("🎉 **bold**");

    expect(plain).toBe("🎉 bold");
    expect(stylesFor(plain, styles)).toEqual({ bold: ["BOLD"] });
    expectWithinUtf16Bounds(plain, styles);
  });

  it("uses UTF-16 offsets for non-BMP CJK inside bold text", () => {
    const [plain, styles] = markdownToSignal("**𠮷野家**");

    expect(plain).toBe("𠮷野家");
    expect(stylesFor(plain, styles)).toEqual({ "𠮷野家": ["BOLD"] });
    expectWithinUtf16Bounds(plain, styles);
  });

  it("uses UTF-16 offsets for ZWJ emoji sequences inside bold text", () => {
    const [plain, styles] = markdownToSignal("**hi 👨‍👩‍👧 bye**");

    expect(plain).toBe("hi 👨‍👩‍👧 bye");
    expect(stylesFor(plain, styles)).toEqual({ "hi 👨‍👩‍👧 bye": ["BOLD"] });
    expectWithinUtf16Bounds(plain, styles);
  });

  it("keeps ASCII style offsets unchanged", () => {
    const [plain, styles] = markdownToSignal("**bold** plain *it*");

    expect(plain).toBe("bold plain it");
    expect(styles.sort()).toEqual(["0:4:BOLD", "11:2:ITALIC"].sort());
  });

  it("keeps daily brief styles aligned after non-BMP emoji", () => {
    const md = "**Weather**\n- Conditions: 🌩️ Thunderstorms\n\n**News**\n*World*\n*Local*\n\n**Quote of the Day**";
    const [plain, styles] = markdownToSignal(md);
    const sd = stylesFor(plain, styles);

    expect(sd.Weather).toEqual(["BOLD"]);
    expect(sd.News).toEqual(["BOLD"]);
    expect(sd.World).toEqual(["ITALIC"]);
    expect(sd.Local).toEqual(["ITALIC"]);
    expect(sd["Quote of the Day"]).toEqual(["BOLD"]);
    expectWithinUtf16Bounds(plain, styles);
  });

  it("rebases styles across chunks", () => {
    const styles = partitionStyles("hello world", ["hello", " world"], ["0:5:BOLD", "6:5:ITALIC"]);

    expect(styles[0]).toEqual(["0:5:BOLD"]);
    expect(styles[1]).toEqual(["0:5:ITALIC"]);
  });

  it("passes through partition styles for a single chunk", () => {
    const [plain, styles] = markdownToSignal("**bold** plain *it*");

    expect(partitionStyles(plain, [plain], styles)).toEqual([styles]);
  });

  it("returns empty partition styles when there are no styles", () => {
    expect(partitionStyles("hello world", ["hello world"], [])).toEqual([[]]);
    expect(partitionStyles("hello world", ["hello", "world"], [])).toEqual([[], []]);
  });

  it("drops partition styles outside trimmed chunks", () => {
    expect(partitionStyles("a   b", ["a", "b"], ["1:3:BOLD"])).toEqual([[], []]);
  });

  it("preserves styles that move to later chunks", () => {
    const lineA = "alpha ".repeat(5).trim();
    const lineB = "beta ".repeat(5).trim();
    const text = `${lineA}\n\n${lineB}\n\n**tail**`;
    const [chunks, parts] = resolveChunkStyles(text, lineA.length + 2);
    const finalChunk = chunks.at(-1) ?? "";
    const finalStyles = parts.at(-1) ?? [];

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(finalStyles.some((style) => style.endsWith(":BOLD"))).toBe(true);
    for (const entry of finalStyles) {
      const [startRaw, lengthRaw] = entry.split(":", 2);
      expect(finalChunk.slice(Number(startRaw), Number(startRaw) + Number(lengthRaw))).toBe("tail");
    }
  });

  it("keeps chunk zero style offsets unchanged", () => {
    const [plain, styles] = markdownToSignal("**head** middle and **tail**");
    const chunks = splitMessage(plain, 12);
    const parts = partitionStyles(plain, chunks, styles);

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(parts[0].some((style) => style.startsWith("0:4:") && style.endsWith(":BOLD"))).toBe(true);
  });

  it("rebases chunk offsets when earlier chunks contain non-BMP text", () => {
    const [plain, styles] = markdownToSignal("🎉 alpha beta gamma\n\n**tail**");
    const chunks = splitMessage(plain, 18);
    const parts = partitionStyles(plain, chunks, styles);
    const finalChunk = chunks.at(-1) ?? "";

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const entry of parts.at(-1) ?? []) {
      const [startRaw, lengthRaw] = entry.split(":", 2);
      expect(finalChunk.slice(Number(startRaw), Number(startRaw) + Number(lengthRaw))).toBe("tail");
    }
  });

  it("splits partition style ranges that span chunk boundaries", () => {
    const chunks = splitMessage("abc def", 4);

    expect(chunks).toEqual(["abc", "def"]);
    expect(partitionStyles("abc def", chunks, ["0:7:BOLD"])).toEqual([["0:3:BOLD"], ["0:3:BOLD"]]);
  });

  it("combines outer bold with inner italic on the same span", () => {
    const [plain, styles] = markdownToSignal("**_combo_**");

    expect(plain).toBe("combo");
    expect(new Set(stylesFor(plain, styles).combo)).toEqual(new Set(["BOLD", "ITALIC"]));
  });

  it("handles adjacent bold and italic markers without separators", () => {
    const [plain, styles] = markdownToSignal("**bold***italic*");
    const sd = stylesFor(plain, styles);

    expect(plain).toBe("bolditalic");
    expect(sd.bold).toEqual(["BOLD"]);
    expect(sd.italic).toEqual(["ITALIC"]);
  });

  it("leaves unclosed bold markers as plain text", () => {
    expect(markdownToSignal("**bold")).toEqual(["**bold", []]);
  });

  it("leaves unclosed inline code markers as plain text", () => {
    expect(markdownToSignal("use `grep")).toEqual(["use `grep", []]);
  });

  it("styles inline code inside blockquotes as monospace after stripping the marker", () => {
    const [plain, styles] = markdownToSignal("> use `grep`");

    expect(plain).toBe("use grep");
    expect(stylesFor(plain, styles).grep).toEqual(["MONOSPACE"]);
  });

  it("represents header text with inner bold as contiguous bold ranges", () => {
    const [plain, styles] = markdownToSignal("# **wrap** me");
    const boldRanges = styles.filter((style) => style.endsWith(":BOLD"));
    const covered = new Set<number>();

    for (const entry of boldRanges) {
      const [startRaw, lengthRaw] = entry.split(":", 2);
      for (let i = Number(startRaw); i < Number(startRaw) + Number(lengthRaw); i += 1) covered.add(i);
    }

    expect(plain).toBe("wrap me");
    expect(boldRanges).toHaveLength(2);
    expect(covered).toEqual(new Set([...plain].keys()));
  });
});
