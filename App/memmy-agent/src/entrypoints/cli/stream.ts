function makeConsole(): any {
  return {
    file: process.stdout,
    forceTerminal: Boolean(process.stdout.isTTY),
    status: (status: string) => {
      let active = false;
      return {
        status,
        start() {
          if (active) return;
          active = true;
          process.stdout.write(status);
          if (!isTtyFile(process.stdout)) process.stdout.write("\n");
        },
        stop() {
          active = false;
        },
      };
    },
    print(...args: any[]) {
      process.stdout.write(`${args.join(" ")}\n`);
    },
  };
}

export { makeConsole };

function isTtyFile(file: any): boolean {
  if (typeof file?.isatty === "function") return Boolean(file.isatty());
  return Boolean(file?.isTTY);
}

function clearStatusLine(file: any): void {
  if (isTtyFile(file)) file.write("\r\x1b[2K");
}

export class ThinkingSpinner {
  console: any;
  spinner: any;
  active = false;
  constructor({ console: consoleArg, botName }: { console?: any; botName?: string } = {}) {
    this.console = consoleArg ?? makeConsole();
    const name = botName ?? "memmy";
    this.spinner = this.console.status(`${name} is thinking...`);
  }

  start(): void {
    if (this.active) return;
    this.active = true;
    this.spinner.start();
  }

  stop(): void {
    if (!this.active) return;
    clearStatusLine(this.console.file);
    this.active = false;
    this.spinner.stop();
  }

  pause(): { [Symbol.dispose]: () => void } {
    const wasActive = this.active;
    if (wasActive) this.stop();
    return {
      [Symbol.dispose]: () => {
        if (wasActive) this.start();
      },
    };
  }
}

export class StreamRenderer {
  console: any;
  chunks: string[] = [];
  botName: string;
  botIcon: string;
  headerPrinted = false;
  live: any = null;
  buffer = "";
  thinking: ThinkingSpinner | null = null;
  renderMarkdown: boolean;
  private renderedChars = 0;
  private needsLineBreak = false;

  constructor({
    showSpinner,
    botName,
    botIcon,
    renderMarkdown,
    console: consoleArg,
  }: {
    showSpinner?: boolean;
    botName?: string;
    botIcon?: string;
    renderMarkdown?: boolean;
    console?: any;
  } = {}) {
    this.console = consoleArg ?? makeConsole();
    this.botName = botName ?? "memmy";
    this.botIcon = botIcon ?? "🍚";
    this.renderMarkdown = renderMarkdown ?? true;
    if (showSpinner ?? true) {
      this.thinking = new ThinkingSpinner({ console: this.console, botName: this.botName });
      this.thinking.start();
    }
  }

  write(chunk: string): void {
    if (!chunk) return;
    this.chunks.push(chunk);
    this.buffer += chunk;
    this.ensureHeader();
    this.writeOutput(chunk);
    this.renderedChars += chunk.length;
    this.needsLineBreak = !chunk.endsWith("\n");
  }

  private writeOutput(text: string): void {
    const file = this.console?.file;
    if (typeof file?.write === "function") file.write(text);
    else process.stdout.write(text);
    (file as any)?.flush?.();
    (process.stdout as any).flush?.();
  }

  text(): string {
    return this.chunks.join("");
  }

  pauseSpinner(): { [Symbol.dispose]: () => void } {
    return this.thinking?.pause() ?? { [Symbol.dispose]: () => undefined };
  }

  ensureHeader(): void {
    if (this.thinking) this.thinking.stop();
    if (!this.headerPrinted) {
      const header = this.botIcon ? `${this.botIcon} ${this.botName}` : this.botName;
      this.console.print(header);
      this.headerPrinted = true;
    }
  }

  ensureLineBreak(): void {
    if (!this.needsLineBreak) return;
    this.writeOutput("\n");
    this.needsLineBreak = false;
  }

  stopForInput(): void {
    if (this.thinking) this.thinking.stop();
  }

  async close(): Promise<void> {
    if (this.live?.stop) this.live.stop();
    this.live = null;
    if (this.thinking) this.thinking.stop();
    this.ensureLineBreak();
  }

  async onEnd({ resuming = false }: { resuming?: boolean } = {}): Promise<void> {
    if (this.live?.stop) this.live.stop();
    this.live = null;
    if (this.thinking) this.thinking.stop();
    if (!resuming) {
      const pending = this.buffer.slice(this.renderedChars);
      if (pending) {
        this.ensureHeader();
        this.writeOutput(pending);
        this.renderedChars += pending.length;
        this.needsLineBreak = !pending.endsWith("\n");
      }
      this.ensureLineBreak();
    } else if (this.renderedChars > 0) {
      this.ensureLineBreak();
      if (this.thinking) this.thinking.start();
    } else if (this.thinking) {
      this.thinking.start();
    }
    this.buffer = "";
    this.renderedChars = 0;
  }
}
