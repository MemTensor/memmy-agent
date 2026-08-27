import iconv from "iconv-lite";
import { describe, expect, it, vi } from "vitest";
import {
  CommandOutputDecoder,
  parseWindowsOemCodePage,
  type WindowsOemCodePageQueryResult,
} from "../../../../src/core/agent-runtime/tools/command-output-decoder.js";

const WINDOWS_COMMAND_NOT_FOUND = "'node' 不是内部或外部命令，也不是可运行的程序\r\n或批处理文件。\r\n";

function decodeAll(decoder: CommandOutputDecoder, chunks: Buffer[]): string {
  let output = "";
  for (const chunk of chunks) {
    decoder.push(chunk);
    output += decoder.read();
  }
  return output + decoder.end();
}

function registryResult(codePage: string, utf16 = false): WindowsOemCodePageQueryResult {
  const text = `    OEMCP    REG_SZ    ${codePage}\r\n`;
  return {
    status: 0,
    stdout: Buffer.from(text, utf16 ? "utf16le" : "ascii"),
  };
}

describe("CommandOutputDecoder", () => {
  it("decodes the Chinese Windows command-not-found error from CP936", () => {
    const encoded = iconv.encode(WINDOWS_COMMAND_NOT_FOUND, "cp936");
    const decoder = new CommandOutputDecoder({ platform: "win32", oemCodePage: 936 });

    expect(decodeAll(decoder, [encoded])).toBe(WINDOWS_COMMAND_NOT_FOUND);
  });

  it("decodes complete one-shot records after collecting multiple chunks", () => {
    const encoded = iconv.encode(WINDOWS_COMMAND_NOT_FOUND, "cp936");
    const decoder = new CommandOutputDecoder({ platform: "win32", oemCodePage: 936 });

    decoder.push(encoded.subarray(0, 7));
    decoder.push(encoded.subarray(7, 19));
    decoder.push(encoded.subarray(19));

    expect(decoder.end()).toBe(WINDOWS_COMMAND_NOT_FOUND);
  });

  it("keeps UTF-8 output on Windows and handles characters split across chunks", () => {
    const encoded = Buffer.from("UTF-8 中文和 emoji 😀\r\n", "utf8");
    const splitAt = encoded.indexOf(Buffer.from("中")) + 1;
    const decoder = new CommandOutputDecoder({ platform: "win32", oemCodePage: 936 });

    const output = decodeAll(decoder, [encoded.subarray(0, splitAt), encoded.subarray(splitAt, splitAt + 2), encoded.subarray(splitAt + 2)]);

    expect(output).toBe("UTF-8 中文和 emoji 😀\r\n");
    expect(output).not.toContain("�");
  });

  it("holds an incomplete CP936 character until the next chunk", () => {
    const encoded = iconv.encode("中文", "cp936");
    const decoder = new CommandOutputDecoder({ platform: "win32", oemCodePage: 936 });

    decoder.push(encoded.subarray(0, 1));
    expect(decoder.read()).toBe("");
    decoder.push(encoded.subarray(1, 3));
    expect(decoder.read()).toBe("中");
    decoder.push(encoded.subarray(3));

    expect(decoder.end()).toBe("文");
  });

  it("returns ASCII immediately without querying OEMCP and preserves CRLF", () => {
    const query = vi.fn(() => registryResult("936"));
    const decoder = new CommandOutputDecoder({ platform: "win32", queryOemCodePage: query });

    decoder.push(Buffer.from("ready>\r\n", "ascii"));

    expect(decoder.read()).toBe("ready>\r\n");
    expect(decoder.end()).toBe("");
    expect(query).not.toHaveBeenCalled();
  });

  it("keeps stdout and stderr decoder state independent", () => {
    const stdout = new CommandOutputDecoder({ platform: "win32", oemCodePage: 936 });
    const stderr = new CommandOutputDecoder({ platform: "win32", oemCodePage: 936 });
    const stderrBytes = iconv.encode("错误", "cp936");

    stdout.push(Buffer.from("正确", "utf8"));
    stderr.push(stderrBytes.subarray(0, 1));

    expect(stdout.read()).toBe("正确");
    expect(stderr.read()).toBe("");

    stderr.push(stderrBytes.subarray(1));
    expect(stderr.end()).toBe("错误");
    expect(stdout.end()).toBe("");
  });

  it("decodes UTF-8 and OEM records independently in one stream", () => {
    const decoder = new CommandOutputDecoder({ platform: "win32", oemCodePage: 936 });
    const bytes = Buffer.concat([
      Buffer.from("UTF-8 中文\r\n", "utf8"),
      iconv.encode("系统错误\r\n", "cp936"),
    ]);

    expect(decodeAll(decoder, [bytes])).toBe("UTF-8 中文\r\n系统错误\r\n");
  });

  it("returns only new text from read and flushes an unterminated record once", () => {
    const decoder = new CommandOutputDecoder({ platform: "win32", oemCodePage: 936 });
    const encoded = iconv.encode("没有换行", "cp936");

    decoder.push(encoded.subarray(0, 4));
    const first = decoder.read();
    decoder.push(encoded.subarray(4));
    const second = decoder.read();
    const final = decoder.end();

    expect(first + second + final).toBe("没有换行");
    expect(decoder.read()).toBe("");
    expect(decoder.end()).toBe("");
  });

  it("extracts OEMCP from ASCII and UTF-16LE registry output", () => {
    expect(parseWindowsOemCodePage(registryResult("936").stdout)).toBe("936");
    expect(parseWindowsOemCodePage(registryResult("932", true).stdout)).toBe("932");
  });

  it("maps queried OEM code pages instead of hard-coding CP936", () => {
    const query = vi.fn(() => registryResult("932"));
    const decoder = new CommandOutputDecoder({ platform: "win32", queryOemCodePage: query });
    const expected = "コマンドが見つかりません";

    expect(decodeAll(decoder, [iconv.encode(expected, "cp932")])).toBe(expected);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["spawn error", { status: null, stdout: Buffer.alloc(0), error: new Error("spawn failed") }],
    ["non-zero exit", { status: 1, stdout: Buffer.from("failed") }],
    ["empty output", { status: 0, stdout: Buffer.alloc(0) }],
    ["unrecognized output", { status: 0, stdout: Buffer.from("OEMCP unavailable") }],
  ] satisfies Array<[string, WindowsOemCodePageQueryResult]>)("emits a fixed diagnostic for %s while querying OEMCP", (_label, result) => {
    const decoder = new CommandOutputDecoder({ platform: "win32", queryOemCodePage: () => result });

    const output = decodeAll(decoder, [Buffer.from([0xff])]);

    expect(output).toBe("[Memmy: unable to decode Windows command output; OEMCP=unknown; first 64 bytes=ff; omitted=0]");
    expect(output).not.toContain("�");
  });

  it("emits a fixed diagnostic for UTF-8 OEMCP or an unsupported code page", () => {
    const utf8Oem = new CommandOutputDecoder({ platform: "win32", oemCodePage: 65001 });
    const unsupported = new CommandOutputDecoder({ platform: "win32", oemCodePage: 99999 });

    expect(decodeAll(utf8Oem, [Buffer.from([0xff])])).toContain("OEMCP=65001");
    expect(decodeAll(unsupported, [Buffer.from([0xff])])).toContain("OEMCP=99999");
  });

  it("limits diagnostic bytes and reports the omitted count", () => {
    const decoder = new CommandOutputDecoder({ platform: "win32", oemCodePage: null });

    const output = decodeAll(decoder, [Buffer.alloc(65, 0xff)]);

    expect(output).toContain(`first 64 bytes=${"ff".repeat(64)}`);
    expect(output).toContain("omitted=1");
  });

  it("keeps the existing per-chunk String(Buffer) behavior outside Windows", () => {
    const query = vi.fn(() => registryResult("936"));
    const encoded = Buffer.from("中文", "utf8");
    const chunks = [encoded.subarray(0, 1), encoded.subarray(1, 4), encoded.subarray(4)];
    const decoder = new CommandOutputDecoder({ platform: "darwin", queryOemCodePage: query });

    expect(decodeAll(decoder, chunks)).toBe(chunks.map((chunk) => String(chunk)).join(""));
    expect(query).not.toHaveBeenCalled();
  });

  it("uses UTF-8 for bytes that are valid in both UTF-8 and an OEM code page", () => {
    const query = vi.fn(() => registryResult("936"));
    const decoder = new CommandOutputDecoder({ platform: "win32", queryOemCodePage: query });

    expect(decodeAll(decoder, [Buffer.from([0xc2, 0xa1])])).toBe("¡");
    expect(query).not.toHaveBeenCalled();
  });
});
