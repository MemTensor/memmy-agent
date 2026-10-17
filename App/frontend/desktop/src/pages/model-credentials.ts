import { canonicalCatalogProviderId } from "@memmy/local-api-contracts";
import type { ModelConfigFormValues, ModelConfigValidationState } from "./model-config-validation.js";
import { createModelConfigValidationKey, hasRequiredModelConfigValues } from "./model-config-validation.js";

/** Binds a displayed credential to the saved connection that owns it. */
export interface SavedEndpointIdentity {
  endpointId: string;
  credentialSignature: string;
}

export function chatProtocol(provider: string) {
  if (provider === "anthropic") return "anthropic-messages" as const;
  if (provider === "gemini" || provider === "google") return "gemini-generate-content" as const;
  return "openai-chat-completions" as const;
}

export function endpointCredentialSignature(
  provider: string, protocol: string, endpoint: string, apiKey: string, apiKeyMasked: string
): string {
  const raw = apiKey.trim();
  return JSON.stringify({
    provider: canonicalCatalogProviderId(provider) ?? provider.trim().toLowerCase(),
    protocol,
    endpoint: endpoint.trim().replace(/\/+$/, ""),
    credential: raw ? `raw:${raw}` : `masked:${apiKeyMasked.trim()}`
  });
}

/** Tests, display and persistence must all consume these same resolved values. */
export function resolveModelCredentials(
  values: ModelConfigFormValues,
  source: SavedEndpointIdentity | null | undefined
): ModelConfigFormValues {
  const protocol = values.protocol ?? chatProtocol(values.provider);
  const raw = values.apiKey.trim();
  const signature = endpointCredentialSignature(values.provider, protocol, values.endpoint, raw, values.apiKeyMasked ?? "");
  const matches = Boolean(source && source.credentialSignature === signature);
  const hasExistingApiKey = !raw && matches && Boolean(values.apiKeyMasked);
  return {
    ...values,
    protocol,
    endpoint: values.endpoint.trim().replace(/\/+$/, ""),
    apiKey: raw,
    endpointId: matches ? source!.endpointId : undefined,
    apiKeyMasked: hasExistingApiKey ? values.apiKeyMasked : "",
    hasExistingApiKey,
    credentialSource: source ?? null,
    requiresApiKey: !raw && !hasExistingApiKey && Boolean(source || values.apiKeyMasked)
  };
}

/** Rebind the initial saved validation to its credential identity, never to later edits. */
export function bindSavedValidation(
  validation: ModelConfigValidationState, values: ModelConfigFormValues
): ModelConfigValidationState {
  return {
    ...validation,
    testedKey: validation.testedKey && hasRequiredModelConfigValues(values)
      ? createModelConfigValidationKey(values) : null
  };
}
