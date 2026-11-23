// Real separate Node process; only external Codex trust is controlled by the test.
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createCodexSkillTarget as backend } from "../../App/backend/src/adapters/outbound/skill-writer/codex/target.ts";
import { createCodexSkillTarget as memory } from "../../Memory/src/agent-source/integration/codex/target.ts";
const [home, integration, action] = process.argv.slice(2);
const target = (integration === "Backend" ? backend : memory)({
  rootDirectory: home, memmyConfigPath: join(home, "config.yaml"),
  trustHooks: async () => {
    writeFileSync(join(home, "entered"), "");
    while (!existsSync(join(home, "release"))) await delay(10);
    throw new Error("controlled trust failure");
  }
});
try {
  if (action === "install") await target.installPlugin("codex");
  else await target.uninstallPlugin("codex");
} catch (error) {
  if (action !== "install" || error.message !== "controlled trust failure") throw error;
}
