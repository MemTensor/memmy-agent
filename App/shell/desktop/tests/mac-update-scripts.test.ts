import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMacSigningRequirement,
  createMacDmgUpdateInstallScript,
  createMacDmgUpdateStageScript
} from "../src/main/mac-update-scripts.js";

let root: string;
let destination: string;
let staged: string;
let marker: string;
let log: string;
let tools: Record<string, string>;

function fixture(app: string, tag: string, fields: Record<string, string> = {}) {
  fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
  const values = { CFBundleIdentifier: "cn.memtensor.memmy", CFBundleExecutable: "Memmy", LSMinimumSystemVersion: "12.0", CFBundleShortVersionString: "1.2.2-rc.1", ...fields };
  fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict>${Object.entries(values).map(([key, value]) => `<key>${key}</key><string>${value}</string>`).join("")}</dict></plist>`);
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "Memmy"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(path.join(app, "Contents", "MacOS", "architecture"), "arm64 x86_64");
  fs.writeFileSync(path.join(app, "signature"), "valid");
  fs.writeFileSync(path.join(app, "team"), "MEMMYTEAM1");
  fs.writeFileSync(path.join(app, "tag"), tag);
}

function mockTool(name: string, script: string) {
  const file = path.join(root, name);
  fs.writeFileSync(file, `#!/bin/sh\n${script}\n`, { mode: 0o700 });
  return file;
}

function instrument(script: string) {
  for (const [binary, replacement] of Object.entries(tools)) script = script.replaceAll(binary, `'${replacement}'`);
  return script;
}

function install(options: { expectedVersion?: string; currentVersion?: string } = {}) {
  const helper = path.join(root, "install.zsh");
  fs.writeFileSync(helper, instrument(createMacDmgUpdateInstallScript({ architecture: "arm64", teamIdentifier: "MEMMYTEAM1", expectedVersion: "1.2.2-rc.1", currentVersion: "1.2.1", ...options })));
  return spawnSync("/bin/zsh", [helper, "unused.dmg", destination, log, "99999999", "0", marker, staged, `${staged}.ready`], { encoding: "utf8", timeout: 10_000 });
}

describe("macOS update signing requirement", () => {
  it("emits a literal requirement with the field-prefixed Developer ID certificate extension", () => {
    const requirement = buildMacSigningRequirement("S7NLXHGBJ2");
    // Without the leading "=" codesign treats the value as a requirement file and fails with ENOENT.
    expect(requirement.startsWith("=")).toBe(true);
    // The raw OID is a syntax error: the requirement parser stops at the first dot.
    expect(requirement).toContain('certificate leaf[field.1.2.840.113635.100.6.1.13] exists');
    expect(requirement).not.toMatch(/leaf\[1\.2\.840/);
    expect(requirement).toContain('identifier "cn.memtensor.memmy"');
    expect(requirement).toContain('certificate leaf[subject.OU] = "S7NLXHGBJ2"');
    expect(requirement).toContain("anchor apple generic");
  });

  it("rejects requirement values that could escape the requirement string", () => {
    expect(() => buildMacSigningRequirement("")).toThrow(/team identifier/u);
    expect(() => buildMacSigningRequirement('TEAM" or anchor apple generic')).toThrow(/quotes/u);
    expect(() => buildMacSigningRequirement("TEAM1", 'cn.memtensor."')).toThrow(/quotes/u);
  });

  it("embeds the corrected literal requirement in both generated helper scripts", () => {
    const options = { architecture: "arm64" as const, teamIdentifier: "S7NLXHGBJ2" };
    const requirement = buildMacSigningRequirement("S7NLXHGBJ2");
    for (const script of [createMacDmgUpdateInstallScript(options), createMacDmgUpdateStageScript(options)]) {
      // The legacy forms must never come back: they made every signed update fail validation.
      expect(script).toContain(`'${requirement}'`);
      expect(script).not.toContain("certificate leaf[1.2.840.113635.100.6.1.13]");
      expect(script).not.toContain('local signing_requirement=\'anchor apple generic');
      expect(script).toContain('/usr/bin/codesign --verify --deep --strict -R "$signing_requirement" "$app_path"');
      expect(script).toContain('/usr/bin/codesign --verify --deep --strict "$app_path"');
    }
  });

  it("omits the team requirement only for unsigned builds", () => {
    const unsigned = createMacDmgUpdateStageScript({ architecture: "arm64", teamIdentifier: null, allowUnsigned: true });
    expect(unsigned).toContain("EXPECTED_TEAM=''");
    expect(unsigned).not.toContain("certificate leaf[subject.OU]");
    expect(() => createMacDmgUpdateStageScript({ architecture: "arm64", teamIdentifier: null })).toThrow(/signing team/u);
  });
});

describe.runIf(process.platform === "darwin")("macOS helper script passes the literal requirement to codesign", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-requirement-"));
    destination = path.join(root, "Memmy.app");
    staged = path.join(root, "Memmy.staged.app");
    marker = path.join(root, "prepared.json");
    log = path.join(root, "update.log");
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("passes the literal requirement instead of a requirement file path", () => {
    fixture(destination, "original");
    fixture(staged, "replacement");
    fs.writeFileSync(`${staged}.ready`, "");
    fs.writeFileSync(marker, "pending");
    const recorded = path.join(root, "codesign-requirement.txt");
    tools = {
      "/usr/bin/pgrep": mockTool("pgrep", "exit 1"),
      "/usr/bin/lipo": mockTool("lipo", "exit 0"),
      "/usr/bin/sw_vers": mockTool("sw_vers", "echo 14.0"),
      "/usr/bin/xattr": mockTool("xattr", "exit 0"),
      "/usr/bin/codesign": mockTool("codesign", `for arg in "$@"; do app="$arg"; done
if [ "$1" = -dv ]; then echo "TeamIdentifier=$(cat "$app/team")" >&2; exit 0; fi
previous=""
for arg in "$@"; do
  if [ "$previous" = -R ]; then printf '%s' "$arg" > '${recorded}'; fi
  previous="$arg"
done
[ "$(cat "$app/signature")" = valid ]`),
    };
    const result = install();
    expect(result.status, fs.existsSync(log) ? fs.readFileSync(log, "utf8") : "no log").toBe(0);
    expect(fs.readFileSync(recorded, "utf8")).toBe(buildMacSigningRequirement("MEMMYTEAM1"));
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("replacement");
  });
});

describe.runIf(process.platform === "darwin")("real codesign verification of the generated requirement", () => {
  let tempRoot: string;

  function signedFixtureApp(bundleId: string, identity?: { name: string; keychain: string }): string {
    const app = path.join(tempRoot, `${bundleId}.app`);
    fs.mkdirSync(path.join(app, "Contents", "MacOS"), { recursive: true });
    fs.writeFileSync(path.join(app, "Contents", "Info.plist"), `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string><key>CFBundleExecutable</key><string>Memmy</string></dict></plist>`);
    // A real Mach-O executable lets codesign seal and verify the bundle without launching it.
    fs.copyFileSync("/usr/bin/true", path.join(app, "Contents", "MacOS", "Memmy"));
    const args = identity
      ? ["--force", "--sign", identity.name, "--keychain", identity.keychain, app]
      : ["--force", "--sign", "-", app];
    const signed = spawnSync("/usr/bin/codesign", args, { encoding: "utf8" });
    expect(signed.status, signed.stderr).toBe(0);
    return app;
  }

  /**
   * Creates a throwaway self-signed code-signing identity in a temporary keychain.
   *
   * The certificate carries the TeamIdentifier in `subject.OU` and the Developer ID extension OID,
   * mirroring the fields the update requirement matches on. It is deliberately not anchored to
   * Apple, so `anchor apple generic` still fails while every other clause can be exercised.
   *
   * @returns The identity handle, or null when this machine cannot create a temporary identity.
   */
  function tryCreateTestIdentity(): { name: string; keychain: string } | null {
    const keychain = path.join(tempRoot, "memmy-test.keychain-db");
    const password = "memmy-test";
    const config = path.join(tempRoot, "openssl.cnf");
    const key = path.join(tempRoot, "identity.key");
    const certificate = path.join(tempRoot, "identity.pem");
    const identityBundle = path.join(tempRoot, "identity.p12");
    fs.writeFileSync(config, `[req]
distinguished_name = dn
x509_extensions = ext
prompt = no
[dn]
CN = Memmy Update Test
O = MemTensor
OU = S7NLXHGBJ2
[ext]
keyUsage = critical,digitalSignature
extendedKeyUsage = codeSigning
basicConstraints = critical,CA:false
1.2.840.113635.100.6.1.13 = DER:0500
`);
    keychains.add(keychain);
    const steps: Array<[string, string[]]> = [
      ["/usr/bin/openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-config", config, "-keyout", key, "-out", certificate]],
      ["/usr/bin/openssl", ["pkcs12", "-export", "-inkey", key, "-in", certificate, "-out", identityBundle, "-passout", `pass:${password}`, "-name", "Memmy Update Test"]],
      ["/usr/bin/security", ["create-keychain", "-p", password, keychain]],
      ["/usr/bin/security", ["unlock-keychain", "-p", password, keychain]],
      ["/usr/bin/security", ["import", identityBundle, "-k", keychain, "-P", password, "-A", "-T", "/usr/bin/codesign"]],
      ["/usr/bin/security", ["set-key-partition-list", "-S", "apple-tool:,apple:,codesign:", "-s", "-k", password, keychain]],
    ];
    for (const [command, args] of steps) {
      if (spawnSync(command, args, { encoding: "utf8" }).status !== 0) {
        return null;
      }
    }
    return { name: "Memmy Update Test", keychain };
  }

  function verifyWithRequirement(app: string, requirement: string) {
    return spawnSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", "-R", requirement, app], { encoding: "utf8" });
  }

  /**
   * Reports whether codesign accepts the requirement as a well-formed expression.
   *
   * A syntax error surfaces as "unexpected char" / "invalid requirement specification"; an
   * identity mismatch is a different, expected failure for synthetic fixtures.
   *
   * @param requirement The literal requirement, including its leading "=".
   * @returns True when the requirement is syntactically valid.
   */
  function requirementSyntaxIsValid(app: string, requirement: string): boolean {
    const result = verifyWithRequirement(app, requirement);
    return !/unexpected char|invalid requirement specification|invalid or corrupted code requirement/u.test(result.stderr);
  }

  const keychains = new Set<string>();

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-codesign-"));
  });
  afterEach(() => {
    for (const keychain of keychains) {
      spawnSync("/usr/bin/security", ["delete-keychain", keychain], { encoding: "utf8" });
    }
    keychains.clear();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("treats the generated value as an inline requirement, not a file path", () => {
    const app = signedFixtureApp("cn.memtensor.memmy");
    const requirement = buildMacSigningRequirement("S7NLXHGBJ2");
    const result = verifyWithRequirement(app, requirement);
    expect(result.stderr).not.toContain("No such file or directory");
    expect(result.stderr).not.toContain("invalid requirement specification");
    expect(result.stderr).not.toMatch(/unexpected char/u);
    expect(requirementSyntaxIsValid(app, requirement)).toBe(true);
  });

  it("reproduces both legacy syntax failures the shipped v1.2.4 update hit", () => {
    const app = signedFixtureApp("cn.memtensor.memmy");
    // 1. Without the literal "=" prefix codesign looks for a file and fails with ENOENT.
    const missingLiteralPrefix = verifyWithRequirement(app, buildMacSigningRequirement("S7NLXHGBJ2").replace(/^=/u, ""));
    expect(missingLiteralPrefix.stderr).toContain("No such file or directory");
    // 2. A bare OID is rejected by the requirement parser at the first dot.
    const bareOid = verifyWithRequirement(app, '=anchor apple generic and identifier "cn.memtensor.memmy" and certificate leaf[1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "S7NLXHGBJ2"');
    expect(bareOid.status).not.toBe(0);
    expect(bareOid.stderr).toMatch(/unexpected char|invalid requirement specification|invalid or corrupted code requirement/u);
    expect(requirementSyntaxIsValid(app, '=certificate leaf[1.2.840.113635.100.6.1.13] exists')).toBe(false);
  });

  it("matches the bundle identifier and rejects a different one", () => {
    const app = signedFixtureApp("cn.memtensor.memmy");
    expect(verifyWithRequirement(app, '=identifier "cn.memtensor.memmy"').status).toBe(0);
    expect(verifyWithRequirement(app, '=identifier "cn.memtensor.other"').status).not.toBe(0);
  });

  it("accepts the installed team and the Developer ID extension, and rejects mismatches", () => {
    const identity = tryCreateTestIdentity();
    if (!identity) {
      // Keychain access can be unavailable in sandboxed runners; the syntax coverage above still applies.
      return;
    }
    const app = signedFixtureApp("cn.memtensor.memmy", identity);
    // A same-team package satisfies the team and certificate-extension clauses of the requirement.
    expect(verifyWithRequirement(app, '=certificate leaf[subject.OU] = "S7NLXHGBJ2"').status).toBe(0);
    expect(verifyWithRequirement(app, '=certificate leaf[field.1.2.840.113635.100.6.1.13] exists').status).toBe(0);
    // A package from another team, another bundle ID, or without the Developer ID extension is rejected.
    expect(verifyWithRequirement(app, '=certificate leaf[subject.OU] = "OTHERTEAM1"').status).not.toBe(0);
    expect(verifyWithRequirement(app, '=identifier "cn.memtensor.other"').status).not.toBe(0);
    expect(verifyWithRequirement(app, '=certificate leaf[field.1.2.840.113635.100.6.1.14] exists').status).not.toBe(0);
    // The shipped requirement parses, and only the Apple anchor clause keeps this fixture out.
    const requirement = buildMacSigningRequirement("S7NLXHGBJ2");
    expect(requirementSyntaxIsValid(app, requirement)).toBe(true);
    expect(verifyWithRequirement(app, requirement).status).not.toBe(0);
    expect(verifyWithRequirement(app, requirement.replace("anchor apple generic and ", "")).status).toBe(0);
  });

  it("rejects a bundle signed under another TeamIdentifier", () => {
    const app = signedFixtureApp("cn.memtensor.memmy");
    // Ad-hoc signing carries no TeamIdentifier, so a team-pinned requirement must fail closed.
    expect(verifyWithRequirement(app, '=certificate leaf[subject.OU] = "S7NLXHGBJ2"').status).not.toBe(0);
  });
});

describe.runIf(process.platform === "darwin")("macOS automatic update validation and rollback", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "memmy-update-兼容-"));
    destination = path.join(root, "Memmy.app");
    staged = path.join(root, "Memmy.staged.app");
    marker = path.join(root, "prepared.json");
    log = path.join(root, "update.log");
    fixture(destination, "original");
    fixture(staged, "replacement");
    fs.writeFileSync(`${staged}.ready`, "");
    fs.writeFileSync(marker, "pending");
    tools = {
      "/usr/bin/pgrep": mockTool("pgrep", "exit 1"),
      "/usr/bin/lipo": mockTool("lipo", 'case " $(cat "$(dirname "$3")/architecture") " in *" $2 "*) exit 0;; *) exit 1;; esac'),
      "/usr/bin/sw_vers": mockTool("sw_vers", "echo 14.0"),
      "/usr/bin/xattr": mockTool("xattr", "exit 0"),
      "/usr/bin/codesign": mockTool("codesign", `for arg in "$@"; do app="$arg"; done
if [ "$1" = -dv ]; then echo "TeamIdentifier=$(cat "$app/team")" >&2; exit 0; fi
for arg in "$@"; do if [ "$arg" = -R ] && [ -f "$app/untrusted-chain" ]; then exit 1; fi; done
if [ -f "$app/fail-after-replace" ] && [ "$app" = '${destination}' ]; then exit 1; fi
[ "$(cat "$app/signature")" = valid ]`),
    };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("replaces a compatible app and removes the completion marker", () => {
    const result = install();
    expect(result.error).toBeUndefined();
    expect(result.status, fs.readFileSync(log, "utf8")).toBe(0);
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("replacement");
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(`${destination}.update-backup`)).toBe(false);
  }, 15_000);

  it.each([
    ["advertised version", () => fixture(staged, "replacement", { CFBundleShortVersionString: "1.2.1" })],
    ["bundle identifier", () => fixture(staged, "replacement", { CFBundleIdentifier: "other.app" })],
    ["executable escape", () => fixture(staged, "replacement", { CFBundleExecutable: "../Memmy" })],
    ["architecture", () => fs.writeFileSync(path.join(staged, "Contents", "MacOS", "architecture"), "x86_64")],
    ["minimum OS", () => fixture(staged, "replacement", { LSMinimumSystemVersion: "14.1" })],
    ["missing minimum OS", () => fixture(staged, "replacement", { LSMinimumSystemVersion: "" })],
    ["signature", () => fs.writeFileSync(path.join(staged, "signature"), "invalid")],
    ["signing team", () => fs.writeFileSync(path.join(staged, "team"), "OTHERTEAM1")],
    ["Apple Developer ID certificate", () => fs.writeFileSync(path.join(staged, "untrusted-chain"), "")],
  ])("keeps the original app when the update fails %s validation", (_reason, corrupt) => {
    corrupt();
    expect(install().status).not.toBe(0);
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("original");
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.existsSync(`${destination}.update-backup`)).toBe(false);
  });

  it.each([
    ["1.2.1", "1.2.2-rc.1", false],
    ["1.2.2-rc.1", "1.2.2-rc.1", false],
    ["1.2.2-rc.1", "1.2.2", false],
    ["1.2.2", "1.2.2-rc.1", true],
    ["1.2.2-rc.10", "1.2.2-rc.2", true],
  ])("compares package %s against current %s with prerelease precedence", (version, currentVersion, allowed) => {
    fixture(staged, "replacement", { CFBundleShortVersionString: version });
    expect(install({ expectedVersion: version, currentVersion }).status === 0).toBe(allowed);
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe(allowed ? "replacement" : "original");
  });

  it("rejects a symlink at the destination without changing its target", () => {
    const original = path.join(root, "original.app");
    fs.renameSync(destination, original);
    fs.symlinkSync(original, destination);
    expect(install().status).not.toBe(0);
    expect(fs.lstatSync(destination).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(original, "tag"), "utf8")).toBe("original");
  });

  it("restores the original when validation fails after the new bundle has replaced it", () => {
    fs.writeFileSync(path.join(staged, "fail-after-replace"), "");
    expect(install().status).not.toBe(0);
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("original");
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toContain("previous app restored");
  });

  it("leaves the active installer's lock in place when a second installer starts", () => {
    fs.mkdirSync(`${marker}.lock`);
    fixture(`${destination}.update-tmp`, "active replacement");
    expect(install().status).toBe(0);
    expect(fs.existsSync(`${marker}.lock`)).toBe(true);
    expect(fs.readFileSync(path.join(`${destination}.update-tmp`, "tag"), "utf8")).toBe("active replacement");
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("original");
  });

  it("preserves the original backup when the failed replacement cannot be removed", () => {
    fs.writeFileSync(path.join(staged, "fail-after-replace"), "");
    tools["/bin/rm"] = mockTool("rm", `for arg in "$@"; do last="$arg"; done
if [ "$last" = '${destination}' ]; then exit 1; fi
exec /bin/rm "$@"`);
    expect(install().status).not.toBe(0);
    expect(fs.readFileSync(path.join(`${destination}.update-backup`, "tag"), "utf8")).toBe("original");
    expect(fs.existsSync(path.join(destination, "Memmy.app.update-backup"))).toBe(false);
    expect(fs.readFileSync(log, "utf8")).toContain("rollback failed; original is at");
  });

  it("preserves a prior rollback backup before starting another update", () => {
    fixture(`${destination}.update-backup`, "original recovery backup");
    fixture(destination, "previous failed replacement");
    expect(install().status).not.toBe(0);
    expect(fs.readFileSync(path.join(`${destination}.update-backup`, "tag"), "utf8")).toBe("original recovery backup");
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("previous failed replacement");
    expect(fs.readFileSync(path.join(staged, "tag"), "utf8")).toBe("replacement");
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(log, "utf8")).toContain("recovery is required; previous app preserved");
  });

  it("rejects an incompatible package during staging before marking it ready", () => {
    const dmg = path.join(root, "dmg");
    fixture(path.join(dmg, "Memmy.app"), "replacement", { LSMinimumSystemVersion: "15.0" });
    tools["/usr/bin/hdiutil"] = mockTool("hdiutil", 'if [ "$1" = attach ]; then cp -R "$2"/. "$6"; fi');
    const helper = path.join(root, "stage.zsh");
    fs.writeFileSync(helper, instrument(createMacDmgUpdateStageScript({ architecture: "arm64", teamIdentifier: "MEMMYTEAM1", expectedVersion: "1.2.2-rc.1", currentVersion: "1.2.1" })));
    const result = spawnSync("/bin/zsh", [helper, dmg, staged, `${staged}.ready`, log], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).not.toBe(0);
    expect(fs.existsSync(`${staged}.ready`)).toBe(false);
    expect(fs.readFileSync(path.join(destination, "tag"), "utf8")).toBe("original");
  });
});
