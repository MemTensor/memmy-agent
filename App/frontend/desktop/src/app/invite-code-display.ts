/**
 * Display-only invite code until the cloud account API returns a real one.
 * Stable for a given account identifier so review screenshots look consistent.
 */
export function resolveDisplayInviteCode(input: {
  email?: string;
  phoneNumber?: string | null;
}): string {
  const seed = (input.email?.trim() || input.phoneNumber?.trim() || "GUEST")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toUpperCase();
  const body = `${seed.slice(0, 4)}${seed.slice(-2)}XX`.slice(0, 6);
  return `MEMMY-${body}`;
}
