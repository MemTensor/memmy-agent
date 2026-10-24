const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

contextBridge.exposeInMainWorld('memmySurfaceControl', {
  send(action: unknown) {
    ipcRenderer.send('memmy:computer-use-surface:interaction', action);
  },
  captureEnded(source: string, epoch: number) {
    ipcRenderer.send('memmy:computer-use-surface:capture-ended', source, epoch);
  },
  captureReady(source: string, epoch: number, width: number, height: number) {
    ipcRenderer.send('memmy:computer-use-surface:capture-ready', source, epoch, width, height);
  },
  snapshotReady(snapshotEpoch: number) {
    ipcRenderer.send('memmy:computer-use-surface:snapshot-ready', snapshotEpoch);
  },
  hide(scope: 'task' | 'all' = 'task') {
    ipcRenderer.send('memmy:computer-use-surface:hide', scope);
  },
});
export {};
