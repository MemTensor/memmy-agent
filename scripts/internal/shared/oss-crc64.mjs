import { createReadStream } from "node:fs";

const MASK_64 = 0xffffffffffffffffn;
const REFLECTED_POLYNOMIAL = 0xc96c5795d7870f42n;

const TABLE = Array.from({ length: 256 }, (_, byte) => {
  let value = BigInt(byte);
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1n) === 1n
      ? (value >> 1n) ^ REFLECTED_POLYNOMIAL
      : value >> 1n;
  }
  return value & MASK_64;
});

function updateCrc64Xz(state, bytes) {
  let next = state;
  for (const byte of bytes) {
    const index = Number((next ^ BigInt(byte)) & 0xffn);
    next = TABLE[index] ^ (next >> 8n);
  }
  return next & MASK_64;
}

export function crc64Xz(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("CRC64/XZ input must be a Uint8Array or Buffer");
  }
  return (updateCrc64Xz(MASK_64, bytes) ^ MASK_64) & MASK_64;
}

export async function crc64XzFile(path) {
  let state = MASK_64;
  for await (const chunk of createReadStream(path)) {
    state = updateCrc64Xz(state, chunk);
  }
  return (state ^ MASK_64) & MASK_64;
}

export function parseUnsignedCrc64(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,19})$/.test(value)) {
    throw new Error("Expected CRC64 must be an unsigned decimal integer");
  }
  const parsed = BigInt(value);
  if (parsed > MASK_64) {
    throw new Error("Expected CRC64 exceeds the unsigned 64-bit range");
  }
  return parsed;
}
