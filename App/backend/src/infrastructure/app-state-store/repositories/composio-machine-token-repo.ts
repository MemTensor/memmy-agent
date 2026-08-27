/** Composio machine token repo module. */
import { randomBytes } from "node:crypto";
import type { SecretStore } from "../secret-store.js";

const COMPOSIO_MACHINE_TOKEN_REF = "machine:composio-token";
const COMPOSIO_MACHINE_TOKEN_PURPOSE = "composio_machine_token";

export interface ComposioMachineTokenRepository {
  /** Reads get or create token. */
  getOrCreateToken(): string;
}

/** Creates create composio machine token repository. */
export function createComposioMachineTokenRepository(secretStore: SecretStore): ComposioMachineTokenRepository {
  return {
    getOrCreateToken() {
      const existingToken = secretStore.get(COMPOSIO_MACHINE_TOKEN_REF);
      if (existingToken) {
        return existingToken;
      }

      const token = createComposioMachineToken();
      secretStore.set(COMPOSIO_MACHINE_TOKEN_REF, token, {
        uuid: null,
        purpose: COMPOSIO_MACHINE_TOKEN_PURPOSE
      });

      return token;
    }
  };
}

/** Creates create composio machine token. */
function createComposioMachineToken(): string {
  return `mct_${randomBytes(32).toString("base64url")}`;
}
