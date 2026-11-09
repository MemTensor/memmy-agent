#!/usr/bin/env python3
"""Assemble the isolated local Episode test app from built sources and installed Electron assets.
Run source builds (including backend SQL/assets and desktop-edition.json) first.
Requires node, @electron/asar, and /Applications/Memmy.app.
Output: release/memmy-organization/memmy organiaztion.app (Apple Silicon).
No changes are made to the installed app or its configuration.
"""
import hashlib, json, os, pathlib, plistlib, shutil, subprocess
ROOT = pathlib.Path(__file__).resolve().parents[2]
OUT = ROOT / 'release/memmy-organization'
STAGE = OUT / 'staging/app'
APP = OUT / 'memmy organiaztion.app'
BASE = pathlib.Path('/Applications/Memmy.app')
NODE = os.environ.get('NODE', 'node')
def run(*args): subprocess.run([str(x) for x in args], check=True, cwd=ROOT)
def copy(src, dst):
    if dst.exists(): shutil.rmtree(dst) if dst.is_dir() else dst.unlink()
    if src.is_dir(): shutil.copytree(src, dst, symlinks=True)
    else: dst.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(src,dst)
def patch(path, old, new):
    s = path.read_text()
    assert old in s, f'missing patch target {path}: {old}'
    path.write_text(s.replace(old,new))
OUT.mkdir(parents=True, exist_ok=True)
copy(BASE, APP)
if STAGE.exists(): shutil.rmtree(STAGE)
run(NODE, ROOT/'node_modules/@electron/asar/bin/asar.js', 'extract', BASE/'Contents/Resources/app.asar', STAGE)
copy(ROOT/'App/shell/desktop/dist/main', STAGE/'dist/main')
copy(ROOT/'App/shell/desktop/dist/preload', STAGE/'dist/preload')
copy(ROOT/'App/frontend/desktop/dist', STAGE/'dist/renderer')
for name, directory in [('backend','App/backend'),('agent-source-core','AgentSourceCore'),('migrations','Migrations'),('local-api-contracts','App/backend/local-api-contracts'),('desktop-interface','App/shell/desktop/interface'),('knowledge','Knowledge')]:
    source = ROOT/directory
    if (source/'dist').exists(): copy(source/'dist', STAGE/'node_modules/@memmy'/name/'dist')
    if (source/'package.json').exists(): copy(source/'package.json', STAGE/'node_modules/@memmy'/name/'package.json')
agent = STAGE/'dist/runtime/memmy-agent'
copy(ROOT/'App/memmy-agent/dist', agent/'dist')
copy(ROOT/'App/memmy-agent/package.json',agent/'package.json')
# Keep the installed Electron-compatible native dependency tree; update workspace packages.
for destroot in [agent/'node_modules', APP/'Contents/Resources/memory-runtime/node_modules']:
    for name in ['agent-source-core','migrations','local-api-contracts','knowledge']:
        src=STAGE/'node_modules/@memmy'/name
        if src.exists(): copy(src,destroot/'@memmy'/name)
mem=APP/'Contents/Resources/memory-runtime'
copy(ROOT/'Memory/dist',mem/'dist')
copy(ROOT/'Memory/package.json',mem/'package.json')
metadata=json.loads((mem/'memory-runtime.json').read_text());metadata['version']='2.1.4';metadata['buildId']=hashlib.sha256((mem/'dist/src/service/session/episode-selection.js').read_bytes()).hexdigest();(mem/'memory-runtime.json').write_text(json.dumps(metadata,indent=2))
copy(ROOT/'AgentSourceCore/dist',mem/'AgentSourceCore/dist')
patch(mem/'dist/src/server/index.js','startAgentSourceAutomation: true','startAgentSourceAutomation: false')
main=STAGE/'dist/main/main.js'
patch(main,'app.setName("Memmy")','app.setName("memmy organiaztion")')
patch(main,'const userDataPath = windowsDataLayout?.userDataPath ?? resolveDesktopUserDataPath(edition);','const userDataPath = process.env.MEMMY_ORGANIZATION_DATA + "/desktop";')
patch(main,'const memmyHome = windowsDataLayout?.runtimeHomePath ?? resolveDesktopRuntimeHomePath(edition);','const memmyHome = process.env.MEMMY_HOME;')
patch(main,'function triggerAgentSourceAutoInject(reason) {','function triggerAgentSourceAutoInject(reason) { return;')
patch(main,'function startRequiredUpdateBackgroundChecks() {','function startRequiredUpdateBackgroundChecks() { return;')
patch(main,'async function checkForUpdates() {','async function checkForUpdates() { return { status: "not-configured", currentVersion: "1.2.2" };')
patch(main,'async function installCliTools() {','async function installCliTools() { throw new Error("测试版不安装全局 CLI，请使用独立测试界面。");')
patch(STAGE/'node_modules/@memmy/backend/dist/src/services/agent-source-auto-inject-service.js','async runOnce() {','async runOnce() { return { ok: true, skipped: true, reason: "isolated_test_build", installed: [], failed: [] };')
# Independent defaults, including all fallback clients in the packaged JS.
for base in [STAGE/'dist/main',STAGE/'node_modules/@memmy',agent/'dist',mem/'dist/src']:
    for f in base.rglob('*.js'):
        s=f.read_text().replace("com.memtensor.memmy-memory", "com.memtensor.memmy-organization-memory")
        for before,after in [('18960','28960'),('18970','28970'),('18980','28980')]: s=s.replace(before,after)
        f.write_text(s)
bootstrap='''import { app } from 'electron';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
const base = process.env.MEMMY_ORGANIZATION_TEST_ROOT || join(homedir(), 'Library/Application Support/memmy organiaztion');
const home = join(base, 'sandbox-home');
const runtime = join(base, 'runtime');
for (const p of [base, home, runtime, join(base,'desktop')]) mkdirSync(p,{recursive:true});
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = join(home,'.config');
process.env.XDG_DATA_HOME = join(home,'.local/share');
process.env.XDG_CACHE_HOME = join(home,'.cache');
process.env.MEMMY_ORGANIZATION_DATA = base;
process.env.MEMMY_HOME = runtime;
process.env.MEMMY_CONFIG = join(runtime,'config.yaml');
process.env.MEMMY_MEMORY_DB = process.env.MEMORY_SERVICE_DB = join(runtime,'memory-service/memory.sqlite');
process.env.MEMMY_MEMORY_URL = process.env.MEMORY_SERVICE_URL = 'http://127.0.0.1:28960';
process.env.MEMMY_MEMORY_PORT = process.env.MEMORY_SERVICE_PORT = '28960';
process.env.MEMMY_AGENT_WORKSPACE = join(runtime,'workspace');
process.env.MEMMY_PACKAGED_RENDERER_PORT = '29100';
process.env.MEMMY_PACKAGE_SIGNING = 'unsigned';
app.setPath('home', home);
app.setAppLogsPath(join(base,'logs'));
process.chdir(runtime);
app.setPath('userData',join(base,'desktop'));
if (!existsSync(process.env.MEMMY_CONFIG)) writeFileSync(process.env.MEMMY_CONFIG, JSON.stringify({
  memmyMemory: {storage: {mode:'local',backend:'sqlite',sqlitePath:process.env.MEMMY_MEMORY_DB,endpoint:process.env.MEMMY_MEMORY_URL},algorithm:{session:{turnJudge:true,turnJudgeKeepInput:true,followUpMode:'merge_follow_ups'}},agentAccess:{autoScanKnownAgents:false,watchFileChanges:false,autoInjectSkill:false}},
  channels:{websocket:{port:28980}},gateway:{port:28970,heartbeat:{enabled:false}},fileMemory:{enabled:false}
},null,2),{mode:0o600});
import('./dist/main/main.js').catch(error => { writeFileSync(join(base,'startup-error.log'),String(error.stack || error)); app.exit(1); });
'''
(STAGE/'organization-bootstrap.mjs').write_text(bootstrap)
p=json.loads((STAGE/'package.json').read_text());p.update(name='memmy-organization-test',productName='memmy organiaztion',version='1.2.2',main='./organization-bootstrap.mjs');(STAGE/'package.json').write_text(json.dumps(p,indent=2))
resources=APP/'Contents/Resources'
(resources/'app.asar').unlink()
shutil.rmtree(resources/'app.asar.unpacked')
run(NODE,ROOT/'node_modules/@electron/asar/bin/asar.js','pack',STAGE,resources/'app.asar','--unpack-dir','**')
plistpath=APP/'Contents/Info.plist'
p=plistlib.loads(plistpath.read_bytes())
p.update(CFBundleName='memmy organiaztion',CFBundleDisplayName='memmy organiaztion',CFBundleIdentifier='cn.memtensor.memmy.organization-test',CFBundleShortVersionString='1.2.2',CFBundleVersion='1.2.2')
p.pop('CFBundleURLTypes',None)
# Electron verifies the archive header hash, even for local ad-hoc signatures.
header=subprocess.check_output([NODE,'--input-type=module','-e',"import {getRawHeader} from '@electron/asar'; process.stdout.write(getRawHeader(process.argv[1]).headerString)",str(resources/'app.asar')],cwd=ROOT)
p['ElectronAsarIntegrity']={'Resources/app.asar':{'algorithm':'SHA256','hash':hashlib.sha256(header).hexdigest()}}
plistpath.write_bytes(plistlib.dumps(p))
for f in (APP/'Contents/Frameworks').glob('Memmy Helper*.app/Contents/Info.plist'):
    p=plistlib.loads(f.read_bytes());p['CFBundleIdentifier']=p['CFBundleIdentifier'].replace('cn.memtensor.memmy','cn.memtensor.memmy.organization-test');f.write_bytes(plistlib.dumps(p))
p=plistlib.loads(plistpath.read_bytes());p['CFBundleExecutable']='memmy organiaztion';plistpath.write_bytes(plistlib.dumps(p))
(APP/'Contents/MacOS/Memmy').rename(APP/'Contents/MacOS/memmy organiaztion')
for helper in (APP/'Contents/Frameworks').glob('Memmy Helper*.app'):
    path=helper/'Contents/Info.plist';p=plistlib.loads(path.read_bytes());old=p['CFBundleExecutable'];new=old.replace('Memmy','memmy organiaztion');p.update(CFBundleExecutable=new,CFBundleName=new,CFBundleDisplayName=new);path.write_bytes(plistlib.dumps(p));(helper/'Contents/MacOS'/old).rename(helper/'Contents/MacOS'/new);helper.rename(helper.with_name(helper.name.replace('Memmy','memmy organiaztion')))
run('/usr/bin/codesign','--force','--deep','--sign','-',APP)
run('/usr/bin/codesign','--verify','--deep','--strict',APP)
print(APP)
