const redirected = new Map<string, string | null>();

export class LoguruBridge {
  libName: string;
  level: string | null;
  constructor(libName: string, level: string | null = null) {
    this.libName = libName;
    this.level = level;
  }
}

export function redirectLibLogging(name: string, level: string | null = null): LoguruBridge {
  redirected.set(name, level);
  return new LoguruBridge(name, level);
}

export function installLoggingBridge(name = "root", level: string | null = null): LoguruBridge {
  return redirectLibLogging(name, level);
}

export function redirectedLoggers(): Record<string, string | null> {
  return Object.fromEntries(redirected);
}
