/** Browser sign-in values are transient execution input, never progress/history data. */
export function redactBrowserAuthArguments(name: unknown, args: any): any {
  if (name !== 'browser_auth_request' || !args || typeof args !== 'object' || Array.isArray(args)) return args;
  if (!Object.prototype.hasOwnProperty.call(args, 'provided_values')) return args;
  const values = args.provided_values;
  return { ...args, provided_values: values && typeof values === 'object' && !Array.isArray(values)
    ? Object.fromEntries(Object.keys(values).map(key => [key, '[REDACTED]'])) : '[REDACTED]' };
}

/** Provider extensions may retain signatures, but must not duplicate executable auth input. */
export function redactBrowserAuthMetadata(name: unknown, metadata: any): any {
  if (name !== 'browser_auth_request' || !metadata || typeof metadata !== 'object') return metadata;
  if (Array.isArray(metadata)) return metadata.map(value => redactBrowserAuthMetadata(name, value));
  return Object.fromEntries(Object.entries(metadata)
    .filter(([key]) => key !== 'arguments' && key !== 'provided_values')
    .map(([key, value]) => [key, redactBrowserAuthMetadata(name, value)]));
}

/** A browser client may report status and control identifiers, never credentials. */
export function publicBrowserAuthResult(value: unknown): string {
  const result = value as Record<string, any> | null;
  if (!result || typeof result !== 'object' || !['submitted', 'declined', 'cancelled', 'unavailable',
    'expired', 'origin_changed', 'page_changed', 'locator_invalid', 'submission_failed'].includes(result.status))
    throw new Error('Invalid browser auth response');
  return JSON.stringify({ status: result.status,
    ...(typeof result.selected_option === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(result.selected_option)
      ? { selected_option: result.selected_option } : {}),
    ...(result.locator_error && typeof result.locator_error.field_id === 'string'
      && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(result.locator_error.field_id)
      && result.locator_error.reason === 'not_user_visible'
      ? { locator_error: { field_id: result.locator_error.field_id, reason: 'not_user_visible' } } : {}),
  });
}
