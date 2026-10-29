import { Command } from "commander";
import { prepareStartupMigrations } from "./startup-migrations.js";

/** Runs the same forced migrations as the CLI without loading Agent services. */
export async function runStartupMigrationCommand(argv: string[] = process.argv): Promise<void> {
  const app = new Command("memmy")
    .option("-s, --session <sessionId>", "Resume an existing cli:* terminal session")
    .option("--standalone", "Create a new standalone terminal session")
    .option("--project <path>", "Create a terminal session bound to a project path");
  app.command("migrate", { hidden: true })
    .option("-w, --workspace <dir>", "Workspace directory")
    .option("-c, --config <path>", "Path to config file")
    .option("--app-database <path>", "Desktop app database path")
    .action(async (options: { config?: string; workspace?: string; appDatabase?: string }) => {
      await prepareStartupMigrations(options, process.env, { force: true });
      console.log("Migrations ready.");
    });
  await app.parseAsync(argv);
}
