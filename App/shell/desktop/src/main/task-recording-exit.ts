/** An active task video gets time to seal and remux before the gateway is terminated. */
export async function stopTaskRecordingBeforeExit(gateway: { baseUrl: string; bootstrapSecret: string }, onActive: () => void, timeoutMs = 25_000): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const bootstrap = await fetch(new URL("/webui/bootstrap", gateway.baseUrl), { headers: { "X-Memmy-Agent-Auth": gateway.bootstrapSecret }, signal });
  if (!bootstrap.ok) throw new Error("Recording exit authentication failed");
  const data: unknown = await bootstrap.json();
  if (!data || typeof data !== "object" || !("token" in data) || typeof data.token !== "string") throw new Error("Recording exit authentication failed");
  const headers = { Authorization: `Bearer ${data.token}`, "Content-Type": "application/json" };
  const response = await fetch(new URL("/api/computer-recordings", gateway.baseUrl), { headers, signal });
  if (!response.ok) throw new Error("Recording exit status failed");
  const status: unknown = await response.json();
  if (!status || typeof status !== "object" || !("recordings" in status) || !Array.isArray(status.recordings)) throw new Error("Recording exit status invalid");
  if (!status.recordings.some((recording) => recording && ["starting", "recording", "paused", "finalizing"].includes(recording.state))) return;
  onActive();
  const stopped = await fetch(new URL("/api/computer-recordings/active/stop", gateway.baseUrl), { method: "POST", headers, body: "{}", signal });
  if (!stopped.ok) throw new Error("Recording exit stop failed");
  await stopped.arrayBuffer();
}
