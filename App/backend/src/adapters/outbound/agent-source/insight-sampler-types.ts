/** Contract for onboarding insight sample options. */

export interface OnboardingInsightSampleOptions {
  maxSessionFiles: number;
  maxQueries: number;
  maxQueryChars: number;
  maxBytesPerFile: number;
  deadlineMs: number;
  signal?: AbortSignal;
}

export interface OnboardingSampledQuery {
  sourceId: string;
  conversationId: string;
  messageId: string;
  createdAt: string;
  text: string;
  workspacePath: string | null;
}

export interface OnboardingSampleResult {
  sourceId: string;
  displayName: string;
  recentSessionCount: number;
  latestActivityAt: string | null;
  queries: OnboardingSampledQuery[];
  errors: Array<{ target: string; reason: string }>;
}

export interface OnboardingInsightSampler {
  readonly sourceId: string;
  readonly displayName: string;
  detect(): Promise<boolean>;
  sampleRecentUserQueries(options: OnboardingInsightSampleOptions): Promise<OnboardingSampleResult>;
}

export function emptyOnboardingSampleResult(input: {
  sourceId: string;
  displayName: string;
  recentSessionCount?: number;
  latestActivityAt?: string | null;
  errors?: Array<{ target: string; reason: string }>;
}): OnboardingSampleResult {
  return {
    sourceId: input.sourceId,
    displayName: input.displayName,
    recentSessionCount: input.recentSessionCount ?? 0,
    latestActivityAt: input.latestActivityAt ?? null,
    queries: [],
    errors: input.errors ?? []
  };
}
