import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  advanceWindowsStoreTransitionAfterSuccessfulBoot,
  advanceWindowsStoreTransitionState,
  assertWindowsStoreTransitionBinding,
  createWindowsStoreTransitionState,
  parseWindowsStoreTransitionState,
  readWindowsStoreTransitionState,
  resolveWindowsStoreTransitionStatePath,
  updateWindowsStoreTransitionState,
  writeWindowsStoreTransitionState,
  type WindowsStoreTransitionBinding
} from "../src/main/windows-store-transition-state.js";

const createdAt = new Date("2026-09-01T06:00:00.000Z");

describe("Windows Store transition authority journal", () => {
  it("uses one explicit current-user transition journal outside versioned package paths", () => {
    expect(resolveWindowsStoreTransitionStatePath("C:\\Users\\lee\\AppData\\Local")).toBe(
      "C:\\Users\\lee\\AppData\\Local\\Memmy\\store-transition\\active.json"
    );
    expect(() => resolveWindowsStoreTransitionStatePath("C:\\")).toThrow("drive root");
    expect(() => resolveWindowsStoreTransitionStatePath("AppData\\Local")).toThrow("absolute");
  });

  it.each(["cn", "intl"] as const)("creates an identity-bound %s current-install authority record without discovering a default install path", (edition) => {
    const binding = createBinding(edition);
    const state = createWindowsStoreTransitionState({ ...binding, now: createdAt });

    expect(state).toEqual({
      schemaVersion: 1,
      phase: "authority-recorded",
      ...binding,
      createdAt: createdAt.toISOString(),
      updatedAt: createdAt.toISOString()
    });
    expect(state.sourceInstallDirectory).toBe("D:\\企业 应用\\Memmy 自定义目录");
  });

  it("generates a transaction ID when the caller does not supply one", () => {
    const { transactionId: _omitted, ...binding } = createBinding("cn");
    expect(createWindowsStoreTransitionState({ ...binding, now: createdAt }).transactionId)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
  });

  it("allows only the broker-attested phase sequence and keeps repeated writes idempotent", () => {
    let state = createWindowsStoreTransitionState({ ...createBinding("cn"), now: createdAt });
    const canonicalPhases = [
      "store-install-launched",
      "package-registered",
      "data-prepared",
      "awaiting-app-verification",
      "app-verified",
      "legacy-cleanup-attested",
      "cleanup-eligible",
      "cleaned"
    ] as const;
    for (const [index, phase] of canonicalPhases.entries()) {
      const nextTime = new Date(createdAt.getTime() + index * 1_000);
      state = advanceWindowsStoreTransitionState(state, phase, nextTime);
      expect(state.phase).toBe(phase);
      expect(advanceWindowsStoreTransitionState(state, phase, nextTime)).toEqual(state);
    }

    expect(() => advanceWindowsStoreTransitionState(
      createWindowsStoreTransitionState({ ...createBinding("cn"), now: createdAt }),
      "package-registered",
      new Date(createdAt.getTime() + 1_000)
    )).toThrow("Invalid Windows Store transition");
    expect(() => advanceWindowsStoreTransitionState(
      state,
      "cleanup-eligible",
      new Date(createdAt.getTime() + 10_000)
    )).toThrow("Invalid Windows Store transition");
  });

  it("records legacy cleanup completion before a later boot becomes cleanup eligible", () => {
    let state = createWindowsStoreTransitionState({ ...createBinding("cn"), now: createdAt });
    for (const phase of [
      "store-install-launched",
      "package-registered",
      "data-prepared",
      "awaiting-app-verification"
    ] as const) {
      state = advanceWindowsStoreTransitionState(state, phase, new Date(Date.parse(state.updatedAt) + 1_000));
    }

    state = advanceWindowsStoreTransitionAfterSuccessfulBoot(state, new Date(Date.parse(state.updatedAt) + 1_000));
    expect(state.phase).toBe("app-verified");
    state = advanceWindowsStoreTransitionAfterSuccessfulBoot(state, new Date(Date.parse(state.updatedAt) + 1_000));
    expect(state.phase).toBe("legacy-cleanup-attested");
    state = advanceWindowsStoreTransitionAfterSuccessfulBoot(state, new Date(Date.parse(state.updatedAt) + 1_000));
    expect(state.phase).toBe("cleanup-eligible");
    expect(state.phase).not.toBe("cleaned");
  });

  it("requires a native-broker pass for a historical cleanup-complete journal", () => {
    const historical = {
      ...createWindowsStoreTransitionState({ ...createBinding("cn"), now: createdAt }),
      phase: "legacy-cleanup-complete" as const
    };
    const next = advanceWindowsStoreTransitionAfterSuccessfulBoot(
      historical,
      new Date(createdAt.getTime() + 1_000)
    );
    expect(next.phase).toBe("legacy-cleanup-attested");
  });

  it("rejects a mismatched transaction, Store identity, or source authority binding", () => {
    const binding = createBinding("cn");
    const state = createWindowsStoreTransitionState({ ...binding, now: createdAt });
    expect(() => assertWindowsStoreTransitionBinding(state, binding)).not.toThrow();
    expect(() => assertWindowsStoreTransitionBinding(state, {
      ...binding,
      transactionId: "22222222-2222-4222-8222-222222222222"
    })).toThrow("binding does not match");
    expect(() => assertWindowsStoreTransitionBinding(state, {
      ...binding,
      sourceExecutablePath: "D:\\企业 应用\\Memmy 自定义目录\\Other.exe"
    })).toThrow("binding does not match");
    expect(() => assertWindowsStoreTransitionBinding(state, {
      ...binding,
      packageFamilyName: "Memtensor.MemmyAgent_eyack96k521x2"
    })).toThrow("identity");
  });

  it("strictly rejects unknown fields, malformed phases, unsafe paths, and non-current authority", () => {
    const state = createWindowsStoreTransitionState({ ...createBinding("cn"), now: createdAt });
    const cases = [
      { ...state, unexpected: true },
      { ...state, phase: "prepared" },
      { ...state, authority: "persisted-install-authority" },
      { ...state, sourceInstallDirectory: "C:\\" },
      { ...state, sourceExecutablePath: "E:\\Other\\Memmy.exe" },
      { ...state, sourceExecutablePath: "D:\\企业 应用\\Memmy 自定义目录\\nested\\Memmy.exe" },
      { ...state, sourceExecutablePath: "D:\\企业 应用\\Memmy 自定义目录\\nested\\..\\Memmy.exe" },
      { ...state, sourceExecutablePath: "C:\\Program Files\\WindowsApps\\Memtensor.Memmy_1.1.2.0_x64__eyack96k521x2\\Memmy.exe" },
      { ...state, updatedAt: "not-a-timestamp" }
    ];

    for (const value of cases) {
      expect(() => parseWindowsStoreTransitionState(JSON.stringify(value))).toThrow("Windows Store transition");
    }
    expect(() => createWindowsStoreTransitionState({
      ...createBinding("cn"),
      now: new Date(Number.NaN)
    })).toThrow("timestamp");
  });

  it("atomically writes, strictly reads, and advances only the expected binding", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-store-transition-"));
    const statePath = join(root, "journal", "transition-v1.json");
    const binding = createBinding("intl");
    const state = createWindowsStoreTransitionState({ ...binding, now: createdAt });
    try {
      await writeWindowsStoreTransitionState(statePath, state);
      await expect(readWindowsStoreTransitionState(statePath)).resolves.toEqual(state);

      const next = await updateWindowsStoreTransitionState(statePath, {
        expectedBinding: binding,
        nextPhase: "store-install-launched",
        now: new Date(createdAt.getTime() + 1_000)
      });
      expect(next.phase).toBe("store-install-launched");
      await expect(readWindowsStoreTransitionState(statePath)).resolves.toEqual(next);
      expect(await readdir(dirname(statePath))).toEqual(["transition-v1.json"]);

      await expect(updateWindowsStoreTransitionState(statePath, {
        expectedBinding: { ...binding, storeId: "9MZGLKWMZZV6" },
        nextPhase: "package-registered"
      })).rejects.toThrow("identity");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("returns null only for a missing journal and surfaces corrupt contents", async () => {
    const root = await mkdtemp(join(tmpdir(), "memmy-store-transition-corrupt-"));
    const statePath = join(root, "journal", "transition-v1.json");
    try {
      await expect(readWindowsStoreTransitionState(statePath)).resolves.toBeNull();
      await mkdir(dirname(statePath), { recursive: true });
      await writeFile(statePath, "{not-json", "utf8");
      await expect(readWindowsStoreTransitionState(statePath)).rejects.toThrow("Windows Store transition journal is invalid");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

function createBinding(edition: "cn" | "intl"): WindowsStoreTransitionBinding {
  const isCn = edition === "cn";
  return {
    transactionId: "11111111-1111-4111-8111-111111111111",
    edition,
    storeId: isCn ? "9MZGLKWMZZV6" : "9NFVJC9K7ZK9",
    packageFamilyName: isCn
      ? "Memtensor.Memmy_eyack96k521x2"
      : "Memtensor.MemmyAgent_eyack96k521x2",
    aumid: isCn
      ? "Memtensor.Memmy_eyack96k521x2!Memmy"
      : "Memtensor.MemmyAgent_eyack96k521x2!Memmy",
    sourceExecutablePath: "D:\\企业 应用\\Memmy 自定义目录\\Memmy.exe",
    sourceInstallDirectory: "D:\\企业 应用\\Memmy 自定义目录",
    sourceVersion: "1.1.2",
    sourceUserDataPath: "C:\\Users\\lee\\AppData\\Roaming\\Memmy",
    sourceRuntimeHomePath: "D:\\MemmyData\\.memmy",
    authority: "current-install-authority"
  };
}
