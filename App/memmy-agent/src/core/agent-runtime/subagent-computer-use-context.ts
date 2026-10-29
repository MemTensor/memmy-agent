import { RequestContext } from './tools/context.js';

// Keep the accepted user's approval identity out of model-visible spawn args.
// Copied metadata or a serialized object cannot create this host-only grant.
export type SubagentComputerUseAuthorization = Readonly<object>;
const delegatedContexts = new WeakMap<object, RequestContext>();

export function delegateSubagentComputerUse(context: RequestContext | null): SubagentComputerUseAuthorization | null {
  if (!(context instanceof RequestContext) || !context.messageId || !context.sessionKey
    || !context.channel || !context.chatId || context.metadata.computerUseInteractive !== true
    || context.metadata.computerUseInteractiveReason !== 'interactive-user-message') return null;
  const grant = Object.freeze({});
  delegatedContexts.set(grant, new RequestContext({ ...context,
    metadata: structuredClone(context.metadata) }));
  return grant;
}

export function resolveSubagentComputerUseAuthorization(grant?: SubagentComputerUseAuthorization | null): RequestContext | null {
  return grant ? delegatedContexts.get(grant) ?? null : null;
}
