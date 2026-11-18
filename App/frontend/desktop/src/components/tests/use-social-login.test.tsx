// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSocialLogin, type UseSocialLoginResult } from "../use-social-login.js";
import { SocialLoginButtons } from "../social-login-buttons.js";

const mocks = vi.hoisted(() => ({ start: vi.fn(), status: vi.fn(), open: vi.fn() }));
vi.mock("../../app/providers.js", () => ({ useApiClients: () => ({ clients: { account: {
  startSocialLogin: mocks.start, getSocialLoginStatus: mocks.status
} } }) }));
vi.mock("../../utils/open-url.js", () => ({ openExternalUrl: mocks.open }));
vi.mock("../../i18n/use-translation.js", () => ({ useTranslation: () => ({ language: "en-US", t: (key: string) => key }) }));

let root: Root;
let auth: UseSocialLoginResult;
function Harness() {
  auth = useSocialLogin();
  return <SocialLoginButtons pendingProvider={auth.pendingProvider} waitingForAuthorization={auth.waitingForAuthorization}
    feedback={auth.feedback} onLogin={provider => { void auth.start(provider); }} onCancel={auth.reset} />;
}
beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetAllMocks();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.start.mockResolvedValue({ flowId: "flow", pollToken: "poll", authorizationUrl: "https://accounts.google.com/", expiresInSec: 60, pollIntervalSec: 1 });
  mocks.open.mockResolvedValue(undefined);
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(<Harness />); });
});
afterEach(async () => {
  await act(async () => root.unmount());
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["google", "github"] as const)("preserves invitation and completes %s login", async provider => {
  const result = { authenticated: true };
  mocks.status.mockResolvedValue({ status: "completed", result });
  let attempt!: ReturnType<UseSocialLoginResult["start"]>;
  await act(async () => { attempt = auth.start(provider, " MEMMY-A1B2C3 "); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(await attempt).toEqual(result);
  expect(mocks.start).toHaveBeenCalledWith({ provider, locale: "en", loginSource: "Memmy", invitationCode: "MEMMY-A1B2C3" });
  expect(auth.pendingProvider).toBeNull();
});

it("ignores a completed poll after the user cancels", async () => {
  let resolve!: (value: unknown) => void;
  mocks.status.mockImplementation(() => new Promise(done => { resolve = done; }));
  let attempt!: ReturnType<UseSocialLoginResult["start"]>;
  await act(async () => { attempt = auth.start("google"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(mocks.status).toHaveBeenCalledOnce();
  await act(async () => { auth.reset(); });
  await act(async () => { resolve({ status: "completed", result: { authenticated: true } }); });
  expect(await attempt).toBeNull();
  expect(auth.feedback).toBeNull();
});

it("polls with state until completion and stops on expiry", async () => {
  mocks.start.mockResolvedValue({ state: "desktop-state", authorizationUrl: "https://accounts.google.com/", expiresInSec: 60, pollIntervalSec: 1 });
  mocks.status.mockResolvedValueOnce({ status: "pending" }).mockResolvedValueOnce({ status: "completed", result: { authenticated: true } });
  let attempt!: ReturnType<UseSocialLoginResult["start"]>;
  await act(async () => { attempt = auth.start("google"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(await attempt).toEqual({ authenticated: true });
  expect(mocks.status.mock.calls).toEqual([[{ state: "desktop-state" }], [{ state: "desktop-state" }]]);
  mocks.status.mockResolvedValue({ status: "expired" });
  await act(async () => { attempt = auth.start("google"); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(await attempt).toBeNull();
  expect(auth.feedback?.text).toBe("login.social.expired");
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(mocks.status).toHaveBeenCalledTimes(3);
});

it("does not start polling after cancellation while the browser opens", async () => {
  let resolve!: () => void;
  mocks.open.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  let attempt!: ReturnType<UseSocialLoginResult["start"]>;
  await act(async () => { attempt = auth.start("github"); });
  expect(auth.waitingForAuthorization).toBe(false);
  expect(document.body.textContent).toContain("login.social.opening");
  await act(async () => { auth.reset(); resolve(); });
  expect(await attempt).toBeNull();
  expect(auth.feedback).toBeNull();
  expect(mocks.status).not.toHaveBeenCalled();
});

it("lets the user cancel waiting and retry without a late poll changing the new attempt", async () => {
  let completeOldPoll!: (value: unknown) => void;
  mocks.status.mockImplementationOnce(() => new Promise(done => { completeOldPoll = done; }))
    .mockResolvedValue({ status: "pending" });
  let oldAttempt!: ReturnType<UseSocialLoginResult["start"]>;
  await act(async () => { oldAttempt = auth.start("google"); });
  expect(auth.waitingForAuthorization).toBe(true);
  expect(document.body.textContent).toContain("login.social.authorizing");
  expect(document.body.textContent).not.toContain("login.social.opening");
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  const cancel = [...document.querySelectorAll("button")].find(button => button.textContent === "login.social.cancelWaiting")!;
  expect(cancel.disabled).toBe(false);
  await act(async () => { cancel.click(); });
  expect(auth.pendingProvider).toBeNull();
  expect(auth.waitingForAuthorization).toBe(false);
  expect(auth.feedback).toBeNull();
  expect([...document.querySelectorAll("button")].every(button => !button.disabled)).toBe(true);
  let retry!: ReturnType<UseSocialLoginResult["start"]>;
  await act(async () => { retry = auth.start("github"); });
  await act(async () => { completeOldPoll({ status: "completed", result: { authenticated: true } }); });
  expect(await oldAttempt).toBeNull();
  expect(auth.pendingProvider).toBe("github");
  expect(auth.waitingForAuthorization).toBe(true);
  await act(async () => { auth.reset(); await vi.advanceTimersByTimeAsync(5000); });
  expect(await retry).toBeNull();
  expect(mocks.status).toHaveBeenCalledOnce();
});

it("unlocks login when authorization expires without a callback", async () => {
  mocks.start.mockResolvedValue({ state: "expiring-state", authorizationUrl: "https://accounts.google.com/", expiresInSec: 2, pollIntervalSec: 1 });
  mocks.status.mockResolvedValue({ status: "pending" });
  let attempt!: ReturnType<UseSocialLoginResult["start"]>;
  await act(async () => { attempt = auth.start("google"); await vi.advanceTimersByTimeAsync(2000); });
  expect(await attempt).toBeNull();
  expect(auth.pendingProvider).toBeNull();
  expect(auth.waitingForAuthorization).toBe(false);
  expect(auth.feedback?.text).toBe("login.social.expired");
});
