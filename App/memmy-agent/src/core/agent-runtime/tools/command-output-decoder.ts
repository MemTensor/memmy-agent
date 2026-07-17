import { isUtf8 } from "node:buffer";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import iconv from "iconv-lite";

const WINDOWS_OEMCP_REGISTRY_KEY = String.raw`HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage`;
const WINDOWS_OEMCP_REGISTRY_ARGS = ["query", WINDOWS_OEMCP_REGISTRY_KEY, "/v", "OEMCP", "/reg:64"] as const;
const DIAGNOSTIC_PREVIEW_BYTES = 64;

export type WindowsOemCodePageQueryResult = {
  status: number | null;
  stdout: Buffer;
  error?: Error;
};

export type WindowsOemCodePageQuery = () => WindowsOemCodePageQueryResult;

export type CommandOutputDecoderOptions = {
  platform?: NodeJS.Platform;
  oemCodePage?: string | number | null;
  queryOemCodePage?: WindowsOemCodePageQuery;
};

type WindowsOemEncoding = {
  codePage: string | null;
  encoding: string | null;
};

type RecordEncoding = "unknown" | "utf8" | "oem" | "failed";

type Utf8Status =
  | { kind: "valid" }
  | { kind: "incomplete"; validPrefixLength: number }
  | { kind: "invalid" };

let cachedDefaultWindowsOemEncoding: WindowsOemEncoding | null = null;

function defaultWindowsOemCodePageQuery(): WindowsOemCodePageQueryResult {
  const windowsRoot = process.env.SYSTEMROOT ?? process.env.WINDIR ?? String.raw`C:\Windows`;
  const regPath = path.win32.join(windowsRoot, "System32", "reg.exe");
  try {
    const result = spawnSync(regPath, [...WINDOWS_OEMCP_REGISTRY_ARGS], {
      encoding: null,
      shell: false,
      windowsHide: true,
    });
    return {
      status: result.status,
      stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? ""),
      ...(result.error ? { error: result.error } : {}),
    };
  } catch (error) {
    return {
      status: null,
      stdout: Buffer.alloc(0),
      error: error instanceof Error ? error : new Error(String(error)),
    };
  }
}

export function parseWindowsOemCodePage(stdout: Buffer): string | null {
  if (stdout.length === 0) return null;
  const ascii = Buffer.from([...stdout].filter((byte) => byte !== 0)).toString("ascii");
  return ascii.match(/\bOEMCP\s+REG_SZ\s+([0-9]{3,5})\b/i)?.[1] ?? null;
}

function normalizeCodePage(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return /^[0-9]{3,5}$/.test(normalized) ? normalized : null;
}

function encodingForCodePage(codePage: string | null): WindowsOemEncoding {
  if (!codePage || codePage === "65001") return { codePage, encoding: null };
  const encoding = `cp${codePage}`;
  return {
    codePage,
    encoding: iconv.encodingExists(encoding) ? encoding : null,
  };
}

function queryWindowsOemEncoding(query: WindowsOemCodePageQuery): WindowsOemEncoding {
  const result = query();
  if (result.error || result.status !== 0 || result.stdout.length === 0) {
    return { codePage: null, encoding: null };
  }
  return encodingForCodePage(parseWindowsOemCodePage(result.stdout));
}

function defaultWindowsOemEncoding(): WindowsOemEncoding {
  cachedDefaultWindowsOemEncoding ??= queryWindowsOemEncoding(defaultWindowsOemCodePageQuery);
  return cachedDefaultWindowsOemEncoding;
}

function isIncompleteUtf8Sequence(bytes: Buffer): boolean {
  if (bytes.length === 0) return false;
  const first = bytes[0]!;
  let expectedLength = 0;
  if (first >= 0xc2 && first <= 0xdf) expectedLength = 2;
  else if (first >= 0xe0 && first <= 0xef) expectedLength = 3;
  else if (first >= 0xf0 && first <= 0xf4) expectedLength = 4;
  else return false;
  if (bytes.length >= expectedLength) return false;

  for (let index = 1; index < bytes.length; index += 1) {
    const byte = bytes[index]!;
    if (byte < 0x80 || byte > 0xbf) return false;
    if (index === 1 && first === 0xe0 && byte < 0xa0) return false;
    if (index === 1 && first === 0xed && byte > 0x9f) return false;
    if (index === 1 && first === 0xf0 && byte < 0x90) return false;
    if (index === 1 && first === 0xf4 && byte > 0x8f) return false;
  }
  return true;
}

function utf8Status(bytes: Buffer): Utf8Status {
  if (isUtf8(bytes)) return { kind: "valid" };
  const earliestPossibleStart = Math.max(0, bytes.length - 3);
  for (let start = earliestPossibleStart; start < bytes.length; start += 1) {
    if (!isUtf8(bytes.subarray(0, start))) continue;
    if (isIncompleteUtf8Sequence(bytes.subarray(start))) {
      return { kind: "incomplete", validPrefixLength: start };
    }
  }
  return { kind: "invalid" };
}

function leadingAsciiLength(bytes: Buffer): number {
  let length = 0;
  while (length < bytes.length && bytes[length]! < 0x80) length += 1;
  return length;
}

function asBuffer(chunk: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

export class CommandOutputDecoder {
  private readonly platform: NodeJS.Platform;
  private readonly injectedOemCodePage: string | number | null | undefined;
  private readonly hasInjectedOemCodePage: boolean;
  private readonly queryOemCodePage: WindowsOemCodePageQuery | undefined;
  private pendingInput: Buffer[] = [];
  private ready: string[] = [];
  private unknownBytes = Buffer.alloc(0);
  private recordEncoding: RecordEncoding = "unknown";
  private utf8Decoder: StringDecoder | null = null;
  private oemDecoder: iconv.DecoderStream | null = null;
  private resolvedOemEncoding: WindowsOemEncoding | null = null;
  private recordPreview = Buffer.alloc(0);
  private recordLength = 0;
  private ended = false;

  constructor(options: CommandOutputDecoderOptions = {}) {
    this.platform = options.platform ?? process.platform;
    this.injectedOemCodePage = options.oemCodePage;
    this.hasInjectedOemCodePage = Object.prototype.hasOwnProperty.call(options, "oemCodePage");
    this.queryOemCodePage = options.queryOemCodePage;
  }

  push(chunk: Buffer | Uint8Array): void {
    if (this.ended) throw new Error("command output decoder has already ended");
    const buffer = asBuffer(chunk);
    if (buffer.length === 0) return;
    this.pendingInput.push(Buffer.from(buffer));
  }

  read(): string {
    this.drainInput();
    const text = this.ready.join("");
    this.ready = [];
    return text;
  }

  end(): string {
    if (this.ended) return "";
    this.drainInput();
    this.ended = true;
    if (this.platform === "win32" && (this.recordLength > 0 || this.recordEncoding !== "unknown" || this.unknownBytes.length > 0)) {
      this.finishWindowsRecord();
      this.resetWindowsRecord();
    }
    return this.read();
  }

  private drainInput(): void {
    if (this.pendingInput.length === 0) return;
    const chunks = this.pendingInput;
    this.pendingInput = [];
    if (this.platform !== "win32") {
      for (const chunk of chunks) this.ready.push(String(chunk));
      return;
    }
    this.consumeWindowsInput(chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks));
  }

  private consumeWindowsInput(buffer: Buffer): void {
    let recordStart = 0;
    for (let index = 0; index < buffer.length; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      const recordBytes = buffer.subarray(recordStart, index);
      this.trackRecordBytes(recordBytes);
      this.consumeWindowsBytes(recordBytes);
      this.finishWindowsRecord();
      this.ready.push("\n");
      this.resetWindowsRecord();
      recordStart = index + 1;
    }

    if (recordStart < buffer.length) {
      const recordBytes = buffer.subarray(recordStart);
      this.trackRecordBytes(recordBytes);
      this.consumeWindowsBytes(recordBytes);
    }
  }

  private trackRecordBytes(bytes: Buffer): void {
    this.recordLength += bytes.length;
    if (this.recordPreview.length >= DIAGNOSTIC_PREVIEW_BYTES || bytes.length === 0) return;
    const remaining = DIAGNOSTIC_PREVIEW_BYTES - this.recordPreview.length;
    this.recordPreview = Buffer.concat([this.recordPreview, bytes.subarray(0, remaining)]);
  }

  private consumeWindowsBytes(bytes: Buffer): void {
    if (bytes.length === 0 || this.recordEncoding === "failed") return;
    if (this.recordEncoding === "utf8") {
      this.appendReady(this.utf8Decoder!.write(bytes));
      return;
    }
    if (this.recordEncoding === "oem") {
      this.appendReady(this.oemDecoder!.write(bytes));
      return;
    }

    this.unknownBytes = this.unknownBytes.length === 0 ? Buffer.from(bytes) : Buffer.concat([this.unknownBytes, bytes]);
    const asciiLength = leadingAsciiLength(this.unknownBytes);
    if (asciiLength > 0) {
      this.appendReady(this.unknownBytes.subarray(0, asciiLength).toString("ascii"));
      this.unknownBytes = this.unknownBytes.subarray(asciiLength);
    }
    if (this.unknownBytes.length === 0) return;

    const status = utf8Status(this.unknownBytes);
    if (status.kind === "valid") {
      this.lockUtf8();
      return;
    }
    if (status.kind === "incomplete") {
      if (status.validPrefixLength > 0) this.lockUtf8();
      return;
    }
    this.lockOemOrFail();
  }

  private lockUtf8(): void {
    this.recordEncoding = "utf8";
    this.utf8Decoder = new StringDecoder("utf8");
    this.appendReady(this.utf8Decoder.write(this.unknownBytes));
    this.unknownBytes = Buffer.alloc(0);
  }

  private lockOemOrFail(): void {
    const resolved = this.resolveOemEncoding();
    if (!resolved.encoding) {
      this.recordEncoding = "failed";
      this.unknownBytes = Buffer.alloc(0);
      return;
    }
    this.recordEncoding = "oem";
    this.oemDecoder = iconv.getDecoder(resolved.encoding);
    this.appendReady(this.oemDecoder.write(this.unknownBytes));
    this.unknownBytes = Buffer.alloc(0);
  }

  private finishWindowsRecord(): void {
    if (this.recordEncoding === "unknown" && this.unknownBytes.length > 0) {
      if (isUtf8(this.unknownBytes)) this.lockUtf8();
      else this.lockOemOrFail();
    }

    if (this.recordEncoding === "utf8") {
      this.appendReady(this.utf8Decoder?.end() ?? "");
    } else if (this.recordEncoding === "oem") {
      this.appendReady(this.oemDecoder?.end() ?? "");
    } else if (this.recordEncoding === "failed") {
      this.appendReady(this.failureDiagnostic());
    }
  }

  private resetWindowsRecord(): void {
    this.recordEncoding = "unknown";
    this.unknownBytes = Buffer.alloc(0);
    this.utf8Decoder = null;
    this.oemDecoder = null;
    this.recordPreview = Buffer.alloc(0);
    this.recordLength = 0;
  }

  private resolveOemEncoding(): WindowsOemEncoding {
    if (this.resolvedOemEncoding) return this.resolvedOemEncoding;
    if (this.hasInjectedOemCodePage) {
      this.resolvedOemEncoding = encodingForCodePage(normalizeCodePage(this.injectedOemCodePage));
    } else if (this.queryOemCodePage) {
      this.resolvedOemEncoding = queryWindowsOemEncoding(this.queryOemCodePage);
    } else {
      this.resolvedOemEncoding = defaultWindowsOemEncoding();
    }
    return this.resolvedOemEncoding;
  }

  private failureDiagnostic(): string {
    const codePage = this.resolveOemEncoding().codePage ?? "unknown";
    const omitted = Math.max(0, this.recordLength - this.recordPreview.length);
    return `[Memmy: unable to decode Windows command output; OEMCP=${codePage}; first 64 bytes=${this.recordPreview.toString("hex")}; omitted=${omitted}]`;
  }

  private appendReady(text: string): void {
    if (text) this.ready.push(text);
  }
}
