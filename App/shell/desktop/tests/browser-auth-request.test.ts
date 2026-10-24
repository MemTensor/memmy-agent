import { expect, it } from 'vitest';
import { parseBrowserAuthRequest } from '../src/main/browser-auth-request.js';

const request = { origin: 'https://example.test', fields: [
  { id: 'password', label: 'Password', type: 'password', required: true,
    selector: 'input[autocomplete="current-password"]' },
] };

it('accepts only bounded non-secret metadata for one current origin', () => {
  expect(parseBrowserAuthRequest(request)).toEqual(request);
  expect(() => parseBrowserAuthRequest({ ...request, origin: 'https://example.test/login?code=secret' }))
    .toThrow(/origin/);
  expect(() => parseBrowserAuthRequest({ ...request, password: 'secret' })).toThrow(/request/);
  expect(() => parseBrowserAuthRequest({ ...request, fields: [{ ...request.fields[0],
    label: '<script>bad</script>' }] })).toThrow(/field/);
  expect(() => parseBrowserAuthRequest({ ...request, options: [
    { id: 'provider', label: 'Google', selector: 'button.google' },
    { id: 'password', label: 'Password', field_ids: ['missing'] },
  ] })).toThrow(/option/);
});

it('accepts a bounded iframe chain and rejects ambiguous frame paths', () => {
  expect(parseBrowserAuthRequest({ ...request, frames: ['iframe#id', 'iframe#challenge'] }))
    .toMatchObject({ frames: ['iframe#id', 'iframe#challenge'] });
  expect(() => parseBrowserAuthRequest({ ...request, frame: 'iframe#id', frames: ['iframe#challenge'] }))
    .toThrow(/frame/);
  expect(() => parseBrowserAuthRequest({ ...request, frames: [] })).toThrow(/frame/);
  expect(() => parseBrowserAuthRequest({ ...request, frames: Array(4).fill('iframe') }))
    .toThrow(/frame/);
});

it('accepts task-provided values only for inspected fields and does not put them in a missing-fields form', async () => {
  const { collectMissingBrowserAuth } = await import('../src/main/browser-auth-request.js');
  const parsed = parseBrowserAuthRequest({ ...request, fields: [...request.fields,
    { id: 'code', label: '验证码', type: 'text', required: true, selector: '#code' }],
    provided_values: { password: 'already-supplied-secret' } });
  let form: unknown;
  const answer = await collectMissingBrowserAuth(parsed, async metadata => {
    form = metadata;
    return { values: { code: '246810' } };
  });
  expect(form).toMatchObject({ fields: [{ id: 'code' }] });
  expect(JSON.stringify(form)).not.toContain('already-supplied-secret');
  expect(answer).toEqual({ values: { password: 'already-supplied-secret', code: '246810' } });
  expect(() => parseBrowserAuthRequest({ ...request, provided_values: { other: 'secret' } })).toThrow(/provided/);
  expect(() => parseBrowserAuthRequest({ ...request, provided_values: { password: 'x'.repeat(4097) } })).toThrow(/provided/);
});

it('does not ask again when all selected sign-in fields are already available', async () => {
  const { collectMissingBrowserAuth } = await import('../src/main/browser-auth-request.js');
  let prompts = 0;
  const parsed = parseBrowserAuthRequest({ ...request, provided_values: { password: 'known-secret' } });
  expect(await collectMissingBrowserAuth(parsed, async () => { prompts++; return null; }))
    .toEqual({ values: { password: 'known-secret' } });
  expect(prompts).toBe(0);
});

it('skips unspecified optional inputs when every required value is known', async () => {
  const { collectMissingBrowserAuth } = await import('../src/main/browser-auth-request.js');
  const parsed = parseBrowserAuthRequest({ ...request, fields: [...request.fields,
    { id: 'optionalCode', label: 'Optional code', type: 'text', required: false, selector: '#optional-code' }],
    provided_values: { password: 'known-secret' } });
  let prompts = 0;
  expect(await collectMissingBrowserAuth(parsed, async () => { prompts++; return null; }))
    .toEqual({ values: { password: 'known-secret' } });
  expect(prompts).toBe(0);
});

it('collects only missing required values and leaves unspecified optional inputs absent', async () => {
  const { collectMissingBrowserAuth } = await import('../src/main/browser-auth-request.js');
  const parsed = parseBrowserAuthRequest({ ...request, fields: [...request.fields,
    { id: 'optionalCode', label: 'Optional code', type: 'text', required: false, selector: '#optional-code' }] });
  let prompts = 0;
  expect(await collectMissingBrowserAuth(parsed, async metadata => {
    prompts++;
    expect(metadata.fields.map(field => field.id)).toEqual(['password']);
    return { values: { password: 'collected-secret' } };
  })).toEqual({ values: { password: 'collected-secret' } });
  expect(prompts).toBe(1);
});


it('does not fill redaction placeholders restored from a pending-call checkpoint', async () => {
  const { collectMissingBrowserAuth } = await import('../src/main/browser-auth-request.js');
  const checkpoint = JSON.parse(JSON.stringify({ pendingToolCalls: [{ function: {
    arguments: JSON.stringify({ ...request, provided_values: { password: '[REDACTED]' } }),
  } }] }));
  const restored = parseBrowserAuthRequest(JSON.parse(checkpoint.pendingToolCalls[0].function.arguments));
  expect(restored.provided_values).toEqual({});
  let requested = false;
  expect(await collectMissingBrowserAuth(restored, async metadata => {
    requested = true;
    expect(metadata.fields).toMatchObject([{ id: 'password' }]);
    expect(JSON.stringify(metadata)).not.toContain('[REDACTED]');
    return null;
  })).toBeNull();
  expect(requested).toBe(true);
});
