const { contextBridge, ipcRenderer } = require('electron');

const EXECUTE_CHANNEL = 'sentinel:operator:execute';
const VOICE_LISTEN_CHANNEL = 'sentinel:voice:listen-once';

contextBridge.exposeInMainWorld('sentinelOperator', Object.freeze({
  execute(request) {
    return ipcRenderer.invoke(EXECUTE_CHANNEL, request);
  },
}));

contextBridge.exposeInMainWorld('ultronVoice', Object.freeze({
  listenOnce() {
    return ipcRenderer.invoke(VOICE_LISTEN_CHANNEL);
  },
}));
