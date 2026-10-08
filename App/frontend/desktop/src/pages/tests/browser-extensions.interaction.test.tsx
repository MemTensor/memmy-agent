// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { BrowserExtensions, type BrowserExtensionActions, type BrowserExtensionEntry,
  type BrowserExtensionLabels } from '../browser-extensions.js';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const labels: BrowserExtensionLabels = { title: '扩展', description: '管理内置浏览器扩展',
  permissionNotice: '安装前会显示权限并请你确认', install: '安装', empty: '暂无扩展',
  loaded: '已启用', unavailable: '不可用', needsReapproval: '目录已变更，需要重新批准',
  reapprove: '重新批准', remove: '移除', loadFailed: '读取失败', actionFailed: '操作失败' };

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

it('states the permission review and keeps changed extensions disabled until reapproved', async () => {
  let entries: BrowserExtensionEntry[] = [{ id: 'a'.repeat(32), name: 'Example', version: '1.0',
    directory: '/selected/example', loaded: false, needsReapproval: true }];
  const actions: BrowserExtensionActions = {
    list: vi.fn(async () => entries),
    install: vi.fn(async () => ({ status: 'cancelled' as const })),
    reapprove: vi.fn(async () => {
      entries = [{ ...entries[0]!, loaded: true, needsReapproval: false }];
      return { status: 'installed' as const, extension: entries[0]! };
    }),
    remove: vi.fn(async () => { entries = []; return true; }),
  };
  await act(async () => root.render(<BrowserExtensions actions={actions} labels={labels} />));
  expect(container.textContent).toContain('安装前会显示权限并请你确认');
  expect(container.textContent).toContain('目录已变更，需要重新批准');
  expect(container.textContent).toContain('/selected/example');
  await act(async () => (container.querySelector('[aria-label="重新批准: Example"]') as HTMLButtonElement).click());
  expect(actions.reapprove).toHaveBeenCalledWith('a'.repeat(32));
  expect(container.textContent).toContain('已启用');
  expect(container.querySelector('[aria-label="重新批准: Example"]')).toBeNull();
  await act(async () => (container.querySelector('[aria-label="移除: Example"]') as HTMLButtonElement).click());
  expect(actions.remove).toHaveBeenCalledWith('a'.repeat(32));
  expect(container.textContent).toContain('暂无扩展');
});

it('calls native installation through its action without accepting a renderer directory', async () => {
  const actions: BrowserExtensionActions = {
    list: vi.fn(async () => []),
    install: vi.fn(async () => ({ status: 'cancelled' as const })),
    reapprove: vi.fn(async () => ({ status: 'cancelled' as const })),
    remove: vi.fn(async () => false),
  };
  await act(async () => root.render(<BrowserExtensions actions={actions} labels={labels} />));
  await act(async () => ([...container.querySelectorAll('button')].find(item => item.textContent === '安装') as HTMLButtonElement).click());
  expect(actions.install).toHaveBeenCalledWith();
});
