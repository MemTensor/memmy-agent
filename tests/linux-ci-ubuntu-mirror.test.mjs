import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { assertHostedUbuntuRunner, planUbuntuMirror, recoverUbuntuMirror } from "../scripts/internal/linux/ci-ubuntu-mirror.mjs";

const source = `Types: deb
URIs: mirror+file:/etc/apt/apt-mirrors.txt
Suites: noble noble-updates noble-backports
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg

Types: deb
URIs: http://ports.ubuntu.com/ubuntu-ports/
Suites: noble-security
Components: main restricted universe multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
`;
const metadata = "Codename: noble\nArchitectures: amd64 arm64\n";
function adapters({ downloadFails = false, signatureFails = false, text = metadata } = {}) {
  const calls = [];
  return { calls,
    fetchRelease(url) { calls.push(["fetch", url]); if (downloadFails) throw new Error("DNS failure"); return { text }; },
    verifyRelease() { calls.push(["verify"]); if (signatureFails) throw new Error("BAD signature"); },
    applySource(value) { calls.push(["apply", value]); },
  };
}

describe("signed Ubuntu CI mirror recovery", () => {
  it.each([
    ["x64", "https://mirrors.mit.edu/ubuntu/"],
    ["arm64", "https://mirrors.mit.edu/ubuntu-ports/"],
  ])("maps %s while preserving suites, components and archive trust", (architecture, url) => {
    const plan = planUbuntuMirror(source, architecture);
    expect(plan.mirror).toBe(url);
    const lines = value => value.split("\n").filter(line => !line.startsWith("URIs:"));
    expect(lines(plan.nextSource)).toEqual(lines(source));
    expect(plan.nextSource).not.toContain("Trusted:");
    const io = adapters();
    expect(recoverUbuntuMirror(plan, io).changed).toBe(true);
    expect(io.calls.map(call => call[0])).toEqual(["fetch", "verify", "apply"]);
    expect(io.calls[0][1]).toBe(url + "dists/noble/InRelease");
  });
  it("does not change any apt configuration if mirror download fails", () => {
    const io = adapters({ downloadFails: true });
    expect(() => recoverUbuntuMirror(planUbuntuMirror(source, "arm64"), io)).toThrow("DNS failure");
    expect(io.calls.map(call => call[0])).toEqual(["fetch"]);
  });
  it("rejects an invalid signature before every privileged write", () => {
    const io = adapters({ signatureFails: true });
    expect(() => recoverUbuntuMirror(planUbuntuMirror(source, "x64"), io)).toThrow("BAD signature");
    expect(io.calls.map(call => call[0])).toEqual(["fetch", "verify"]);
  });
  it.each(["Codename: jammy\nArchitectures: amd64 arm64\n", "Codename: noble\nArchitectures: amd64\n"])("rejects signed but unsuitable metadata: %s", text => {
    const io = adapters({ text });
    expect(() => recoverUbuntuMirror(planUbuntuMirror(source, "arm64"), io)).toThrow("suite/architecture");
    expect(io.calls.map(call => call[0])).toEqual(["fetch", "verify"]);
  });
  it("is idempotent without repeating a privileged write", () => {
    const first = planUbuntuMirror(source, "arm64");
    const second = planUbuntuMirror(first.nextSource, "arm64");
    const io = adapters();
    expect(recoverUbuntuMirror(second, io).changed).toBe(false);
    expect(io.calls).toEqual([]);
  });
  it.each([
    source.replace("noble-security", "jammy-security"),
    source.replaceAll("/usr/share/keyrings/ubuntu-archive-keyring.gpg", "/tmp/other.gpg"),
    source.replace("mirror+file:/etc/apt/apt-mirrors.txt", "https://example.invalid/ubuntu/"),
    source + "\nTrusted: yes\n",
  ])("does not replace unexpected source configuration", invalid => {
    expect(() => planUbuntuMirror(invalid, "x64")).toThrow();
  });
  it("refuses non-hosted, non-Linux, or other Ubuntu releases", () => {
    const input = { environment: { GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted" }, platform: "linux", osRelease: 'ID=ubuntu\nVERSION_ID="24.04"\n' };
    expect(() => assertHostedUbuntuRunner(input)).not.toThrow();
    expect(() => assertHostedUbuntuRunner({ ...input, platform: "darwin" })).toThrow();
    expect(() => assertHostedUbuntuRunner({ ...input, environment: { ...input.environment, RUNNER_ENVIRONMENT: "self-hosted" } })).toThrow();
    expect(() => assertHostedUbuntuRunner({ ...input, osRelease: 'ID=ubuntu\nVERSION_ID="22.04"\n' })).toThrow();
  });
  it("uses the same verified mirror before native apt without weakening platform checks", () => {
    const workflow = YAML.parse(readFileSync(new URL("../.github/workflows/computer-use-native.yml", import.meta.url), "utf8"));
    const job = workflow.jobs.native;
    expect(job.strategy.matrix.runner).toEqual(["ubuntu-24.04", "ubuntu-24.04-arm", "macos-26", "windows-2025"]);
    const index = name => job.steps.findIndex(step => step.name === name);
    const mirror = index("Verify a signed Ubuntu mirror for native desktop checks");
    const desktop = index("Prepare an isolated Linux desktop session");
    expect(job.steps.findIndex(step => step.uses?.startsWith("actions/setup-node@"))).toBeLessThan(mirror);
    expect(mirror).toBeLessThan(desktop);
    expect(job.steps[mirror]).toMatchObject({
      if: "runner.os == 'Linux' && runner.environment == 'github-hosted'",
      run: "node scripts/internal/linux/ci-ubuntu-mirror.mjs",
    });
    expect(job.steps[desktop].if).toBe("runner.os == 'Linux'");
    expect(job.steps[desktop].run.trim().split("\n")).toEqual([
      "sudo apt-get update", "sudo apt-get install -y dbus-x11 xvfb",
      "bash scripts/internal/linux/install-computer-use-deps.sh",
      "bash scripts/internal/linux/install-computer-use-deps.sh",
    ]);
    expect(job.steps[index("Check Linux MCP and desktop backend")].run).toContain("dbus-run-session -- xvfb-run -a node");
    expect(job.steps[index("Check Windows runtime fixtures with native PowerShell 5.1")].shell).toBe("powershell");
    expect(job.steps[index("Test Memmy macOS native source")].run).toContain("swift test");
    expect(job["continue-on-error"]).toBeUndefined();
  });
});
