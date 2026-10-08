const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('memmySurfaceControl', {
  send(action: unknown) {
    ipcRenderer.send('memmy:computer-use-surface:interaction', action);
  },
  captureEnded(source: string, epoch: number) {
    ipcRenderer.send('memmy:computer-use-surface:capture-ended', source, epoch);
  },
  captureReady(source: string, epoch: number) {
    ipcRenderer.send('memmy:computer-use-surface:capture-ready', source, epoch);
  },
  hide() {
    ipcRenderer.send('memmy:computer-use-surface:hide');
  },
  expand() {
    ipcRenderer.send('memmy:computer-use-surface:expand');
  },
});
export {};
