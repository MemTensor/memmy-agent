/**
 * 立即取一次协助收件箱。
 *
 * 收件箱平时每 5 秒轮询一次；新手引导在开启「接收协助请求」之后要马上看到小饭团发来的请求，
 * 所以宿主把 {@link registerAssistInboxRefresh} 注册进来，引导按需触发一次，不等下一轮。
 */
let refresh: (() => void) | null = null;

export function registerAssistInboxRefresh(fn: (() => void) | null): void {
  refresh = fn;
}

export function requestAssistInboxRefresh(): void {
  refresh?.();
}
