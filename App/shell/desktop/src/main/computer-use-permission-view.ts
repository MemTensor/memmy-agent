/** The host owns all state and actions; the view only renders the permission card. */
export function computerUsePermissionHtml(nonce: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>Memmy 权限</title><style>
*{box-sizing:border-box}
html,body{width:100%;height:100%;margin:0;overflow:hidden;background:transparent;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#353535}
button{font:inherit;cursor:pointer}
button:focus-visible,[draggable=true]:focus-visible{outline:3px solid #1685ee;outline-offset:3px}
.panel{position:relative;width:1090px;height:228px;transform:scale(.5);transform-origin:top left;overflow:hidden;background:#e5e5e5;border:1px solid #bdbdbd;border-radius:34px;box-shadow:0 12px 30px #0003,inset 0 1px #fff9}
.arrow{position:absolute;left:133px;top:0;width:64px;height:80px;filter:drop-shadow(0 2px 2px #0005);pointer-events:none}
.heading{position:absolute;left:208px;right:118px;top:38px;height:42px;padding:0;border:0;background:transparent;text-align:left;color:#616161;font-size:27px;font-weight:400;line-height:1.25;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.heading:hover:not(:disabled){color:#484848}.heading:disabled{cursor:default}
.close{position:absolute;right:22px;top:32px;height:52px;padding:0 18px;border:0;border-radius:14px;background:#dedede;color:#444;font-size:24px;line-height:52px;white-space:nowrap}
.close:hover{background:#d3d3d3}
.back{position:absolute;left:36px;top:112px;width:58px;height:58px;border:0;border-radius:50%;background:#dedede;color:#444;display:grid;place-items:center;padding:0}
.back:hover{background:#d3d3d3}.back svg{width:21px;height:28px}
.tile{position:absolute;left:128px;right:20px;top:99px;height:84px;padding:12px 15px;border:1px solid #dcdae0;border-radius:12px;background:#f6f6f6;display:flex;align-items:center;gap:14px;user-select:none;cursor:grab;text-align:left}
.tile:active{cursor:grabbing}.tile[aria-disabled=true]{cursor:default}.tile:hover{background:#f8f8f8}
.tile img{flex:none;width:54px;height:54px;object-fit:contain;pointer-events:none}
.tile strong{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:27px;line-height:34px;font-weight:400;color:#343434}
.aftercare{position:absolute;left:128px;right:20px;bottom:10px;height:27px;display:flex;align-items:center;gap:12px;color:#666;font-size:13px}
.aftercare[hidden]{display:none}.message{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.link{padding:3px 2px;border:0;background:transparent;color:#555;text-decoration:underline;text-underline-offset:2px;white-space:nowrap}
.primary{min-width:82px;padding:5px 11px;border:0;border-radius:8px;background:#147ce9;color:#fff;white-space:nowrap;font-size:13px}
.primary:hover{background:#086bd5}.primary:disabled{opacity:.5;cursor:default}
</style></head><body><main class="panel" role="dialog" aria-label="Memmy 权限">
<svg class="arrow" viewBox="0 0 64 80" aria-hidden="true"><path d="M32 4 5 37c-2 3 0 6 4 6h10v27c0 3 2 5 5 5h16c3 0 5-2 5-5V43h10c4 0 6-3 4-6L32 4Z" fill="#0785f5" stroke="#fff" stroke-width="4" stroke-linejoin="round"/></svg>
<button id="settings" class="heading" title="打开系统设置">将 Memmy 拖入上方列表，允许辅助功能</button>
<button id="close" class="close" title="关闭" aria-label="关闭">关闭</button>
<button id="back" class="back" title="返回 Memmy" aria-label="返回 Memmy"><svg viewBox="0 0 21 28" aria-hidden="true"><path d="M15 4 6 14l9 10" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"/></svg></button>
<div id="helper-drag" class="tile" draggable="false" tabindex="0" role="button" aria-disabled="true" aria-label="拖动 Memmy 到系统权限列表"><img id="helper-icon" alt="" draggable="false" hidden><strong>Memmy</strong></div>
<div id="aftercare" class="aftercare" hidden><span id="message" class="message" role="status" aria-live="polite"></span><button id="reopen" class="link">打开系统设置</button><button id="copyPath" class="link" title="列表中找不到时，复制程序路径后用系统设置的加号添加">复制程序路径</button><button id="primary" class="primary">重新检测</button></div>
</main><script nonce="${nonce}">
const bridge=window.computerUsePermissions, el=id=>document.getElementById(id);
let state=null,ready=false;
const labels={accessibility:'辅助功能',screenRecording:'屏幕录制',inputMonitoring:'输入监控'};
function render(){if(!state)return;
  const required=state.requiredPermission;
  ready=!state.permissions.failure&&state.permissions[required]==='granted';
  el('settings').textContent=ready?'Memmy 的权限已开启，可以继续':'将 Memmy 拖入上方列表，允许'+labels[required];
  el('settings').disabled=state.busy||ready||state.permissions.failure==='helperPauseFailed';
  el('helper-drag').draggable=Boolean(state.canDragHelper&&!ready);
  el('helper-drag').setAttribute('aria-disabled',String(!state.canDragHelper||ready));
  if(state.helperIcon){el('helper-icon').src=state.helperIcon;el('helper-icon').hidden=false;}
  el('aftercare').hidden=!(state.showActions||state.dragError||state.permissions.failure||ready);
  el('message').textContent=state.busy?'正在检测权限…':state.dragError||state.message||'开启权限后，点击“重新检测”。';
  el('reopen').hidden=ready;
  el('reopen').disabled=state.busy||state.permissions.failure==='helperPauseFailed';
  el('copyPath').title=state.helperApp||'';
  el('primary').disabled=state.busy;
  el('primary').textContent=state.busy?'检测中…':ready?(state.canContinue?'继续任务':'完成'):'重新检测';
}
el('back').addEventListener('click',()=>bridge.act('later'));
el('close').addEventListener('click',()=>bridge.close());
document.addEventListener('keydown',event=>{if(event.key==='Escape')bridge.act('later')});
el('settings').addEventListener('click',()=>bridge.act(state.requiredPermission));
el('reopen').addEventListener('click',()=>bridge.act(state.requiredPermission));
el('copyPath').addEventListener('click',()=>bridge.act('copyPath'));
el('primary').addEventListener('click',()=>bridge.act(ready?'continue':'recheck'));
el('helper-drag').addEventListener('dragstart',event=>{event.preventDefault();if(el('helper-drag').getAttribute('aria-disabled')==='false')bridge.dragHelper()});
el('helper-drag').addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();bridge.act(state.requiredPermission)}});
bridge.subscribe(next=>{state=next;render()});
</script></body></html>`;
}
