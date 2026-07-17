/**
 * Runtime log-level gate: filter console output according to MEMMY_LOG_LEVEL.
 * Used only in gateway daemon mode so the desktop "log level" setting affects
 * Agent Gateway.
 */

/** Valid log levels. */
export type LogLevel = "error" | "warn" | "info" | "debug";

/** Log-level verbosity order: larger numbers are more verbose. */
const ORDER: Record<LogLevel, number> = { error: 0, warn: 1, info: 2, debug: 3 };

/** Valid level set. */
const LEVELS: readonly LogLevel[] = ["error", "warn", "info", "debug"];

/** Console methods controlled by the level gate. */
export interface ConsoleMethods {
  error: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
}

/**
 * Parse any input into a valid level, falling back to info for invalid values.
 *
 * @param value Any input, usually process.env.MEMMY_LOG_LEVEL.
 * @returns Valid log level.
 */
export function parseLogLevel(value: unknown): LogLevel {
  return LEVELS.includes(value as LogLevel) ? (value as LogLevel) : "info";
}

/**
 * Select console methods by level: replace methods more verbose than the
 * threshold with no-op functions and pass the rest through.
 *
 * @param level Target level.
 * @param base Base console method set, defaulting to the global console.
 * @returns Filtered method set.
 */
export function selectConsoleMethods(
  level: LogLevel,
  base: ConsoleMethods = console,
): ConsoleMethods {
  const threshold = ORDER[level];
  const noop = (): void => {};
  return {
    error: base.error,
    warn: ORDER.warn > threshold ? noop : base.warn,
    info: ORDER.info > threshold ? noop : base.info,
    log: ORDER.info > threshold ? noop : base.log,
    debug: ORDER.debug > threshold ? noop : base.debug,
  };
}

/**
 * Read MEMMY_LOG_LEVEL and install the level gate on the global console.
 *
 * @param level Target level, defaulting to process.env.MEMMY_LOG_LEVEL.
 */
export function installConsoleLevelGate(
  level: LogLevel = parseLogLevel(process.env.MEMMY_LOG_LEVEL),
): void {
  Object.assign(console, selectConsoleMethods(level));
}
