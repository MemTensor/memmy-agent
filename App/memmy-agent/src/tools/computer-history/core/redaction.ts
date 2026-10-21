/** Shared by raw capture and summaries so credentials cannot escape at either layer. */
export function redactSensitive(value: unknown): string {
  return String(value ?? "")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[image base64 omitted]")
    .replace(/\bBearer\s+[a-z0-9._~+/-]{12,}/gi, "Bearer [REDACTED]")
    .replace(/\bsk-[a-z0-9_-]{12,}\b/gi, "[REDACTED]")
    // Quoted values may contain spaces, commas or escaped quotes. Preserve
    // quotes and surrounding JSON punctuation instead of consuming the next
    // field, and also accept the unquoted key=value form used in terminals.
    .replace(
      /((?:["']?\b(?:api[ _-]?key|access[ _-]?token|auth[ _-]?token|password|secret)\b["']?)\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[REDACTED\]|[^\s,;\]}]+)/gi,
      (_match, prefix: string, secret: string) => {
        const quote = secret[0] === '"' || secret[0] === "'" ? secret[0] : "";
        return `${prefix}${quote}[REDACTED]${quote}`;
      },
    )
    // Accessibility values and window text can contain a credential-looking
    // token without a key/value label (for example `demo-secret-value-123`).
    // Mask those structured secret tokens while leaving ordinary prose intact.
    .replace(/\b[a-z0-9]+[-_](?:secret|token)(?:[-_][a-z0-9]+)+\b/gi, "[REDACTED]");
}
