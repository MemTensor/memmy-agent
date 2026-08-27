export const AGENT_IMAGE_TARGET_MAX_BYTES = 6 * 1024 * 1024;
export const AGENT_IMAGE_MAX_EDGE = 2048;
export const AGENT_IMAGE_WEBP_QUALITY = 0.85;

export const AGENT_IMAGE_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif"
] as const;

export type AgentImageMime = typeof AGENT_IMAGE_MIME_TYPES[number];

export interface EncodedAgentImage {
  blob: Blob;
  mime: AgentImageMime;
  bytes: number;
  normalized: boolean;
  fallbackOriginal?: boolean;
}

export function isAgentImageMime(value: string): value is AgentImageMime {
  return (AGENT_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

export function agentImageAccept(): string {
  return AGENT_IMAGE_MIME_TYPES.join(",");
}

export function agentImageExtensionForMime(mime: AgentImageMime): string {
  switch (mime) {
    case "image/jpeg":
      return ".jpg";
    case "image/webp":
      return ".webp";
    case "image/gif":
      return ".gif";
    case "image/png":
    default:
      return ".png";
  }
}

export async function encodeAgentImage(file: File): Promise<EncodedAgentImage> {
  const sniffed = sniffAgentImageMime(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
  if (!sniffed) {
    throw new Error("home.media.error.sendReadFailed");
  }

  if (file.size <= AGENT_IMAGE_TARGET_MAX_BYTES) {
    return originalEncodedImage(file, sniffed);
  }

  if (!canUseCanvasEncoding()) {
    throw new Error("home.media.error.sendSize");
  }

  let image: ImageBitmap;
  try {
    image = await createImageBitmap(file);
  } catch {
    throw new Error("home.media.error.sendSize");
  }

  try {
    const { width, height } = containImageSize(image.width, image.height, AGENT_IMAGE_MAX_EDGE);
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("home.media.error.sendSize");
    }
    context.drawImage(image, 0, 0, width, height);
    const outputMime: AgentImageMime = sniffed === "image/png" || sniffed === "image/gif" ? "image/png" : "image/webp";
    const encoded = await canvas.convertToBlob({
      type: outputMime,
      quality: outputMime === "image/webp" ? AGENT_IMAGE_WEBP_QUALITY : undefined
    });
    if (encoded.size > AGENT_IMAGE_TARGET_MAX_BYTES) {
      throw new Error("home.media.error.sendSize");
    }
    return {
      blob: encoded,
      mime: outputMime,
      bytes: encoded.size,
      normalized: true
    };
  } catch (error) {
    if (error instanceof Error && error.message === "home.media.error.sendSize") {
      throw error;
    }
    throw new Error("home.media.error.sendSize");
  } finally {
    image.close();
  }
}

function originalEncodedImage(file: File, mime: AgentImageMime): EncodedAgentImage {
  return {
    blob: file,
    mime,
    bytes: file.size,
    normalized: false,
    fallbackOriginal: true
  };
}

function canUseCanvasEncoding(): boolean {
  return typeof createImageBitmap === "function" && typeof OffscreenCanvas === "function";
}

function containImageSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!Number.isFinite(longest) || longest <= 0) {
    throw new Error("home.media.error.sendReadFailed");
  }
  if (longest <= maxEdge) {
    return { width, height };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

export function sniffAgentImageMime(bytes: Uint8Array): AgentImageMime | null {
  if (bytes.length >= 8
    && bytes[0] === 0x89
    && bytes[1] === 0x50
    && bytes[2] === 0x4e
    && bytes[3] === 0x47
    && bytes[4] === 0x0d
    && bytes[5] === 0x0a
    && bytes[6] === 0x1a
    && bytes[7] === 0x0a) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (bytes.length >= 12
    && bytes[0] === 0x52
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x46
    && bytes[8] === 0x57
    && bytes[9] === 0x45
    && bytes[10] === 0x42
    && bytes[11] === 0x50) {
    return "image/webp";
  }
  if (bytes.length >= 6
    && bytes[0] === 0x47
    && bytes[1] === 0x49
    && bytes[2] === 0x46
    && bytes[3] === 0x38
    && (bytes[4] === 0x37 || bytes[4] === 0x39)
    && bytes[5] === 0x61) {
    return "image/gif";
  }
  return null;
}
