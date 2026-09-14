export type RootTerminalOptions = {
  sessionId?: string;
  standalone?: boolean;
  project?: string;
};

export function parseRootTerminalOptions(argv: string[]): RootTerminalOptions | null {
  if (argv.length <= 2) return {};

  const args = argv.slice(2);
  const options: RootTerminalOptions = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--standalone") {
      options.standalone = true;
    } else if (arg === "--session" || arg === "-s") {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error("--session requires a sessionId");
      options.sessionId = value;
    } else if (arg === "--project") {
      const value = args[++index];
      if (!value || value.startsWith("-")) throw new Error("--project requires a path");
      options.project = value;
    } else {
      return null;
    }
  }

  const selected = Number(Boolean(options.sessionId))
    + Number(Boolean(options.standalone))
    + Number(Boolean(options.project));
  if (selected > 1) {
    throw new Error("--session, --standalone, and --project are mutually exclusive");
  }
  return options;
}
