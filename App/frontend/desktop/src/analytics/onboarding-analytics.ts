/** Onboarding funnel analytics helpers (additive params on existing events). */
import type { ScanPermission } from "@memmy/local-api-contracts";
import type {
  OnboardingActivationEvent,
  OnboardingCompletedEvent,
  OnboardingStepCompletedEvent,
  OnboardingStepName
} from "./analytics-events.js";
import type { ProductTourTab } from "../app/product-tour.js";

export type OnboardingFlow = "deny" | "scan_only" | "full";

export type ProductTourOnboardingStep =
  | "product_tour_logs"
  | "product_tour_agents"
  | "product_tour_agents_scan"
  | "product_tour_overview"
  | "product_tour_tools";

/**
 * Historical step_index values — do not renumber existing ones.
 * Funnel / product order is NOT by these numbers (see 埋点文档.md).
 * Product tour sub-steps replace the former aggregate `product_tour` (index 4).
 */
export const ONBOARDING_STEP_INDEX = {
  scan_permission: 1,
  improvement_program: 2,
  first_report: 3,
  product_tour_logs: 4,
  product_tour_agents: 5,
  product_tour_agents_scan: 6,
  product_tour_overview: 7,
  product_tour_tools: 8,
  /** Chronologically last, but legacy index stays 0. */
  nickname: 0
} as const satisfies Record<OnboardingStepName, number>;

export function resolveOnboardingFlow(
  scanPermission: ScanPermission | undefined | null
): OnboardingFlow | undefined {
  if (scanPermission === "none") {
    return "deny";
  }
  if (scanPermission === "scan_only") {
    return "scan_only";
  }
  if (scanPermission === "scan_and_write_skill") {
    return "full";
  }
  return undefined;
}

export function resolveProductTourOnboardingStep(
  tab: ProductTourTab
): ProductTourOnboardingStep | null {
  switch (tab) {
    case "logs":
      return "product_tour_logs";
    case "agents":
      return "product_tour_agents";
    case "agentsScan":
      return "product_tour_agents_scan";
    case "overview":
      return "product_tour_overview";
    case "tools":
      return "product_tour_tools";
    default:
      return null;
  }
}

export interface OnboardingCommonParams {
  flow?: OnboardingFlow;
  scan_permission?: ScanPermission;
}

export function buildOnboardingCommonParams(
  scanPermission: ScanPermission | undefined | null
): OnboardingCommonParams {
  const flow = resolveOnboardingFlow(scanPermission);
  return {
    ...(flow ? { flow } : {}),
    ...(scanPermission && scanPermission !== "unset" ? { scan_permission: scanPermission } : {})
  };
}

export function buildOnboardingStepCompletedEvent(input: {
  step: OnboardingStepName;
  choice?: string;
  scanPermission?: ScanPermission | null;
  emptyHistory?: boolean;
}): OnboardingStepCompletedEvent {
  return {
    name: "onboarding_step_completed",
    params: {
      step: input.step,
      step_index: ONBOARDING_STEP_INDEX[input.step],
      ...(input.choice ? { choice: input.choice } : {}),
      ...buildOnboardingCommonParams(input.scanPermission),
      ...(input.emptyHistory !== undefined ? { empty_history: input.emptyHistory } : {})
    },
    consentTier: "basic"
  };
}

export function buildProductTourStepEvent(input: {
  tab: ProductTourTab;
  /** `viewed` on enter; `skipped` only when user taps skip on that step. No `completed`. */
  choice: "viewed" | "skipped";
  scanPermission?: ScanPermission | null;
}): OnboardingStepCompletedEvent | null {
  const step = resolveProductTourOnboardingStep(input.tab);
  if (!step) {
    return null;
  }
  return buildOnboardingStepCompletedEvent({
    step,
    choice: input.choice,
    scanPermission: input.scanPermission
  });
}

export function buildOnboardingCompletedEvent(
  scanPermission?: ScanPermission | null
): OnboardingCompletedEvent {
  return {
    name: "onboarding_completed",
    params: buildOnboardingCommonParams(scanPermission),
    consentTier: "basic"
  };
}

export function buildOnboardingActivationEvent(input: {
  name: OnboardingActivationEvent["name"];
  pagePath: string;
  scanPermission?: ScanPermission | null;
  action?: string;
  sourceId?: string;
  durationMs?: number;
}): OnboardingActivationEvent {
  return {
    name: input.name,
    params: {
      page_path: input.pagePath,
      ...buildOnboardingCommonParams(input.scanPermission),
      ...(input.action ? { action: input.action } : {}),
      ...(input.sourceId ? { source_id: input.sourceId } : {}),
      ...(input.durationMs !== undefined ? { duration_ms: input.durationMs } : {})
    },
    consentTier: "basic"
  };
}
