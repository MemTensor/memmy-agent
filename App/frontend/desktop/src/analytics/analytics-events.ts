export type AnalyticsConsentTier = "basic" | "improvement";

export interface PageViewEvent {
  name: "page_view";
  params: {
    page_title: string;
    page_location: string;
    page_referrer: string;
  };
  consentTier: "basic";
}

export interface FeatureEvent {
  name: string;
  params: {
    page_path: string;
    [key: string]: string | number | boolean;
  };
  consentTier: "basic";
}

export interface SignupCompletedEvent {
  name: "signup_completed";
  params: { method: "phone" | "email"; is_new_user: boolean };
  consentTier: "basic";
}

export interface ByokStartedEvent {
  name: "byok_started";
  params?: Record<string, string | number | boolean>;
  consentTier: "basic";
}

export interface ByokCompletedEvent {
  name: "byok_completed";
  params?: Record<string, string | number | boolean>;
  consentTier: "basic";
}

export interface OnboardingStepCompletedEvent {
  name: "onboarding_step_completed";
  params: {
    step: "nickname" | "scan_permission" | "improvement_program" | "mode_selection";
    step_index: number;
    choice?: string;
  };
  consentTier: "basic";
}

export interface OnboardingCompletedEvent {
  name: "onboarding_completed";
  params: Record<string, never>;
  consentTier: "basic";
}

export interface FirstEntryEvent {
  name: "first_entry";
  params: { page_location: string };
  consentTier: "basic";
}

export interface TokenUsageSnapshotEvent {
  name: "token_usage_snapshot";
  params: {
    plan_name: string;
    total_tokens: number;
    used_tokens: number;
    remaining_tokens: number;
    usage_pct: number;
  };
  consentTier: "basic";
}

export interface ImprovementLogEvent {
  name: "improvement_log";
  params: Record<string, string | number | boolean>;
  consentTier: "improvement";
}

export type AnalyticsEvent =
  | PageViewEvent
  | FeatureEvent
  | FirstEntryEvent
  | SignupCompletedEvent
  | ByokStartedEvent
  | ByokCompletedEvent
  | OnboardingStepCompletedEvent
  | OnboardingCompletedEvent
  | TokenUsageSnapshotEvent
  | ImprovementLogEvent;
