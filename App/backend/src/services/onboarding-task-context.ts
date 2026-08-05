export type OnboardingTaskStatus = "pending" | "active" | "waiting" | "completed" | "uncertain";

export interface OnboardingTaskContextSummary {
  topic: string;
  userGoal: string;
  latestRequest: string;
  status: OnboardingTaskStatus;
  currentState: string;
  agentActions: string[];
  verifiedResults: string[];
  unresolvedItems: string[];
  continuationPoint: string;
  trajectorySummary: string;
}
