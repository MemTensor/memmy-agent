import { expect, it } from 'vitest';
import { ToolCallRequest } from '../../src/providers/base.js';
import { buildToolEventStartPayload, buildToolEventFinishPayloads } from '../../src/utils/progress-events.js';
import { formatToolHints } from '../../src/utils/tool-hints.js';
import { publicBrowserAuthResult } from '../../src/utils/browser-auth-privacy.js';
import { OpenAICompatProvider } from '../../src/providers/openai-compat-provider.js';

it('keeps provided sign-in values executable while removing them from history, checkpoints and progress', () => {
  const secret = 'provided-code-246810';
  const call = new ToolCallRequest({ id: 'auth-1', name: 'browser_auth_request', arguments: {
    origin: 'https://example.test', fields: [{ id: 'code' }], provided_values: { code: secret },
  } });
  expect(call.arguments.provided_values.code).toBe(secret);
  const recorded = [JSON.parse(JSON.stringify(call)), call.toOpenAIToolCall(), buildToolEventStartPayload(call),
    ...buildToolEventFinishPayloads({ toolCalls: [call], toolResults: ['{"status":"submitted"}'],
      toolEvents: [{ status: 'ok' }] }), formatToolHints([call])];
  expect(JSON.stringify(recorded)).not.toContain(secret);
  expect(JSON.stringify(recorded)).toContain('[REDACTED]');
});

it('returns only auth status and bounded control identifiers, including for unexpected browser response fields', () => {
  expect(publicBrowserAuthResult({ status: 'submitted', values: { password: 'never-return' },
    debug: 'never-return' })).toBe('{"status":"submitted"}');
  expect(() => publicBrowserAuthResult({ status: 'never-return' })).toThrow('Invalid browser auth response');
});

it('parses flattened provider calls without copying executable input into provider metadata', () => {
  const secret = 'flattened-code-864209';
  const response = OpenAICompatProvider.parse({ choices: [{ message: { tool_calls: [{
    call_id: 'flat-auth', name: 'browser_auth_request',
    arguments: JSON.stringify({ origin: 'https://example.test', provided_values: { code: secret } }),
    thought_signature: 'keep-provider-signature',
  }] } }] });
  const call = response.toolCalls[0]!;
  expect(call.id).toBe('flat-auth');
  expect(call.arguments.provided_values.code).toBe(secret);
  expect(call.providerSpecificFields).toEqual({ thought_signature: 'keep-provider-signature' });
  expect(JSON.stringify([call, call.toOpenAIToolCall()])).not.toContain(secret);
});

it('removes duplicated auth input from legacy and nested metadata while retaining provider signatures', () => {
  const secret = 'metadata-code-864209';
  const call = new ToolCallRequest({ id: 'auth-meta', name: 'browser_auth_request', arguments: {
    provided_values: { code: secret },
  }, extraContent: { signature: 'signed-model-content', provided_values: { code: secret } },
  providerSpecificFields: { arguments: JSON.stringify({ provided_values: { code: secret } }),
    nested: [{ provided_values: { code: secret }, signature: 'opaque-signature' }] },
  functionProviderSpecificFields: { arguments: { provided_values: { code: secret } }, signature: 'fn-signature' } });
  expect(call.arguments.provided_values.code).toBe(secret);
  // Also defend serialization of older or subsequently assigned provider metadata.
  call.providerSpecificFields!.arguments = JSON.stringify({ provided_values: { code: secret } });
  const recorded = JSON.stringify([call, call.toOpenAIToolCall()]);
  expect(recorded).not.toContain(secret);
  expect(recorded).toContain('opaque-signature');
  expect(recorded).toContain('fn-signature');
  expect(recorded).toContain('signed-model-content');
});

it('preserves provider metadata for other tools', () => {
  const call = new ToolCallRequest({ id: 'other', name: 'other_tool',
    providerSpecificFields: { arguments: 'provider-data', nested: { provided_values: 'non-auth' } } });
  expect(call.toOpenAIToolCall().provider_specific_fields).toEqual(call.providerSpecificFields);
  expect(JSON.parse(JSON.stringify(call)).providerSpecificFields).toEqual(call.providerSpecificFields);
});
