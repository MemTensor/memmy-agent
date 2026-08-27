const CACHE_PREFIX = "memmy.memory-panel.";
const CACHE_VERSION = 1;
const CACHE_TTL_MS = 30_000;

interface CacheEnvelope<T> {
  version: number;
  savedAt: string;
  data: T;
}

export function memoryPanelCacheKey(...parts: Array<string | number | undefined | null>): string {
  return parts
    .map((part) => String(part ?? ""))
    .join(":");
}

export function memoryPanelLatestCacheKey(section: string): string {
  return memoryPanelCacheKey(section, "latest");
}

export function readMemoryPanelCache<T>(key: string): T | null {
  const storage = storageForMemoryPanelCache();
  if (!storage) {
    return null;
  }

  try {
    const raw = storage.getItem(`${CACHE_PREFIX}${key}`);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<CacheEnvelope<T>>;
    const savedAt = Date.parse(parsed.savedAt ?? "");
    if (
      parsed.version !== CACHE_VERSION ||
      parsed.data === undefined ||
      !Number.isFinite(savedAt) ||
      Date.now() - savedAt > CACHE_TTL_MS
    ) {
      storage.removeItem(`${CACHE_PREFIX}${key}`);
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
}

export function readMemoryPanelCacheFirst<T>(keys: readonly string[]): T | null {
  for (const key of keys) {
    const data = readMemoryPanelCache<T>(key);
    if (data) {
      return data;
    }
  }
  return null;
}

export function writeMemoryPanelCache<T>(key: string, data: T): void {
  const storage = storageForMemoryPanelCache();
  if (!storage) {
    return;
  }

  try {
    const envelope: CacheEnvelope<T> = {
      version: CACHE_VERSION,
      savedAt: new Date().toISOString(),
      data
    };
    storage.setItem(`${CACHE_PREFIX}${key}`, JSON.stringify(envelope));
  } catch {
    // A cache failure does not affect the main flow.
  }
}

export function writeMemoryPanelCaches<T>(keys: readonly string[], data: T): void {
  for (const key of keys) {
    writeMemoryPanelCache(key, data);
  }
}

export function clearMemoryPanelCache(): void {
  const storage = storageForMemoryPanelCache();
  if (!storage) {
    return;
  }

  try {
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(CACHE_PREFIX)) {
        storage.removeItem(key);
      }
    }
  } catch {
    // A cache-clearing failure does not affect the result of clearing the backend data.
  }
}

function storageForMemoryPanelCache(): Storage | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}
