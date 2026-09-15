import { randomBytes } from "node:crypto";
import type {
  DesktopUpdateCheckResult,
  DesktopUpdateOfferToken
} from "@memmy/desktop-interface";

const DEFAULT_MAX_AGE_MS = 30 * 60 * 1_000;
const DEFAULT_MAX_ENTRIES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const TOKEN_GENERATION_ATTEMPTS = 8;

export interface DesktopUpdateOfferRegistryOptions {
  createToken?: () => string;
  maxAgeMs?: number;
  maxEntries?: number;
  now?: () => number;
}

export interface DesktopUpdateOfferRegistry {
  readonly size: number;
  issue(ownerWebContentsId: number, offer: DesktopUpdateCheckResult): DesktopUpdateOfferToken;
  run<T>(
    ownerWebContentsId: number,
    token: unknown,
    action: (offer: DesktopUpdateCheckResult) => Promise<T>
  ): Promise<T>;
  revokeOwner(ownerWebContentsId: number): number;
  clear(): void;
}

interface DesktopUpdateOfferEntry {
  ownerWebContentsId: number;
  offer: DesktopUpdateCheckResult;
  expiresAt: number;
  issuedSequence: number;
  inFlight?: Promise<unknown>;
}

export const createDesktopUpdateOfferRegistry = (
  options: DesktopUpdateOfferRegistryOptions = {}
): DesktopUpdateOfferRegistry => {
  const createToken = options.createToken ?? defaultCreateToken;
  const maxAgeMs = normalizePositiveInteger(options.maxAgeMs ?? DEFAULT_MAX_AGE_MS, "max age");
  const maxEntries = normalizePositiveInteger(options.maxEntries ?? DEFAULT_MAX_ENTRIES, "capacity");
  const now = options.now ?? Date.now;
  const entries = new Map<DesktopUpdateOfferToken, DesktopUpdateOfferEntry>();
  let issuedSequence = 0;

  const readNow = (): number => {
    const timestamp = now();
    if (!Number.isFinite(timestamp)) {
      throw new Error("Desktop update offer clock returned an invalid timestamp");
    }
    return timestamp;
  };

  const pruneForIssue = (timestamp: number): void => {
    for (const [token, entry] of entries) {
      if (!entry.inFlight && timestamp >= entry.expiresAt) {
        entries.delete(token);
      }
    }
    while (entries.size >= maxEntries) {
      const oldest = [...entries.entries()]
        .filter(([, entry]) => !entry.inFlight)
        .sort((left, right) => left[1].issuedSequence - right[1].issuedSequence)[0];
      if (!oldest) {
        throw new Error("Desktop update offer registry is at capacity");
      }
      entries.delete(oldest[0]);
    }
  };

  const createUniqueToken = (): DesktopUpdateOfferToken => {
    for (let attempt = 0; attempt < TOKEN_GENERATION_ATTEMPTS; attempt += 1) {
      const token = normalizeOfferToken(createToken());
      if (!entries.has(token)) return token;
    }
    throw new Error("Desktop update offer token generation collided repeatedly");
  };

  const resolveEntry = (
    ownerWebContentsId: number,
    rawToken: unknown
  ): { token: DesktopUpdateOfferToken; entry: DesktopUpdateOfferEntry } => {
    const ownerId = normalizeOwnerId(ownerWebContentsId);
    const token = normalizeOfferToken(rawToken);
    const entry = entries.get(token);
    if (!entry || entry.ownerWebContentsId !== ownerId || readNow() >= entry.expiresAt) {
      if (entry && !entry.inFlight) entries.delete(token);
      throw new Error("Desktop update offer is missing, expired, or unavailable");
    }
    return { token, entry };
  };

  return {
    get size(): number {
      return entries.size;
    },

    issue(ownerWebContentsId, offer): DesktopUpdateOfferToken {
      const ownerId = normalizeOwnerId(ownerWebContentsId);
      if (offer.status !== "available") {
        throw new Error("Desktop update offer registry only accepts available updates");
      }
      const timestamp = readNow();
      pruneForIssue(timestamp);
      const token = createUniqueToken();
      const snapshot = structuredClone(offer);
      delete snapshot.offerToken;
      issuedSequence += 1;
      entries.set(token, {
        ownerWebContentsId: ownerId,
        offer: snapshot,
        expiresAt: timestamp + maxAgeMs,
        issuedSequence
      });
      return token;
    },

    run<T>(ownerWebContentsId: number, rawToken: unknown, action: (offer: DesktopUpdateCheckResult) => Promise<T>): Promise<T> {
      let resolved: { token: DesktopUpdateOfferToken; entry: DesktopUpdateOfferEntry };
      try {
        resolved = resolveEntry(ownerWebContentsId, rawToken);
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

    revokeOwner(ownerWebContentsId): number {
      const ownerId = normalizeOwnerId(ownerWebContentsId);
      let revoked = 0;
      for (const [token, entry] of entries) {
        if (entry.ownerWebContentsId !== ownerId) continue;
        entries.delete(token);
        revoked += 1;
      }
      return revoked;
    },

    clear(): void {
      entries.clear();
    }
  };
};

const defaultCreateToken = (): string => randomBytes(32).toString("base64url");

const normalizeOfferToken = (value: unknown): DesktopUpdateOfferToken => {
  if (typeof value !== "string" || !TOKEN_PATTERN.test(value)) {
    throw new Error("Desktop update offer token is invalid");
  }
  return value as DesktopUpdateOfferToken;
};

const normalizeOwnerId = (value: number): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Desktop update offer owner WebContents ID is invalid");
  }
  return value;
};

const normalizePositiveInteger = (value: number, label: string): number => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Desktop update offer registry ${label} must be a positive integer`);
  }
  return value;
};
