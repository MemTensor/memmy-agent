/** Input validation module. */

/** Handles require non empty string. */
export function requireNonEmptyString(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw Object.assign(new Error(`${field} is required`), { code: "invalid_argument" as const });
  }

  return normalized;
}
