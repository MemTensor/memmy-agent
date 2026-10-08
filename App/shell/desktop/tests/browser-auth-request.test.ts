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
