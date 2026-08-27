const UTC_OFFSET = /^(?:(?:UTC|GMT)\s*)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;

/** Returns the host's current fixed UTC offset. */
export function systemUtcOffset(): string {
  return formatOffset(-new Date().getTimezoneOffset());
}

/** Normalizes fixed offsets and converts legacy IANA zones to their current offset. */
export function normalizeTimeZoneOffset(value?: string | null): string {
  const timeZone = value?.trim();
  if (!timeZone) return systemUtcOffset();
  const fixed = parseOffset(timeZone);
  if (fixed !== null) return formatOffset(fixed);
  try {
    const offsetName = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset",
    }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? "";
    const offset = parseOffset(offsetName);
    if (offset !== null) return formatOffset(offset);
  } catch {
    // Invalid values are rejected below.
  }
  throw new Error(`invalid timezone: ${timeZone}`);
}

function parseOffset(value: string): number | null {
  if (/^(?:UTC|GMT|Z)$/i.test(value.trim())) return 0;
  const match = UTC_OFFSET.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}
