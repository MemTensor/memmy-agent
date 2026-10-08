export type BrowserAuthField = { id: string; label: string; type: string; selector: string;
  autocomplete?: string; required: boolean };
export type BrowserAuthOption = { id: string; label: string; selector?: string; field_ids?: string[] };
export type BrowserAuthRequest = { origin: string; frame?: string; frames?: string[]; fields: BrowserAuthField[];
  options?: BrowserAuthOption[]; submit?: { selector: string; action: 'click' | 'press_enter' } };
export type BrowserAuthResult = { status: 'submitted' | 'declined' | 'cancelled' | 'unavailable'
  | 'expired' | 'origin_changed' | 'page_changed' | 'locator_invalid' | 'submission_failed';
  selected_option?: string; locator_error?: { field_id: string; reason: 'not_user_visible' } };

const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/.test(value);
const label = (value: unknown): value is string => typeof value === 'string' && value.trim() === value
  && value.length >= 1 && value.length <= 80 && !/[\r\n<>]/.test(value);
const selector = (value: unknown): value is string => typeof value === 'string'
  && value.length >= 1 && value.length <= 300 && !/[\r\n\0]/.test(value);

/** Only non-secret, bounded control metadata may cross the Agent/main-process IPC boundary. */
export function parseBrowserAuthRequest(value: unknown): BrowserAuthRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser auth request');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['origin', 'frame', 'frames', 'fields', 'options', 'submit'].includes(key)))
    throw new Error('Invalid browser auth request');
  if (typeof input.origin !== 'string' || input.origin.length > 320
    || !Array.isArray(input.fields) || input.fields.length > 8) throw new Error('Invalid browser auth request');
  let parsed: URL;
  try { parsed = new URL(input.origin); }
  catch { throw new Error('Invalid browser auth origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== input.origin)
    throw new Error('Invalid browser auth origin');
  if (input.frame !== undefined && !selector(input.frame)) throw new Error('Invalid browser auth frame');
  if (input.frames !== undefined && (input.frame !== undefined || !Array.isArray(input.frames)
    || input.frames.length < 1 || input.frames.length > 3 || input.frames.some(value => !selector(value))))
    throw new Error('Invalid browser auth frame chain');
  const fields = input.fields.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid browser auth field');
    const field = raw as Record<string, unknown>;
    if (Object.keys(field).some(key => !['id', 'label', 'type', 'autocomplete', 'required', 'selector'].includes(key))
      || !id(field.id) || field.id === 'selected_option' || !label(field.label) || !selector(field.selector)
      || typeof field.type !== 'string' || !['text', 'email', 'password', 'tel', 'number'].includes(field.type)
      || typeof field.required !== 'boolean'
      || (field.autocomplete !== undefined && (typeof field.autocomplete !== 'string'
        || field.autocomplete.length > 80))) throw new Error('Invalid browser auth field');
    return field as BrowserAuthField;
  });
  if (new Set(fields.map(field => field.id)).size !== fields.length) throw new Error('Duplicate browser auth field');
  let options: BrowserAuthOption[] | undefined;
  if (input.options !== undefined) {
    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 8)
      throw new Error('Invalid browser auth options');
    options = input.options.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid browser auth option');
      const option = raw as Record<string, unknown>;
      if (Object.keys(option).some(key => !['id', 'label', 'selector', 'field_ids'].includes(key))
        || !id(option.id) || !label(option.label)
        || (option.selector !== undefined && !selector(option.selector))
        || (option.field_ids !== undefined && (!Array.isArray(option.field_ids)
          || option.field_ids.some(fieldId => !fields.some(field => field.id === fieldId)))))
        throw new Error('Invalid browser auth option');
      if (!option.selector && !Array.isArray(option.field_ids)) throw new Error('Invalid browser auth option');
      return option as BrowserAuthOption;
    });
    if (new Set(options.map(option => option.id)).size !== options.length)
      throw new Error('Duplicate browser auth option');
  }
  let submit: BrowserAuthRequest['submit'];
  if (input.submit !== undefined) {
    const raw = input.submit;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid browser auth submit');
    const value = raw as Record<string, unknown>;
    if (Object.keys(value).some(key => !['selector', 'action'].includes(key))
      || !selector(value.selector) || !['click', 'press_enter'].includes(String(value.action)))
      throw new Error('Invalid browser auth submit');
    const parsedSubmit = value as NonNullable<BrowserAuthRequest['submit']>;
    if (parsedSubmit.action === 'press_enter' && !fields.some(field => field.selector === parsedSubmit.selector))
      throw new Error('Browser auth Enter target must be a credential field');
    if (parsedSubmit.action === 'click' && fields.some(field => field.selector === parsedSubmit.selector))
      throw new Error('Browser auth submit must be distinct from credential fields');
    submit = parsedSubmit;
  }
  if (!fields.length && !options) throw new Error('Browser auth requires visible controls');
  return { origin: input.origin, ...(input.frame ? { frame: input.frame as string } : {}),
    ...(input.frames ? { frames: input.frames as string[] } : {}),
    fields, ...(options ? { options } : {}), ...(submit ? { submit } : {}) };
}
