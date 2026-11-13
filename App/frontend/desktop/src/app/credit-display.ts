import type { CreditsGrant } from "@memmy/local-api-contracts";
import type { CreditBucket } from "./credits-preview-quota.js";

export function creditMinor(amount: string): bigint { return BigInt(amount.replace(".", "")); }
export function formatCreditMinor(minor: bigint, language: string): string {
  const absolute = minor < 0n ? -minor : minor;
  return `${minor < 0n ? "-" : ""}${(absolute / 100n).toLocaleString(language)}.${String(absolute % 100n).padStart(2, "0")}`;
}
export function formatCreditAmount(amount: string, language: string): string { return formatCreditMinor(creditMinor(amount), language); }
export function creditUsagePercent(used: bigint, granted: bigint): number {
  return granted > 0n ? Math.min(100, Math.max(0, Number(used * 10000n / granted) / 100)) : 0;
}
export function creditDisplayBuckets(buckets: CreditBucket[], grants?: CreditsGrant[]) {
  return grants ? grants.map(grant => ({
    id: grant.grantId, invitation: grant.sourceType === "INVITATION", usageKnown: grant.used !== undefined || (grant.status !== "EXPIRED" && grant.status !== "REVOKED"),
    used: grant.used === undefined ? creditMinor(grant.granted) - creditMinor(grant.remaining) - creditMinor(grant.reserved) : creditMinor(grant.used), granted: creditMinor(grant.granted),
    remaining: creditMinor(grant.remaining), reserved: creditMinor(grant.reserved),
    grantedAt: grant.grantedAt, expiresAt: grant.expiresAt, label: grant.sourceName
  })) : buckets.map(bucket => ({ ...bucket, invitation: bucket.id.startsWith("invite:"), usageKnown: true, used: creditMinor((bucket.granted - bucket.remaining).toFixed(2)), granted: creditMinor(bucket.granted.toFixed(2)), remaining: creditMinor(bucket.remaining.toFixed(2)), reserved: 0n, label: undefined }));
}
