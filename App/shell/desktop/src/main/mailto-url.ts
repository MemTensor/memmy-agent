export function normalizeMailtoUrl(rawUrl: string): string {
  const url = rawUrl.trim();

  if (!url) {
    throw new Error("rejected empty mailto url");
  }
  if (/[\r\n]/u.test(url)) {
    throw new Error("rejected mailto url with control characters");
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("rejected invalid mailto url");
  }

  if (parsed.protocol.toLowerCase() !== "mailto:") {
    throw new Error("rejected non-mailto url");
  }

  return url;
}
