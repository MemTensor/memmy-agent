/** Account service module. */
import {
  AccountInvitationViewSchema,
  AccountLoginResultViewSchema,
  AccountProfileViewSchema,
  AccountSessionViewSchema,
  LotteryRewardSchema,
  SendCodeResponseSchema,
  SocialLoginStatusResponseSchema,
  StartSocialLoginResponseSchema,
  type AccountChannel,
  type AccountInvitationView,
  type AccountLoginResultView,
  type AccountProfileView,
  type AccountSessionView,
  type LotteryReward,
  type LotteryRewardAckInput,
  type SendCodeInput,
  type SendCodeResponse,
  type SocialLoginStatusInput,
  type SocialLoginStatusResponse,
  type StartSocialLoginInput,
  type StartSocialLoginResponse,
  type UpdateAccountProfileInput,
  type VerifyCodeInput
} from "@memmy/local-api-contracts";
import type { CloudAccountProfile, CloudClient, CloudLoginResult } from "../adapters/outbound/cloud-client/index.js";
import type {
  AccountSessionProfileInput,
  AccountSessionRepository
} from "../infrastructure/app-state-store/repositories/account-session-repo.js";
import type { BootstrapRepository } from "../infrastructure/app-state-store/repositories/bootstrap-repo.js";
import type { MemmyConfigWriter, RuntimeProjectionResult } from "../infrastructure/memmy-config/index.js";
import type { MemoryClient } from "../adapters/outbound/memory-client/index.js";
import type { OkResponse } from "@memmy/local-api-contracts";
import { VerificationRequestError, toVerificationRequestError } from "./verification-request-error.js";

const RESEND_WINDOW_MS = 60_000;

export interface AccountService {
  sendCode(input: SendCodeInput): Promise<SendCodeResponse>;
  verifyCode(input: VerifyCodeInput): Promise<AccountLoginResultView>;
  startSocialLogin(input: StartSocialLoginInput): Promise<StartSocialLoginResponse>;
  getSocialLoginStatus(input: SocialLoginStatusInput): Promise<SocialLoginStatusResponse>;
  getInvitation(): Promise<AccountInvitationView>;
  getLotteryReward(): Promise<LotteryReward>;
  ackLotteryReward(input: LotteryRewardAckInput): Promise<OkResponse>;
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
  /** Bootstrap repository used to preserve machine-level onboarding across logout. */
  bootstrapRepository: Pick<BootstrapRepository, "preserveCompletedOnboardingForLocalByok">;
  /** Memmy config writer. */
  memmyConfigWriter?: MemmyConfigWriter;
  /** Memory client. */
  memoryClient?: Pick<MemoryClient, "reloadConfig">;
  /** Now. */
  now?: () => Date;
  /** Verification channel supported by the current desktop package. */
  accountChannel?: AccountChannel;
  /** Invoked after the cloud profile is refreshed so entitlement-gated features can be reconciled. */
  onAccountGrantsRefreshed?: () => Promise<void>;
}

/** Creates create account service. */
export function createAccountService(options: CreateAccountServiceOptions): AccountService {
  const now = options.now ?? (() => new Date());
  const pendingCodeRequests = new Map<string, Promise<SendCodeResponse>>();
  // Independent from successful-send records; survives renderer navigation while this service runs.
  const failedCodeRetryAt = new Map<string, number>();

  async function sendCodeRequest(input: SendCodeInput, key: string): Promise<SendCodeResponse> {
    const time = now().getTime();
    for (const [address, retryAt] of failedCodeRetryAt) {
      if (retryAt <= time) failedCodeRetryAt.delete(address);
    }
    const retryAt = failedCodeRetryAt.get(key);
    if (retryAt !== undefined) {
      throw new VerificationRequestError("Please wait before requesting another code", 429, Math.ceil((retryAt - time) / 1000));
    }
    const sentAt = options.accountSessionRepository.getLastCodeSentAt(key);
    const remaining = getRemainingResendSeconds(sentAt, now());
    if (remaining > 0) {
      return SendCodeResponseSchema.parse({ ok: true, resendAfterSec: remaining });
    }

    try {
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
    } catch (error) {
      // A failed response does not prove delivery failed. Keep the resend window
      // to avoid sending another code while the first one may still arrive.
      const failure = toVerificationRequestError(error, RESEND_WINDOW_MS / 1000);
      if (!failure) throw error;
      failedCodeRetryAt.set(key, now().getTime() + RESEND_WINDOW_MS);
      throw failure;
    }

    // Record only cloud-confirmed success, not a failed attempt or handset delivery.
    options.accountSessionRepository.markCodeSent(key, now().toISOString());
    return SendCodeResponseSchema.parse({ ok: true, resendAfterSec: RESEND_WINDOW_MS / 1000 });
  }

  return {
    async sendCode(input) {
      assertExpectedAccountChannel(input.channel, options.accountChannel);
      const key = toCodeKey(input);
      const pending = pendingCodeRequests.get(key);
      if (pending) {
        return pending;
      }

      const request = sendCodeRequest(input, key);
      pendingCodeRequests.set(key, request);
      try {
        return await request;
      } finally {
        pendingCodeRequests.delete(key);
      }
    },

    async verifyCode(input) {
      assertExpectedAccountChannel(input.channel, options.accountChannel);
      const loginResult = await options.cloudClient.login({
        ...(input.email ? { email: input.email } : {}),
        ...(input.phoneNumber ? { phoneNumber: input.phoneNumber } : {}),
        verificationCode: input.verificationCode,
        loginSource: input.loginSource,
        ...(input.invitationCode ? { invitationCode: input.invitationCode } : {})
      }).catch((error: unknown) => { throw toVerificationRequestError(error) ?? error; });
      return finalizeCloudLogin(loginResult, input.channel, options);
    },

    async startSocialLogin(input) {
      assertSocialLoginSupported(options.accountChannel);
      return StartSocialLoginResponseSchema.parse(
        await options.cloudClient.startSocialLogin(input)
      );
    },

    async getSocialLoginStatus(input) {
      assertSocialLoginSupported(options.accountChannel);
      const status = await options.cloudClient.getSocialLoginStatus(input);
      if (status.status !== "completed") {
        return SocialLoginStatusResponseSchema.parse(status);
      }
      return SocialLoginStatusResponseSchema.parse({
        status: "completed",
        result: await finalizeCloudLogin(status.result, "email", options)
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

    async getLotteryReward() {
      const uuid = options.accountSessionRepository.getCloudUuid();
      if (!uuid) {
        return { hasReward: false };
      }
      try {
        return LotteryRewardSchema.parse(await options.cloudClient.getLotteryReward({ uuid }));
      } catch {
        return { hasReward: false };
      }
    },

    async ackLotteryReward(input) {
      const uuid = options.accountSessionRepository.getCloudUuid();
      if (!uuid) {
        throw Object.assign(new Error("Account session is not authenticated"), {
          code: "unauthorized" as const
        });
      }
      await options.cloudClient.ackLotteryReward({
        uuid,
        ...(input.drawId ? { drawId: input.drawId } : {})
      });
      return { ok: true };
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
        rawProfileMode: "merge",
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
      options.bootstrapRepository.preserveCompletedOnboardingForLocalByok();
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
        onGrantsRefreshed: options.onAccountGrantsRefreshed,
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

function assertSocialLoginSupported(accountChannel: AccountChannel | undefined): void {
  if (accountChannel === "email") return;
  throw Object.assign(new Error("Social login is not supported by this desktop package"), {
    code: "invalid_argument" as const
  });
}

async function finalizeCloudLogin(
  loginResult: CloudLoginResult,
  authChannel: AccountChannel,
  options: CreateAccountServiceOptions
): Promise<AccountLoginResultView> {
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
      authChannel
    })
  );

  const refreshedSession = await refreshCloudGuideState({
    cloudClient: options.cloudClient,
    accountSessionRepository: options.accountSessionRepository,
    session,
    cloudUuid: loginResult.uuid,
    onGrantsRefreshed: options.onAccountGrantsRefreshed
  });
  return AccountLoginResultViewSchema.parse({
    session: refreshedSession,
    invitationResult: loginResult.invitationResult ?? { status: "not_provided" }
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
  await options.onAccountGrantsRefreshed?.().catch((error: unknown) => {
    console.warn(`Account grant reconciliation failed: ${String(error)}`);
  });
}

/** Handles refresh cloud guide state. */
async function refreshCloudGuideState(input: {
  cloudClient: CloudClient;
  accountSessionRepository: AccountSessionRepository;
  session: AccountSessionView;
  cloudUuid?: string;
  onGrantsRefreshed?: () => Promise<void>;
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
  const refreshed = AccountSessionViewSchema.parse(
    input.accountSessionRepository.upsert({
      profile: toSessionProfileInput(cloudProfile),
      isNewUser: input.session.isNewUser
    })
  );
  // Entitlement-gated features reconcile in the background; a failure here must not fail the login.
  await input.onGrantsRefreshed?.().catch((error: unknown) => {
    console.warn(`Account grant reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
  });
  return refreshed;
}

function isUnauthorized(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "unauthorized");
}

/** Handles to code key. */
function toCodeKey(input: SendCodeInput): string {
  const address = input.channel === "email" ? requireAddress(input.email, "email") : requireAddress(input.phoneNumber, "phoneNumber");
  // Match the persisted throttle identity without altering the cloud payload.
  return `${input.channel}:${address.trim().toLowerCase()}`;
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
