/** Model config validation module. */

/** Contract for model config form values. */
export interface ModelConfigFormValues {
  provider: string;
  endpoint: string;
  model: string;
  apiKey: string;
  apiKeyMasked?: string;
  hasExistingApiKey?: boolean;
}

/** Type definition for model config validation status. */
export type ModelConfigValidationStatus = "idle" | "testing" | "success" | "error";

/** Contract for model config validation state. */
export interface ModelConfigValidationState {
  status: ModelConfigValidationStatus;
  message: string | null;
  testedKey: string | null;
}

/** Creates create model config validation key. */
export function createModelConfigValidationKey(values: ModelConfigFormValues): string {
  return JSON.stringify({
    provider: values.provider.trim(),
    endpoint: values.endpoint.trim(),
    model: values.model.trim(),
    apiKey: values.apiKey.trim() || existingSecretKey(values)
  });
}

/** Checks can save model config. */
export function canSaveModelConfig(values: ModelConfigFormValues, validation: ModelConfigValidationState): boolean {
  return hasRequiredModelConfigValues(values)
    && (validation.status === "success" || validation.status === "idle")
    && validation.testedKey === createModelConfigValidationKey(values);
}

/** Checks can save optional model config. */
export function canSaveOptionalModelConfig(enabled: boolean, values: ModelConfigFormValues, validation: ModelConfigValidationState): boolean {
  return !enabled || canSaveModelConfig(values, validation);
}

/** Checks has required model config values. */
export function hasRequiredModelConfigValues(values: ModelConfigFormValues): boolean {
  return Boolean(values.provider.trim() && values.endpoint.trim() && values.model.trim() && (values.apiKey.trim() || values.hasExistingApiKey));
}

function existingSecretKey(values: ModelConfigFormValues): string {
  if (!values.hasExistingApiKey) {
    return "";
  }

  return values.apiKeyMasked?.trim() || "__existing_api_key__";
}
