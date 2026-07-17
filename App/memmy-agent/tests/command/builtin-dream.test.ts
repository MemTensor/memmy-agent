import { describe, expect, it } from "vitest";
import { InboundMessage } from "../../src/core/runtime-messages/events.js";
import { cmdDreamLog, cmdDreamRestore } from "../../src/command/builtin.js";
import { CommandContext } from "../../src/command/router.js";
import { CommitInfo } from "../../src/utils/gitstore.js";

class FakeStore {
  constructor(
    public git: FakeGit,
    private lastDreamCursor = 1,
  ) {}

  getLastDreamCursor(): number {
    return this.lastDreamCursor;
  }
}

class FakeGit {
  constructor(
    private init: {
      initialized?: boolean;
      commits?: CommitInfo[];
      diffMap?: Record<string, [CommitInfo, string] | null>;
      revertResult?: string | null;
    } = {},
  ) {}

  isInitialized(): boolean {
    return this.init.initialized ?? true;
  }

  log(maxEntries = 20): CommitInfo[] {
    return (this.init.commits ?? []).slice(0, maxEntries);
  }

  showCommitDiff(sha: string): [CommitInfo, string] | null {
    return this.init.diffMap?.[sha] ?? null;
  }

  revert(sha: string): string | null {
    void sha;
    return this.init.revertResult ?? null;
  }
}

function makeCtx(raw: string, git: FakeGit, args = "", lastDreamCursor = 1): CommandContext {
  const msg = new InboundMessage({ channel: "cli", senderId: "u1", chatId: "direct", content: raw });
  return new CommandContext({
    msg,
    session: null,
    key: msg.sessionKey,
    raw,
    args,
    loop: { consolidator: { store: new FakeStore(git, lastDreamCursor) } },
  });
}

describe("dream log command", () => {
  it("formats the latest dream change with friendly next steps", async () => {
    const commit = new CommitInfo("abcd1234", "dream: 2026-04-04, 2 change(s)", "2026-04-04 12:00");
    const diff = "diff --git a/SOUL.md b/SOUL.md\n--- a/SOUL.md\n+++ b/SOUL.md\n@@ -1 +1 @@\n-old\n+new\n";
    const out = await cmdDreamLog(makeCtx("/dream-log", new FakeGit({ commits: [commit], diffMap: { [commit.sha]: [commit, diff] } })));

    expect(out.content).toContain("## Dream Update");
    expect(out.content).toContain("Here is the latest Dream memory change.");
    expect(out.content).toContain("- Commit: `abcd1234`");
    expect(out.content).toContain("- Changed files: `SOUL.md`");
    expect(out.content).toContain("Use `/dream-restore abcd1234` to undo this change.");
    expect(out.content).toContain("```diff");
  });

  it("guides the user when a requested commit is missing", async () => {
    const out = await cmdDreamLog(makeCtx("/dream-log deadbeef", new FakeGit({ diffMap: {} }), "deadbeef"));
    expect(out.content).toContain("Couldn't find Dream change `deadbeef`.");
    expect(out.content).toContain("Use `/dream-restore` to list recent versions");
  });

  it("is clear before the first Dream run", async () => {
    const out = await cmdDreamLog(makeCtx("/dream-log", new FakeGit({ initialized: false }), "", 0));
    expect(out.content).toContain("Dream has not run yet.");
    expect(out.content).toContain("Run `/dream`");
  });
});

describe("dream restore command", () => {
  it("lists versions with next steps", async () => {
    const commits = [
      new CommitInfo("abcd1234", "dream: latest", "2026-04-04 12:00"),
      new CommitInfo("bbbb2222", "dream: older", "2026-04-04 08:00"),
    ];
    const out = await cmdDreamRestore(makeCtx("/dream-restore", new FakeGit({ commits })));

    expect(out.content).toContain("## Dream Restore");
    expect(out.content).toContain("Choose a Dream memory version to restore.");
    expect(out.content).toContain("`abcd1234` 2026-04-04 12:00 - dream: latest");
    expect(out.content).toContain("Preview a version with `/dream-log <sha>`");
    expect(out.content).toContain("Restore a version with `/dream-restore <sha>`.");
  });

  it("mentions restored files and follow-up after success", async () => {
    const commit = new CommitInfo("abcd1234", "dream: latest", "2026-04-04 12:00");
    const diff = [
      "diff --git a/SOUL.md b/SOUL.md",
      "--- a/SOUL.md",
      "+++ b/SOUL.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/memory/MEMORY.md b/memory/MEMORY.md",
      "--- a/memory/MEMORY.md",
      "+++ b/memory/MEMORY.md",
      "@@ -1 +1 @@",
      "-old",
      "+new",
    ].join("\n");
    const git = new FakeGit({ diffMap: { [commit.sha]: [commit, diff] }, revertResult: "eeee9999" });
    const out = await cmdDreamRestore(makeCtx("/dream-restore abcd1234", git, "abcd1234"));

    expect(out.content).toContain("Restored Dream memory to the state before `abcd1234`.");
    expect(out.content).toContain("- New safety commit: `eeee9999`");
    expect(out.content).toContain("- Restored files: `SOUL.md`, `memory/MEMORY.md`");
    expect(out.content).toContain("Use `/dream-log eeee9999` to inspect the restore diff.");
  });
});
