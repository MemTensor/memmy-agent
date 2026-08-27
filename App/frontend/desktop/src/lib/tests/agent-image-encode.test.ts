import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_IMAGE_TARGET_MAX_BYTES,
  encodeAgentImage,
} from "../agent-image-encode.js";

const PNG_HEADER = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("agent image encode", () => {
  it("uses magic bytes instead of declared file.type for supported small images", async () => {
    const file = imageFile("renamed.jpg", "image/jpeg", PNG_HEADER);

    const encoded = await encodeAgentImage(file);

    expect(encoded.blob).toBe(file);
    expect(encoded.mime).toBe("image/png");
    expect(encoded.bytes).toBe(file.size);
    expect(encoded.normalized).toBe(false);
  });

  it("returns small supported originals without requiring canvas encoding", async () => {
    const createImageBitmap = vi.fn(async () => {
      throw new Error("should not decode small originals");
    });
    vi.stubGlobal("createImageBitmap", createImageBitmap);
    const file = imageFile("small.png", "image/png", PNG_HEADER);

    const encoded = await encodeAgentImage(file);

    expect(encoded.blob).toBe(file);
    expect(encoded.mime).toBe("image/png");
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it("rejects oversized images when browser decoding fails", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(async () => {
      throw new Error("decode failed");
    }));
    vi.stubGlobal("OffscreenCanvas", class {});
    const file = imageFile(
      "large.png",
      "image/png",
      concatBytes(PNG_HEADER, new Uint8Array(AGENT_IMAGE_TARGET_MAX_BYTES + 1))
    );

    await expect(encodeAgentImage(file)).rejects.toThrow("home.media.error.sendSize");
  });

  it("rejects unsupported magic bytes", async () => {
    const file = imageFile("vector.svg", "image/svg+xml", new TextEncoder().encode("<svg />"));

    await expect(encodeAgentImage(file)).rejects.toThrow("home.media.error.sendReadFailed");
  });
});

function imageFile(name: string, type: string, bytes: Uint8Array): File {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return new File([buffer], name, { type });
}

function concatBytes(left: Uint8Array, right: Uint8Array): Uint8Array {
  const out = new Uint8Array(left.length + right.length);
  out.set(left, 0);
  out.set(right, left.length);
  return out;
}
