import os from "node:os";

const ELLIPSIS = "…";

function truncateEnd(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  if (maxLen <= 1) return ELLIPSIS.slice(0, maxLen);
  return value.slice(0, maxLen - 1) + ELLIPSIS;
}

function abbreviateUrl(value: string, maxLen: number): string {
  if (value.length <= maxLen) return value;
  const url = new URL(value);
  const domain = url.host;
  const segments = url.pathname.replace(/\/+$/, "").split("/");
  const basename = segments.at(-1) ?? "";
  if (!basename) return truncateEnd(value, maxLen);

  let budget = maxLen - domain.length - basename.length - 4;
  if (budget < 0) {
    const trunc = maxLen - domain.length - 5;
    return `${domain}/${ELLIPSIS}/${trunc > 0 ? basename.slice(0, trunc) : ""}`;
  }

  const kept: string[] = [];
  for (let i = segments.length - 2; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment.length + 1 <= budget) {
      kept.push(segment);
      budget -= segment.length + 1;
    } else {
      break;
    }
  }
  kept.reverse();
  return kept.length
    ? `${domain}/${ELLIPSIS}/${kept.join("/")}/${basename}`
    : `${domain}/${ELLIPSIS}/${basename}`;
}

export function abbreviatePath(value: string, maxLen = 40): string {
  if (!value) return value;
  if (/^https?:\/\//i.test(value)) {
    return abbreviateUrl(value, maxLen);
  }

  let normalized = value.replace(/\\/g, "/");
  const home = os.homedir().replace(/\\/g, "/");
  if (normalized.startsWith(`${home}/`)) normalized = `~${normalized.slice(home.length)}`;
  else if (normalized === home) normalized = "~";

  if (normalized.length <= maxLen) return normalized;

  const parts = normalized.replace(/\/+$/, "").split("/");
  if (parts.length <= 1) return truncateEnd(normalized, maxLen);

  const basename = parts.at(-1) ?? "";
  let budget = maxLen - basename.length - 3;
  const kept: string[] = [];
  for (let i = parts.length - 2; i >= 0; i -= 1) {
    const needed = parts[i].length + 1;
    if (needed <= budget) {
      kept.push(parts[i]);
      budget -= needed;
    } else {
      break;
    }
  }
  kept.reverse();
  return kept.length ? `${ELLIPSIS}/${kept.join("/")}/${basename}` : `${ELLIPSIS}/${basename}`;
}
