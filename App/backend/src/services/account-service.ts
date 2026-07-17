/** Account service module. */
import {
  AccountProfileViewSchema,
  AccountSessionViewSchema,
  SendCodeResponseSchema,
  type AccountProfileView,
  type AccountSessionView,
  type SendCodeInput,
  type SendCodeResponse,
  type UpdateAccountProfileInput,
  type VerifyCodeInput
} from "@memmy/local-api-contracts";
import type { CloudAccountProfile, CloudClient } from "../adapters/outbound/cloud-client/index.js";
import type {
  AccountSessionProfileInput,
  AccountSessionRepository
} from "../infrastructure/app-state-store/repositories/account-session-repo.js";
import type { MemmyConfigWriter, RuntimeProjectionResult } from "../infrastructure/memmy-config/index.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { OkResponse } from "@memmy/local-api-contracts";

const RESEND_WINDOW_MS = 60_000;

export interface AccountService {
  sendCode(input: SendCodeInput): Promise<SendCodeResponse>;
  verifyCode(input: VerifyCodeInput): Promise<AccountSessionView>;
  updateProfile(input: UpdateAccountProfileInput): Promise<AccountProfileView>;
  markGuideFinished(): Promise<OkResponse>;
  logout(): Promise<OkResponse>;
  getSession(): Promise<AccountSessionView>;
}

export interface CreateAccountServiceOptions {
  /** Cloud client. */
  cloudClient: CloudClient;
  /** Account session repository. */
  accountSessionRepository: AccountSessionRepository;
  /** Memmy config writer. */
  memmyConfigWriter?: MemmyConfigWriter;
  /** Memory client. */
  memoryClient?: Pick<MemoryClient, "reloadConfig">;
  /** Now. */
  now?: () => Date;
}

/** Creates create account service. */
export function createAccountService(options: CreateAccountServiceOptions): AccountService {
  const now = options.now ?? (() => new Date());

  return {
    async sendCode(input) {
      const key = toCodeKey(input);
      const sentAt = options.accountSessionRepository.getLastCodeSentAt(key);
      const remaining = getRemainingResendSeconds(sentAt, now());
      if (remaining > 0) {
        return SendCodeResponseSchema.parse({ ok: true, resendAfterSec: remaining });
      }

      if (input.channel === "email") {
        await options.cloudClient.sendEmailCode({
          email: requireAddress(input.email, "email"),
          zhEnv: input.locale === "zh"
        });
      } else {
        await options.cloudClient.sendPhoneCode({
          phoneNumber: requireAddress(input.phoneNumber, "phoneNumber"),
          zhEnv: input.locale === "zh"
        });
      }

      const sentAtNow = now().toISOString();
      options.accountSessionRepository.markCodeSent(key, sentAtNow);
      return SendCodeResponseSchema.parse({ ok: true, resendAfterSec: 60 });
    },

    async verifyCode(input) {
      const loginResult = await options.cloudClient.login({
        ...(input.email ? { email: input.email } : {}),
        ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
        verificationCode: input.verificationCode,
        loginSource: input.loginSource
      });

      if (options.memmyConfigWriter) {
        const projection = await options.memmyConfigWriter.writeAccountModelProjection({
          cloudUuid: loginResult.uuid,
          userId: loginResult.profile.userId
        });
        await reloadMemoryConfigIfNeeded(projection, options);
      }

      const session = AccountSessionViewSchema.parse(
        options.accountSessionRepository.upsert({
          profile: toSessionProfileInput(loginResult.profile),
          uuid: loginResult.accountUuid,
          cloudUuid: loginResult.uuid,
          isNewUser: loginResult.isNewUser
        })
      );

      return refreshCloudGuideState({
        cloudClient: options.cloudClient,
        accountSessionRepository: options.accountSessionRepository,
        session,
        cloudUuid: loginResult.uuid
      });
    },

    async updateProfile(input) {
      const session = options.accountSessionRepository.get();
      if (!session.authenticated) {
        throw Object.assign(new Error("Account session is not authenticated"), { code: "unauthorized" as const });
      }

      const cloudUuid = options.accountSessionRepository.getCloudUuid();
      if (cloudUuid) {
        await options.cloudClient.updateAccountProfile({ uuid: cloudUuid, userName: input.nickname });
      }

      const updated = options.accountSessionRepository.upsert({
        profile: {
          ...session.profile,
          nickname: input.nickname,
          rawProfile: {
            ...session.profile,
            userName: input.nickname
          }
        }
      });

      if (!updated.authenticated) {
        throw Object.assign(new Error("Account session is not authenticated"), { code: "unauthorized" as const });
      }

      return AccountProfileViewSchema.parse(updated.profile);
    },

    async markGuideFinished() {
      const uuid = options.accountSessionRepository.getCloudUuid();
      if (uuid) {
        await options.cloudClient.updateAccountGuide({ uuid, hasFinishedGuide: true });
      }

      return { ok: true };
    },

    async logout() {
      const uuid = options.accountSessionRepository.getCloudUuid();
      if (uuid) {
        try {
          await options.cloudClient.logout({ uuid });
        } catch {
          // noop
        }
      }

      const projection = await options.memmyConfigWriter?.clearAccountModelProjection?.();
      options.accountSessionRepository.clear();
      await reloadMemoryConfigIfNeeded(projection, options);
      return { ok: true };
    },

    async getSession() {
      const session = AccountSessionViewSchema.parse(options.accountSessionRepository.get());
      return refreshCloudGuideState({
        cloudClient: options.cloudClient,
        accountSessionRepository: options.accountSessionRepository,
        session
      });
    }
  };
}

async function reloadMemoryConfigIfNeeded(
  projection: RuntimeProjectionResult | undefined,
  options: CreateAccountServiceOptions
): Promise<void> {
  if (!projection?.changed || !projection.activeProfileAffected || !options.memoryClient) {
    return;
  }

  try {
    await options.memoryClient.reloadConfig({ reason: "account_profile_projected" });
  } catch {
    // noop
  }
}

/** Handles refresh cloud guide state. */
async function refreshCloudGuideState(input: {
  cloudClient: CloudClient;
  accountSessionRepository: AccountSessionRepository;
  session: AccountSessionView;
  cloudUuid?: string;
}): Promise<AccountSessionView> {
  if (!input.session.authenticated) {
    return input.session;
  }

  const cloudUuid = input.cloudUuid ?? input.accountSessionRepository.getCloudUuid();
  if (!cloudUuid) {
    return input.session;
  }

  const cloudProfile = await input.cloudClient.getAccountInfo({ uuid: cloudUuid });
  return AccountSessionViewSchema.parse(
    input.accountSessionRepository.upsert({
      profile: toSessionProfileInput(cloudProfile),
      isNewUser: input.session.isNewUser
    })
  );
}

/** Handles to code key. */
function toCodeKey(input: SendCodeInput): string {
  const address = input.channel === "email" ? requireAddress(input.email, "email") : requireAddress(input.phoneNumber, "phoneNumber");
  return `${input.channel}:${address}`;
}

/**
 * Reads a required account address.
 *
 * @param value Email or phone number.
 * @param field Field name.
 * @returns A non-empty string.
 */
function requireAddress(value: string | undefined, field: string): string {
  if (!value) {
    throw Object.assign(new Error(`${field} is required`), { code: "invalid_argument" as const });
  }

  return value;
}

/**
 * Computes the seconds remaining before a resend is allowed.
 *
 * @param sentAt Time of the last send.
 * @param now Current time.
 * @returns Seconds still to wait.
 */
function getRemainingResendSeconds(sentAt: string | null, now: Date): number {
  if (!sentAt) {
    return 0;
  }

  const elapsedMs = now.getTime() - new Date(sentAt).getTime();
  if (elapsedMs >= RESEND_WINDOW_MS) {
    return 0;
  }

  return Math.ceil((RESEND_WINDOW_MS - elapsedMs) / 1000);
}

/**
 * Converts a cloud-client profile into account session repository input.
 *
 * @param profile Account profile returned by the cloud-client.
 * @returns A profile that accountSessionRepo can persist.
 */
function toSessionProfileInput(profile: CloudAccountProfile): AccountSessionProfileInput {
  return {
    userId: profile.userId,
    email: profile.email,
    phoneNumber: profile.phoneNumber,
    nickname: profile.nickname,
    avatarUrl: profile.avatarUrl,
    planType: profile.planType,
    hasFinishedGuide: profile.hasFinishedGuide,
    region: profile.region,
    registeredAt: profile.registeredAt,
    rawProfile: profile.rawProfile
  };
}
