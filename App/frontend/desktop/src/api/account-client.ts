import {
  AccountProfileViewSchema,
  AccountSessionViewSchema,
  OkResponseSchema,
  SendCodeInputSchema,
  SendCodeResponseSchema,
  UpdateAccountProfileInputSchema,
  VerifyCodeInputSchema,
  type AccountProfileView,
  type AccountSessionView,
  type OkResponse,
  type RuntimeConfig,
  type SendCodeInput,
  type SendCodeResponse,
  type UpdateAccountProfileInput,
  type VerifyCodeInput
} from "@memmy/local-api-contracts";
import { requestJson } from "./http.js";

export type AccountIdentifier =
  | {
      channel: "email";
      email: string;
    }
  | {
      channel: "phone";
      phoneNumber: string;
    };

export type AccountCodeValidationReason = "identifier" | "code";

export interface AccountCodeValidationInput {
  identifier: string;
  code?: string;
  requireCode?: boolean;
}

export type AccountCodeValidationResult =
  | {
      ok: true;
      identifier: AccountIdentifier;
    }
  | {
      ok: false;
      reason: AccountCodeValidationReason;
    };

export interface AccountClient {
  sendCode(input: SendCodeInput): Promise<SendCodeResponse>;
  verifyCode(input: VerifyCodeInput): Promise<AccountSessionView>;
  updateProfile(input: UpdateAccountProfileInput): Promise<AccountProfileView>;
  markGuideFinished(): Promise<OkResponse>;
  logout(): Promise<OkResponse>;
  getSession(): Promise<AccountSessionView>;
}

export function createHttpAccountClient(config: RuntimeConfig): AccountClient {
  return {
    async sendCode(input) {
      return requestJson({
        config,
        path: "/api/account/send-code",
        schema: SendCodeResponseSchema,
        body: SendCodeInputSchema.parse(input)
      });
    },

    async verifyCode(input) {
      return requestJson({
        config,
        path: "/api/account/verify-code",
        schema: AccountSessionViewSchema,
        body: VerifyCodeInputSchema.parse(input)
      });
    },

    async updateProfile(input) {
      return requestJson({
        config,
        path: "/api/account/profile",
        schema: AccountProfileViewSchema,
        init: { method: "PATCH" },
        body: UpdateAccountProfileInputSchema.parse(input)
      });
    },

    async markGuideFinished() {
      return requestJson({
        config,
        path: "/api/account/guide-finished",
        schema: OkResponseSchema,
        init: { method: "POST" },
        body: {}
      });
    },

    async logout() {
      return requestJson({
        config,
        path: "/api/account/logout",
        schema: OkResponseSchema,
        init: { method: "POST" },
        body: {}
      });
    },

    async getSession() {
      return requestJson({
        config,
        path: "/api/account/session",
        schema: AccountSessionViewSchema
      });
    }
  };
}

export function resolveAccountIdentifier(rawIdentifier: string): AccountIdentifier | null {
  const identifier = rawIdentifier.trim();
  if (!identifier) {
    return null;
  }

  if (identifier.includes("@")) {
    return {
      channel: "email",
      email: identifier
    };
  }

  return {
    channel: "phone",
    phoneNumber: identifier
  };
}

export function validateAccountCodeInput(input: AccountCodeValidationInput): AccountCodeValidationResult {
  const accountIdentifier = resolveAccountIdentifier(input.identifier);
  if (!accountIdentifier) {
    return { ok: false, reason: "identifier" };
  }

  const identifierResult = SendCodeInputSchema.safeParse({
    ...accountIdentifier,
    locale: "zh"
  });
  if (!identifierResult.success) {
    return { ok: false, reason: "identifier" };
  }

  if (input.requireCode && !input.code?.trim()) {
    return { ok: false, reason: "code" };
  }

  return {
    ok: true,
    identifier: accountIdentifier
  };
}
