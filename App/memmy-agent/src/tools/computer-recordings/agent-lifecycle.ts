import { RecordingStartSchema } from "@memmy/local-api-contracts";
import { getRecordingSessionService } from "./service.js";

/** Called by the runtime after dequeue, immediately before the actual turn. Never throws into execution. */
export async function startAgentRecording(input: { runId: string; chatId: string; messageId: string; metadata: Record<string, unknown>;
  notify: (payload: Record<string, unknown>) => Promise<void> }): Promise<string | null> {
  if (input.metadata.task_recording == null) return null;
  try {
    const parsed = RecordingStartSchema.parse(input.metadata.task_recording);
    const service = getRecordingSessionService();
    if (!await service.claimAgentMessage(input.chatId, input.messageId)) return null;
    const recording = await service.start(parsed, { runId: input.runId, chatId: input.chatId, messageId: input.messageId });
    await input.notify({ recording_id: recording.id, recording_state: recording.state }).catch(() => {});
    return recording.id;
  } catch {
    await input.notify({ recording_state: "failed", recording_error: "recording_not_started" }).catch(() => {});
    return null;
  }
}
export async function finishAgentRecording(id: string | null, cancelled: boolean): Promise<void> {
  if (!id) return;
  try { await getRecordingSessionService().control(id, "stop", cancelled ? "cancelled" : "completed"); } catch { /* recording cannot change the Agent result */ }
}
