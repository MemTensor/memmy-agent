/** Merges configured headers case-insensitively, matching HTTP header semantics. */
export function mergeProviderHeaders(defaults: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  const headers = { ...defaults };
  for (const [key, value] of Object.entries(extra)) {
    for (const existing of Object.keys(headers)) if (existing.toLowerCase() === key.toLowerCase()) delete headers[existing];
    headers[key] = value;
  }
  return headers;
}
