const baseUrl = (process.env.MEMMY_SMOKE_BASE_URL ?? "http://127.0.0.1:28960/api/v1").replace(/\/$/u, "");
const token = process.env.MEMMY_SMOKE_TOKEN ?? "release-smoke-token";
const timeoutMs = Number(process.env.MEMMY_SMOKE_TIMEOUT_MS ?? 30_000);
const runId = crypto.randomUUID();
const originalTitle = `Release smoke original ${runId}`;
const originalContent = `Original release smoke content ${runId}.`;
const namespaceHeaders = {
  authorization: `Bearer ${token}`,
  "x-memmy-user-id": "release-smoke-user",
  "x-memmy-project-id": "release-smoke-project",
  "x-memmy-workspace-id": "release-smoke-workspace",
  "content-type": "application/json"
};

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { ...namespaceHeaders, ...options.headers }
  });
  const body = await response.json();
  if (!response.ok) {
    throw new Error(`${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

async function waitForHealth() {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const health = await request("/health");
      if (health.ok === true && health.storage?.ready === true) {
        return health;
      }
      lastError = new Error(`Memory health is not ready: ${JSON.stringify(health)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw lastError ?? new Error("Memory health check timed out");
}

const health = await waitForHealth();
const added = await request("/memory/add?source=codex", {
  method: "POST",
  body: JSON.stringify({
    layer: "L2",
    title: originalTitle,
    content: originalContent,
    tags: ["release-smoke"],
    deferProcessing: true
  })
});
if (typeof added.id !== "string") {
  throw new Error("Memory add did not return an id");
}

const memoryPath = `/memory/${encodeURIComponent(added.id)}`;
const edited = await request(`${memoryPath}/edit?source=codex`, {
  method: "POST",
  body: JSON.stringify({
    version: 1,
    title: "Release smoke edited",
    content: "Edited release smoke content.",
    tags: ["release-smoke"],
    reason: "container smoke edit"
  })
});
if (edited.ok !== true || edited.version !== 2) {
  throw new Error(`Memory edit assertion failed: ${JSON.stringify(edited)}`);
}

const history = await request(`${memoryPath}/history?source=codex`);
const historyVersions = history.items?.map((item) => item.version) ?? [];
if (history.currentVersion !== 2 || !historyVersions.includes(1) || !historyVersions.includes(2)) {
  throw new Error(`Memory history assertion failed: ${JSON.stringify(history)}`);
}

const restored = await request(`${memoryPath}/history/1/restore?source=codex`, {
  method: "POST",
  body: JSON.stringify({ version: 2, reason: "container smoke restore" })
});
if (restored.ok !== true || restored.version !== 3 || restored.restoredVersion !== 1) {
  throw new Error(`Memory restore assertion failed: ${JSON.stringify(restored)}`);
}

const detail = await request(`${memoryPath}?source=codex`);
if (
  detail.item?.version !== 3 ||
  detail.item?.title !== originalTitle ||
  detail.item?.body !== originalContent
) {
  throw new Error(`Restored memory assertion failed: ${JSON.stringify(detail)}`);
}

console.log(JSON.stringify({
  health: health.ok,
  storageReady: health.storage.ready,
  version: health.version,
  memoryId: added.id,
  editVersion: edited.version,
  restoreVersion: restored.version,
  restoredFrom: restored.restoredVersion
}));
