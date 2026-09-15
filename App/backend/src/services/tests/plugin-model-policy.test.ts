import { describe, expect, it, vi } from "vitest";
import { resolvePluginModelSelection } from "../plugin-model-policy.js";

const ACCOUNT_PRESET = {
  ok: true as const,
  selection: { provider: "memmy", model: "memmy-agent", endpointId: "cloud" },
  context: { source: "account" as const }
};
const BYOK_PRESET = {
  ok: true as const,
  selection: { provider: "openai", model: "gpt-4o", endpointId: "byok" },
  context: { source: "byok" as const }
};

function signedIn(userId = "u-1") {
  return { authenticated: true as const, profile: { userId } };
}

function signedOut() {
  return { authenticated: false as const };
}

describe("插件模型策略", () => {
  it("account-only 插件在账号模式下拿到账号预设", async () => {
    const resolveAssignedModel = vi.fn(async () => ACCOUNT_PRESET);

    const resolved = await resolvePluginModelSelection({
      accountOnly: true,
      userMode: "account",
      account: signedIn() as never,
      resolveAssignedModel: resolveAssignedModel as never
    });

    expect(resolved).toBe(ACCOUNT_PRESET);
    expect(resolveAssignedModel).toHaveBeenCalledWith({
      mode: "account",
      activeAccountId: "u-1",
      capability: "agent"
    });
  });

  it("account-only 插件在 BYOK 模式下拿不到模型", async () => {
    const resolveAssignedModel = vi.fn(async () => BYOK_PRESET);

    const resolved = await resolvePluginModelSelection({
      accountOnly: true,
      userMode: "byok",
      account: signedIn() as never,
      resolveAssignedModel: resolveAssignedModel as never
    });

    expect(resolved).toBeNull();
    expect(resolveAssignedModel).not.toHaveBeenCalled();
  });

  it("账号模式下解析出的 BYOK 预设同样被拒", async () => {
    // 这是绕过密封的那条路：账号模式允许挂 BYOK 预设，只看 userMode 就会把
    // 密文发到第三方端点，那边解不开，插件也就等于被白嫖走了一次调用。
    const resolveAssignedModel = vi.fn(async () => BYOK_PRESET);

    const resolved = await resolvePluginModelSelection({
      accountOnly: true,
      userMode: "account",
      account: signedIn() as never,
      resolveAssignedModel: resolveAssignedModel as never
    });

    expect(resolved).toBeNull();
  });

  it("account-only 插件在未登录时拿不到模型", async () => {
    const resolveAssignedModel = vi.fn(async () => ACCOUNT_PRESET);

    const resolved = await resolvePluginModelSelection({
      accountOnly: true,
      userMode: "account",
      account: signedOut() as never,
      resolveAssignedModel: resolveAssignedModel as never
    });

    expect(resolved).toBeNull();
    expect(resolveAssignedModel).not.toHaveBeenCalled();
  });

  it("account-only 插件遇到解析失败时拿不到模型", async () => {
    const resolveAssignedModel = vi.fn(async () => ({ ok: false as const, reason: "no_preset" }));

    const resolved = await resolvePluginModelSelection({
      accountOnly: true,
      userMode: "account",
      account: signedIn() as never,
      resolveAssignedModel: resolveAssignedModel as never
    });

    expect(resolved).toBeNull();
  });

  it("普通插件在 BYOK 模式下照常拿到 BYOK 预设", async () => {
    const resolveAssignedModel = vi.fn(async () => BYOK_PRESET);

    const resolved = await resolvePluginModelSelection({
      accountOnly: false,
      userMode: "byok",
      account: signedIn() as never,
      resolveAssignedModel: resolveAssignedModel as never
    });

    expect(resolved).toBe(BYOK_PRESET);
    expect(resolveAssignedModel).toHaveBeenCalledWith({
      mode: "byok",
      activeAccountId: "u-1",
      capability: "agent"
    });
  });

  it("未知用户模式下任何插件都拿不到模型", async () => {
    const resolveAssignedModel = vi.fn(async () => ACCOUNT_PRESET);

    const resolved = await resolvePluginModelSelection({
      accountOnly: false,
      userMode: "local",
      account: signedIn() as never,
      resolveAssignedModel: resolveAssignedModel as never
    });

    expect(resolved).toBeNull();
    expect(resolveAssignedModel).not.toHaveBeenCalled();
  });

  it("宿主没有模型解析能力时返回空而不是抛错", async () => {
    const resolved = await resolvePluginModelSelection({
      accountOnly: false,
      userMode: "account",
      account: signedIn() as never,
      resolveAssignedModel: undefined
    });

    expect(resolved).toBeNull();
  });
});
