/** Drain the Windows recorder before terminating the Agent's process tree. */
export async function stopComputerHistoryBeforeExit(
  gateway: { baseUrl: string; bootstrapSecret: string },
  timeoutMs = 3_000
): Promise<void> {
  // One deadline covers authentication, stopping, and reading both response bodies.
  const signal = AbortSignal.timeout(timeoutMs);
  const bootstrap = await fetch(new URL("/webui/bootstrap", gateway.baseUrl), {
    headers: { "X-Memmy-Agent-Auth": gateway.bootstrapSecret },
    signal
  });
  if (!bootstrap.ok) {
    throw new Error(`Computer History exit authentication failed (${bootstrap.status})`);
  }
  const authentication: unknown = await bootstrap.json();
  if (!authentication || typeof authentication !== "object"
    || !("token" in authentication) || typeof authentication.token !== "string"
    || !authentication.token) {
    throw new Error("Computer History exit authentication returned no token");
  }
  const response = await fetch(new URL("/api/computer-history/observation/stop", gateway.baseUrl), {
    method: "POST",
    headers: { Authorization: `Bearer ${authentication.token}`, "Content-Type": "application/json" },
    body: "{}",
    signal
  });
  // An idle Agent reports already-stopped as 409; quitting remains successful.
  if (!response.ok && response.status !== 409) {
    throw new Error(`Computer History exit stop failed (${response.status})`);
  }
  await response.arrayBuffer();
}
