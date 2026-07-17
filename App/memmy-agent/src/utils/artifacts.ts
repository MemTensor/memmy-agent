import fs from "node:fs";
import path from "node:path";
import { getMediaDir } from "../config/paths.js";
import { detectImageMime, ensureDir } from "./helpers.js";

const DATA_IMAGE_RE = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]*)$/;
const MIME_EXTENSIONS: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

export class ArtifactError extends Error {}

export function extractArtifactBlocks(text: string): string[] {
  return [...text.matchAll(/```[\s\S]*?```/g)].map((match) => match[0]);
}

export function decodeImageDataUrl(dataUrl: string): [Buffer, string] {
  const match = DATA_IMAGE_RE.exec(dataUrl.trim());
  if (!match) throw new ArtifactError("expected a base64 image data URL");
  let raw: Buffer;
  try {
    raw = Buffer.from(match[2], "base64");
  } catch (err) {
    throw new ArtifactError("invalid base64 image payload", { cause: err });
  }
  if (raw.length === 0 || raw.toString("base64").replace(/=+$/g, "") !== match[2].replace(/\s+/g, "").replace(/=+$/g, "")) {
    throw new ArtifactError("invalid base64 image payload");
  }
  const detected = detectImageMime(raw);
  if (detected == null) throw new ArtifactError("unsupported or unrecognized image data");
  return [raw, detected];
}

function safeRelativeDir(saveDir: string): string {
  const normalized = saveDir.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized) throw new ArtifactError("saveDir must not be empty");
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new ArtifactError("saveDir must be a safe relative path");
  }
  return path.join(...parts);
}

function artifactRoot(saveDir: string): string {
  const mediaRoot = path.resolve(getMediaDir());
  const root = path.resolve(mediaRoot, safeRelativeDir(saveDir));
  const rel = path.relative(mediaRoot, root);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ArtifactError("artifact directory escapes media root");
  return root;
}

function dayString(createdAt: Date): string {
  return createdAt.toISOString().slice(0, 10);
}

export function storeGeneratedImageArtifact(
  dataUrl: string,
  {
    prompt,
    model,
    sourceImages = [],
    saveDir = "generated",
    provider = "openrouter",
    createdAt,
  }: {
    prompt: string;
    model: string;
    sourceImages?: string[];
    saveDir?: string;
    provider?: string;
    createdAt?: Date;
  },
): Record<string, any> {
  const [raw, mime] = decodeImageDataUrl(dataUrl);
  const ext = MIME_EXTENSIONS[mime];
  if (!ext) throw new ArtifactError(`unsupported image MIME type: ${mime}`);
  const now = createdAt ?? new Date();
  const dayDir = ensureDir(path.join(artifactRoot(saveDir), dayString(now)));
  const id = `img_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const imagePath = path.join(dayDir, `${id}${ext}`);
  const metadataPath = path.join(dayDir, `${id}.json`);
  fs.writeFileSync(imagePath, raw);
  const metadata = {
    id,
    path: imagePath,
    mime,
    prompt,
    model,
    provider,
    source_images: sourceImages,
    created_at: now.toISOString(),
  };
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
  return metadata;
}

export function generatedImageToolResult(artifacts: Array<Record<string, any>>): string {
  return JSON.stringify({
    artifacts,
    next_step:
      "Use these artifact paths as reference_images for follow-up edits. Call the message tool with the artifact paths in the media parameter to deliver the images to the user. Keep raw paths internal unless the user asks for debug details.",
  });
}
