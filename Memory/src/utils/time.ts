export function nowIso(): string {
  return new Date().toISOString();
}

const NAIVE_ISO_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
const UTC_OFFSET = /^(?:(?:UTC|GMT)\s*)?([+-])(\d{1,2})(?::?(\d{2}))?$/i;

/** Returns the host's current fixed UTC offset. */
export function systemTimeZone(): string {
  return offsetFromMinutes(-new Date().getTimezoneOffset());
}

/** Normalizes fixed offsets and converts legacy IANA zones to their current offset. */
export function resolveTimeZone(value?: string | null): string {
  const timeZone = value?.trim();
  if (!timeZone) return systemTimeZone();
  const fixed = parseOffsetMinutes(timeZone);
  if (fixed !== null) return offsetFromMinutes(fixed);
  try {
    const offsetName = new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "longOffset"
    }).formatToParts(new Date()).find((part) => part.type === "timeZoneName")?.value ?? "";
    const offset = parseOffsetMinutes(offsetName);
    if (offset !== null) return offsetFromMinutes(offset);
  } catch {
    // Handled below.
  }
  throw new Error(`invalid timezone: ${timeZone}`);
}

/** Formats an instant using a fixed UTC offset. */
export function formatZonedTime(value: string | number | Date, timeZone?: string | null): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const offset = resolveTimeZone(timeZone);
  const shifted = shiftedDate(date, offset);
  return `${dateParts(shifted)} UTC${offset}`;
}

/** Returns the calendar date for an instant at the requested fixed offset. */
export function zonedDateKey(value: string | number | Date, timeZone?: string | null): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return dateParts(shiftedDate(date, resolveTimeZone(timeZone))).slice(0, 10);
}

/** Parses an ISO timestamp, interpreting offset-less values in the user timezone. */
export function isoTimeToUtc(value: string, timeZone?: string | null): string {
  const trimmed = value.trim();
  const naive = NAIVE_ISO_TIME.exec(trimmed);
  if (!naive) {
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) throw new Error("invalid ISO timestamp");
    return parsed.toISOString();
  }

  const fields = naive.slice(1).map((part) => Number(part ?? 0));
  const [year, month, day, hour, minute, second] = fields;
  const millis = Number(String(naive[7] ?? "").padEnd(3, "0") || 0);
  const localAsUtc = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!, millis);
  const offset = parseOffsetMinutes(resolveTimeZone(timeZone)) ?? 0;
  return new Date(localAsUtc - offset * 60_000).toISOString();
}

function parseOffsetMinutes(value: string): number | null {
  if (/^(?:UTC|GMT|Z)$/i.test(value.trim())) return 0;
  const match = UTC_OFFSET.exec(value.trim());
  if (!match) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3] ?? 0);
  if (hours > 14 || minutes > 59 || (hours === 14 && minutes !== 0)) return null;
  return (match[1] === "-" ? -1 : 1) * (hours * 60 + minutes);
}

function offsetFromMinutes(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, "0")}:${String(absolute % 60).padStart(2, "0")}`;
}

function shiftedDate(date: Date, offset: string): Date {
  return new Date(date.getTime() + (parseOffsetMinutes(offset) ?? 0) * 60_000);
}

function dateParts(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}
