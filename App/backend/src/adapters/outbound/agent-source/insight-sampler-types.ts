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

export interface OnboardingSampledMessage extends OnboardingSampledQuery {
  role: "user" | "assistant" | "tool";
}

export interface OnboardingConversationReference {
  sourceId: string;
  displayName: string;
  conversationId: string;
  latestActivityAt: string;
  workspacePath: string | null;
}

export interface OnboardingConversationWindow extends OnboardingConversationReference {
  messages: OnboardingSampledMessage[];
}

export interface OnboardingSampleResult {
  sourceId: string;
  displayName: string;
  recentSessionCount: number;
  latestActivityAt: string | null;
  queries: OnboardingSampledQuery[];
  /** Recent visible messages used only to identify the newest conversation. */
  recentMessages?: OnboardingSampledMessage[];
  errors: Array<{ target: string; reason: string }>;
}

export interface OnboardingInsightSampler {
  readonly sourceId: string;
  readonly displayName: string;
  detect(): Promise<boolean>;
  sampleRecentUserQueries(options: OnboardingInsightSampleOptions): Promise<OnboardingSampleResult>;
}

export interface OnboardingConversationWindowReader {
  readConversation(
    reference: OnboardingConversationReference,
    options: Pick<OnboardingInsightSampleOptions, "maxQueryChars" | "deadlineMs" | "signal">
  ): Promise<OnboardingConversationWindow | null>;
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
