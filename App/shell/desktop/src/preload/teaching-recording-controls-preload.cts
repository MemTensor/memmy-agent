const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');
const channel = 'memmy:teaching-recording-controls';
contextBridge.exposeInMainWorld('teachingRecordingControls', {
  action: (action: { id: string; action: 'stop' | 'cancel' }) => ipcRenderer.send(`${channel}:action`, action),
  confirm: (open: boolean) => ipcRenderer.send(`${channel}:confirm`, open === true),
  subscribeFeedback: (callback: (feedback: { busy: boolean; error: string | null }) => void) => {
    ipcRenderer.on(`${channel}:feedback`, (_event, feedback) => callback(feedback));
  },
  subscribe: (callback: (state: unknown) => void) => {
    ipcRenderer.on(`${channel}:state`, (_event, state: unknown) => callback(state));
    void ipcRenderer.invoke(`${channel}:ready`);
  },
});
export {};
