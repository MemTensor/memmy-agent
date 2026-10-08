import type { RequestContext } from '../../core/agent-runtime/tools/context.js';

type SnapshotText = {
  appHeader: string;
  windowHeader: string;
  lines: Map<number, string>;
  footer: string | null;
};

type Baseline = {
  selector: string;
  snapshot: SnapshotText;
  windowId: number;
  revision: number;
  generation: number;
};

const MAX_STATE_CHARS = 1_000_000;
const MAX_BASELINES = 32;
const ACTIONS = new Set(['click', 'drag', 'perform_secondary_action', 'press_key', 'scroll', 'set_value', 'type_text']);

function scopeKey(context: RequestContext | null): string | null {
  if (!context || context.metadata.computerUseInteractive === false) return null;
  const messageId = context.messageId ?? context.metadata.message_id ?? context.metadata.messageId
    ?? context.metadata.turnId ?? context.metadata.turn_id;
  if (!context.sessionKey || !context.channel || !context.chatId || !messageId
    || ['system', 'cron'].includes(context.channel)) return null;
  return JSON.stringify([context.sessionKey, context.channel, context.chatId, messageId]);
}

function parseSnapshot(text: string): SnapshotText | null {
  if (!text || text.length > MAX_STATE_CHARS) return null;
  const lines = text.split('\n');
  if (!/^App=.+ \(pid [1-9]\d*\)$/.test(lines[0] ?? '') || !/^Window: .+, App: .+\.$/.test(lines[1] ?? '')) return null;
  const tree = new Map<number, string>();
  let offset = 2;
  for (; offset < lines.length && lines[offset] !== ''; offset++) {
    const match = /^[\t ]*(0|[1-9]\d*)\s/.exec(lines[offset]);
    if (!match || Number(match[1]) !== tree.size) return null;
    tree.set(tree.size, lines[offset]);
  }
  if (!tree.size) return null;
  let footer: string | null = null;
  if (offset < lines.length) {
    if (lines.length !== offset + 2 || !/^(?:Selected text: \[.*\]|The focused UI element is .+\.)$/.test(lines[offset + 1])) return null;
    footer = lines[offset + 1];
  }
  return { appHeader: lines[0], windowHeader: lines[1], lines: tree, footer };
}

function currentWindowId(result: any): number | null {
  const value = result?._meta?.memmyComputerUse?.targetWindowID;
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function firstText(output: any): string | null {
  const block = Array.isArray(output) ? output[0] : null;
  return block?.type === 'text' && typeof block.text === 'string' ? block.text : null;
}

function hasDeliveredImage(output: any): boolean {
  return Array.isArray(output) && output.some((block: any) => block?.type === 'image_url');
}

function patchText(before: SnapshotText, after: SnapshotText, fullLength: number): string | null {
  const changes: string[] = [];
  for (let index = 0; index < Math.max(before.lines.size, after.lines.size); index++) {
    const oldLine = before.lines.get(index);
    const newLine = after.lines.get(index);
    if (oldLine === newLine) continue;
    if (oldLine !== undefined) changes.push(`- ${oldLine}`);
    if (newLine !== undefined) changes.push(`+ ${newLine}`);
  }
  const patch = [after.appHeader, after.windowHeader,
    'AX tree changes since the previous model-visible state (apply by element index):',
    ...(changes.length ? changes : ['No AX tree line changes.']),
    ...(after.footer ? ['', after.footer] : []),
  ].join('\n');
  return patch.length + 120 < fullLength && patch.length < fullLength * 0.75 ? patch : null;
}

/** Compacts only text shown to the model. Native snapshots and element maps stay complete. */
export class NativeAxDiffPresenter {
  private readonly baselines = new Map<string, Baseline>();

  present(name: string, args: Record<string, any>, result: any, output: any, context: RequestContext | null,
    revision: number | null, currentRevision: number, generation: number): any {
    const scope = scopeKey(context);
    if (!scope || (name !== 'get_app_state' && !ACTIONS.has(name))) return output;
    const selector = typeof args.app === 'string' ? args.app.trim().toLowerCase() : '';
    const text = firstText(output);
    const snapshot = result?.isError !== true && text !== null ? parseSnapshot(text) : null;
    const windowId = currentWindowId(result);
    // The runner may replace long text-only output with a short file preview.
    // Require an image that survived conversion so this text reaches the model intact.
    if (!selector || !snapshot || !hasDeliveredImage(output) || windowId === null || revision === null || revision !== currentRevision) {
      this.baselines.delete(scope);
      return output;
    }

    const previous = this.baselines.get(scope);
    const next: Baseline = { selector, snapshot, windowId, revision, generation };
    this.baselines.delete(scope);
    this.baselines.set(scope, next);
    if (this.baselines.size > MAX_BASELINES) this.baselines.delete(this.baselines.keys().next().value!);
    if (name === 'get_app_state' || !previous || previous.revision !== revision - 1
      || previous.generation !== generation || previous.selector !== selector
      || previous.windowId !== windowId || previous.snapshot.appHeader !== snapshot.appHeader
      || previous.snapshot.windowHeader !== snapshot.windowHeader) return output;

    const patch = patchText(previous.snapshot, snapshot, text!.length);
    if (!patch) return output;
    return [{ ...output[0], text: patch }, ...output.slice(1)];
  }

  clear(): void { this.baselines.clear(); }
}
