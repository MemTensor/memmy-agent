export function formatTokenGiftAmount(totalTokens: number | undefined): string {
  if (totalTokens === undefined || !Number.isFinite(totalTokens) || totalTokens <= 0) {
    return "—";
  }

  return Math.trunc(totalTokens).toLocaleString("en-US");
}
