import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runProcess } from "../src/process.mjs";

async function options(t) {
  const cwd = await mkdtemp(join(tmpdir(), "office-process-test-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  return { cwd, env: process.env, children: new Set() };
}
test("file-backed subprocess stdio transports input, output, diagnostics and exit status", async t => {
  const config = await options(t);
  const result = await runProcess(process.execPath, ["-e", `console.log(require('fs').readFileSync(0,'utf8')); console.error('diagnostic'); process.exitCode=7;`], { ...config, input: "Office request" });
  assert.equal(result.code, 7); assert.equal(result.stdout.trim(), "Office request"); assert.equal(result.stderr.trim(), "diagnostic");
  assert.equal(config.children.size, 0); assert.deepEqual(await readdir(config.cwd), []);
});
test("file-backed subprocesses enforce deadlines and remove temporary transport files", async t => {
  const config = await options(t);
  await assert.rejects(runProcess(process.execPath, ["-e", "console.error('engine initialization blocked');setInterval(()=>{},1000)"], { ...config, timeout: 1000 }), /timed out: engine initialization blocked/);
  assert.equal(config.children.size, 0); assert.deepEqual(await readdir(config.cwd), []);
});
test("file-backed subprocesses reject oversized output", async t => {
  const config = await options(t);
  await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('x'.repeat(4096))"], { ...config, maxOutput: 1024 }), /output exceeded/);
  assert.deepEqual(await readdir(config.cwd), []);
});
test("bounded diagnostics keep startup context and the final failure after noisy engine warnings", async t => {
  const config = await options(t);
  const result = await runProcess(process.execPath, ["-e", "process.stderr.write('startup context\\n'+'warning\\n'.repeat(4096)+'final failure');process.exitCode=2"], config);
  assert.equal(result.code, 2);
  assert.ok(result.stderr.startsWith("startup context\n"));
  assert.ok(result.stderr.endsWith("final failure"));
  assert.ok(result.stderr.length < 8300);
  assert.deepEqual(await readdir(config.cwd), []);
});
