type AliasGroups = readonly (readonly [string, ...string[]])[];

// Deprecated token-named fields historically measured characters, not tokens.
// Keep their numeric meaning for old callers; expose only max_output_chars.
export const OUTPUT_LIMIT_ALIASES = [
  ["max_output_chars", "maxOutputChars", "max_output_tokens", "maxOutputTokens"],
] as const;

export const OUTPUT_LIMIT_DESCRIPTION =
  "Maximum retained command output in UTF-16 code units (JavaScript string length), not tokens. " +
  "Defaults to 10000; truncation notices and status metadata are additional.";

/** Resolve legacy fields before side effects. Nullish values are unset; empty strings and false are explicit. */
export function normalizeParameterAliases(params: Record<string, any>, groups: AliasGroups): {
  params: Record<string, any>;
  error: string | null;
} {
  const normalized = { ...params };
  for (const [canonical, ...aliases] of groups) {
    const supplied = [canonical, ...aliases].filter((key) => params[key] != null);
    const first = supplied[0];
    for (const key of supplied.slice(1)) {
      if (params[key] !== params[first]) {
        return {
          params,
          error: `Conflicting parameters: ${first} and ${key} must have the same value when both are provided. Use only ${canonical}.`,
        };
      }
    }
    if (first !== undefined) normalized[canonical] = params[first];
    else delete normalized[canonical];
    for (const alias of aliases) delete normalized[alias];
  }
  return { params: normalized, error: null };
}

export function castParameterAliases(
  params: Record<string, any>,
  groups: AliasGroups,
  cast: (params: Record<string, any>) => Record<string, any>,
): Record<string, any> {
  const converted = cast(params);
  if (!converted || typeof converted !== "object" || Array.isArray(converted)) return converted;
  for (const [canonical, ...aliases] of groups) {
    for (const alias of aliases) {
      if (alias in converted) converted[alias] = cast({ [canonical]: converted[alias] })[canonical];
    }
  }
  // Preserve conflicting fields for validateParams, including on repeated casts.
  return normalizeParameterAliases(converted, groups).params;
}
