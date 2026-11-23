import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ensureMemoryService, stopManagedChild, type ManagedChild, type PackagedRuntimeConfig } from "../src/main/runtime-services.js";
const roots: string[] = [];
const processes: ChildProcess[] = [];
const children: ManagedChild[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) await stopManagedChild(child);
  for (const child of processes.splice(0)) if (child.exitCode === null) child.kill("SIGTERM");
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
async function fixture(mode: "legacy" | "mismatch" | "unowned" | "starting") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-auth-upgrade-"))); roots.push(root);
  const serviceHome = join(root, "memory-service"); await mkdir(serviceHome);
  const entry = join(root, "memory-server.cjs");
  const db = join(root, "memory.sqlite"); const configPath = join(root, "config.yaml");
  await writeFile(db, "existing-user-data"); await writeFile(configPath, "memmyMemory: {}\n");
  await writeFile(entry, `
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const args=process.argv.slice(2), root=__dirname, db=path.join(root,'memory.sqlite'), config=path.join(root,'config.yaml');
const arg=(name)=>args[args.indexOf(name)+1];
const token=process.env.MEMMY_MEMORY_TOKEN || '', legacy=!token, mode=process.env.FIXTURE_MODE;
let starting=legacy && mode==='starting';
const record=(event)=>fs.appendFileSync(path.join(root,'events'),event+'\\n');
const server=http.createServer((req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/api/v1/health') {res.end(JSON.stringify({ok:true,protocolVersion:1,status:starting?'upgrading':'ready'}));return;}
 if(req.url==='/api/v1/auth/check') {
  if(starting) {res.writeHead(503);res.end('{}');return;}
  const status=legacy?(mode==='mismatch'?401:404):(req.headers.authorization==='Bearer '+token?200:401);
  res.writeHead(status);res.end(JSON.stringify({authenticated:true,authVersion:1}));return;
 }
 if(req.url==='/api/v1/admin/shutdown') {
  record('shutdown');res.end('{}');setTimeout(()=>server.close(()=>{
   fs.rmSync(db+'.server.lock',{force:true});record('released');process.exit(0);
  }),150);return;
 }
 res.writeHead(404);res.end('{}');
});
server.listen(Number(arg('--port')||0),'127.0.0.1',()=>{
 const port=server.address().port;
 fs.writeFileSync(db+'.server.lock',JSON.stringify({pid:process.pid,sqlitePath:db,host:'127.0.0.1',port}));
 fs.writeFileSync(path.join(root,'memory-service','runtime.json'),JSON.stringify({pid:mode==='unowned'?0:process.pid,endpoint:'http://127.0.0.1:'+port,configPath:config,sqlitePath:db}));
 record(legacy?'old-started':'new-authenticated');
 if(starting) setTimeout(()=>{starting=false;record('migration-finished');},300);
});
process.on('SIGTERM',()=>server.close(()=>{fs.rmSync(db+'.server.lock',{force:true});process.exit(0);}));
`);
  const child = spawn(process.execPath, [entry, "--port", "0"], { env: { ...process.env, MEMMY_MEMORY_TOKEN: "", FIXTURE_MODE: mode }, stdio: "ignore" }); processes.push(child);
  let endpoint = "";
  await vi.waitFor(async () => { const state = JSON.parse(await readFile(join(serviceHome, "runtime.json"), "utf8")); endpoint = state.endpoint; expect(endpoint).toBeTruthy(); });
  const port = Number(new URL(endpoint).port);
  const runtime: PackagedRuntimeConfig = { configPath, memoryBaseUrl: endpoint, memoryDatabasePath: db, memoryToken: "fixture-secret", memoryListenHost: "127.0.0.1", memoryListenPort: port, agentWorkspace: root, agentGatewayBaseUrl: "http://127.0.0.1:1", agentGatewayHealthHost: "127.0.0.1", agentGatewayHealthPort: 1, agentGatewayBootstrapSecret: "fixture" };
  const start = () => ensureMemoryService({ memoryEntry: entry, agentEntry: "unused" }, runtime, children, { appPath: root, appDatabaseFile: join(root, "app.sqlite"), resourcesPath: root, logDirectory: root, logLevel: "info" }).catch(async error => { throw new Error(error.message + "\n" + await readFile(join(root, "memory.log"), "utf8").catch(() => "")); });
  return { root, child, db, start, endpoint };
}
it.each(["legacy", "starting"] as const)("gracefully replaces a verified %s owner after readiness and database release", async mode => {
  const f = await fixture(mode); await f.start();
  expect(children).toHaveLength(1);
  expect(await readFile(f.db, "utf8")).toBe("existing-user-data");
  const events = (await readFile(join(f.root, "events"), "utf8")).trim().split("\n");
  expect(events).toEqual(mode === "starting" ? ["old-started", "migration-finished", "shutdown", "released", "new-authenticated"] : ["old-started", "shutdown", "released", "new-authenticated"]);
  expect((await fetch(`${f.endpoint}/api/v1/auth/check`)).status).toBe(401);
  expect((await fetch(`${f.endpoint}/api/v1/auth/check`, { headers: { authorization: "Bearer fixture-secret" } })).status).toBe(200);
});
it.each(["mismatch", "unowned"] as const)("does not stop or replace a %s owner", async mode => {
  const f = await fixture(mode);
  await expect(f.start()).rejects.toThrow(/authentication/);
  expect(f.child.exitCode).toBeNull(); expect(children).toHaveLength(0);
  expect(await readFile(join(f.root, "events"), "utf8")).toBe("old-started\n");
});
