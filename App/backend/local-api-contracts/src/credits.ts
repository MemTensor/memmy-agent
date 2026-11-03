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
  grantId: id, sourceType: z.enum(["PLAN", "CHECK_IN", "INVITATION", "REDEMPTION", "MIGRATION", "ADJUSTMENT"]),
  sourceId: z.string(), sourceName: z.string(), granted: amount, remaining: amount, reserved: amount,
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

const rewardGrant = z.object({ grantId: id, amount, expiresAt: stamp.nullable() });
export const CreditsCheckinRequestSchema = z.object({ requestId: z.string().regex(/^[A-Za-z0-9_:-]{1,128}$/) }).strict();
export const CreditsRedemptionRequestSchema = CreditsCheckinRequestSchema.extend({ code: z.string().min(1).max(128) }).strict();
export const CreditsCheckinSchema = z.object({ claimed: z.boolean(), alreadyClaimed: z.boolean(), businessDate: z.string(), grant: rewardGrant, balance: amount, accountVersion: z.number().int().nonnegative() });
export const CreditsRedemptionSchema = z.object({ redeemed: z.boolean(), activityName: z.string(), grant: rewardGrant, balance: amount, accountVersion: z.number().int().nonnegative() });
export const CreditsInvitationSummarySchema = z.object({ invitationCode: z.string(), rule: z.object({ inviterReward: amount, inviteeReward: amount, validDays: z.number().int(), dailyLimit: z.number().int() }), todayRewarded: z.number().int(), todayRemaining: z.number().int(), totalRewarded: amount });
export const CreditsInvitationsQuerySchema = z.object({ status: z.enum(["PENDING", "QUALIFIED", "REWARDED", "REJECTED"]).optional(), cursor: z.string().max(4096).optional(), limit: z.coerce.number().int().min(1).max(100).optional() }).strict();
export const CreditsInvitationsPageSchema = z.object({ items: z.array(z.object({ inviteeMask: z.string(), registeredAt: stamp, qualifiedAt: stamp.nullable(), inviterGrant: amount, inviteeGrant: amount, status: z.enum(["PENDING", "QUALIFIED", "REWARDED", "REJECTED"]) })), nextCursor: z.string().nullable(), hasMore: z.boolean() });
export type CreditsInvitationsQuery = z.infer<typeof CreditsInvitationsQuerySchema>;
