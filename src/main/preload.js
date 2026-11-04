'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const subscribe = (channel) => (callback) => {
  const handler = (_event, payload) => callback(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('api', {
  platform: process.platform,
  getState: () => ipcRenderer.invoke('state:get'),
  installEngine: () => ipcRenderer.invoke('engine:install'),
  openExternal: (url) => ipcRenderer.invoke('shell:external', url),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  add: (urls, options) => ipcRenderer.invoke('download:add', { urls, options }),
  pause: (gid) => ipcRenderer.invoke('download:pause', gid),
  resume: (gid) => ipcRenderer.invoke('download:resume', gid),
  remove: (gid) => ipcRenderer.invoke('download:remove', gid),
  clearFinished: () => ipcRenderer.invoke('history:clear'),
  forgetHistory: (id) => ipcRenderer.invoke('history:forget', id),
  chooseDir: () => ipcRenderer.invoke('dialog:dir'),
  reveal: (target) => ipcRenderer.invoke('shell:reveal', target),
  open: (target) => ipcRenderer.invoke('app:open', target),
  onUpdate: subscribe('engine:update'),
  onStatus: subscribe('engine:status'),
  onVerify: subscribe('verify:result'),
  onLog: subscribe('engine:log'),
});
