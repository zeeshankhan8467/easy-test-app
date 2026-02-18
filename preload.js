const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Auth (EasyTest: email + password)
  login: (email, password) => ipcRenderer.invoke('auth:login', { email, password }),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getToken: () => ipcRenderer.invoke('auth:getToken'),
  getUser: () => ipcRenderer.invoke('auth:getUser'),

  // EasyTest API
  fetchExams: () => ipcRenderer.invoke('api:fetchExams'),
  fetchExamSnapshot: (examId) => ipcRenderer.invoke('api:fetchExamSnapshot', examId),
  fetchParticipants: (examId) => ipcRenderer.invoke('api:fetchParticipants', examId),
  syncLiveResults: (payload) => ipcRenderer.invoke('api:syncLiveResults', payload),

  // Offline storage
  getPendingResponses: () => ipcRenderer.invoke('storage:getPendingResponses'),
  savePendingResponses: (data) => ipcRenderer.invoke('storage:savePendingResponses', data),
  clearPendingForExam: (examId) => ipcRenderer.invoke('storage:clearPendingForExam', examId),

  // SDK (clicker)
  isSDKLoaded: () => ipcRenderer.invoke('sdk:isLoaded'),
  connectClicker: (mode) => ipcRenderer.invoke('sdk:connect', mode),
  disconnectClicker: (baseId) => ipcRenderer.invoke('sdk:disconnect', baseId),
  startSession: (settings) => ipcRenderer.invoke('sdk:startSession', settings),
  stopSession: (baseId) => ipcRenderer.invoke('sdk:stopSession', baseId),
  getSDKStatus: () => ipcRenderer.invoke('sdk:getStatus'),

  onClickerResponse: (cb) => { ipcRenderer.on('clicker-response', (e, data) => cb(data)); },
  onConnectEvent: (cb) => { ipcRenderer.on('sdk-connect-event', (e, data) => cb(data)); },
  onVoteEvent: (cb) => { ipcRenderer.on('sdk-vote-event', (e, data) => cb(data)); },
  onHDParamEvent: (cb) => { ipcRenderer.on('sdk-hdparam-event', (e, data) => cb(data)); },

  removeAllSDKListeners: () => {
    ipcRenderer.removeAllListeners('clicker-response');
    ipcRenderer.removeAllListeners('sdk-connect-event');
    ipcRenderer.removeAllListeners('sdk-vote-event');
    ipcRenderer.removeAllListeners('sdk-hdparam-event');
  },

  nav: (page) => ipcRenderer.invoke('nav:goto', page),
});
