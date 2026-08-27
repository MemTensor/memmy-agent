/** Quota feedback module. */

export const FEEDBACK_MIN_LENGTH = 20;

export function feedbackLength(text: string): number {
  return text.trim().length;
}

export function canSubmitFeedback(text: string): boolean {
  return feedbackLength(text) >= FEEDBACK_MIN_LENGTH;
}
