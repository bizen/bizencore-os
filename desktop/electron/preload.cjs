const { contextBridge, ipcRenderer } = require('electron');
const { exposeClerkBridge } = require('@clerk/electron/preload');

exposeClerkBridge();
const invoke = (name, ...args) => ipcRenderer.invoke(`bizencore:${name}`, ...args);
const subscribe = (name, callback) => {
  const listener = (_event, ...args) => callback(...args);
  ipcRenderer.on(name, listener);
  return () => ipcRenderer.removeListener(name, listener);
};
contextBridge.exposeInMainWorld('bizencoreDesktop', {
  integratedTitlebar: process.platform === 'darwin',
  ...(process.argv.includes('--bizencore-validation') ? { validation: {
    state: () => invoke('validation-state'),
    sample: value => invoke('validation-sample', value),
  } } : {}),
  mcpSupported: true,
  checkUpdate: () => invoke('check-update'),
  openUpdate: () => invoke('open-update'),
  authorize: token => invoke('authorize', token),
  lock: () => invoke('lock'),
  agents: () => invoke('agents'),
  agentDiagnostics: () => invoke('agent-diagnostics'),
  conversations: (agent, cwd) => invoke('conversations', agent, cwd),
  notify: value => invoke('notify', value),
  openExternal: url => invoke('open-external', url),
  folder: () => invoke('folder'),
  taskRun: args => invoke('task-run', args),
  taskStop: id => invoke('task-stop', id),
  taskReview: id => invoke('task-review', id),
  start: args => invoke('start', args),
  write: (id, data) => invoke('write', id, data),
  resize: (id, cols, rows) => invoke('resize', id, cols, rows),
  acknowledgeOutput: (id, streamId, sequence) => invoke('ack-output', id, streamId, sequence),
  stop: id => invoke('stop', id),
  onEvent: callback => subscribe('bizencore:agent-event', callback),
  onExpired: callback => subscribe('bizencore:access-expired', callback),
  onResume: callback => subscribe('bizencore:resume', callback),
  onFocusPane: callback => subscribe('bizencore:focus-pane', callback),
});
