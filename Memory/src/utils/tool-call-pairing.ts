/** Source-native invocation IDs take precedence over generic message/record IDs. */
export function toolInvocationId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["call_id", "tool_call_id", "toolCallId", "id"]) {
    const id = record[key];
    if (typeof id === "string" && id.trim()) return id;
  }
  return undefined;
}

/** Match records from one turn only; callers are responsible for the turn boundary. */
export function matchToolResultIndices(toolCalls: unknown[], toolResults: unknown[]): Array<number | undefined> {
  const callIds = toolCalls.map(toolInvocationId);
  const resultIds = toolResults.map(toolInvocationId);
  // Older adapters supplied positional arrays without any invocation IDs. Keep
  // that form only when neither array has IDs and both arrays retain equal slot counts.
  if (toolCalls.length === toolResults.length && callIds.every((id) => !id) && resultIds.every((id) => !id)) {
    return toolCalls.map((_, index) => index);
  }

  const callCounts = new Map<string, number>();
  for (const id of callIds) {
    if (id) callCounts.set(id, (callCounts.get(id) ?? 0) + 1);
  }
  const resultsById = new Map<string, number[]>();
  resultIds.forEach((id, index) => {
    if (!id) return;
    const indices = resultsById.get(id) ?? [];
    indices.push(index);
    resultsById.set(id, indices);
  });
  return callIds.map((id) => {
    if (!id || callCounts.get(id) !== 1) return undefined;
    const indices = resultsById.get(id);
    // Duplicate IDs are ambiguous; never guess by position or consume another ID.
    return indices?.length === 1 ? indices[0] : undefined;
  });
}
