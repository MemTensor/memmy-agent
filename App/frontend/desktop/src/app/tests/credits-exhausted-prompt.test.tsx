// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { useCreditsExhaustedPrompt, requestCreditsExhaustedPrompt } from "../credits-exhausted-prompt.js";
import { I18nProvider } from "../../i18n/i18n-provider.js";
import { TokenExhaustedModal } from "../../pages/token-exhausted-modal.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>, host: HTMLDivElement;
let input = {enabled:true,userId:"a" as string | null,balance:"0.00" as string | undefined,preview:false,spendable:undefined as string | undefined};
function Harness() {
  const prompt = useCreditsExhaustedPrompt(input);
  return <I18nProvider language="zh-CN">{prompt.open && <TokenExhaustedModal creditsPreview onGoHandle={prompt.dismiss} onLater={prompt.dismiss}/>}</I18nProvider>;
}
async function render() { await act(async () => root.render(<Harness/>)); }
async function dismiss() { await act(async () => host.querySelector<HTMLButtonElement>(".token-exhausted-modal__button--later")!.click()); }
beforeEach(() => { host=document.createElement("div");document.body.append(host);root=createRoot(host);input={enabled:true,userId:"a",balance:"0.00",preview:false,spendable:undefined}; });
afterEach(() => { act(() => root.unmount()); host.remove(); });
it("does not open merely because settlement reaches zero; denied calls open and funding closes", async () => {
  input.balance="1.00"; await render();
  input.balance="0.00"; await render();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => requestCreditsExhaustedPrompt());
  expect(host.textContent).toContain("积分不足");
  await dismiss(); await render(); expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => requestCreditsExhaustedPrompt());
  input={...input,balance:"100.00",spendable:"0.00"}; await render();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  input.spendable="100.00"; await render();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
});
it("accepts fresh insufficient responses without a preview flag or a successful balance query", async () => {
  input.balance=undefined; await render(); expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => requestCreditsExhaustedPrompt()); expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  await dismiss(); await act(async () => requestCreditsExhaustedPrompt()); expect(host.querySelector('[role="dialog"]')).not.toBeNull();
});
it("does not treat a fully reserved account as exhausted, but still opens for an actual denied call", async () => {
  input.balance = "100.00"; input.spendable = "0.00"; await render();
  input.balance = "83.27"; await render();
  expect(host.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => requestCreditsExhaustedPrompt());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
  input.balance = "70.15"; await render();
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
});
it("does not carry a previous account's dialog into another account or BYOK/pet surfaces", async () => {
  await render(); await act(async () => requestCreditsExhaustedPrompt()); input={...input,userId:"b",balance:undefined}; await render(); expect(host.querySelector('[role="dialog"]')).toBeNull();
  input={...input,enabled:false,balance:"0.00"}; await render();
  await act(async () => requestCreditsExhaustedPrompt()); expect(host.querySelector('[role="dialog"]')).toBeNull();
});
