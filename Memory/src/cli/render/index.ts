import { renderSetupResult } from "./setup.js";

export { renderSetupResult } from "./setup.js";

export function renderCliOutput(value: unknown): string | undefined {
  return renderSetupResult(value);
}
