const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const channel = 'memmy:computer-use-permission-panel';
contextBridge.exposeInMainWorld('computerUsePermissions', {
  act: (action: string) => ipcRenderer.invoke(`${channel}:action`, action),
  subscribe: (callback: (state: unknown) => void) => {
    ipcRenderer.on(`${channel}:state`, (_event, state: unknown) => callback(state));
    void ipcRenderer.invoke(`${channel}:action`, 'ready');
  },
});
export {};
