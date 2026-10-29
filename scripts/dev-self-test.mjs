#!/usr/bin/env node
/**
 * Run the real Electron app against a separate profile without stopping an installed Memmy.
 * node scripts/dev-self-test.mjs --prepare
 * node scripts/dev-self-test.mjs --start --skip-build
 * Stable acceptance mode is the default; add --watch only for source development.
 * The profile retains a private config/app-settings snapshot with account and model state.
 * Copied source bindings and scan journals are discarded. No workspace, browser profile,
 * recordings, schedules, or Memory database is copied. Quit this app before restarting it.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync, backup } from 'node:sqlite';
import { superviseDesktop } from './internal/shared/dev-desktop-supervisor.mjs';

const repo = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const require = createRequire(path.join(repo, 'package.json'));
const YAML = require('yaml');
const seedSanitizationVersion = 1;
const options = { action: 'help', skipBuild: false, watch: false, profile: path.join(repo, '.tmp', 'dev-self-test'),
  portBase: 43160, edition: 'cn', runtimeNode: process.env.MEMMY_RUNTIME_NODE_PATH || process.execPath };
const valueOptions = new Map([
  ['--profile', 'profile'], ['--port-base', 'portBase'], ['--edition', 'edition'],
  ['--runtime-node', 'runtimeNode'], ['--source-config', 'sourceConfig'], ['--source-db', 'sourceDb'],
]);
for (let index = 2; index < process.argv.length; index++) {
  const arg = process.argv[index];
  if (arg === '--prepare' || arg === '--start') options.action = arg.slice(2);
  else if (arg === '--skip-build') options.skipBuild = true;
  else if (arg === '--watch') options.watch = true;
  else if (arg === '--help' || arg === '-h') options.action = 'help';
  else if (valueOptions.has(arg)) {
    const value = process.argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${arg}`);
    options[valueOptions.get(arg)] = value;
  } else throw new Error(`Unknown argument: ${arg}`);
}
// An explicit development opt-in takes precedence; otherwise acceptance stays stable.
const stableRenderer = options.watch || process.env.MEMMY_STABLE_ELECTRON_DEMO?.trim() === '0' ? '0' : '1';

function record(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
function assertCheckoutDestination(file) {
  let existing = file;
  while (!fs.lstatSync(existing, { throwIfNoEntry: false })) existing = path.dirname(existing);
  const resolved = fs.realpathSync(existing);
  if (resolved !== repo && !inside(repo, resolved)) throw new Error(`Build destination escaped this checkout: ${file}`);
}
function privateDirectory(directory) {
  if (fs.lstatSync(directory, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Profile directory is a symbolic link: ${directory}`);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
}
function writePrivate(file, contents) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Profile file is a symbolic link: ${file}`);
  fs.writeFileSync(file, contents, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function readConfig(file) {
  try {
    const config = YAML.parse(fs.readFileSync(file, 'utf8'));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('not an object');
    return config;
  } catch { throw new Error(`Config cannot be read as a YAML object: ${file}. Its contents were not logged.`); }
}
function log(message) { process.stdout.write(`[dev-self-test] ${message}\n`); }
let leasePath;
function acquireLease(file) {
  if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Launcher lock cannot be a symbolic link');
  try {
    const descriptor = fs.openSync(file, 'wx', 0o600);
    fs.writeFileSync(descriptor, String(process.pid));
    fs.closeSync(descriptor);
    leasePath = file;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(fs.readFileSync(file, 'utf8'));
    if (alive(pid)) throw new Error(`Another self-test launcher is using this profile (PID ${pid})`);
    fs.rmSync(file);
    acquireLease(file);
  }
}

async function prepare() {
  if (process.platform !== 'darwin') throw new Error('This launcher currently supports macOS only.');
  if (!['cn', 'intl'].includes(options.edition)) throw new Error('--edition must be cn or intl');
  options.portBase = Number(options.portBase);
  if (!Number.isInteger(options.portBase) || options.portBase < 30000 || options.portBase > 59994)
    throw new Error('--port-base must be an integer from 30000 to 59994');
  if ([47321, 47322, 47323].includes(options.portBase + 5))
    throw new Error('--port-base must keep the external browser bridge outside the ordinary extension discovery ports 47321-47323');
  const temporaryRoot = path.join(repo, '.tmp');
  privateDirectory(temporaryRoot);
  const profile = path.resolve(options.profile);
  if (!inside(fs.realpathSync(temporaryRoot), profile)) throw new Error('--profile must be inside this checkout\'s .tmp directory');
  privateDirectory(profile);
  if (!inside(fs.realpathSync(temporaryRoot), fs.realpathSync(profile))) throw new Error('Profile resolves outside this checkout\'s .tmp directory');
  const previousProfile = readJson(path.join(profile, 'profile.json'));
  if (previousProfile && (previousProfile.repo !== repo || previousProfile.edition !== options.edition))
    throw new Error('Existing profile belongs to another checkout or edition; choose a different --profile');
  acquireLease(path.join(profile, 'launcher.lock'));
  // Native AF_UNIX paths on macOS have a small length limit. A worktree path is too long.
  const socketTemporary = path.join('/private/tmp', `memmy-self-${createHash('sha256').update(profile).digest('hex').slice(0, 12)}`);
  const paths = { root: profile, appData: path.join(profile, 'app-data'),
    runtime: path.join(profile, 'runtime'), workspace: path.join(profile, 'workspace'),
    tasks: path.join(profile, 'tasks'), logs: path.join(profile, 'logs'),
    temp: socketTemporary, sessionData: path.join(profile, 'session-data'),
    downloads: path.join(profile, 'downloads'), documents: path.join(profile, 'documents'),
    crashes: path.join(profile, 'crash-dumps') };
  // Both editions intentionally use the same directory name in desktop-edition.ts.
  paths.userData = path.join(paths.appData, 'Memmy');
  paths.config = path.join(paths.runtime, 'config.yaml');
  paths.database = path.join(paths.userData, 'app.sqlite');
  paths.memoryHome = path.join(paths.runtime, 'memory-service');
  paths.memoryDatabase = path.join(paths.memoryHome, 'memory.sqlite');
  paths.run = path.join(profile, 'run.json');
  paths.restartRequest = path.join(profile, 'restart-request.json');
  for (const directory of [paths.appData, paths.userData, paths.runtime, paths.workspace, paths.tasks,
    paths.logs, paths.sessionData, paths.downloads, paths.documents, paths.crashes, paths.memoryHome]) {
    privateDirectory(directory);
    if (!inside(profile, fs.realpathSync(directory))) throw new Error(`Directory escaped the profile: ${directory}`);
  }
  if (fs.existsSync(paths.temp) && fs.statSync(paths.temp).uid !== process.getuid())
    throw new Error('Native socket temporary directory has another owner');
  privateDirectory(paths.temp);
  const running = readJson(paths.run);
  if (alive(running?.launcherPid) || alive(running?.electronPid) || alive(running?.vitePid))
    throw new Error(`This self-test profile is already running. Quit its Electron window/launcher before restarting. Profile: ${profile}`);
  const defaultRuntime = path.join(os.homedir(), '.memmy');
  const sourceConfig = path.resolve(options.sourceConfig || path.join(defaultRuntime, 'config.yaml'));
  const sourceDb = path.resolve(options.sourceDb || path.join(os.homedir(), 'Library', 'Application Support',
    'Memmy', 'app.sqlite'));
  if (sourceConfig === paths.config || sourceDb === paths.database) throw new Error('The source must be separate from the self-test profile');
  for (const file of [paths.config, paths.database]) if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink())
    throw new Error(`Profile file cannot be a symbolic link: ${file}`);
  if (!fs.existsSync(paths.config)) {
    if (!fs.existsSync(sourceConfig)) throw new Error('No source config found; provide --source-config with an existing account/model config.');
    const config = readConfig(sourceConfig);
    writePrivate(paths.config, YAML.stringify(config));
  }
  let copiedDatabase = false;
  if (!fs.existsSync(paths.database) && fs.existsSync(sourceDb)) {
    const source = new DatabaseSync(sourceDb, { readOnly: true });
    try { await backup(source, paths.database); } finally { source.close(); }
    fs.chmodSync(paths.database, 0o600);
    copiedDatabase = true;
  }
  // Keep account/model configuration and explicit browser/Computer Use testing capabilities.
  // Never start copied IM channels or arbitrary user MCP servers in a second app instance.
  const config = readConfig(paths.config);
  if (record(config.app).userMode === 'account' && !fs.existsSync(paths.database))
    throw new Error('Account mode requires the matching source app.sqlite snapshot; provide --source-db.');
  config.channels = { websocket: { ...record(record(config.channels).websocket),
    enabled: true, host: '127.0.0.1', port: options.portBase + 2, tokenIssueSecret: randomBytes(32).toString('hex'),
    websocketRequiresToken: true } };
  delete config.channels.websocket.token;
  config.gateway = { ...record(config.gateway), host: '127.0.0.1', port: options.portBase + 1,
    heartbeat: { ...record(record(config.gateway).heartbeat), enabled: false } };
  config.agents = { ...record(config.agents), defaults: { ...record(record(config.agents).defaults), workspace: paths.workspace } };
  config.memmyMemory = { ...record(config.memmyMemory), storage: { ...record(record(config.memmyMemory).storage),
    mode: 'local', backend: 'sqlite', sqlitePath: paths.memoryDatabase,
    endpoint: `http://127.0.0.1:${options.portBase}`, token: randomBytes(32).toString('hex') },
    agentAccess: { autoScanKnownAgents: false, watchFileChanges: false, autoInjectSkill: false } };
  config.tools = { ...record(config.tools), mcpServers: {
    memmy_computer_use: { type: 'stdio', command: 'open-computer-use', args: ['mcp'] } } };
  config.fileMemory = { enabled: false };
  writePrivate(paths.config, YAML.stringify(config));
  const sanitizeSeed = copiedDatabase || previousProfile?.seedSanitizationVersion !== seedSanitizationVersion;
  if (fs.existsSync(paths.database)) {
    const database = new DatabaseSync(paths.database);
    try {
      const columns = new Set(database.prepare('PRAGMA table_info(app_settings)').all().map(row => row.name));
      const settings = { auto_update_enabled: 0, auto_scan_known_agents: 0, watch_file_changes: 0,
        auto_inject_skill: 0, stop_memory_service_on_exit: 1, default_launch_mode: 'full', last_launch_mode: 'full' };
      for (const [column, value] of Object.entries(settings)) if (columns.has(column))
        database.prepare(`UPDATE app_settings SET ${column} = ?`).run(value);
      if (sanitizeSeed) {
        // Clear only this snapshot. Copied jobs can expose paused personal ingestion and
        // contain conversations; source bindings retain original file paths and recipes.
        // Children precede parents so this also works with foreign keys enforced.
        const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
        database.exec('BEGIN');
        try {
          for (const table of ['account_agent_source_scan_messages', 'account_agent_source_scan_results',
            'account_agent_source_scan_source_state', 'account_agent_source_scan_jobs', 'account_agent_sources']) {
            if (tables.has(table)) database.exec(`DELETE FROM ${table}`);
          }
          database.exec('COMMIT');
        } catch (error) { database.exec('ROLLBACK'); throw error; }
      }
    } finally { database.close(); }
  }
  if (sanitizeSeed) {
    // History uses its own persisted intent rather than a YAML enable switch. Make the
    // initial copied profile explicitly idle; later intentional self-tests retain intent.
    const history = path.join(paths.runtime, 'computer-history');
    const histories = path.join(history, 'histories');
    const wechat = path.join(history, 'wechat');
    for (const directory of [history, histories, wechat]) privateDirectory(directory);
    writePrivate(path.join(histories, 'recording-intent.json'), JSON.stringify({ state: 'stopped' }));
    writePrivate(path.join(wechat, 'consent.json'), JSON.stringify({ version: 1, enabled: false,
      consentId: null, consentedAt: null, updatedAt: null }));
  }
  const helperApp = path.join(repo, 'App', 'native-computer-use', 'dist', 'Memmy Computer Use.app');
  paths.helper = path.join(helperApp, 'Contents', 'MacOS', 'MemmyComputerUse');
  writePrivate(path.join(profile, 'profile.json'), JSON.stringify({ repo, edition: options.edition,
    portBase: options.portBase, sourceConfig, sourceDb, paths, seedSanitizationVersion,
    preparedAt: new Date().toISOString() }, null, 2));
  // The main module sets userData from appData before acquiring its single-instance lock.
  // Set appData first; --user-data-dir by itself would be overwritten by that module.
  writePrivate(path.join(profile, 'electron-bootstrap.cjs'), `const { app } = require('electron');\n` +
    `const fs = require('node:fs');\n` +
    `const restartRequest = ${JSON.stringify(paths.restartRequest)};\n` +
    // The launcher owns Vite and the bootstrap. A bare Electron relaunch would outlive
    // its first child while the launcher tears down the renderer underneath it.
    `app.relaunch = () => {\n` +
    `  if (fs.lstatSync(restartRequest, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Invalid self-test restart file');\n` +
    `  fs.writeFileSync(restartRequest, JSON.stringify({ pid: process.pid, requestedAt: Date.now() }), { mode: 0o600 });\n` +
    `};\n` +
    Object.entries({ appData: paths.appData, sessionData: paths.sessionData, logs: paths.logs, temp: paths.temp,
      crashDumps: paths.crashes, downloads: paths.downloads, documents: paths.documents })
      .map(([name, directory]) => `app.setPath(${JSON.stringify(name)}, ${JSON.stringify(directory)});`).join('\n') + '\n' +
    `import(${JSON.stringify(pathToFileURL(path.join(repo, 'App/shell/desktop/dist/main/main.js')).href)})` +
    `.catch(error => { fs.writeFileSync(${JSON.stringify(path.join(paths.logs, 'desktop-startup-error.json'))}, JSON.stringify({ name: error?.name, code: error?.code, message: error?.message, stack: error?.stack }, null, 2), { mode: 0o600 }); console.error('Self-test desktop startup failed; see desktop-startup-error.json in profile logs.'); app.exit(1); });\n`);
  const frontendRequire = createRequire(path.join(repo, 'App/frontend/desktop/package.json'));
  const viteEntry = frontendRequire.resolve('vite');
  writePrivate(path.join(profile, 'vite.config.mjs'),
    `import original from ${JSON.stringify(path.join(repo, 'App/frontend/desktop/vite.config.ts'))};\n` +
    `import { mergeConfig } from ${JSON.stringify(viteEntry)};\n` +
    `export default context => mergeConfig(typeof original === 'function' ? original(context) : original, ` +
    JSON.stringify({ server: { host: '127.0.0.1', port: options.portBase + 3, strictPort: true,
      hmr: { host: '127.0.0.1', port: options.portBase + 4 } } }) + ');\n');
  log(`Prepared isolated profile: ${profile}`);
  log('Account/model and app settings retained privately; copied source bindings and scan journals discarded on first preparation.');
  return paths;
}

async function portIsFree(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}
function runBuild(executable, args, label) {
  log(label);
  const result = spawnSync(executable, args, { cwd: repo, stdio: 'inherit', env: { ...process.env,
    PATH: `${path.dirname(options.runtimeNode)}${path.delimiter}${process.env.PATH || ''}` } });
  if (result.status !== 0) throw new Error(`${label} failed. No desktop app was launched.`);
}
async function start(paths) {
  options.runtimeNode = fs.realpathSync(options.runtimeNode);
  if (!options.skipBuild) {
    const helperApp = path.join(repo, 'App', 'native-computer-use', 'dist', 'Memmy Computer Use.app');
    // Validate existing ancestors before the build can copy/sign any native output.
    for (const destination of [paths.helper, path.join(helperApp, 'Contents', 'Resources'),
      path.join(helperApp, 'Contents', 'SharedSupport'), path.join(repo, 'App', 'native-computer-use',
        '.build', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-release`)]) assertCheckoutDestination(destination);
    runBuild('bash', [path.join(repo, 'scripts/internal/mac/build-memmy-computer-use.sh'),
      helperApp, process.arch, '-'], 'Building and locally signing this checkout\'s native Computer Use helper');
    runBuild('npm', ['run', 'build:runtime', '-w', '@memmy/desktop'], 'Building current Memory and Agent sources');
    runBuild('npm', ['run', 'build', '-w', '@memmy/desktop'], 'Building current desktop shell and renderer');
  }
  const main = path.join(repo, 'App/shell/desktop/dist/main/main.js');
  for (const file of [main, path.join(repo, 'App/shell/desktop/dist/preload/preload.cjs'),
    path.join(repo, 'Memory/dist/src/server/index.js'), path.join(repo, 'App/memmy-agent/dist/main.js'), paths.helper]) {
    if (!fs.existsSync(file)) throw new Error(`Build prerequisite missing: ${file}`);
  }
  const realHelper = fs.realpathSync(paths.helper);
  if (!inside(repo, realHelper)) throw new Error('The native helper must belong to this checkout; an installed Memmy helper is not allowed.');
  // Avoid ABI repair here: shared node_modules may also be in use by another checkout.
  const sqliteCheck = spawnSync(options.runtimeNode, ['--input-type=module', '-e',
    `import {createRequire} from 'node:module';\n` +
    [path.join(repo, 'Memory/package.json'), path.join(repo, 'App/memmy-agent/package.json')]
      .map(file => `{const Database=createRequire(${JSON.stringify(file)})('better-sqlite3');const db=new Database(':memory:');db.close();}`).join('\n')],
    { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'] });
  if (sqliteCheck.status !== 0) {
    writePrivate(path.join(paths.logs, 'sqlite-preflight.log'), sqliteCheck.stderr || 'SQLite ABI check failed');
    throw new Error(`SQLite native ABI does not match ${options.runtimeNode}. See ${path.join(paths.logs, 'sqlite-preflight.log')}; select a compatible --runtime-node or repair only this checkout's dependencies.`);
  }
  for (let offset = 0; offset < 6; offset++) if (!await portIsFree(options.portBase + offset))
    throw new Error(`Port ${options.portBase + offset} is already occupied; no process was stopped. Use another --port-base.`);
  const config = readConfig(paths.config);
  const env = { ...process.env, MEMMY_HOME: paths.runtime, MEMMY_CONFIG: paths.config,
    MEMMY_AGENT_DATA_DIR: paths.runtime, MEMMY_AGENT_WORKSPACE: paths.workspace, MEMMY_AGENT_TASKS_DIR: paths.tasks,
    MEMMY_MEMORY_HOME: paths.memoryHome, MEMORY_SERVICE_HOME: paths.memoryHome,
    MEMMY_MEMORY_DB: paths.memoryDatabase, MEMORY_SERVICE_DB: paths.memoryDatabase,
    MEMMY_MEMORY_URL: `http://127.0.0.1:${options.portBase}`, MEMORY_SERVICE_URL: `http://127.0.0.1:${options.portBase}`,
    MEMMY_MEMORY_TOKEN: config.memmyMemory.storage.token, MEMORY_SERVICE_TOKEN: config.memmyMemory.storage.token,
    MEMMY_MEMORY_LAYER_URL: `http://127.0.0.1:${options.portBase}`, MEMMY_MEMORY_LAYER_TOKEN: config.memmyMemory.storage.token,
    MEMMY_EXTERNAL_BROWSER_BRIDGE_PORT: String(options.portBase + 5),
    MEMMY_RUNTIME_NODE_PATH: options.runtimeNode, MEMMY_RUNTIME_CONFIG_PATH: path.join(paths.runtime, 'runtime.json'),
    VITE_MEMMY_AGENT_WEBUI_URL: `http://127.0.0.1:${options.portBase + 2}`,
    MEMMY_RENDERER_URL: `http://127.0.0.1:${options.portBase + 3}`,
    MEMMY_STABLE_ELECTRON_DEMO: stableRenderer,
    MEMMY_DEV_COMPUTER_USE_BINARY: realHelper, MEMMY_ACCOUNT_CHANNEL: options.edition === 'cn' ? 'phone' : 'email',
    MEMMY_APP_EDITION: options.edition, TMPDIR: paths.temp, TMP: paths.temp, TEMP: paths.temp,
    PATH: `${path.dirname(options.runtimeNode)}${path.delimiter}${process.env.PATH || ''}` };
  // Never let a shell's package/previous-process settings override the isolated profile.
  for (const name of ['ELECTRON_RUN_AS_NODE', 'MEMMY_TEST_PROFILE_ROOT', 'MEMMY_TEST_PORT_BASE',
    'MEMMY_ENABLE_SIGNED_TEST_PROFILE', 'MEMMY_MIGRATIONS_READY_CONFIG', 'MEMMY_MIGRATIONS_READY_WORKSPACE',
    'MEMMY_MIGRATIONS_READY_SESSION_DAG', 'MEMMY_MIGRATIONS_READY_APP_DATABASE', 'MEMMY_APP_DATABASE',
    'OPEN_COMPUTER_USE_AGENT_SOCKET_NAMESPACE', 'MEMMY_LOCKED_MAC_CONSENT_FILE', 'MEMMY_AGENT_SESSION_DAG_DIR']) delete env[name];
  const artifacts = [main, path.join(repo, 'App/shell/desktop/dist/preload/preload.cjs'),
    path.join(repo, 'Memory/dist/src/server/index.js'), path.join(repo, 'App/memmy-agent/dist/main.js'), realHelper];
  const gitHead = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).stdout?.trim();
  const changedFiles = [...new Set([
    ...spawnSync('git', ['diff', 'HEAD', '--name-only', '-z'], { cwd: repo, encoding: 'utf8' }).stdout.split('\0'),
    ...spawnSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' }).stdout.split('\0'),
  ].filter(Boolean))];
  const changedSources = changedFiles.map(relative => {
    const file = path.join(repo, relative);
    return { file: relative, sha256: fs.lstatSync(file, { throwIfNoEntry: false })?.isFile()
      ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null };
  });
  writePrivate(path.join(paths.root, 'launch-provenance.json'), JSON.stringify({ repo, gitHead, changedFiles, changedSources,
    runtimeNode: options.runtimeNode, buildSkipped: options.skipBuild, rendererMode: stableRenderer === '1' ? 'stable' : 'watch',
    launchedAt: new Date().toISOString(),
    artifacts: artifacts.map(file => ({ file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
      modifiedAt: fs.statSync(file).mtime.toISOString() })) }, null, 2));
  const children = [];
  function launch(executable, args, name, cwd) {
    const output = fs.openSync(path.join(paths.logs, `${name}.log`), 'a', 0o600);
    const child = spawn(executable, args, { cwd, env, stdio: ['ignore', output, output] });
    fs.closeSync(output);
    children.push(child);
    child.on('error', () => log(`${name} failed to start; see ${paths.logs}`));
    return child;
  }
  const frontendRequire = createRequire(path.join(repo, 'App/frontend/desktop/package.json'));
  const vitePackage = frontendRequire.resolve('vite/package.json');
  const vite = launch(options.runtimeNode, [path.join(path.dirname(vitePackage), 'bin/vite.js'),
    '--config', path.join(paths.root, 'vite.config.mjs')], 'renderer', path.join(repo, 'App/frontend/desktop'));
  writePrivate(paths.run, JSON.stringify({ launcherPid: process.pid, vitePid: vite.pid, repo, startedAt: new Date().toISOString() }));
  try {
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline && vite.exitCode === null && vite.signalCode === null) {
      try { const response = await fetch(env.MEMMY_RENDERER_URL, { signal: AbortSignal.timeout(1_000) }); ready = response.ok; } catch { /* Server is starting. */ }
      if (ready) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error(`Renderer did not start; see ${path.join(paths.logs, 'renderer.log')}`);
    const desktopRequire = createRequire(path.join(repo, 'App/shell/desktop/package.json'));
    if (fs.lstatSync(paths.restartRequest, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error('Restart request cannot be a symbolic link');
    fs.rmSync(paths.restartRequest, { force: true });
    let stopping = false;
    const stop = () => {
      stopping = true;
      for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    vite.once('close', stop);
    try {
      process.exitCode = await superviseDesktop({
        restartRequestPath: paths.restartRequest,
        launch: () => launch(desktopRequire('electron'), [path.join(paths.root, 'electron-bootstrap.cjs')], 'desktop', repo),
        isStopping: () => stopping,
        onLaunched: electron => {
          writePrivate(paths.run, JSON.stringify({ launcherPid: process.pid, vitePid: vite.pid, electronPid: electron.pid,
            repo, startedAt: new Date().toISOString() }));
          log(`Launched real Electron app; gateway and Memory health still require validation. Profile: ${paths.root}`);
          log(`Renderer: ${env.MEMMY_RENDERER_URL}; logs: ${paths.logs}`);
          log(env.MEMMY_STABLE_ELECTRON_DEMO === '1'
            ? 'Stable acceptance mode: source watching disabled. Hot updates can destroy current browser tab connections; keep this mode for acceptance. Rebuild and restart the full launcher after code changes.'
            : 'Watch mode: source hot updates can reload the renderer and destroy current browser tab connections. Use stable mode for acceptance; main/preload changes still require a restart.');
          log('In-app restart keeps the renderer running. Quit the app or press Ctrl+C here to stop.');
        },
        beforeRestart: async () => {
          const deadline = Date.now() + 30_000;
          while (!stopping && Date.now() < deadline) {
            const free = await Promise.all([0, 1, 2, 5].map(offset => portIsFree(options.portBase + offset)));
            if (free.every(Boolean)) return;
            await new Promise(resolve => setTimeout(resolve, 250));
          }
          if (!stopping) throw new Error('Previous self-test services did not stop; no replacement app was launched.');
        },
        onRestart: () => log('Restarting the self-test desktop with the same profile and running renderer.'),
      });
    } finally {
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      vite.removeListener('close', stop);
    }
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    fs.rmSync(paths.run, { force: true });
  }
}

if (options.action === 'help') {
  process.stdout.write(`Usage: node scripts/dev-self-test.mjs --prepare | --start [--skip-build] [--watch]\n` +
    `Options: --profile <checkout/.tmp/path> --port-base <30000-59994> --edition cn|intl\n` +
    `         --runtime-node <absolute Node executable> --source-config <config.yaml> --source-db <app.sqlite>\n` +
    `Requires Node with node:sqlite backup (Node 22.16+), installed workspace dependencies,\n` +
    `and macOS Swift/signing tools for the native helper build (or an existing helper with --skip-build).\n` +
    `--prepare snapshots config/app settings on first use, discards copied source/scan data,\n` +
    `and creates an idle History profile and bootstrap; it launches nothing.\n` +
    `--start builds the local native helper (ad hoc signature), runtime, and desktop unless\n` +
    `--skip-build is passed, then runs Vite and the full Electron app.\n` +
    `Stable acceptance mode is the default (MEMMY_STABLE_ELECTRON_DEMO=1).\n` +
    `--watch enables source hot updates and overrides the environment; explicit\n` +
    `MEMMY_STABLE_ELECTRON_DEMO=0 also enables watching. Hot updates can destroy\n` +
    `current browser tab connections; use stable mode for acceptance.\n` +
    `Renderer mode: ${stableRenderer === '1' ? 'stable' : 'watch'}\n`);
} else {
  try { const paths = await prepare(); if (options.action === 'start') await start(paths); }
  catch (error) { process.stderr.write(`[dev-self-test] ${error.message}\n`); process.exitCode = 1; }
  finally {
    if (leasePath && fs.existsSync(leasePath) && fs.readFileSync(leasePath, 'utf8') === String(process.pid)) fs.rmSync(leasePath);
  }
}
