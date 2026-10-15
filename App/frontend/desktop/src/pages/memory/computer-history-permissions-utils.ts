/** Domain rules cover the host and subdomains; paths/ports never narrow a rule. */
export function normalizeWebsite(input: string): string | null {
  const value = input.trim();
  if (!value || /\s|\*/u.test(value)) return null;
  try {
    const url = new URL(value.includes("://") ? value : `https://${value}`);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
    const domain = url.hostname.toLowerCase().replace(/\.$/u, "");
    return domain.length <= 253 && domain.split(".").every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(label)) ? domain : null;
  } catch { return null; }
}
