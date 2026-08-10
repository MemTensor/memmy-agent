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
  name:
    | "account_logout"
    | "agent_media_attached"
    | "agent_restart_requested"
    | "agent_send_message"
    | "agent_stop_generation"
    | "byok_exit_to_register"
    | "model_config_saved"
    | "model_connection_tested"
    | "model_mode_switched"
    | "send_verification_code"
    | "task_archived"
    | "task_deleted"
    | "task_opened"
    | "task_pinned"
    | "task_renamed";
  params: {
    page_path: string;
    [key: string]: string | number | boolean;
  };
  consentTier: "basic";
}

export interface SignupCompletedEvent {
  name: "signup_completed";
  params: {
    method: "phone" | "email";
    is_new_user: boolean;
    user_mode: "account";
    invite_code_provided: boolean;
  };
  consentTier: "basic";
}

export interface InviteResultToastEvent {
  name: "invite_result_toast";
  params: {
    result: "success" | "invalid" | "not_new_user";
  };
  consentTier: "basic";
}

export interface InviteCodeCopiedEvent {
  name: "invite_code_copied";
  params: {
    page_path: "/settings";
  };
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

export type OnboardingFlow = "deny" | "scan_only" | "full";

export type OnboardingStepName =
  | "nickname"
  | "scan_permission"
  | "first_report"
  | "improvement_program"
  | "product_tour_logs"
  | "product_tour_agents"
  | "product_tour_agents_scan"
  | "product_tour_overview"
  | "product_tour_tools";

export interface OnboardingStepCompletedEvent {
  name: "onboarding_step_completed";
  params: {
    step: OnboardingStepName;
    step_index: number;
    choice?: string;
    /** deny | scan_only | full — maps scan_permission for funnel branching */
    flow?: OnboardingFlow;
    scan_permission?: string;
    /** Present when step=first_report */
    empty_history?: boolean;
  };
  consentTier: "basic";
}

export interface OnboardingCompletedEvent {
  name: "onboarding_completed";
  params: {
    flow?: OnboardingFlow;
    scan_permission?: string;
  };
  consentTier: "basic";
}

export interface OnboardingActivationEvent {
  name:
    | "onboarding_first_task_completed"
    | "onboarding_relay_clicked"
    | "onboarding_external_memory_verified";
  params: {
    page_path: string;
    action?: string;
    source_id?: string;
    duration_ms?: number;
    flow?: OnboardingFlow;
    scan_permission?: string;
  };
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

export interface MemoryUiEventParams {
  page_path: string;
  sub_page: string;
  filter_layer: string;
  result_count?: number;
  source_id?: string;
  scan_mode?: string;
  duration_ms?: number;
}

export interface MemoryUiSearchSubmittedEvent {
  name: "memory_ui_search_submitted";
  params: MemoryUiEventParams & { result_count: number };
  consentTier: "basic";
}

export interface MemoryUiDetailOpenedEvent {
  name: "memory_detail_opened";
  params: MemoryUiEventParams;
  consentTier: "basic";
}

export interface MemoryUiDeletedEvent {
  name: "memory_deleted";
  params: MemoryUiEventParams;
  consentTier: "basic";
}

export interface MemoryUiPanelRefreshedEvent {
  name: "memory_panel_refreshed";
  params: MemoryUiEventParams & { result_count: number };
  consentTier: "basic";
}

export interface MemoryUiSourceScanStartedEvent {
  name: "memory_source_scan_started";
  params: MemoryUiEventParams & { source_id: string; scan_mode: string };
  consentTier: "basic";
}

export interface MemoryUiSourceScanCompletedEvent {
  name: "memory_source_scan_completed";
  params: MemoryUiEventParams & { source_id: string; scan_mode: string; duration_ms?: number };
  consentTier: "basic";
}

export interface MemoryUiSourceScanFailedEvent {
  name: "memory_source_scan_failed";
  params: MemoryUiEventParams & { source_id: string; scan_mode: string; duration_ms?: number };
  consentTier: "basic";
}

export type MemoryUiAnalyticsEvent =
  | MemoryUiSearchSubmittedEvent
  | MemoryUiDetailOpenedEvent
  | MemoryUiDeletedEvent
  | MemoryUiPanelRefreshedEvent
  | MemoryUiSourceScanStartedEvent
  | MemoryUiSourceScanCompletedEvent
  | MemoryUiSourceScanFailedEvent;

export type AnalyticsEvent =
  | PageViewEvent
  | FeatureEvent
  | FirstEntryEvent
  | SignupCompletedEvent
  | InviteResultToastEvent
  | InviteCodeCopiedEvent
  | ByokStartedEvent
  | ByokCompletedEvent
  | OnboardingStepCompletedEvent
  | OnboardingCompletedEvent
  | OnboardingActivationEvent
  | TokenUsageSnapshotEvent
  | ImprovementLogEvent
  | MemoryUiAnalyticsEvent;
