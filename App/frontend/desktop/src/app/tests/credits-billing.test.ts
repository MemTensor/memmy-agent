// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import {
  advanceCreditCycle, consumeCreditBuckets, createCreditDemo, creditAnniversary, creditCycleWindow,
  creditRangeStart, describeCreditPool, filterCreditLedger, grantPreviewCredits, ledgerGroupCredits,
  previewCreditPlan, readCreditDemo, writeCreditDemo, CREDIT_LEDGER, type CreditBucket
} from "../credits-preview-quota.js";

const date = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour);
const bucket = (id: string, source: CreditBucket["source"], granted: number, expiresAt: string | null): CreditBucket => ({
  id, source, granted, remaining: granted, grantedAt: date(10, 1).toISOString(), expiresAt
});

beforeEach(() => window.sessionStorage.clear());

describe("monthly credit cycles", () => {
  it("starts with 1,000 on the account anniversary, not the first of next month", () => {
    const account = createCreditDemo(date(10, 15));
    expect(describeCreditPool(account, date(10, 15)).totalRemaining).toBe(1000);
    expect(creditCycleWindow(account, date(10, 20)).end).toEqual(date(11, 15));
  });

  it("restores the original day after short months, including leap years", () => {
    const anchor = new Date(2026, 0, 31, 9, 15).toISOString();
    expect(creditAnniversary(anchor, 1)).toEqual(new Date(2026, 1, 28, 9, 15));
    expect(creditAnniversary(anchor, 2)).toEqual(new Date(2026, 2, 31, 9, 15));
    expect(creditAnniversary(new Date(2024, 0, 31).toISOString(), 1)).toEqual(new Date(2024, 1, 29));
  });

  it("clears only the old plan bucket and does not accumulate unused months", () => {
    let account = createCreditDemo(date(10, 15));
    account.buckets[0]!.remaining = 300;
    account = grantPreviewCredits(account, bucket("reward", "reward", 200, null));
    const renewed = advanceCreditCycle(account, date(11, 15));
    expect(describeCreditPool(renewed, date(11, 15)).totalRemaining).toBe(1200);
    const later = advanceCreditCycle(renewed, new Date(2027, 2, 16, 12));
    expect(describeCreditPool(later, new Date(2027, 2, 16, 12)).totalRemaining).toBe(1200);
    expect(advanceCreditCycle(later, new Date(2027, 2, 16, 12))).toBe(later);
  });

  it("upgrades by replacing plan credits and preserving other sources", () => {
    let account = createCreditDemo(date(10, 1));
    account.buckets[0]!.remaining = 300;
    account = grantPreviewCredits(account, bucket("reward", "reward", 200, null));
    const upgraded = previewCreditPlan(account, "pro", date(10, 15));
    expect(describeCreditPool(upgraded, date(10, 15)).totalRemaining).toBe(5200);
    expect(creditCycleWindow(upgraded, date(10, 15)).end).toEqual(date(11, 15));
  });

  it("keeps Plus active across monthly credit resets", () => {
    const pro = previewCreditPlan(createCreditDemo(date(10, 1)), "pro", date(10, 15));
    const next = advanceCreditCycle(pro, date(11, 15));
    expect(next.plan).toBe("pro");
    expect(describeCreditPool(next, date(11, 15)).planRemaining).toBe(5000);
    expect(advanceCreditCycle(next, date(12, 15)).plan).toBe("pro");
  });

  it("migrates old commerce samples without retaining purchased balances or downgrading Plus", () => {
    const account = previewCreditPlan(createCreditDemo(date(10, 1)), "pro", date(10, 1));
    account.buckets[0]!.remaining = 3200;
    window.sessionStorage.setItem("memmy.creditsPreview.demo", JSON.stringify({ ...account, version: 2,
      balanceSampleVersion: 4, paidUntil: date(10, 20).toISOString(), autoRenew: true,
      buckets: [...account.buckets, { ...bucket("legacy-purchase", "reward", 800, null), source: "purchase" }] }));
    const migrated = readCreditDemo(date(10, 25));
    expect(migrated.plan).toBe("pro");
    expect(describeCreditPool(migrated, date(10, 25)).totalRemaining).toBe(3200);
    expect(migrated).not.toHaveProperty("paidUntil");
    expect(migrated).not.toHaveProperty("autoRenew");
    expect(readCreditDemo(date(11, 1)).plan).toBe("pro");
    expect(describeCreditPool(readCreditDemo(date(11, 1)), date(11, 1)).planRemaining).toBe(5000);
  });

  it("does not reset credits or the anniversary for a repeated upgrade", () => {
    const account = previewCreditPlan(createCreditDemo(date(10, 1)), "pro", date(10, 1));
    account.buckets[0]!.remaining = 3200;
    expect(previewCreditPlan(account, "pro", date(10, 20))).toEqual(account);
  });

  it("does not move the anniversary or add credits when re-reading preview state", () => {
    writeCreditDemo(createCreditDemo(date(10, 15)));
    const first = readCreditDemo(date(10, 18));
    const second = readCreditDemo(date(10, 20));
    expect(second.cycleAnchor).toBe(first.cycleAnchor);
    expect(describeCreditPool(second, date(10, 20)).totalRemaining).toBe(1000);
  });
});

describe("expiry-first deduction", () => {
  it("spends earliest expiry across sources and splits a charge across buckets", () => {
    const buckets = [
      bucket("plan", "plan", 300, date(11, 15).toISOString()),
      bucket("reward", "reward", 100, date(10, 20).toISOString()),
      bucket("pack", "reward", 500, null)
    ];
    const result = consumeCreditBuckets(buckets, 150, date(10, 15));
    expect(result.buckets.map(b => b.remaining)).toEqual([250, 0, 500]);
    expect(result.charged).toBe(150);
    expect(buckets[1]!.remaining).toBe(100);
  });

  it("allows an expiring reward to be first and excludes expired/future grants", () => {
    const result = consumeCreditBuckets([
      bucket("reward", "reward", 20, null),
      bucket("plan", "plan", 100, date(11, 15).toISOString()),
      bucket("pack", "reward", 10, date(10, 20).toISOString()),
      bucket("expired", "reward", 999, date(10, 15).toISOString()),
      { ...bucket("future", "reward", 999, null), grantedAt: date(10, 16).toISOString() }
    ], 15.25, date(10, 15));
    expect(result.buckets.map(b => b.remaining)).toEqual([20, 94.75, 0, 999, 999]);
    expect(result.uncovered).toBe(0);
  });

  it("never debits below zero or counts the same grant twice", () => {
    const result = consumeCreditBuckets([bucket("one", "reward", 0.3, null)], 0.4, date(10, 15));
    expect(result.buckets[0]!.remaining).toBe(0);
    expect(result.charged).toBe(0.3);
    expect(result.uncovered).toBe(0.1);
    const b = bucket("pack-order", "reward", 200, null);
    const account = grantPreviewCredits(createCreditDemo(date(10, 15)), b);
    expect(grantPreviewCredits(account, b)).toBe(account);
  });
});

describe("call-level date filtering", () => {
  it("excludes yesterday's calls from today's group total", () => {
    const now = new Date(2026, 9, 15, 2, 3);
    const rows = filterCreditLedger(CREDIT_LEDGER, now, creditRangeStart("today", now), now);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.group.calls.map(call => call.requestId)).toEqual(["preview-7f3a"]);
    expect(ledgerGroupCredits(rows[0]!.group)).toBe(16.75);
  });

  it("includes in-range calls even when the group timestamp is outside the window", () => {
    const now = date(10, 15);
    const rows = filterCreditLedger([{ ...CREDIT_LEDGER[0]!, hoursAgo: 200,
      calls: [{ hoursAgo: 1, credits: 5, requestId: "inside" }, { hoursAgo: 200, credits: 50, requestId: "outside" }]
    }], now, creditRangeStart("7", now), now);
    expect(ledgerGroupCredits(rows[0]!.group)).toBe(5);
  });

  it("keeps sample timestamps fixed across reloads rather than shifting them into today", () => {
    const anchor = date(10, 15);
    const now = date(10, 17);
    expect(filterCreditLedger(CREDIT_LEDGER, anchor, creditRangeStart("today", now), now)).toHaveLength(0);
  });
});
