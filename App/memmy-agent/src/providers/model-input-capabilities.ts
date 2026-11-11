export type ModelInputModality = "text" | "image" | "video";

const TEXT = Object.freeze(["text"] as const);
const TEXT_IMAGE = Object.freeze(["text", "image"] as const);

export function requiredInputModalities(
  messages: readonly Record<string, any>[],
): readonly ModelInputModality[] {
  const hasImage = messages.some((message) =>
    Array.isArray(message?.content)
    && message.content.some((block: any) => block?.type === "image_url"),
  );
  return hasImage ? TEXT_IMAGE : TEXT;
}

export function coversInputModalities(
  supported: readonly ModelInputModality[],
  required: readonly ModelInputModality[],
): boolean {
  return required.every((modality) => supported.includes(modality));
}
