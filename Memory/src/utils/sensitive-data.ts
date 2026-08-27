const SENSITIVE_FIELD =
  "(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|token|password|passwd|pwd|secret|client[_-]?secret|private[_-]?key|credential)";

const ESCAPED_JSON_SECRET = new RegExp(
  `(\\\\")(${SENSITIVE_FIELD})(\\\\")\\s*:\\s*(\\\\")(.*?)(\\\\")`,
  "gi"
);
const JSON_SECRET = new RegExp(
  `(")(${SENSITIVE_FIELD})(")\\s*:\\s*(")([^"]*)(")`,
  "gi"
);
const QUOTED_ASSIGNED_SECRET = new RegExp(
  `\\b(${SENSITIVE_FIELD})\\s*[:=]\\s*(?:\\\\?["'])(.*?)(?:\\\\?["'])`,
  "gi"
);
const ASSIGNED_SECRET = new RegExp(
  `\\b(${SENSITIVE_FIELD})\\s*[:=]\\s*([^\\s,;}\\"']+)`,
  "gi"
);

export function redactSensitiveText(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9._-]+\b/gi, "[redacted]")
    .replace(ESCAPED_JSON_SECRET, "$1$2$3:$4[redacted]$6")
    .replace(JSON_SECRET, "$1$2$3:$4[redacted]$6")
    .replace(
      /([?&](?:key|api_key|access_token|refresh_token|token|password|secret)=)[^&\s]+/gi,
      "$1[redacted]"
    )
    .replace(QUOTED_ASSIGNED_SECRET, "$1=[redacted]")
    .replace(ASSIGNED_SECRET, "$1=[redacted]");
}
