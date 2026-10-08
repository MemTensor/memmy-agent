import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export type LocalTestProfile = {
  root: string;
  home: string;
  appData: string;
  userData: string;
  sessionData: string;
  logs: string;
  temp: string;
  crashDumps: string;
  downloads: string;
  documents: string;
  runtimeHome: string;
  workspace: string;
  memoryDatabase: string;
  portBase: number;
};

function within(parent: string, child: string): boolean {
  const part = relative(parent, child);
  return part.length > 0 && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && !isAbsolute(part);
}

const RELEASE_MAC_TEAM_ID = 'S7NLXHGBJ2';

export function readExecutableSigningTeamIdentifier(executablePath: string): string | null {
  const result = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', executablePath], {
    encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return result.status === 0 ? /^TeamIdentifier=([A-Z0-9]+)$/m.exec(result.stderr)?.[1] ?? null : null;
}

/** Signed local packages require a build marker, an explicit launch switch, and the release Team ID. */
export function prepareLocalTestProfile(options: {
  requestedRoot?: string;
  manifest: string | null;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  env: NodeJS.ProcessEnv;
  signedTeamIdentifier?: string | null;
  temporaryDirectory?: string;
}): LocalTestProfile | null {
  const requestedRoot = options.requestedRoot?.trim();
  let manifest: { signing?: unknown; localTestProfile?: unknown } = {};
  try { manifest = JSON.parse(options.manifest ?? '{}') as typeof manifest; } catch { /* Fail closed below. */ }
  const signedLocalBuild = manifest?.signing === 'signed' && manifest.localTestProfile === 'signed-local';
  if (signedLocalBuild && (!requestedRoot || options.env.MEMMY_ENABLE_SIGNED_TEST_PROFILE !== '1')) {
    throw new Error('Signed local test build requires MEMMY_TEST_PROFILE_ROOT and MEMMY_ENABLE_SIGNED_TEST_PROFILE=1');
  }
  if (!requestedRoot) {
    if (options.env.MEMMY_ENABLE_SIGNED_TEST_PROFILE) throw new Error('Signed local test profile requires MEMMY_TEST_PROFILE_ROOT');
    return null;
  }
  if (options.platform !== 'darwin' || !options.isPackaged || !(
    manifest?.signing === 'unsigned' && !manifest.localTestProfile ||
    signedLocalBuild && options.env.MEMMY_ENABLE_SIGNED_TEST_PROFILE === '1'
      && options.signedTeamIdentifier === RELEASE_MAC_TEAM_ID
  )) {
    throw new Error('MEMMY_TEST_PROFILE_ROOT requires an unsigned macOS test package or a marked signed local package with the release Team ID');
  }
  if (!isAbsolute(requestedRoot)) throw new Error('MEMMY_TEST_PROFILE_ROOT must be an absolute temporary directory');

  const candidate = resolve(requestedRoot);
  const temporaryBases = [options.temporaryDirectory ?? tmpdir(), '/tmp', '/private/tmp']
    .filter(existsSync).map(base => realpathSync(base));
  const lexicalBases = [options.temporaryDirectory ?? tmpdir(), '/tmp', '/private/tmp'].map(base => resolve(base));
  if (!lexicalBases.some(base => {
    const name = relative(base, candidate);
    return within(base, candidate) && !name.includes(sep);
  })) {
    throw new Error('MEMMY_TEST_PROFILE_ROOT must be a direct child of a temporary directory');
  }
  const expectedHome = join(candidate, 'home');
  if (!options.env.HOME || resolve(options.env.HOME) !== expectedHome) {
    throw new Error('Launch the test build with HOME=<MEMMY_TEST_PROFILE_ROOT>/home before Electron starts');
  }
  if (lstatSync(candidate, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new Error('MEMMY_TEST_PROFILE_ROOT cannot be a symbolic link');
  }
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const root = realpathSync(candidate);
  if (!temporaryBases.some(base => within(base, root))) {
    throw new Error('MEMMY_TEST_PROFILE_ROOT resolves outside a temporary directory');
  }

  const home = join(root, 'home');
  const appData = join(root, 'app-data');
  const profile: LocalTestProfile = {
    root, home, appData,
    userData: join(appData, 'Memmy'),
    sessionData: join(root, 'session-data'),
    logs: join(root, 'logs'),
    temp: join(root, 'temp'),
    crashDumps: join(root, 'crash-dumps'),
    downloads: join(root, 'downloads'),
    documents: join(root, 'documents'),
    runtimeHome: join(home, '.memmy'),
    workspace: join(root, 'workspace'),
    memoryDatabase: join(home, '.memmy', 'memory-service', 'memory.sqlite'),
    portBase: 30000 + (createHash('sha256').update(root).digest().readUInt16BE(0) % 10000) * 3,
  };
  for (const directory of [profile.home, profile.appData, profile.userData, profile.sessionData,
    profile.logs, profile.temp, profile.crashDumps, profile.downloads, profile.documents, profile.runtimeHome,
    profile.workspace, join(profile.runtimeHome, 'memory-service')]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (!within(root, realpathSync(directory))) {
      throw new Error(`Isolated test directory resolves outside its profile root: ${directory}`);
    }
  }
  for (const file of [join(profile.userData, 'app.sqlite'), join(profile.userData, 'browser-history.json'),
    join(profile.runtimeHome, 'config.yaml'), profile.memoryDatabase]) {
    if (lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) {
      throw new Error(`Isolated test file cannot be a symbolic link: ${file}`);
    }
  }
  return profile;
}

export function applyLocalTestProfileEnvironment(profile: LocalTestProfile, env: NodeJS.ProcessEnv): void {
  env.HOME = profile.home;
  env.MEMMY_TEST_PROFILE_ROOT = profile.root;
  env.MEMMY_TEST_PORT_BASE = String(profile.portBase);
  env.MEMMY_HOME = profile.runtimeHome;
  env.MEMMY_CONFIG = join(profile.runtimeHome, 'config.yaml');
  env.MEMMY_AGENT_DATA_DIR = profile.runtimeHome;
  env.MEMMY_AGENT_WORKSPACE = profile.workspace;
  env.MEMMY_AGENT_TASKS_DIR = join(profile.root, 'tasks');
  env.MEMMY_MEMORY_HOME = join(profile.runtimeHome, 'memory-service');
  env.MEMORY_SERVICE_HOME = env.MEMMY_MEMORY_HOME;
  env.MEMMY_MEMORY_DB = profile.memoryDatabase;
  env.MEMORY_SERVICE_DB = profile.memoryDatabase;
  env.MEMMY_MEMORY_URL = `http://127.0.0.1:${profile.portBase}`;
  env.MEMORY_SERVICE_URL = env.MEMMY_MEMORY_URL;
  env.MEMMY_MEMORY_TOKEN = randomBytes(24).toString('hex');
  env.MEMORY_SERVICE_TOKEN = env.MEMMY_MEMORY_TOKEN;
  env.CODEX_HOME = join(profile.home, '.codex');
  env.XDG_CONFIG_HOME = join(profile.home, '.config');
  env.XDG_DATA_HOME = join(profile.home, '.local', 'share');
  env.XDG_CACHE_HOME = join(profile.home, '.cache');
  env.TMPDIR = profile.temp;
  env.TMP = profile.temp;
  env.TEMP = profile.temp;
  env.CLAUDE_CONFIG_DIR = join(profile.home, '.claude');
  env.OPENCODE_CONFIG_DIR = join(profile.home, '.config', 'opencode');
  env.OPENCLAW_STATE_DIR = join(profile.home, '.openclaw');
  env.OPENCLAW_CONFIG_PATH = join(env.OPENCLAW_STATE_DIR, 'openclaw.json');
  env.OPENCLAW_WORKSPACE_DIR = join(env.OPENCLAW_STATE_DIR, 'workspace');
  env.HERMES_HOME = join(profile.home, '.hermes');
  env.DSH_HOME = join(profile.home, '.dsh');
  env.WORKBUDDY_CONFIG_DIR = join(profile.home, '.workbuddy');
  env.CODEBUDDY_CONFIG_DIR = env.WORKBUDDY_CONFIG_DIR;
  env.PI_CODING_AGENT_DIR = join(profile.home, '.pi', 'agent');
  env.QWENWORK_CONFIG_DIR = join(profile.home, '.qwenworkcn');
  env.OAUTH_CLI_KIT_TOKEN_PATH = join(profile.runtimeHome, 'auth', 'codex.json');
  env.OPENAI_CODEX_TOKEN_PATH = env.OAUTH_CLI_KIT_TOKEN_PATH;
  env.CHATGPT_TOKEN_PATH = env.OAUTH_CLI_KIT_TOKEN_PATH;
}
