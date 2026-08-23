const { contextBridge, ipcRenderer } = require('electron');

const EXECUTE_CHANNEL = 'sentinel:operator:execute';

contextBridge.exposeInMainWorld('sentinelOperator', Object.freeze({
  execute(request) {
    return ipcRenderer.invoke(EXECUTE_CHANNEL, request);
  },
}));
