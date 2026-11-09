import { z } from "zod";

const amount = z.string().regex(/^\d+\.\d{2}$/);
const delta = z.string().regex(/^-?\d+\.\d{2}$/);
const stamp = z.string().datetime({ offset: true });
const id = z.string().regex(/^[1-9]\d*$/);
export const CreditsSummarySchema = z.object({
  account: z.object({ balance: amount, held: amount, spendable: amount, version: z.number().int().nonnegative() }),
  plan: z.object({ code: z.enum(["FREE", "PRO"]), cycleStart: stamp, cycleEnd: stamp, nextCycleGrant: amount }),
  balanceBySource: z.object({ plan: amount, reward: amount }),
  checkin: z.object({ claimedToday: z.boolean(), reward: amount }),
  knowledgeEntitlement: z.object({ baseLimit: z.number().int(), storageBytes: z.number().int(), membersPerBase: z.number().int() })
});
export const CreditsGrantSchema = z.object({
  grantId: id, sourceType: z.enum(["PLAN", "CHECK_IN", "INVITATION", "REDEMPTION", "MIGRATION", "ADJUSTMENT", "IMPROVEMENT"]),
  sourceId: z.string(), sourceName: z.string(), granted: amount, remaining: amount, reserved: amount, used: amount.optional(),
  grantedAt: stamp, expiresAt: stamp.nullable(), status: z.enum(["AVAILABLE", "EXHAUSTED", "EXPIRED", "REVOKED"])
});
export const CreditsLedgerEntrySchema = z.object({
  ledgerId: id, direction: z.enum(["CREDIT", "DEBIT"]), businessType: z.string(), entryType: z.string(),
  amount, balanceDelta: delta, heldDelta: delta, balanceAfter: amount, heldAfter: amount,
  title: z.string(), occurredAt: stamp, referenceId: z.string().nullable()
});
export const CreditsGrantsPageSchema = z.object({ items: z.array(CreditsGrantSchema), nextCursor: z.string().nullable(), hasMore: z.boolean() });
export const CreditsLedgerPageSchema = z.object({ items: z.array(CreditsLedgerEntrySchema), nextCursor: z.string().nullable(), hasMore: z.boolean() });
const pagination = { from: stamp.optional(), to: stamp.optional(), cursor: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).optional() };
export const CreditsGrantsQuerySchema = z.object({ ...pagination,
  sourceType: CreditsGrantSchema.shape.sourceType.optional(), status: CreditsGrantSchema.shape.status.optional()
}).strict();
export const CreditsLedgerQuerySchema = z.object({ ...pagination,
  direction: z.enum(["CREDIT", "DEBIT"]).optional(),
  businessType: z.enum(["PLAN_GRANT", "REWARD", "MODEL_USAGE", "ADJUSTMENT", "MIGRATION"]).optional()
}).strict();
export type CreditsSummary = z.infer<typeof CreditsSummarySchema>;
export type CreditsGrant = z.infer<typeof CreditsGrantSchema>;
export type CreditsLedgerEntry = z.infer<typeof CreditsLedgerEntrySchema>;
export type CreditsGrantsPage = z.infer<typeof CreditsGrantsPageSchema>;
export type CreditsLedgerPage = z.infer<typeof CreditsLedgerPageSchema>;
export type CreditsGrantsQuery = z.infer<typeof CreditsGrantsQuerySchema>;
export type CreditsLedgerQuery = z.infer<typeof CreditsLedgerQuerySchema>;

export const CreditsPlansQuerySchema = z.object({
  region: z.enum(["CN", "INTL"]).optional(), language: z.enum(["zh-CN", "en-US"]).optional(), clientVersion: z.string().max(64).optional()
}).strict();
export const CreditsPlansSchema = z.object({
  currentPlan: z.enum(["FREE", "PRO"]),
  plans: z.array(z.object({ code: z.enum(["FREE", "PRO"]), name: z.string(), cycleGrant: amount,
    knowledgeEntitlement: CreditsSummarySchema.shape.knowledgeEntitlement })).length(2).refine(plans => new Set(plans.map(plan => plan.code)).size === 2),
  application: z.object({ eligible: z.boolean(), formType: z.enum(["CN_ZH", "CN_EN", "INTL_ZH", "INTL_EN"]), formUrl: z.string().url() })
});
export const CreditsApplicationSchema = z.object({
  applicationId: id, status: z.enum(["PENDING", "PROCESSING", "APPROVED", "REJECTED", "FAILED"]),
  submittedAt: stamp, processedAt: stamp.nullable(), plan: z.enum(["FREE", "PRO"]), failureReason: z.string().nullable()
}).nullable();
export type CreditsPlansQuery = z.infer<typeof CreditsPlansQuerySchema>;
export type CreditsPlans = z.infer<typeof CreditsPlansSchema>;
export type CreditsApplication = z.infer<typeof CreditsApplicationSchema>;
export const CreditsUsageQuerySchema = z.object({ ...pagination,
  domain: z.enum(["agent", "memory", "embedding", "asr"]).optional(),
  model: z.string().min(1).max(128).optional(),
  status: z.enum(["AUTHORIZED", "RUNNING", "SUCCEEDED", "FAILED", "INTERRUPTED", "SETTLED", "RELEASED", "RECONCILING"]).optional()
}).strict();
export const CreditsUsageExportQuerySchema = CreditsUsageQuerySchema.omit({ cursor: true, limit: true });
export const CreditsUsageSchema = z.object({
  callId: z.string().nullable(), requestId: z.string().nullable(), domain: z.string(), operation: z.string(), model: z.string(),
  inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), chargedCredits: amount,
  status: z.literal("SETTLED"), businessDate: z.string(), callCount: z.number().int().positive(), startedAt: stamp, settledAt: stamp,
  requestContent: z.string().nullable(), requestContentStatus: z.enum(["AVAILABLE", "UNAVAILABLE", "EXPIRED"])
});
export const CreditsUsagePageSchema = z.object({ items: z.array(CreditsUsageSchema), nextCursor: z.string().nullable(), hasMore: z.boolean(), total: z.number().int().nonnegative().optional() });
export const CreditsUsageDetailSchema = CreditsUsageSchema.extend({ pricingVersion: z.string().nullable(),
  settlementVersion: z.number().int().nonnegative().nullable().default(null),
  cachedTokens: z.number().int().nonnegative(), audioSeconds: z.string().nullable(), chargeCredits: amount, absorbedCredits: amount, settlementStatus: z.literal("SETTLED"), remainingCredits: amount.nullable(),
  inputCredits: amount.nullable().default(null), outputCredits: amount.nullable().default(null),
  checkpoints: z.array(z.object({ sequence: z.number().int().nonnegative(), usageTokens: z.number().int().nonnegative(), chargedCredits: amount })).default([]) });
export const CreditsUsageExportSchema = z.object({ exportId: z.string(), fileName: z.string(), downloadUrl: z.string(), rowCount: z.number().int().nonnegative(), expiresAt: stamp });
export const CreditsUsageDownloadSchema = z.object({ csv: z.string() });
export type CreditsUsageQuery = z.infer<typeof CreditsUsageQuerySchema>;
export type CreditsUsage = z.infer<typeof CreditsUsageSchema>;
export type CreditsUsagePage = z.infer<typeof CreditsUsagePageSchema>;
export type CreditsUsageDetail = z.infer<typeof CreditsUsageDetailSchema>;
export type CreditsUsageExportQuery = z.infer<typeof CreditsUsageExportQuerySchema>;
const rewardGrant = z.object({ grantId: id, amount, expiresAt: stamp.nullable() });
export const CreditsCheckinRequestSchema = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/) }).strict();
export const CreditsRedemptionRequestSchema = CreditsCheckinRequestSchema.extend({ code: z.string().min(1).max(128) }).strict();
export const CreditsCheckinSchema = z.object({ claimed: z.boolean(), alreadyClaimed: z.boolean(), businessDate: z.string(), grant: rewardGrant, balance: amount, accountVersion: z.number().int().nonnegative() });
export const CreditsRedemptionSchema = z.object({ redeemed: z.boolean(), activityName: z.string(), grant: rewardGrant, balance: amount, accountVersion: z.number().int().nonnegative() });
export const CreditsInvitationSummarySchema = z.object({ invitationCode: z.string(), rule: z.object({ inviterReward: amount, inviteeReward: amount, validDays: z.number().int(), dailyLimit: z.number().int() }), todayRewarded: z.number().int(), todayRemaining: z.number().int(), totalRewarded: amount });
export const CreditsInvitationsQuerySchema = z.object({ status: z.enum(["PENDING", "QUALIFIED", "REWARDED", "REJECTED"]).optional(), cursor: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
export const CreditsInvitationsPageSchema = z.object({ items: z.array(z.object({ inviteeMask: z.string(), registeredAt: stamp, qualifiedAt: stamp.nullable(), inviterGrant: amount, inviteeGrant: amount, status: z.enum(["PENDING", "QUALIFIED", "REWARDED", "REJECTED"]) })), nextCursor: z.string().nullable(), hasMore: z.boolean() });
export type CreditsInvitationsQuery = z.infer<typeof CreditsInvitationsQuerySchema>;

export const CreditApplicationRoles = ["PRODUCT", "ENGINEERING", "RESEARCH", "LEGAL", "MANAGEMENT", "OTHER"] as const;
export const CreditApplicationUseCases = ["KNOWLEDGE", "WRITING", "RESEARCH", "CODING", "LEGAL", "LEARNING", "OTHER"] as const;
export const CreditApplicationFrequencies = ["DAILY", "WEEKLY", "OCCASIONAL", "EVALUATING"] as const;
export const CreditsApplicationRequestSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/),
  formType: z.enum(["CN_ZH", "CN_EN", "INTL_ZH", "INTL_EN"]),
  formVersion: z.literal("v1"),
  answers: z.object({
    organization: z.string().trim().min(1).max(200),
    role: z.union([z.enum(CreditApplicationRoles), z.literal("")]),
    useCases: z.array(z.enum(CreditApplicationUseCases)).min(1).max(7).refine(values => new Set(values).size === values.length),
    upgradeReason: z.string().trim().min(1).max(4000),
    usageFrequency: z.union([z.enum(CreditApplicationFrequencies), z.literal("")]),
    additionalContact: z.string().trim().max(320)
  }).strict()
}).strict();
export type CreditsApplicationRequest = z.infer<typeof CreditsApplicationRequestSchema>;
