import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  crc64Xz,
  crc64XzFile,
  parseUnsignedCrc64,
} from "../scripts/internal/shared/oss-crc64.mjs";
import {
  parseFinalOssHeadHeaders,
  verifyOssObjectIntegrity,
} from "../scripts/internal/shared/oss-object-integrity.mjs";

const repoRoot = resolve(import.meta.dirname, "..");
const verifierPath = resolve(repoRoot, "scripts/verify-oss-object-integrity.mjs");
const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("OSS CRC64/XZ verification", () => {
  it("matches the CRC-64/XZ check vector used by OSS", () => {
    expect(crc64Xz(Buffer.alloc(0))).toBe(0n);
    expect(crc64Xz(Buffer.from("a", "ascii"))).toBe(0x330284772e652b05n);
    expect(crc64Xz(Buffer.from("123456789", "ascii"))).toBe(0x995dc9bbdf1939fan);
    expect(() => crc64Xz("123456789")).toThrow("Uint8Array or Buffer");
  });

  it("produces the same checksum while streaming a file", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "memmy-oss-crc64-"));
    temporaryDirectories.push(directory);
    const path = resolve(directory, "payload.bin");
    const payload = Buffer.alloc(256 * 1024 + 37);
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] = (index * 31 + 17) & 0xff;
    }
    writeFileSync(path, payload);

    await expect(crc64XzFile(path)).resolves.toBe(crc64Xz(payload));
  });

  it("validates unsigned decimal CRC64 metadata", () => {
    expect(parseUnsignedCrc64("0")).toBe(0n);
    expect(parseUnsignedCrc64("18446744073709551615")).toBe(0xffffffffffffffffn);
    expect(() => parseUnsignedCrc64("-1")).toThrow("unsigned decimal integer");
    expect(() => parseUnsignedCrc64("01")).toThrow("unsigned decimal integer");
    expect(() => parseUnsignedCrc64("18446744073709551616")).toThrow("unsigned 64-bit range");
  });

  it("parses only the final HTTP response block and rejects duplicate integrity headers", () => {
    const parsed = parseFinalOssHeadHeaders([
      "HTTP/1.1 302 Found",
      "Content-MD5: redirect-value",
      "content-md5: duplicate-redirect-value",
      "Location: https://example.invalid/final",
      "",
      "HTTP/2 200",
      "content-length: 12",
      "content-md5: AAAAAAAAAAAAAAAAAAAAAA==",
      "etag: final-etag",
      "x-oss-object-type: Normal",
      "",
    ].join("\r\n"));
    expect(parsed).toMatchObject({
      status: 200,
      contentLength: "12",
      contentMd5: "AAAAAAAAAAAAAAAAAAAAAA==",
      etag: "final-etag",
      objectType: "Normal",
    });

    expect(() => parseFinalOssHeadHeaders([
      "HTTP/1.1 200 OK",
      "Content-MD5: AAAAAAAAAAAAAAAAAAAAAA==",
      "content-md5: AAAAAAAAAAAAAAAAAAAAAA==",
      "x-oss-object-type: Normal",
      "",
    ].join("\n"))).toThrow("duplicate content-md5");

    expect(() => parseFinalOssHeadHeaders([
      "HTTP/1.1 503 Service Unavailable",
      "Content-Length: 0",
      "",
    ].join("\r\n"))).toThrow("unexpected HTTP status 503");
  });

  it("verifies Normal objects with Content-MD5", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "memmy-oss-normal-"));
    temporaryDirectories.push(directory);
    const path = resolve(directory, "payload.bin");
    const payload = Buffer.from("normal-release-asset", "utf8");
    writeFileSync(path, payload);
    const contentMd5 = createHash("md5").update(payload).digest("base64");
    const headers = [
      "HTTP/1.1 200 OK",
      `Content-Length: ${payload.length}`,
      `Content-MD5: ${contentMd5}`,
      "ETag: normal-etag",
      "x-oss-object-type: Normal",
      "",
    ].join("\r\n");

    await expect(verifyOssObjectIntegrity(headers, path)).resolves.toMatchObject({
      objectType: "Normal",
      method: "content-md5",
      size: payload.length,
    });
  });

  it("requires and verifies CRC64/XZ for Multipart objects even if MD5 is present", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "memmy-oss-crc64-cli-"));
    temporaryDirectories.push(directory);
    const path = resolve(directory, "payload.bin");
    const payload = Buffer.from("release-asset", "utf8");
    writeFileSync(path, payload);
    const checksum = crc64Xz(payload).toString(10);
    const headers = [
      "HTTP/1.1 200 OK",
      `Content-Length: ${payload.length}`,
      "Content-MD5: AAAAAAAAAAAAAAAAAAAAAA==",
      `x-oss-hash-crc64ecma: ${checksum}`,
      "ETag: multipart-etag-21",
      "x-oss-object-type: Multipart",
      "",
    ].join("\r\n");
    const headersPath = resolve(directory, "headers.txt");
    writeFileSync(headersPath, headers);

    await expect(verifyOssObjectIntegrity(headers, path)).resolves.toMatchObject({
      objectType: "Multipart",
      method: "crc64-xz",
      expected: checksum,
      actual: checksum,
      size: payload.length,
    });

    const matched = spawnSync(process.execPath, [verifierPath, headersPath, path], {
      encoding: "utf8",
    });
    expect(matched.status, matched.stderr).toBe(0);
    expect(JSON.parse(matched.stdout)).toMatchObject({ method: "crc64-xz", actual: checksum });

    writeFileSync(headersPath, headers.replace(checksum, "1"));
    const mismatched = spawnSync(process.execPath, [verifierPath, headersPath, path], {
      encoding: "utf8",
    });
    expect(mismatched.status).toBe(1);
    expect(mismatched.stderr).toContain("CRC64/XZ mismatch");
  });

  it("fails closed for missing Multipart CRC64 and unknown object types", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "memmy-oss-metadata-"));
    temporaryDirectories.push(directory);
    const path = resolve(directory, "payload.bin");
    writeFileSync(path, "payload");
    const base = ["HTTP/1.1 200 OK", "Content-Length: 7"];
    const validMd5 = createHash("md5").update("payload").digest("base64");

    await expect(verifyOssObjectIntegrity([
      ...base,
      `Content-MD5: ${validMd5}`,
      "x-oss-object-type: Multipart",
      "",
    ].join("\r\n"), path)).rejects.toThrow("missing a valid x-oss-hash-crc64ecma");

    await expect(verifyOssObjectIntegrity([
      ...base,
      `Content-MD5: ${validMd5}`,
      "x-oss-object-type: Appendable",
      "",
    ].join("\r\n"), path)).rejects.toThrow("Unsupported OSS object type");

    await expect(verifyOssObjectIntegrity([
      ...base,
      "Content-MD5: AAAAAAAAAAAAAAAAAAAAAA==",
      "x-oss-object-type: Normal",
      "",
    ].join("\r\n"), path)).rejects.toThrow("Content-MD5 mismatch");

    await expect(verifyOssObjectIntegrity([
      ...base,
      "x-oss-hash-crc64ecma: 1",
      "x-oss-object-type: Normal",
      "",
    ].join("\r\n"), path)).rejects.toThrow("missing a canonical Content-MD5");

    await expect(verifyOssObjectIntegrity([
      ...base,
      "Content-MD5: AAAAAAAAAAAAAAAAAAAAAA==",
      "x-oss-hash-crc64ecma: 18446744073709551616",
      "x-oss-object-type: Multipart",
      "",
    ].join("\r\n"), path)).rejects.toThrow("unsigned 64-bit range");

    await expect(verifyOssObjectIntegrity([
      ...base,
      `Content-MD5: ${validMd5}`,
      "",
    ].join("\r\n"), path)).rejects.toThrow("Unsupported OSS object type 'missing'");

    await expect(verifyOssObjectIntegrity([
      "HTTP/1.1 200 OK",
      "Content-Length: 8",
      `Content-MD5: ${validMd5}`,
      "x-oss-object-type: Normal",
      "",
    ].join("\r\n"), path)).rejects.toThrow("Content-Length mismatch");
  });
});
