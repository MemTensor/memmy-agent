import continuationPrompt from "./legal-diagnosis-continuation-prompt.md?raw";

/** Continue the existing plugin session with the protocol's locale-independent instructions. */
export function buildLegalDiagnosisContinuationPrompt(sessionId: string): string {
  return continuationPrompt.trimEnd().replace("{sessionId}", () => JSON.stringify(sessionId));
}
