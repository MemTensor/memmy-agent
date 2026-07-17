import type { RuntimeConfig } from "@memmy/local-api-contracts";

export function createEventsConnection(config: RuntimeConfig): EventSource {
  const url = new URL("/api/events", config.baseUrl);
  url.searchParams.set("token", config.localToken);
  return new EventSource(url);
}
