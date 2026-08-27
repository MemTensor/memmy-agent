/** Account service module. */
import {
  AccountInvitationViewSchema,
  AccountLoginResultViewSchema,
  AccountProfileViewSchema,
  AccountSessionViewSchema,
  SendCodeResponseSchema,
  type AccountChannel,
  type AccountInvitationView,
  type AccountLoginResultView,
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
  verifyCode(input: VerifyCodeInput): Promise<AccountLoginResultView>;
  getInvitation(): Promise<AccountInvitationView>;
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
  /** Verification channel supported by the current desktop package. */
  accountChannel?: AccountChannel;
}

/** Creates create account service. */
export function createAccountService(options: CreateAccountServiceOptions): AccountService {
  const now = options.now ?? (() => new Date());

  return {
    async sendCode(input) {
      assertExpectedAccountChannel(input.channel, options.accountChannel);
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
      assertExpectedAccountChannel(input.channel, options.accountChannel);
      const loginResult = await options.cloudClient.login({
        ...(input.email ? { email: input.email } : {}),
        ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
        verificationCode: input.verificationCode,
        loginSource: input.loginSource,
        ...(input.invitationCode ? { invitationCode: input.invitationCode } : {})
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
          isNewUser: loginResult.isNewUser,
          authChannel: input.channel
        })
      );

      const refreshedSession = await refreshCloudGuideState({
        cloudClient: options.cloudClient,
        accountSessionRepository: options.accountSessionRepository,
        session,
        cloudUuid: loginResult.uuid
      });
      return AccountLoginResultViewSchema.parse({
        session: refreshedSession,
        invitationResult: loginResult.invitationResult ?? { status: "not_provided" }
      });
    },

    async getInvitation() {
      const cloudUuid = options.accountSessionRepository.getCloudUuid();
      if (!cloudUuid) {
        throw Object.assign(new Error("Account session is not authenticated"), {
          code: "unauthorized" as const
        });
      }
      return AccountInvitationViewSchema.parse(
        await options.cloudClient.ensureInvitationCode({ uuid: cloudUuid })
      );
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
      const session = options.accountSessionRepository.get();
      if (uuid) {
        try {
          await options.cloudClient.logout({ uuid });
        } catch {
          // noop
        }
      }

      await clearLocalAccountState(
        options,
        session.authenticated ? session.profile.userId : undefined,
        true,
        uuid ?? undefined
      );
      return { ok: true };
    },

    async getSession() {
      const session = AccountSessionViewSchema.parse(options.accountSessionRepository.get());
      const cloudUuid = session.authenticated ? options.accountSessionRepository.getCloudUuid() : null;
      return refreshCloudGuideState({
        cloudClient: options.cloudClient,
        accountSessionRepository: options.accountSessionRepository,
        session,
        cloudUuid: cloudUuid ?? undefined,
        onAuthenticationInvalid: () => clearLocalAccountState(
          options,
          session.authenticated ? session.profile.userId : undefined,
          false,
          cloudUuid ?? undefined
        )
      });
    }
  };
}

function assertExpectedAccountChannel(
  actualChannel: AccountChannel,
  expectedChannel: AccountChannel | undefined
): void {
  if (!expectedChannel || actualChannel === expectedChannel) return;
  throw Object.assign(new Error(`Account channel ${actualChannel} is not supported by this desktop package`), {
    code: "invalid_argument" as const
  });
}

async function reloadMemoryConfigIfNeeded(
  projection: RuntimeProjectionResult | undefined,
  options: CreateAccountServiceOptions
): Promise<void> {
  if (!projection?.changed || !projection.memoryConfigAffected || !options.memoryClient) {
    return;
  }

  try {
    await options.memoryClient.reloadConfig({ reason: "account_profile_projected" });
  } catch {
    // noop
  }
}

async function clearLocalAccountState(
  options: CreateAccountServiceOptions,
  ownerAccountId?: string,
  syncSelectedByokToLocal = false,
  expectedCloudUuid?: string
): Promise<void> {
  const projection = await options.memmyConfigWriter?.clearAccountModelProjection?.({
    ownerAccountId,
    syncSelectedByokToLocal,
    expectedCloudUuid
  });
  if (expectedCloudUuid) {
    options.accountSessionRepository.clearIfCloudUuid(expectedCloudUuid);
  } else {
    options.accountSessionRepository.clear();
  }
  await reloadMemoryConfigIfNeeded(projection, options);
}

/** Handles refresh cloud guide state. */
async function refreshCloudGuideState(input: {
  cloudClient: CloudClient;
  accountSessionRepository: AccountSessionRepository;
  session: AccountSessionView;
  cloudUuid?: string;
  onAuthenticationInvalid?: () => Promise<void>;
}): Promise<AccountSessionView> {
  if (!input.session.authenticated) {
    return input.session;
  }

  const cloudUuid = input.cloudUuid ?? input.accountSessionRepository.getCloudUuid();
  if (!cloudUuid) {
    return input.session;
  }

  let cloudProfile: CloudAccountProfile;
  try {
    cloudProfile = await input.cloudClient.getAccountInfo({ uuid: cloudUuid });
  } catch (error) {
    if (isUnauthorized(error) && input.onAuthenticationInvalid) {
      await input.onAuthenticationInvalid();
    }
    throw error;
  }
  return AccountSessionViewSchema.parse(
    input.accountSessionRepository.upsert({
      profile: toSessionProfileInput(cloudProfile),
      isNewUser: input.session.isNewUser
    })
  );
}

function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "unauthorized");
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
