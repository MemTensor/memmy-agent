/** Transcript reader module. */
import { readClaudeCodeSession, type RawSourceMessage } from "@memmy/agent-source-core";

/** Contract for raw claude code message. */
export interface RawClaudeCodeMessage extends RawSourceMessage {
  workspacePath: string | null;
  gitRoot: string | null;
}

/**
 * Reads a Claude Code session as staged native turns. The hook rereads the same file
 * through the same parser on Stop, so both channels resolve one turn to one identity.
 */
export async function* readClaudeCodeTranscript(
  filePath: string,
  signal?: AbortSignal
): AsyncIterable<RawClaudeCodeMessage> {
  for await (const message of readClaudeCodeSession(filePath, signal)) {
    yield { ...message, workspacePath: null, gitRoot: null };
  }
}
