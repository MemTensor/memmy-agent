export function toMemoryDetailErrorMessage(error: unknown, fallbackMessage: string): string {
  const message = error instanceof Error ? error.message : String(error);
  if (isDetailValidationMessage(message)) {
    return fallbackMessage;
  }

  return message;
}

function isDetailValidationMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("expected string to have >=1 characters") ||
    normalized.includes("too small") ||
    normalized.includes("invalid input") ||
    normalized.includes("zod")
  );
}
