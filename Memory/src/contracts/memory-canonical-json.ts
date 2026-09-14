/** Canonical JSON helpers shared by Memory and every Agent Adapter. */

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const SHA256_INITIAL = [
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19
] as const;

const SHA256_ROUND_CONSTANTS = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
] as const;

/** Serializes a JSON value with recursively sorted object keys and no truncation. */
export function canonicalJson(value: JsonValue): string {
  return serializeJsonValue(assertJsonValue(value));
}

/** Validates that a runtime value is representable as JSON without implicit coercion. */
export function assertJsonValue(value: unknown): JsonValue {
  assertJsonNode(value, new Set<object>(), "$input");
  return value as JsonValue;
}

/** Compares strings by Unicode code point rather than locale or UTF-16 collation. */
export function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const delta = leftPoints[index]! - rightPoints[index]!;
    if (delta !== 0) return delta;
  }
  return leftPoints.length - rightPoints.length;
}

/** Portable SHA-256 used by cross-runtime contract identities and fixtures. */
export function sha256Hex(input: string): string {
  const bytes = new TextEncoder().encode(input);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const high = Math.floor(bitLength / 0x1_0000_0000);
  const low = bitLength >>> 0;
  view.setUint32(paddedLength - 8, high, false);
  view.setUint32(paddedLength - 4, low, false);

  const state: number[] = [...SHA256_INITIAL];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      words[index] = view.getUint32(offset + index * 4, false);
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15]!;
      const word2 = words[index - 2]!;
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16]! + sigma0 + words[index - 7]! + sigma1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e!, 6) ^ rotateRight(e!, 11) ^ rotateRight(e!, 25);
      const choose = (e! & f!) ^ (~e! & g!);
      const temporary1 = (h! + sum1 + choose + SHA256_ROUND_CONSTANTS[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a!, 2) ^ rotateRight(a!, 13) ^ rotateRight(a!, 22);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d! + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }

    state[0] = (state[0]! + a!) >>> 0;
    state[1] = (state[1]! + b!) >>> 0;
    state[2] = (state[2]! + c!) >>> 0;
    state[3] = (state[3]! + d!) >>> 0;
    state[4] = (state[4]! + e!) >>> 0;
    state[5] = (state[5]! + f!) >>> 0;
    state[6] = (state[6]! + g!) >>> 0;
    state[7] = (state[7]! + h!) >>> 0;
  }

  return state.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export const MEMORY_CANONICAL_JSON_FIXTURES = [
  {
    input: { z: 1, a: [true, null, "值"] } satisfies JsonValue,
    canonical: "{\"a\":[true,null,\"值\"],\"z\":1}"
  },
  {
    input: { "😀": 1, "界": 2 } satisfies JsonValue,
    canonical: "{\"界\":2,\"😀\":1}"
  }
] as const;

function assertJsonNode(value: unknown, ancestors: Set<object>, path: string): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`${path} contains a non-JSON ${typeof value} value`);
  }
  if (ancestors.has(value)) throw new TypeError(`${path} contains a circular reference`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((item, index) => assertJsonNode(item, ancestors, `${path}[${index}]`));
      return;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} contains a non-plain object`);
    }
    for (const [key, item] of Object.entries(value)) {
      assertJsonNode(item, ancestors, `${path}.${key}`);
    }
  } finally {
    ancestors.delete(value);
  }
}

function serializeJsonValue(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(serializeJsonValue).join(",")}]`;
  return `{${Object.keys(value)
    .sort(compareUnicodeCodePoints)
    .map((key) => `${JSON.stringify(key)}:${serializeJsonValue(value[key]!)}`)
    .join(",")}}`;
}

function rotateRight(value: number, count: number): number {
  return (value >>> count) | (value << (32 - count));
}
