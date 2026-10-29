import fs from 'node:fs';
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { browserSemanticSnapshotExpression } from '../../../../src/core/agent-runtime/tools/browser-semantic-snapshot.js';

const executable = process.env.MEMMY_BROWSER_TEST_EXECUTABLE || (fs.existsSync(chromium.executablePath())
  ? chromium.executablePath() : '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
type Snapshot = { nodes: Array<{ ref: string; role: string; name: string; value: string;
  state?: Record<string, unknown>; depth?: number; context?: string }>; truncated: boolean };

describe.skipIf(!fs.existsSync(executable))('browser semantic observation in isolated headless Chromium', () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await chromium.launch({ executablePath: executable, headless: true }); });
  beforeEach(async () => {
    await page?.close();
    page = await browser.newPage();
  });
  afterAll(async () => { await browser?.close(); });
  const snapshot = (query?: { text?: string; regex?: string }) =>
    page.evaluate(browserSemanticSnapshotExpression('fixture', query)) as Promise<Snapshot>;
  const elementIds = (nodes: Snapshot['nodes']) => page.evaluate(refs => refs.map(ref => {
    const elements = (globalThis as any)[Symbol.for('memmy.playwright.element.refs')];
    return elements.get(ref)?.deref()?.id;
  }), nodes.map(node => node.ref));

  it('exposes an empty roleless editor beside its toolbar without naming it after its body', async () => {
    await page.setContent(`<form aria-label="New request"><p>Business requirements</p>
      <div role="toolbar" aria-label="Text formatting"><input type="number" aria-label="Font size" value="11"><input id="unlabelled-size" value="11"></div>
      <div id="requirements" contenteditable="true" style="min-height:40px"><p><br></p></div></form>`);
    const result = await snapshot();
    expect(result.nodes).toContainEqual(expect.objectContaining({ role: 'spinbutton', name: 'Font size', value: '11' }));
    expect(result.nodes).toContainEqual(expect.objectContaining({ role: 'textbox', name: '', value: '11' }));
    const editor = result.nodes.find(node => node.state?.editable === true);
    expect(editor).toMatchObject({ name: '', value: '', state: { editable: true, multiline: true } });
    expect(await elementIds([editor!])).toEqual(['requirements']);
    await page.locator('#requirements').fill('Documented business requirements');
    const refreshed = (await snapshot()).nodes.find(node => node.state?.editable === true);
    expect(refreshed).toMatchObject({ name: '', value: 'Documented business requirements' });
  });

  it('uses editing hosts instead of exposing every inherited or nested editable child as a field', async () => {
    await page.setContent(`<div id="outer" contenteditable="true"><span>Inherited</span>
      <div contenteditable="true"><p>Nested content</p></div>
      <div contenteditable="false">Static <div id="inner" contenteditable="true">Independent</div></div></div>
      <div id="plain" contenteditable="plaintext-only">Plain text</div>
      <div id="disabled" contenteditable="false">Not editable</div>`);
    const editors = (await snapshot()).nodes.filter(node => node.role === 'textbox');
    expect(await elementIds(editors)).toEqual(['outer', 'inner', 'plain']);
    expect(editors.every(node => node.name === '' && node.state?.editable === true)).toBe(true);
  });

  it('reads rich editor labels and placeholders without replacing labels with entered content', async () => {
    await page.setContent(`<span id="label">Requirements</span>
      <div id="labelled" contenteditable="true" aria-labelledby="label">Existing requirement</div>
      <div id="hinted" contenteditable="true" aria-placeholder="Enter notes" style="height:30px"></div>
      <div id="single" contenteditable="true" role="textbox" aria-label="Summary" aria-multiline="false">A summary</div>
      <div id="shadow"></div>`);
    await page.locator('#shadow').evaluate((element: any) => {
      element.attachShadow({ mode: 'open' }).innerHTML = '<span id="label">Shadow notes</span><div contenteditable="true" aria-labelledby="label">Shadow value</div>';
    });
    const nodes = (await snapshot()).nodes.filter(node => node.role === 'textbox');
    expect(nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Requirements', value: 'Existing requirement' }),
      expect.objectContaining({ name: 'Enter notes', value: '' }),
      expect.objectContaining({ name: 'Summary', value: 'A summary', state: expect.objectContaining({ multiline: false }) }),
      expect.objectContaining({ name: 'Shadow notes', value: 'Shadow value' }),
    ]));
  });

  it('returns current native and rich field values while never exposing password values', async () => {
    await page.setContent(`<label>Name<input id="name" value="Before"></label>
      <label>Details<textarea id="details"></textarea></label>
      <label>Secret<input type="password" value="do-not-return-this-secret"></label>
      <div id="notes" contenteditable="true" role="textbox" aria-label="Notes"></div>`);
    await page.locator('#name').fill('After');
    await page.locator('#details').fill('First line\nSecond line');
    await page.locator('#notes').fill('Rich field value');
    const result = await snapshot();
    expect(result.nodes).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'textbox', name: 'Name', value: 'After' }),
      expect.objectContaining({ role: 'textbox', name: 'Details', value: 'First line\nSecond line' }),
      expect.objectContaining({ role: 'textbox', name: 'Notes', value: 'Rich field value' }),
      expect.objectContaining({ role: 'textbox', name: 'Secret', value: '', state: expect.objectContaining({ valueRedacted: true }) }),
    ]));
    expect(JSON.stringify(result)).not.toContain('do-not-return-this-secret');
    expect((await snapshot({ text: 'Rich field value' })).nodes).toContainEqual(expect.objectContaining({ role: 'textbox', name: 'Notes', value: 'Rich field value' }));
  });

  it('retains form context when its only control is a contenteditable field', async () => {
    await page.setContent('<form aria-label="Feedback"><div contenteditable="true" aria-label="Comment">A comment</div></form>');
    const result = await snapshot();
    expect(result.nodes[0]).toMatchObject({ role: 'form', name: 'Feedback' });
    expect(result.nodes.find(node => node.role === 'textbox')).toMatchObject({ depth: 1 });
    expect((await snapshot({ text: 'Comment' })).nodes.find(node => node.role === 'textbox'))
      .toMatchObject({ context: 'form "Feedback"' });
  });

  it('keeps roleless editors in the control fallback after reaching the scan budget', async () => {
    await page.setContent('<span></span>'.repeat(30_010) + '<div contenteditable="true" aria-label="Late editor">Late value</div>');
    const result = await snapshot();
    expect(result.truncated).toBe(true);
    expect(result.nodes).toContainEqual(expect.objectContaining({ role: 'textbox', name: 'Late editor', value: 'Late value' }));
  });
});
