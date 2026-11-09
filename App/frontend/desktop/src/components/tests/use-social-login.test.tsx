// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useSocialLogin, type UseSocialLoginResult } from "../use-social-login.js";

const mocks = vi.hoisted(() => ({ start: vi.fn(), status: vi.fn(), open: vi.fn() }));
vi.mock("../../app/providers.js", () => ({ useApiClients: () => ({ clients: { account: {
  startSocialLogin: mocks.start, getSocialLoginStatus: mocks.status
} } }) }));
vi.mock("../../utils/open-url.js", () => ({ openExternalUrl: mocks.open }));
vi.mock("../../i18n/use-translation.js", () => ({ useTranslation: () => ({ language: "en-US", t: (key: string) => key }) }));

let root: Root;
let auth: UseSocialLoginResult;
function Harness() { auth = useSocialLogin(); return null; }
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

it("does not start polling after cancellation while the browser opens", async () => {
  let resolve!: () => void;
  mocks.open.mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  let attempt!: ReturnType<UseSocialLoginResult["start"]>;
  await act(async () => { attempt = auth.start("github"); });
  await act(async () => { auth.reset(); resolve(); });
  expect(await attempt).toBeNull();
  expect(auth.feedback).toBeNull();
  expect(mocks.status).not.toHaveBeenCalled();
});
