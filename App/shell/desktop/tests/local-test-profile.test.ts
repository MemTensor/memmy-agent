import { afterEach, describe, expect, it } from 'vitest';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import YAML from 'yaml';
import { applyLocalTestProfileEnvironment, prepareLocalTestProfile } from '../src/main/local-test-profile.js';
import { preparePackagedRuntimeConfig } from '../src/main/runtime-services.js';

const roots: string[] = [];
const freshRoot = () => {
  const root = mkdtempSync(join(tmpdir(), 'memmy-isolated-profile-'));
  roots.push(root);
  return root;
};
const prepare = (root: string, overrides: Record<string, unknown> = {}) => prepareLocalTestProfile({
  requestedRoot: root,
  manifest: '{"signing":"unsigned"}',
  platform: 'darwin',
  isPackaged: true,
  env: { HOME: join(root, 'home') },
  ...overrides,
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('local packaged test profile', () => {
  it('puts Electron, Agent, Memory, browser and export paths in one disposable root', async () => {
    const profile = prepare(freshRoot());
    expect(profile).not.toBeNull();
    if (!profile) return;
    const env: NodeJS.ProcessEnv = { HOME: profile.home, MEMMY_AGENT_WORKSPACE: '/Users/real/workspace',
      MEMMY_MEMORY_DB: '/Users/real/memory.sqlite', CODEX_HOME: '/Users/real/.codex',
      CLAUDE_CONFIG_DIR: '/Users/real/.claude', OPENAI_CODEX_TOKEN_PATH: '/Users/real/token.json' };
    applyLocalTestProfileEnvironment(profile, env);
    for (const path of [profile.home, profile.appData, profile.userData, profile.sessionData,
      profile.logs, profile.temp, profile.crashDumps, profile.downloads, profile.documents, profile.runtimeHome,
      profile.workspace, profile.memoryDatabase, env.MEMMY_CONFIG, env.MEMMY_AGENT_DATA_DIR,
      env.MEMMY_AGENT_TASKS_DIR, env.CODEX_HOME, env.XDG_CONFIG_HOME, env.TMPDIR,
      env.CLAUDE_CONFIG_DIR, env.OPENCODE_CONFIG_DIR, env.OPENCLAW_STATE_DIR,
      env.WORKBUDDY_CONFIG_DIR, env.OPENAI_CODEX_TOKEN_PATH]) {
      expect(relative(profile.root, path!)).not.toMatch(/^\.\./);
    }
    expect(env.MEMMY_MEMORY_DB).toBe(profile.memoryDatabase);
    expect(env.MEMORY_SERVICE_DB).toBe(profile.memoryDatabase);
    expect(env.MEMMY_MEMORY_URL).toBe(`http://127.0.0.1:${profile.portBase}`);
    expect(profile.portBase).toBeGreaterThanOrEqual(30000);
    expect(profile.portBase + 2).toBeLessThanOrEqual(59999);

    const config = await preparePackagedRuntimeConfig({ env, writeConfig: true });
    const saved = YAML.parse(readFileSync(config.configPath, 'utf8'));
    expect(config.configPath).toBe(join(profile.runtimeHome, 'config.yaml'));
    expect(config.memoryDatabasePath).toBe(profile.memoryDatabase);
    expect(config.agentWorkspace).toBe(profile.workspace);
    expect(config.memoryBaseUrl).toBe(`http://127.0.0.1:${profile.portBase}`);
    expect(config.agentGatewayBaseUrl).toBe(`http://127.0.0.1:${profile.portBase + 2}`);
    expect(saved.memmyMemory.storage.sqlitePath).toBe(profile.memoryDatabase);
    expect(saved.memmyMemory.storage.endpoint).toBe(config.memoryBaseUrl);
    expect(saved.channels.websocket.port).toBe(profile.portBase + 2);
    expect(saved.gateway.port).toBe(profile.portBase + 1);
    expect(saved.agents.defaults.workspace).toBe(profile.workspace);
  });

  it('cannot activate in an unmarked signed package, Windows package or ordinary developer run', () => {
    const root = freshRoot();
    for (const overrides of [
      { manifest: '{"signing":"signed"}' },
      { manifest: null },
      { platform: 'win32' },
      { isPackaged: false },
    ]) expect(() => prepare(root, overrides)).toThrow('requires an unsigned macOS test package or a marked signed local package');
  });

  it('opens a marked signed local build only with the explicit switch and release signing Team ID', () => {
    const root = freshRoot();
    const manifest = '{"signing":"signed","localTestProfile":"signed-local"}';
    const signedOptions = { manifest, signedTeamIdentifier: 'S7NLXHGBJ2' };
    expect(() => prepare(root, signedOptions)).toThrow('requires MEMMY_TEST_PROFILE_ROOT and MEMMY_ENABLE_SIGNED_TEST_PROFILE=1');
    expect(() => prepare(root, { ...signedOptions, env: { HOME: join(root, 'home'), MEMMY_ENABLE_SIGNED_TEST_PROFILE: '1' },
      signedTeamIdentifier: null })).toThrow('release Team ID');
    expect(() => prepare(root, { ...signedOptions, env: { HOME: join(root, 'home'), MEMMY_ENABLE_SIGNED_TEST_PROFILE: '1' },
      signedTeamIdentifier: 'OTHERTEAM' })).toThrow('release Team ID');
    expect(prepare(root, { ...signedOptions,
      env: { HOME: join(root, 'home'), MEMMY_ENABLE_SIGNED_TEST_PROFILE: '1' } })?.root).toBe(realpathSync(root));
    expect(() => prepareLocalTestProfile({ manifest, platform: 'darwin', isPackaged: true, env: {},
      signedTeamIdentifier: 'S7NLXHGBJ2' })).toThrow('requires MEMMY_TEST_PROFILE_ROOT');
  });

  it('requires HOME to be redirected before module imports and rejects symlink roots', () => {
    const root = freshRoot();
    expect(() => prepare(root, { env: { HOME: '/Users/real' } })).toThrow('HOME=');
    const target = freshRoot();
    const link = join(tmpdir(), `memmy-test-link-${Date.now()}`);
    symlinkSync(target, link);
    roots.push(link);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(() => prepare(link)).toThrow('cannot be a symbolic link');
  });

  it('rejects non-temporary roots before creating user data', () => {
    expect(() => prepare('/Users/real/Library/Application Support/Memmy')).toThrow('temporary directory');
  });

  it('rejects a database symlink before any app startup writes', () => {
    const root = freshRoot();
    const appData = join(root, 'app-data', 'Memmy');
    mkdirSync(appData, { recursive: true });
    symlinkSync('/Users/real/Library/Application Support/Memmy/app.sqlite', join(appData, 'app.sqlite'));
    expect(() => prepare(root)).toThrow('file cannot be a symbolic link');
  });
});
