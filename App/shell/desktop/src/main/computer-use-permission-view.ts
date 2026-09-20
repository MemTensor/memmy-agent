/** Dynamic text uses textContent; the only image is supplied by the main process. */
export function computerUsePermissionHtml(nonce: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>启用 Open Computer Use</title><style>
*{box-sizing:border-box}body{margin:0;background:#f8faf9;color:#20332f;font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif}main{padding:28px 28px 18px}h1{font-size:23px;letter-spacing:-.4px;margin:0 0 9px;font-weight:650}.intro{margin:0 0 25px;color:#6a7975;line-height:1.5}.permission{display:flex;align-items:center;gap:14px;background:white;border:1px solid #e4ebe8;border-radius:14px;padding:18px;margin:12px 0}.icon{width:38px;height:38px;border-radius:11px;background:#edf6f2;display:grid;place-items:center;color:#348471;font-size:23px}.description{flex:1}.description strong{display:block;font-size:15px;margin-bottom:5px}.description small{color:#79847f;font-size:12px}.status{font-size:11px;display:block;color:#82918b;margin:0 0 6px;text-align:center}.status[data-state=granted]{color:#24856e}.control{text-align:center;min-width:78px}button{font:inherit;border:0;border-radius:8px;padding:8px 13px;cursor:pointer;background:#edf3f0;color:#327b68}button:focus-visible,summary:focus-visible{outline:3px solid #86c9b7;outline-offset:3px}button:disabled{opacity:.55;cursor:default}.done{color:#24856e;font-size:13px}.note{min-height:33px;font-size:12px;color:#788780;line-height:1.5;margin:14px 2px 8px}details{font-size:12px;color:#788780}summary{cursor:pointer;display:inline-block;text-decoration:underline;text-underline-offset:3px}details p{line-height:1.65;margin:10px 0 8px}code{display:block;white-space:pre-wrap;overflow-wrap:anywhere;background:#edf2ef;border-radius:8px;padding:10px;font-size:11px;color:#53665e}footer{display:flex;justify-content:flex-end;gap:9px;position:sticky;bottom:0;background:#f8faf9;padding:15px 28px 22px;border-top:1px solid #edf0ee}.secondary{background:transparent;color:#718078}.primary{background:#439e8b;color:white;min-width:106px}body{max-height:100vh;overflow:auto}
.drag-hint{font-size:12px;color:#788780;margin:18px 2px 9px;line-height:1.5}.helper-drag{display:flex;align-items:center;gap:12px;padding:12px 15px;border:1px dashed #b8d2c8;border-radius:11px;background:#f0f6f3;user-select:none;cursor:grab}.helper-drag:active{cursor:grabbing}.helper-drag[aria-disabled=true]{opacity:.55;cursor:default}.helper-drag img{width:36px;height:36px;pointer-events:none}.helper-drag strong{font-size:14px;font-weight:550}.helper-drag small{margin-left:auto;color:#6a7975;font-size:12px}
</style></head><body><main>
<h1>启用 Open Computer Use</h1><p class="intro">开启以下权限，即可继续当前任务。</p>
<section class="permission" aria-label="辅助功能权限"><span class="icon" aria-hidden="true">↗</span><div class="description"><strong>辅助功能</strong><small>读取和操作应用界面</small></div><div class="control"><span id="ax-status" class="status">待检测</span><button id="accessibility">去开启</button></div></section>
<section class="permission" aria-label="屏幕录制权限"><span class="icon" aria-hidden="true">▣</span><div class="description"><strong>屏幕录制</strong><small>获取屏幕内容</small></div><div class="control"><span id="screen-status" class="status">待检测</span><button id="screenRecording">去开启</button></div></section>
<p id="drag-hint" class="drag-hint">列表里没有？将下方程序拖入系统设置的权限列表。</p>
<div id="helper-drag" class="helper-drag" draggable="false" aria-disabled="true" aria-describedby="drag-hint"><img id="helper-icon" alt="" draggable="false" hidden><strong>Open Computer Use</strong><small>拖入列表</small></div>
<p id="message" class="note" role="status" aria-live="polite">开启权限后，点击“重新检测”。</p>
<details><summary>遇到问题？</summary><p>拖动的是当前使用的 Open Computer Use。若无法拖动，可点击系统设置列表中的“+”，按 ⌘⇧G，粘贴下方路径并添加。</p><code id="helper-path"></code><button id="copyPath">复制程序路径</button></details>
</main><footer><button id="later" class="secondary">稍后</button><button id="primary" class="primary">重新检测</button></footer>
<script nonce="${nonce}">
const bridge = window.computerUsePermissions;
let ready = false;
const el = id => document.getElementById(id);
for (const action of ['accessibility','screenRecording','later','copyPath']) el(action).addEventListener('click',()=>bridge.act(action));
el('primary').addEventListener('click',()=>bridge.act(ready?'continue':'recheck'));
el('helper-drag').addEventListener('dragstart',event=>{
  event.preventDefault();
  if (el('helper-drag').getAttribute('aria-disabled')==='false') bridge.dragHelper();
});
bridge.subscribe(state=>{
  ready=!state.permissions.failure && state.permissions.accessibility==='granted' && state.permissions.screenRecording==='granted';
  for (const [permission,label] of [['accessibility','ax-status'],['screenRecording','screen-status']]) {
    const value=state.permissions[permission];
    el(label).textContent=value==='granted'?'已开启 ✓':value==='required'?'待开启':'待检测';
    el(label).dataset.state=value;
    el(permission).disabled=state.busy || value==='granted' || state.permissions.failure==='helperPauseFailed';
    el(permission).hidden=value==='granted';
  }
  el('helper-path').textContent=state.helperApp;
  el('helper-drag').draggable=Boolean(state.canDragHelper);
  el('helper-drag').setAttribute('aria-disabled',String(!state.canDragHelper));
  el('drag-hint').textContent=state.dragError || '列表里没有？将下方程序拖入系统设置的权限列表。';
  if (state.helperIcon) { el('helper-icon').src=state.helperIcon; el('helper-icon').hidden=false; }
  el('message').textContent=state.busy?'正在检测权限…':state.message || '开启权限后，点击“重新检测”。';
  el('primary').disabled=state.busy;
  el('primary').textContent=state.busy?'检测中…':ready?(state.canContinue?'继续任务':'完成'):'重新检测';
});
</script></body></html>`;
}
