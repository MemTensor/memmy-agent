import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { crc64XzFile, parseUnsignedCrc64 } from "./oss-crc64.mjs";

const TRACKED_HEADERS = new Set([
  "content-length",
  "content-md5",
  "etag",
  "x-oss-hash-crc64ecma",
  "x-oss-object-type",
]);

export function parseFinalOssHeadHeaders(source) {
  if (typeof source !== "string") {
    throw new Error("OSS HEAD response must be text");
  }

  const blocks = [];
  let current = null;
  for (const rawLine of source.split(/\r?\n/)) {
    const statusMatch = /^HTTP\/\S+\s+(\d{3})(?:\s|$)/i.exec(rawLine);
    if (statusMatch) {
      current = { status: Number(statusMatch[1]), headers: new Map() };
      blocks.push(current);
      continue;
    }
    if (!current || !rawLine) continue;
    const separator = rawLine.indexOf(":");
    if (separator < 1) continue;
    const name = rawLine.slice(0, separator).trim().toLowerCase();
    if (!TRACKED_HEADERS.has(name)) continue;
    const values = current.headers.get(name) ?? [];
    values.push(rawLine.slice(separator + 1).trim());
    current.headers.set(name, values);
  }

  const finalBlock = blocks.at(-1);
  if (!finalBlock) {
    throw new Error("OSS HEAD response does not contain an HTTP status line");
  }
  if (finalBlock.status < 200 || finalBlock.status >= 300) {
    throw new Error(`OSS final HEAD response has unexpected HTTP status ${finalBlock.status}`);
  }

  const value = (name) => {
    const values = finalBlock.headers.get(name) ?? [];
    if (values.length > 1) {
      throw new Error(`OSS final HEAD response contains duplicate ${name} headers`);
    }
    return values[0] ?? "";
  };

  return {
    status: finalBlock.status,
    contentLength: value("content-length"),
    contentMd5: value("content-md5"),
    crc64: value("x-oss-hash-crc64ecma"),
    etag: value("etag"),
    objectType: value("x-oss-object-type"),
  };
}

async function md5File(path) {
  const hash = createHash("md5");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest();
}

function parseContentMd5(value) {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(value)) {
    throw new Error("Normal OSS object is missing a canonical Content-MD5 value");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.length !== 16 || decoded.toString("base64") !== value) {
    throw new Error("Normal OSS object returned an invalid Content-MD5 value");
  }
  return decoded;
}

function parseContentLength(value) {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw new Error("OSS object is missing a valid Content-Length value");
  }
  const parsed = BigInt(value);
  if (parsed <= 0n) {
    throw new Error("OSS installer object must be non-empty");
  }
  return parsed;
}

export async function verifyOssObjectIntegrity(headersText, path) {
  const metadata = parseFinalOssHeadHeaders(headersText);
  const expectedSize = parseContentLength(metadata.contentLength);
  const file = await lstat(path);
  if (file.isSymbolicLink() || !file.isFile()) {
    throw new Error("Downloaded OSS installer must be a regular, non-symbolic-link file");
  }
  const actualSize = BigInt(file.size);
  if (actualSize !== expectedSize) {
    throw new Error(`OSS Content-Length mismatch: expected ${expectedSize}, actual ${actualSize}`);
  }

  if (metadata.objectType === "Normal") {
    const expected = parseContentMd5(metadata.contentMd5);
    const actual = await md5File(path);
    if (!actual.equals(expected)) {
      throw new Error(
        `Content-MD5 mismatch: expected ${expected.toString("hex")}, actual ${actual.toString("hex")}`,
      );
    }
    return {
      objectType: metadata.objectType,
      method: "content-md5",
      expected: expected.toString("hex"),
      actual: actual.toString("hex"),
      size: file.size,
      etag: metadata.etag,
    };
  }

  if (metadata.objectType === "Multipart") {
    let expected;
    try {
      expected = parseUnsignedCrc64(metadata.crc64);
    } catch (error) {
      throw new Error(
        `Multipart OSS object is missing a valid x-oss-hash-crc64ecma value: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const actual = await crc64XzFile(path);
    if (actual !== expected) {
      throw new Error(`CRC64/XZ mismatch: expected ${expected}, actual ${actual}`);
    }
    return {
      objectType: metadata.objectType,
      method: "crc64-xz",
      expected: expected.toString(10),
      actual: actual.toString(10),
      size: file.size,
      etag: metadata.etag,
    };
  }

  throw new Error(
    `Unsupported OSS object type '${metadata.objectType || "missing"}'; expected Normal or Multipart`,
  );
}
