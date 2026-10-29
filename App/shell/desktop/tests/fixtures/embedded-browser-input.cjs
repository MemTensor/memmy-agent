const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { EmbeddedBrowserDriver } = require(process.env.MEMMY_INPUT_FIXTURE_DRIVER);

app.setPath('userData', path.join(process.env.MEMMY_INPUT_FIXTURE_ROOT, 'profile'));
app.dock?.hide();
let window, server, driver;
const timeout = setTimeout(() => { console.error('Hidden browser input fixture timed out'); app.exit(1); }, 25_000);

async function main() {
  await app.whenReady();
  app.dock?.hide();
  server = http.createServer((request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(request.url.startsWith('/guest')
      ? '<body><input id="field"><label><input id="check" type="checkbox">Agree</label></body>'
      : '<body><textarea id="composer"></textarea><webview id="foreground" src="/guest?front" style="display:flex;width:600px;height:400px"></webview>'
        + '<webview id="background" src="/guest?back" style="display:flex;position:fixed;left:-10000px;top:0;opacity:0;width:600px;height:400px"></webview></body>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  window = new BrowserWindow({ show: false, width: 900, height: 700,
    webPreferences: { webviewTag: true, backgroundThrottling: true } });
  const guests = [];
  const attached = new Promise(resolve => window.webContents.on('did-attach-webview', (_event, guest) => {
    guests.push(guest); if (guests.length === 2) resolve();
  }));
  await window.loadURL(origin);
  await attached;
  await Promise.all(guests.map(guest => new Promise(resolve => guest.isLoading() ? guest.once('did-stop-loading', resolve) : resolve())));
  const guest = guests.find(item => item.getURL().endsWith('?back'));
  const foreground = guests.find(item => item.getURL().endsWith('?front'));
  assert.ok(guest && foreground);
  const hostEval = expression => window.webContents.executeJavaScript(expression);
  guest.debugger.attach('1.3');
  const rawEval = async expression => (await guest.debugger.sendCommand('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })).result.value;
  const raf = () => rawEval('new Promise(resolve => requestAnimationFrame(() => resolve(true)))');
  const pause = milliseconds => new Promise(resolve => setTimeout(() => resolve(false), milliseconds));
  const animationPaused = !await Promise.race([raf(), pause(400)]);
  await hostEval('composer.value="host fixture";composer.focus();composer.setSelectionRange(composer.value.length,composer.value.length)');
  await rawEval('field.focus();field.select()');
  await guest.debugger.sendCommand('Input.insertText', { text: ' misdirected' });
  const inputMisdirected = await rawEval('field.value === ""')
    && await hostEval('composer.value === "host fixture misdirected"');
  assert.equal(inputMisdirected, true, 'The fixture must reproduce CDP forwarding to the host composer');
  assert.equal(animationPaused, true, 'The offscreen webview must reproduce suspended animation frames');
  guest.debugger.detach();
  await hostEval('composer.value="host fixture";composer.focus()');

  driver = new EmbeddedBrowserDriver(() => window);
  for (const item of guests) driver.attach(item, window);
  driver.selectTab(foreground.id, window);
  let current = true;
  const leaseId = 'a'.repeat(32);
  const approval = { origin, isAllowed: () => true, isCurrentChild: () => current };
  const run = (command, args = {}) => driver.handle({ type: 'memmy:embedded-browser:request', requestId: 'fixture',
    tabId: guest.id, command, args: { approvedOrigin: origin, leaseId, ...args } },
  undefined, approval, () => current);
  await run('allowOrigin', { origin });
  const cdp = (method, params) => run('playwrightCdp', { method, params });
  const evaluate = async expression => (await cdp('Runtime.evaluate', {
    expression, returnByValue: true, awaitPromise: true,
  })).result.value;
  await run('playwrightStart', { input: true, fresh: true });
  const animationResumed = await Promise.race([
    evaluate('new Promise(resolve => requestAnimationFrame(() => resolve(true)))'), pause(1500),
  ]);
  await evaluate('field.focus();field.select()');
  await cdp('Input.insertText', { text: 'exact background guest' });
  const exactGuest = await evaluate('field.value === "exact background guest"');
  const hostUnchanged = await hostEval('composer.value === "host fixture"');
  const selectedTabUnchanged = (await run('listTabs')).selectedTabId === foreground.id;
  await hostEval('composer.focus()');
  await assert.rejects(cdp('Input.insertText', { text: 'must not enter host' }), /input receiver changed/);
  const focusLossBlocked = await hostEval('composer.value === "host fixture"');
  await hostEval('foreground.focus()');
  await assert.rejects(cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'x', text: 'x' }), /input receiver changed/);
  const otherGuestBlocked = true;
  await run('playwrightEnd');
  const endRestored = guest.backgroundThrottling === true;
  // Reuse the tab after both another guest and the host composer had focus.
  // The webview wrapper's window.focus() can leave native focus on the old guest.
  let repeatedLeaseInput = true, repeatedEndRestored = true;
  for (const [index, previous] of ['foreground', 'composer', 'foreground'].entries()) {
    await hostEval(`${previous}.focus()`);
    await run('playwrightStart', { input: true, fresh: false });
    await evaluate('field.focus();field.select()');
    const text = `reused guest ${index}`;
    await cdp('Input.insertText', { text });
    await cdp('Input.dispatchKeyEvent', { type: 'char', text: '!' });
    repeatedLeaseInput &&= await evaluate(`field.value === ${JSON.stringify(text + '!')}`)
      && await hostEval('composer.value === "host fixture"')
      && await foreground.executeJavaScript('field.value === ""')
      && (await run('listTabs')).selectedTabId === foreground.id;
    await run('playwrightEnd');
    repeatedEndRestored &&= guest.backgroundThrottling === true;
  }
  await run('playwrightStart', { input: true, fresh: false });
  current = false;
  await assert.rejects(cdp('Input.insertText', { text: 'cancelled' }), /cancelled|revoked/);
  await run('playwrightEnd');
  const cancellationRestored = guest.backgroundThrottling === true;
  assert.equal(window.isVisible(), false, 'The fixture must never show a window');
  const repaired = { exactGuest, hostUnchanged, selectedTabUnchanged, animationResumed,
    endRestored, cancellationRestored, focusLossBlocked, otherGuestBlocked,
    repeatedLeaseInput, repeatedEndRestored };
  for (const [name, value] of Object.entries(repaired)) assert.equal(value, true, name);
  console.log('MEMMY_ELECTRON_INPUT_RESULT ' + JSON.stringify({ electron: process.versions.electron,
    chromium: process.versions.chrome, baseline: { inputMisdirected, animationPaused }, repaired }));
}

main().then(() => cleanup(0), error => { console.error(error); cleanup(1); });
function cleanup(code) {
  clearTimeout(timeout);
  driver?.dispose();
  window?.destroy();
  server?.close();
  app.exit(code);
}
