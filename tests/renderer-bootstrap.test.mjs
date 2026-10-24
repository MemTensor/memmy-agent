import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const verifier = fileURLToPath(new URL('../scripts/internal/shared/verify-renderer-bootstrap.mjs', import.meta.url));
const PROBE_ERROR = 'Memmy renderer bootstrap probe: runtime IPC disabled';
const roots = [];
afterEach(() => { while (roots.length) rmSync(roots.pop(), { recursive: true, force: true }); });

function verify(root, platform = 'darwin', extraArguments = []) {
  const run = spawnSync(process.execPath, [verifier, '--renderer-dir', root, '--platform', platform, ...extraArguments], {
    encoding: 'utf8', timeout: 15_000
  });
  expect(run.error).toBeUndefined();
  return { status: run.status, ...JSON.parse(run.stdout) };
}

function fixture(entrySource) {
  const root = mkdtempSync(join(tmpdir(), 'memmy-renderer-bootstrap-'));
  roots.push(root);
  writeFileSync(join(root, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="./entry.js"></script></body></html>');
  writeFileSync(join(root, 'entry.js'), entrySource);
  return root;
}

function writeRealReactFixture({ duplicate = false, catchRenderError = false } = {}) {
  const root = fixture(`
    import React from './${duplicate ? 'react-other' : 'react'}.js';
    import ReactDOM from './react-dom-client.js';
    function Startup() {
      const [status, dispatch] = React.useReducer((_previous, next) => next, 'Starting');
      React.useEffect(() => { window.memmy.getRuntimeConfig().catch(error => dispatch(error.message)); }, []);
      return React.createElement('main', null, status);
    }
    class ErrorBoundary extends React.Component {
      constructor(props) { super(props); this.state = { failed: false }; }
      static getDerivedStateFromError() { return { failed: true }; }
      componentDidCatch(error) { console.error('[renderer] react-render', error); }
      render() { return this.state.failed ? React.createElement('main', null, '${PROBE_ERROR}') : this.props.children; }
    }
    ${catchRenderError ? 'window.memmy.getRuntimeConfig().catch(() => {});' : ''}
    ReactDOM.createRoot(document.getElementById('root')).render(
      ${catchRenderError ? 'React.createElement(ErrorBoundary, null, React.createElement(Startup))' : 'React.createElement(Startup)'}
    );
  `);
  const libraries = {
    react: join(dirname(require.resolve('react/package.json')), 'cjs/react.production.js'),
    'react-other': join(dirname(require.resolve('react/package.json')), 'cjs/react.production.js'),
    'react-dom': join(dirname(require.resolve('react-dom/package.json')), 'cjs/react-dom.production.js'),
    'react-dom-client': join(dirname(require.resolve('react-dom/package.json')), 'cjs/react-dom-client.production.js'),
    scheduler: join(dirname(require.resolve('scheduler/package.json')), 'cjs/scheduler.production.js')
  };
  // Actual production React/ReactDOM, with two physical React modules when the
  // fixture requests the same dispatcher split as the broken release artifact.
  for (const [name, libraryPath] of Object.entries(libraries)) {
    const dependencies = name === 'react-dom-client'
      ? { react: 'react', 'react-dom': 'react-dom', scheduler: 'scheduler' }
      : name === 'react-dom' ? { react: 'react' } : {};
    const imports = Object.entries(dependencies).map(([key, file], index) => `import dependency${index} from './${file}.js';`).join('\n');
    const importsMap = Object.keys(dependencies).map((key, index) => `${JSON.stringify(key)}: dependency${index}`).join(',');
    writeFileSync(join(root, `${name}.js`), `${imports}\nconst dependencies={${importsMap}};\nconst require=key=>dependencies[key];\nconst module={exports:{}}; const exports=module.exports;\n${readFileSync(libraryPath, 'utf8')}\nexport default module.exports;`);
  }
  return root;
}

describe('production renderer bootstrap guard', () => {
  it.each(['darwin', 'win32'])('executes real production React startup with one shared dispatcher on %s', platform => {
    const result = verify(writeRealReactFixture(), platform);
    expect(result.status).toBe(0);
    expect(result.ok).toBe(true);
    expect(result.runtimeConfigRequests).toBeGreaterThan(0);
    expect(result.bootstrapErrorScreenReached).toBe(true);
    expect(result.rootBytes).toBeGreaterThan(0);
    expect(result.fatalErrors).toEqual([]);
    expect(result.blockedIo).toEqual([]);
  });

  it.each(['darwin', 'win32'])('rejects the real production duplicate-React white screen on %s', platform => {
    const result = verify(writeRealReactFixture({ duplicate: true }), platform);
    expect(result.status).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.runtimeConfigRequests).toBe(0);
    expect(result.rootBytes).toBe(0);
    expect(result.fatalErrors.join('\n')).toMatch(/null.*useReducer/);
  });

  it('rejects a caught React failure even when an error boundary renders nonempty fallback content', () => {
    const result = verify(writeRealReactFixture({ duplicate: true, catchRenderError: true }));
    expect(result.status).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.runtimeConfigRequests).toBeGreaterThan(0);
    expect(result.bootstrapErrorScreenReached).toBe(true);
    expect(result.rootBytes).toBeGreaterThan(0);
    expect(result.fatalErrors.join('\n')).toContain('[renderer] react-render');
  });

  it('rejects a module that silently leaves the window blank', () => {
    const result = verify(fixture('export const initialized = true;'));
    expect(result.status).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.rootBytes).toBe(0);
    expect(result.runtimeConfigRequests).toBe(0);
  });

  it('rejects blocked network attempts instead of accessing a service', () => {
    const result = verify(fixture('await fetch("https://example.com");'));
    expect(result.status).toBe(1);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('forbids fetch');
  });

  it('reports a missing referenced renderer chunk', () => {
    const result = verify(fixture('import "./missing-chunk.js";'));
    expect(result.status).toBe(1);
    expect(result.error).toMatch(/ENOENT.*missing-chunk/);
  });

  it('rejects a renderer script hosted outside the package', () => {
    const root = fixture('');
    writeFileSync(join(root, 'index.html'), '<div id="root"></div><script type="module" src="https://example.com/entry.js"></script>');
    const result = verify(root);
    expect(result.status).toBe(1);
    expect(result.error).toContain('entrypoint must be local');
  });
});
