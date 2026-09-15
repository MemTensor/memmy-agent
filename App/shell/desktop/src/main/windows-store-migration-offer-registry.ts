import { randomBytes } from "node:crypto";
import type {
  DesktopPreparedUpdateHandle,
  DesktopStoreMigrationToken
} from "@memmy/desktop-interface";

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TOKEN_GENERATION_ATTEMPTS = 8;

export interface WindowsStoreMigrationOffer<Policy, Authority> {
  transactionId: string;
  acquisitionUri: string;
  contextKey: string;
  policy: Policy;
  authority: Authority;
}

export interface WindowsStoreMigrationOfferRegistryOptions {
  createToken?: () => string;
  maxAgeMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface WindowsStoreMigrationOfferRegistry<Policy, Authority> {
  readonly size: number;
  getOrCreate(offer: WindowsStoreMigrationOffer<Policy, Authority>): Extract<
    DesktopPreparedUpdateHandle,
    { kind: "store-migration" }
  >;
  findReusable(contextKey: string): WindowsStoreMigrationOffer<Policy, Authority> | null;
  bindOwner(preparedUpdate: unknown, ownerWebContentsId: number): void;
  read(ownerWebContentsId: number, preparedUpdate: unknown): WindowsStoreMigrationOffer<Policy, Authority>;
  markPrepared(ownerWebContentsId: number, preparedUpdate: unknown): void;
  run<T>(
    ownerWebContentsId: number,
    preparedUpdate: unknown,
    action: (offer: WindowsStoreMigrationOffer<Policy, Authority>) => Promise<T>
  ): Promise<T>;
  unbindOwner(ownerWebContentsId: number): number;
  prune(): number;
  clear(): void;
}

interface WindowsStoreMigrationOfferEntry<Policy, Authority> {
  offer: WindowsStoreMigrationOffer<Policy, Authority>;
  ownerWebContentsIds: Set<number>;
  expiresAt: number;
  issuedSequence: number;
  inFlight?: Promise<unknown>;
  prepared?: boolean;
}

export const createWindowsStoreMigrationOfferRegistry = <Policy, Authority>(
  options: WindowsStoreMigrationOfferRegistryOptions = {}
): WindowsStoreMigrationOfferRegistry<Policy, Authority> => {
  const createToken = options.createToken ?? defaultCreateToken;
  const maxAgeMs = normalizePositiveInteger(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, "max age");
  const maxEntries = normalizePositiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "capacity");
  const now = options.now ?? Date.now;
  const entries = new Map<DesktopStoreMigrationToken, WindowsStoreMigrationOfferEntry<Policy, Authority>>();
  let issuedSequence = 0;

  const readNow = (): number => {
    const timestamp = now();
    if (!Number.isFinite(timestamp)) {
      throw new Error("Windows Store migration offer clock returned an invalid timestamp");
    }
    return timestamp;
  };

  const isExpired = (entry: WindowsStoreMigrationOfferEntry<Policy, Authority>, timestamp: number): boolean =>
    timestamp >= entry.expiresAt && !(entry.prepared && entry.ownerWebContentsIds.size > 0);

  const pruneExpired = (timestamp: number): number => {
    let pruned = 0;
    for (const [token, entry] of entries) {
      if (!entry.inFlight && isExpired(entry, timestamp)) {
        entries.delete(token);
        pruned += 1;
      }
    }
    return pruned;
  };

  const makeRoom = (timestamp: number): void => {
    pruneExpired(timestamp);
    while (entries.size >= maxEntries) {
      const oldest = [...entries.entries()]
        .filter(([, entry]) => !entry.inFlight)
        .sort((left, right) => left[1].issuedSequence - right[1].issuedSequence)[0];
      if (!oldest) {
        throw new Error("Windows Store migration offer registry is at capacity");
      }
      entries.delete(oldest[0]);
    }
  };

  const createUniqueToken = (): DesktopStoreMigrationToken => {
    for (let attempt = 0; attempt < TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
      const token = normalizeToken(createToken());
      if (!entries.has(token)) return token;
    }
    throw new Error("Windows Store migration offer token generation collided repeatedly");
  };

  const resolveEntry = (
    ownerWebContentsId: number,
    rawPreparedUpdate: unknown
  ): {
    token: DesktopStoreMigrationToken;
    entry: WindowsStoreMigrationOfferEntry<Policy, Authority>;
  } => {
    const ownerId = normalizeOwnerId(ownerWebContentsId);
    const token = readPreparedUpdateToken(rawPreparedUpdate);
    const entry = entries.get(token);
    if (
      !entry
      || !entry.ownerWebContentsIds.has(ownerId)
      || isExpired(entry, readNow())
    ) {
      if (entry && !entry.inFlight && isExpired(entry, readNow())) entries.delete(token);
      throw new Error("Microsoft Store migration offer is missing, expired, or unavailable");
    }
    return { token, entry };
  };

  return {
    get size(): number {
      return entries.size;
    },

    getOrCreate(offer): Extract<DesktopPreparedUpdateHandle, { kind: "store-migration" }> {
      const normalizedOffer = normalizeOffer(offer);
      const timestamp = readNow();
      pruneExpired(timestamp);
      for (const [token, entry] of entries) {
        if (
          entry.offer.contextKey === normalizedOffer.contextKey
          && entry.offer.transactionId === normalizedOffer.transactionId
          && entry.offer.acquisitionUri === normalizedOffer.acquisitionUri
        ) {
          return { kind: "store-migration", offerToken: token };
        }
      }

      makeRoom(timestamp);
      const token = createUniqueToken();
      issuedSequence += 1;
      entries.set(token, {
        offer: structuredClone(normalizedOffer),
        ownerWebContentsIds: new Set<number>(),
        expiresAt: timestamp + maxAgeMs,
        issuedSequence
      });
      return { kind: "store-migration", offerToken: token };
    },

    findReusable(contextKey): WindowsStoreMigrationOffer<Policy, Authority> | null {
      const normalizedContextKey = normalizeContextKey(contextKey);
      pruneExpired(readNow());
      const reusable = [...entries.values()]
        .filter((entry) => entry.offer.contextKey === normalizedContextKey)
        .sort((left, right) => right.issuedSequence - left.issuedSequence)[0];
      return reusable ? structuredClone(reusable.offer) : null;
    },

    bindOwner(preparedUpdate, ownerWebContentsId): void {
      const ownerId = normalizeOwnerId(ownerWebContentsId);
      const token = readPreparedUpdateToken(preparedUpdate);
      const entry = entries.get(token);
      if (!entry || isExpired(entry, readNow())) {
        if (entry && !entry.inFlight) entries.delete(token);
        throw new Error("Microsoft Store migration offer is missing, expired, or unavailable");
      }
      entry.ownerWebContentsIds.add(ownerId);
    },

    read(ownerWebContentsId, preparedUpdate) {
      return structuredClone(resolveEntry(ownerWebContentsId, preparedUpdate).entry.offer);
    },

    markPrepared(ownerWebContentsId, preparedUpdate) {
      // A verified download remains usable while its renderer owns the offer.
      // Installation still revalidates the executable immediately before launch.
      resolveEntry(ownerWebContentsId, preparedUpdate).entry.prepared = true;
    },

    run<T>(
      ownerWebContentsId: number,
      preparedUpdate: unknown,
      action: (offer: WindowsStoreMigrationOffer<Policy, Authority>) => Promise<T>
    ): Promise<T> {
      let resolved: {
        token: DesktopStoreMigrationToken;
        entry: WindowsStoreMigrationOfferEntry<Policy, Authority>;
      };
      try {
        resolved = resolveEntry(ownerWebContentsId, preparedUpdate);
      } catch (error) {
        return Promise.reject(error);
      }
      const { token, entry } = resolved;
      if (entry.inFlight) return entry.inFlight as Promise<T>;

      let actionPromise: Promise<T>;
      try {
        actionPromise = Promise.resolve(action(structuredClone(entry.offer)));
      } catch (error) {
        actionPromise = Promise.reject(error);
      }
      const inFlight = actionPromise.then(
        (result) => {
          if (entries.get(token) === entry) entries.delete(token);
          return result;
        },
        (error: unknown) => {
          if (entries.get(token) === entry && entry.inFlight === inFlight) {
            entry.inFlight = undefined;
          }
          throw error;
        }
      );
      entry.inFlight = inFlight;
      return inFlight;
    },

    unbindOwner(ownerWebContentsId): number {
      const ownerId = normalizeOwnerId(ownerWebContentsId);
      let unbound = 0;
      for (const entry of entries.values()) {
        if (entry.ownerWebContentsIds.delete(ownerId)) unbound += 1;
      }
      return unbound;
    },

    prune(): number {
      return pruneExpired(readNow());
    },

    clear(): void {
      entries.clear();
    }
  };
};

const defaultCreateToken = (): string => randomBytes(32).toString("base64url");

const normalizeOffer = <Policy, Authority>(
  offer: WindowsStoreMigrationOffer<Policy, Authority>
): WindowsStoreMigrationOffer<Policy, Authority> => {
  const transactionId = normalizeNonEmptyString(offer.transactionId, "transaction ID");
  const acquisitionUri = normalizeNonEmptyString(offer.acquisitionUri, "acquisition URI");
  const contextKey = normalizeContextKey(offer.contextKey);
  return {
    transactionId,
    acquisitionUri,
    contextKey,
    policy: structuredClone(offer.policy),
    authority: structuredClone(offer.authority)
  };
};

const readPreparedUpdateToken = (value: unknown): DesktopStoreMigrationToken => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Microsoft Store migration prepared handle is invalid");
  }
  const candidate = value as Record<string, unknown>;
  if (candidate.kind !== "store-migration") {
    throw new Error("Microsoft Store migration prepared handle is invalid");
  }
  const keys = Object.keys(candidate).sort();
  if (keys.length !== 2 || keys[0] !== "kind" || keys[1] !== "offerToken") {
    throw new Error("Microsoft Store migration prepared handle is invalid");
  }
  return normalizeToken(candidate.offerToken);
};

const normalizeToken = (value: unknown): DesktopStoreMigrationToken => {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new Error("Microsoft Store migration offer token is invalid");
  }
  return value as DesktopStoreMigrationToken;
};

const normalizeOwnerId = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Microsoft Store migration offer owner WebContents ID is invalid");
  }
  return value;
};

const normalizeContextKey = (value: string): string =>
  normalizeNonEmptyString(value, "context key");

const normalizeNonEmptyString = (value: unknown, label: string): string => {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error(`Microsoft Store migration offer ${label} is invalid`);
  }
  return value;
};

const normalizePositiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Windows Store migration offer registry ${label} must be a positive integer`);
  }
  return value;
};
