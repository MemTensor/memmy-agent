// Protocol fixture, not a replacement for real Codex desktop acceptance.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const home = process.env.CODEX_HOME;
const hooksPath = path.join(home, "hooks.json");
const trustPath = path.join(home, "fixture-trust.json");
const read = (file) => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
const hooks = () => Object.entries(read(hooksPath).hooks || {}).flatMap(([event, entries]) =>
  entries.flatMap((entry, i) => entry.hooks.map((hook, j) => {
    const key = `${hooksPath}:${event}:${i}:${j}`;
    const currentHash = createHash("sha256").update(hook.command).digest("hex");
    const trusted = read(trustPath)[key]?.trusted_hash === currentHash;
    return { key, event, eventName: event[0].toLowerCase() + event.slice(1), handlerType: "command",
      command: hook.command, source: "user", sourcePath: process.argv.includes("canonical-path") ? fs.realpathSync(hooksPath) : hooksPath, currentHash,
      trustStatus: trusted ? "trusted" : "untrusted", enabled: trusted, isManaged: false };
  })));

if (process.argv[2] === "dispatch") {
  const payload = JSON.parse(process.argv[3]);
  let executed = 0;
  for (const hook of hooks().filter(hook => hook.event === payload.hook_event_name && hook.enabled)) {
    const result = spawnSync(hook.command, { shell: true, input: JSON.stringify(payload), encoding: "utf8", timeout: 10000 });
    if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
    if (result.stderr) process.stderr.write(result.stderr);
    executed += 1;
  }
  process.stdout.write(JSON.stringify({ executed }));
} else {
  readline.createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    const respond = result => process.stdout.write(JSON.stringify({ id: message.id, result }) + "\n");
    if (message.method === "initialize") respond({ userAgent: "fixture" });
    if (message.method === "hooks/list") respond({ data: [{ hooks: hooks() }] });
    if (message.method === "config/batchWrite") {
      if (process.argv.includes("fail-write")) {
        process.stdout.write(JSON.stringify({ id: message.id, error: { message: "fixture trust write failed" } }) + "\n");
      } else {
        fs.writeFileSync(trustPath, JSON.stringify({ ...read(trustPath), ...message.params.edits[0].value }));
        respond({});
      }
    }
  });
}
