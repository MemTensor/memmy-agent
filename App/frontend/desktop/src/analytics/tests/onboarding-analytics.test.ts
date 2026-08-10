/** Onboarding analytics helper tests. */
import { describe, expect, it } from "vitest";
import {
  buildOnboardingActivationEvent,
  buildOnboardingCompletedEvent,
  buildOnboardingStepCompletedEvent,
  buildProductTourStepEvent,
  ONBOARDING_STEP_INDEX,
  resolveOnboardingFlow,
  resolveProductTourOnboardingStep
} from "../onboarding-analytics.js";

describe("onboarding-analytics", () => {
  it("maps scan_permission to funnel flow", () => {
    expect(resolveOnboardingFlow("none")).toBe("deny");
    expect(resolveOnboardingFlow("scan_only")).toBe("scan_only");
    expect(resolveOnboardingFlow("scan_and_write_skill")).toBe("full");
    expect(resolveOnboardingFlow("unset")).toBeUndefined();
    expect(resolveOnboardingFlow(null)).toBeUndefined();
  });

  it("keeps historical step_index values and splits product tour sub-steps", () => {
    expect(ONBOARDING_STEP_INDEX.scan_permission).toBe(1);
    expect(ONBOARDING_STEP_INDEX.improvement_program).toBe(2);
    expect(ONBOARDING_STEP_INDEX.first_report).toBe(3);
    expect(ONBOARDING_STEP_INDEX.product_tour_logs).toBe(4);
    expect(ONBOARDING_STEP_INDEX.product_tour_agents).toBe(5);
    expect(ONBOARDING_STEP_INDEX.product_tour_agents_scan).toBe(6);
    expect(ONBOARDING_STEP_INDEX.product_tour_overview).toBe(7);
    expect(ONBOARDING_STEP_INDEX.product_tour_tools).toBe(8);
    expect(ONBOARDING_STEP_INDEX.nickname).toBe(0);
    expect(ONBOARDING_STEP_INDEX).not.toHaveProperty("product_tour");
    expect(ONBOARDING_STEP_INDEX).not.toHaveProperty("mode_selection");
  });

  it("maps tour tabs to onboarding steps", () => {
    expect(resolveProductTourOnboardingStep("logs")).toBe("product_tour_logs");
    expect(resolveProductTourOnboardingStep("agents")).toBe("product_tour_agents");
    expect(resolveProductTourOnboardingStep("agentsScan")).toBe("product_tour_agents_scan");
    expect(resolveProductTourOnboardingStep("overview")).toBe("product_tour_overview");
    expect(resolveProductTourOnboardingStep("tools")).toBe("product_tour_tools");
    expect(resolveProductTourOnboardingStep("chat")).toBeNull();
  });

  it("builds first_report step with viewed and empty_history", () => {
    expect(buildOnboardingStepCompletedEvent({
      step: "first_report",
      choice: "viewed",
      scanPermission: "scan_only",
      emptyHistory: true
    })).toEqual({
      name: "onboarding_step_completed",
      params: {
        step: "first_report",
        step_index: 3,
        choice: "viewed",
        flow: "scan_only",
        scan_permission: "scan_only",
        empty_history: true
      },
      consentTier: "basic"
    });
  });

  it("builds product tour viewed/skipped only (no completed)", () => {
    expect(buildProductTourStepEvent({
      tab: "logs",
      choice: "viewed",
      scanPermission: "scan_and_write_skill"
    })).toEqual({
      name: "onboarding_step_completed",
      params: {
        step: "product_tour_logs",
        step_index: 4,
        choice: "viewed",
        flow: "full",
        scan_permission: "scan_and_write_skill"
      },
      consentTier: "basic"
    });

    expect(buildProductTourStepEvent({
      tab: "agentsScan",
      choice: "skipped",
      scanPermission: "none"
    })).toEqual({
      name: "onboarding_step_completed",
      params: {
        step: "product_tour_agents_scan",
        step_index: 6,
        choice: "skipped",
        flow: "deny",
        scan_permission: "none"
      },
      consentTier: "basic"
    });
  });

  it("builds completed / activation with shared flow", () => {
    expect(buildOnboardingCompletedEvent("scan_and_write_skill")).toEqual({
      name: "onboarding_completed",
      params: {
        flow: "full",
        scan_permission: "scan_and_write_skill"
      },
      consentTier: "basic"
    });

    expect(buildOnboardingActivationEvent({
      name: "onboarding_first_task_completed",
      pagePath: "/main",
      scanPermission: "scan_only",
      durationMs: 1200
    })).toEqual({
      name: "onboarding_first_task_completed",
      params: {
        page_path: "/main",
        flow: "scan_only",
        scan_permission: "scan_only",
        duration_ms: 1200
      },
      consentTier: "basic"
    });
  });
});
