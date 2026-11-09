import { z } from "zod";

const httpsUrl = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && (!url.port || url.port === "443");
  } catch { return false; }
});
export const DesktopContentQuerySchema = z.object({
  locale: z.enum(["zh-CN", "en-US"]), clientVersion: z.string().min(1), region: z.enum(["CN", "INTL"])
});
export type DesktopContentQuery = z.infer<typeof DesktopContentQuerySchema>;
export const DesktopLegalAgreementsSchema = z.object({ items: z.array(z.object({
  agreementCode: z.enum(["USER_AGREEMENT", "PRIVACY_POLICY", "CREDIT_RULES"]), title: z.string().min(1),
  version: z.string().min(1), effectiveAt: z.string().datetime({ offset: true }), url: httpsUrl, required: z.boolean()
})) });
export const DesktopLegalPageSchema = z.object({
  title: z.string().min(1), contentUrl: httpsUrl, version: z.string().min(1), updatedAt: z.string().datetime({ offset: true })
});
export const DesktopPromotionTargets = ["memmy://credits", "memmy://credits/check-in", "memmy://credits/invitations",
  "memmy://credits/redemptions", "memmy://credits/plans"] as const;
export const DesktopPromotionsSchema = z.object({ items: z.array(z.object({
  promotionId: z.string().min(1), title: z.string().min(1), description: z.string(),
  startAt: z.string().datetime({ offset: true }), endAt: z.string().datetime({ offset: true }),
  rewardRule: z.object({ type: z.enum(["CHECK_IN", "INVITE", "IMPROVEMENT", "VOUCHER"]),
    amount: z.string().regex(/^\d+\.\d{2}$/), validDays: z.number().int().positive().nullable(),
    dailyLimit: z.number().int().positive().optional() }),
  targetUrl: z.union([httpsUrl, z.enum(DesktopPromotionTargets)])
})) });
export const DesktopContentSchema = z.object({
  locale: DesktopContentQuerySchema.shape.locale,
  agreements: DesktopLegalAgreementsSchema.shape.items,
  pages: z.array(DesktopLegalPageSchema.extend({ pageCode: z.enum(["CREDIT_RULES", "CREDIT_HELP"]) })),
  promotions: DesktopPromotionsSchema.shape.items
});
export type DesktopContent = z.infer<typeof DesktopContentSchema>;
