/**
 * EasyTest Live - Main Process
 * Classroom clicker-based exam app. Connects to EasyTest backend and same
 * clicker hardware (EasyTestSDK/koffi) as acadally-electron-app.
 */
const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');

// ============ Configuration ============
const API_BASE_URL = process.env.EASYTEST_API_URL || 'http://localhost:8000/api/';

function makeRequest(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = net.request({ method: options.method || 'GET', url });

    if (options.headers) {
      Object.entries(options.headers).forEach(([k, v]) => request.setHeader(k, v));
    }

    let responseData = '';
    request.on('response', (response) => {
      response.on('data', (chunk) => { responseData += chunk.toString(); });
      response.on('end', () => {
        try {
          const data = JSON.parse(responseData);
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data });
        } catch (e) {
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data: responseData });
        }
      });
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

let storePath = null;
function getStorePath() {
  if (!storePath) storePath = path.join(app.getPath('userData'), 'auth-store.json');
  return storePath;
}
function getStore() {
  try {
    const p = getStorePath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.error('getStore:', e); }
  return {};
}
function setStore(data) {
  try {
    const p = getStorePath();
    const current = getStore();
    fs.writeFileSync(p, JSON.stringify({ ...current, ...data }, null, 2));
  } catch (e) { console.error('setStore:', e); }
}

// Offline response storage (pending sync)
const PENDING_RESPONSES_PATH = path.join(app.getPath('userData'), 'pending-responses.json');
function getPendingResponses() {
  try {
    if (fs.existsSync(PENDING_RESPONSES_PATH))
      return JSON.parse(fs.readFileSync(PENDING_RESPONSES_PATH, 'utf8'));
  } catch (e) { console.error('getPendingResponses:', e); }
  return {};
}
function savePendingResponses(data) {
  try {
    fs.writeFileSync(PENDING_RESPONSES_PATH, JSON.stringify(data, null, 2));
  } catch (e) { console.error('savePendingResponses:', e); }
}

let mainWindow;
let sdk = null;
let sdkLoaded = false;
let connectedBaseId = -1;
let connectCallback = null;
let keyEventCallback = null;
let voteEventCallback = null;
let hdParamCallback = null;
let loggedEmptyKeySN = false;

function loadSDK() {
  try {
    const koffi = require('koffi');
    let dllPath = null;
    if (app.isPackaged) {
      const candidates = [
        path.join(process.resourcesPath, 'app.asar.unpacked', 'EasyTestSDK_x64.dll'),
        path.join(__dirname, '..', 'app.asar.unpacked', 'EasyTestSDK_x64.dll'),
      ];
      for (const p of candidates) {
        if (fs.existsSync(p)) { dllPath = p; break; }
      }
    } else {
      dllPath = path.join(__dirname, 'EasyTestSDK_x64.dll');
    }
    if (!dllPath || !fs.existsSync(dllPath)) {
      console.error('EasyTestSDK_x64.dll not found. Copy from acadally-electron-app or place in app root.');
      return false;
    }

    const lib = koffi.load(dllPath);
    const ConnectEventCallback = koffi.proto('void ConnectEventCallback(int baseId, int mode, const char* info)');
    const HDParamEventCallback = koffi.proto('void HDParamEventCallback(int baseId, int mode, const char* info)');
    const VoteEventCallback = koffi.proto('void VoteEventCallback(int baseId, int mode, const char* info)');
    const KeyEventCallback = koffi.proto('void KeyEventCallback(int baseId, int keyId, const char* keySN, int mode, float time, const char* info)');

    sdk = {
      Connect: lib.func('int __cdecl Connect(int mode, const char* param)'),
      Disconnect: lib.func('int __cdecl Disconnect(int baseId)'),
      VoteStart: lib.func('int __cdecl VoteStart(int mode, const char* setting)'),
      VoteStart2: lib.func('int __cdecl VoteStart2(int baseId, int mode, const char* setting)'),
      VoteStop: lib.func('int __cdecl VoteStop()'),
      VoteStop2: lib.func('int __cdecl VoteStop2(int baseId)'),
      ReadHDParam: lib.func('int __cdecl ReadHDParam(int baseId, int mode)'),
      WriteHDParam: lib.func('int __cdecl WriteHDParam(int baseId, int mode, const char* setting)'),
      License: lib.func('int __cdecl License(int mode, const char* info)'),
      SetLogOn: lib.func('int __cdecl SetLogOn(int enable)'),
      StopTaskAndFree: lib.func('int __cdecl StopTaskAndFree()'),
      SetConnectEventCallBack: lib.func('void __cdecl SetConnectEventCallBack(ConnectEventCallback* callback)'),
      SetHDParamEventCallBack: lib.func('void __cdecl SetHDParamEventCallBack(HDParamEventCallback* callback)'),
      SetVoteEventCallBack: lib.func('void __cdecl SetVoteEventCallBack(VoteEventCallback* callback)'),
      SetKeyEventCallBack: lib.func('void __cdecl SetKeyEventCallBack(KeyEventCallback* callback)'),
    };

    sdk.License(1, 'SUNARS2013');
    sdk.SetLogOn(0);

    connectCallback = koffi.register((baseId, mode, info) => {
      if (mode === 1) connectedBaseId = baseId;
      else if (mode === 0) connectedBaseId = -1;
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('sdk-connect-event', { baseId, mode, info });
    }, koffi.pointer(ConnectEventCallback));
    hdParamCallback = koffi.register((baseId, mode, info) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('sdk-hdparam-event', { baseId, mode, info });
    }, koffi.pointer(HDParamEventCallback));
    voteEventCallback = koffi.register((baseId, mode, info) => {
      if (mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('sdk-vote-event', { baseId, mode, info });
    }, koffi.pointer(VoteEventCallback));
    keyEventCallback = koffi.register((baseId, keyId, keySN, mode, time, info) => {
      let answer = (info && typeof info === 'string') ? info.trim() : '';
      const keyNum = typeof keyId === 'number' ? keyId : parseInt(keyId, 10);
      if (keyNum >= 1 && keyNum <= 4) answer = String.fromCharCode(64 + keyNum);
      else if (answer) {
        const upper = answer.toUpperCase().charAt(0);
        const num = parseInt(answer, 10);
        if (num >= 1 && num <= 4) answer = String.fromCharCode(64 + num);
        else if (['A', 'B', 'C', 'D'].includes(upper)) answer = upper;
        else answer = '';
      }
      if (!answer || !['A', 'B', 'C', 'D'].includes(answer)) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        const keySNStr = keySN != null ? String(keySN).trim() : '';
        if (!keySNStr && !loggedEmptyKeySN) {
          loggedEmptyKeySN = true;
          console.log('[EasyTest Live] Clicker keySN is empty from SDK (type=' + typeof keySN + '). Syncing with deviceId fallback (e.g. d1_123).');
        }
        const payload = {
          baseId, clicker_id: keyId, keySN: keySNStr || (keySN != null ? String(keySN) : ''), mode, time, answer, raw_info: info, timestamp: Date.now()
        };
        console.log('[EasyTest Live] Clicker response from SDK: keyId(clicker_id)=' + keyId + ', keySN="' + keySNStr + '" (raw type=' + typeof keySN + '), answer=' + answer);
        mainWindow.webContents.send('clicker-response', payload);
      }
    }, koffi.pointer(KeyEventCallback));

    sdk.SetConnectEventCallBack(connectCallback);
    sdk.SetHDParamEventCallBack(hdParamCallback);
    sdk.SetVoteEventCallBack(voteEventCallback);
    sdk.SetKeyEventCallBack(keyEventCallback);
    sdkLoaded = true;
    console.log('EasyTest SDK loaded');
    return true;
  } catch (error) {
    console.error('loadSDK:', error);
    sdkLoaded = false;
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: '#1a1a2e',
    show: false,
  });

  const store = getStore();
  if (store.token) {
    mainWindow.loadFile(path.join(__dirname, 'src', 'pages', 'dashboard.html'));
  } else {
    mainWindow.loadFile(path.join(__dirname, 'src', 'pages', 'login.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
  loadSDK();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (sdkLoaded && sdk) {
    try { sdk.VoteStop2(0); sdk.Disconnect(0); sdk.StopTaskAndFree(); } catch (e) { console.error(e); }
  }
  if (process.platform !== 'darwin') app.quit();
});

// ============ Auth (EasyTest: email + password -> token, user) ============
ipcMain.handle('auth:login', async (event, { email, password }) => {
  try {
    const response = await makeRequest(`${API_BASE_URL}auth/login/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (response.ok && response.data.token) {
      const userData = response.data.user || {};
      if (!userData.email && email) userData.email = email;
      setStore({ token: response.data.token, user: userData, email: email || userData.email });
      return { success: true, data: response.data };
    }
    return { success: false, error: response.data?.email?.[0] || response.data?.password?.[0] || 'Login failed' };
  } catch (error) {
    return { success: false, error: error.message || 'Network error' };
  }
});

ipcMain.handle('auth:logout', async () => {
  try { fs.unlinkSync(getStorePath()); } catch (e) {}
  return { success: true };
});

ipcMain.handle('auth:getToken', async () => getStore().token || null);
ipcMain.handle('auth:getUser', async () => {
  const store = getStore();
  const user = store.user;
  const email = store.email;
  if (user && typeof user === 'object' && (user.email || user.username || user.id != null)) return user;
  if (email) return { email: email, username: email.split('@')[0], displayName: email };
  return null;
});

// ============ EasyTest API ============
function authHeaders() {
  const token = getStore().token;
  return { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };
}

ipcMain.handle('api:fetchExams', async () => {
  if (!getStore().token) return { success: false, error: 'Not authenticated' };
  try {
    const response = await makeRequest(`${API_BASE_URL}exams/`, { headers: authHeaders() });
    if (response.ok) {
      const list = Array.isArray(response.data) ? response.data : (response.data?.results || []);
      return { success: true, data: list };
    }
    return { success: false, error: response.data?.detail || 'Failed to fetch exams' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('api:fetchExamSnapshot', async (event, examId) => {
  if (!getStore().token) return { success: false, error: 'Not authenticated' };
  try {
    const response = await makeRequest(`${API_BASE_URL}exams/${examId}/snapshot/`, { headers: authHeaders() });
    if (response.ok) return { success: true, data: response.data };
    return { success: false, error: response.data?.detail || 'Failed to fetch snapshot' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('api:fetchParticipants', async (event, examId) => {
  if (!getStore().token) return { success: false, error: 'Not authenticated' };
  try {
    const url = examId != null ? `${API_BASE_URL}participants/?exam_id=${examId}` : `${API_BASE_URL}participants/`;
    const response = await makeRequest(url, { headers: authHeaders() });
    if (response.ok) {
      const list = Array.isArray(response.data) ? response.data : (response.data?.results || []);
      return { success: true, data: list };
    }
    return { success: false, error: response.data?.detail || 'Failed to fetch participants' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('api:syncLiveResults', async (event, { examId, responses, attendance }) => {
  if (!getStore().token) {
    console.log('[EasyTest Live] Sync skipped: not authenticated');
    return { success: false, error: 'Not authenticated' };
  }
  const respCount = (responses && responses.length) || 0;
  const attCount = (attendance && attendance.length) || 0;
  console.log(`[EasyTest Live] Submitting to backend: examId=${examId}, responses=${respCount}, attendance=${attCount}`);
  if (respCount > 0 && responses[0]) {
    const r = responses[0];
    console.log('[EasyTest Live] First response: participant_id=' + (r.participant_id ?? 'none') + ', clicker_id="' + (r.clicker_id ?? '') + '", question_id=' + (r.question_id ?? ''));
  }
  try {
    const response = await makeRequest(`${API_BASE_URL}exams/${examId}/sync_live_results/`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ responses: responses || [], attendance: attendance || [] }),
    });
    if (response.ok) {
      const d = response.data;
      console.log(
        '[EasyTest Live] Backend saved: synced=' + (d?.synced ?? 0) +
        ', attempts_updated=' + (d?.attempts_updated ?? 0) +
        (d?.received != null ? ', received=' + d.received : '') +
        (d?.skipped_no_participant != null ? ', skipped_no_participant=' + d.skipped_no_participant : '') +
        (d?.skipped_no_question != null ? ', skipped_no_question=' + d.skipped_no_question : '') +
        (d?.skipped_already_answered != null ? ', skipped_already_answered=' + d.skipped_already_answered : '')
      );
      return { success: true, data: response.data };
    }
    console.log('[EasyTest Live] Sync failed:', response.data?.error || response.data?.detail || 'Sync failed');
    return { success: false, error: response.data?.error || response.data?.detail || 'Sync failed' };
  } catch (e) {
    console.log('[EasyTest Live] Sync error:', e.message);
    return { success: false, error: e.message };
  }
});

// ============ Offline storage (pending responses) ============
ipcMain.handle('storage:getPendingResponses', async () => getPendingResponses());
ipcMain.handle('storage:savePendingResponses', async (event, data) => {
  savePendingResponses(data);
  return { success: true };
});
ipcMain.handle('storage:clearPendingForExam', async (event, examId) => {
  const all = getPendingResponses();
  delete all[String(examId)];
  savePendingResponses(all);
  return { success: true };
});

// ============ SDK IPC (same as acadally) ============
ipcMain.handle('sdk:isLoaded', async () => ({ loaded: sdkLoaded }));
ipcMain.handle('sdk:connect', async (event, mode = 1) => {
  if (!sdkLoaded || !sdk) return { success: false, error: 'SDK not loaded' };
  try {
    const result = sdk.Connect(mode, '');
    return { success: result >= 0, result, message: result >= 0 ? 'Connection initiated' : 'Connection failed' };
  } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('sdk:disconnect', async (event, baseId = 0) => {
  if (!sdkLoaded || !sdk) return { success: false, error: 'SDK not loaded' };
  try { connectedBaseId = -1; return { success: sdk.Disconnect(baseId) >= 0, result: sdk.Disconnect(baseId) }; } catch (e) { return { success: false, error: e.message }; }
});
// Start voting session — same logic as acadally-electron-app (VoteType_Choice: minSelect,maxSelect,submitMode,displayMode,timeout,optionCount)
ipcMain.handle('sdk:startSession', async (event, settings = {}) => {
  if (!sdkLoaded || !sdk) return { success: false, error: 'SDK not loaded' };
  try {
    const baseId = settings.baseId || 0;
    const voteType = settings.voteType || 10; // 10 = Choice/MCQ
    const optionCount = settings.optionCount || 4;
    const timeout = settings.timeout || 30; // same as acadally: 0 from renderer becomes 30 so clicker does not go blank
    const minSelect = settings.minSelect || 1;
    const maxSelect = settings.maxSelect || 1;
    const submitMode = settings.submitMode || 0; // 0 = auto submit on select
    const displayMode = settings.displayMode || 0; // 0 = blank screen, 1 = active
    const settingStr = `${minSelect},${maxSelect},${submitMode},${displayMode},${timeout},${optionCount}`;
    const result = sdk.VoteStart2(baseId, voteType, settingStr);
    return { success: result >= 0, result, message: result >= 0 ? 'Session started' : 'Failed to start session' };
  } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('sdk:stopSession', async (event, baseId = 0) => {
  if (!sdkLoaded || !sdk) return { success: false, error: 'SDK not loaded' };
  try { return { success: sdk.VoteStop2(baseId) >= 0, result: sdk.VoteStop2(baseId) }; } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('sdk:getStatus', async () => ({ loaded: sdkLoaded, connected: connectedBaseId >= 0, baseId: connectedBaseId }));

// Navigation
ipcMain.handle('nav:goto', async (event, page) => {
  const pages = { 'login': 'login.html', 'dashboard': 'dashboard.html', 'live': 'live.html' };
  if (pages[page]) {
    mainWindow.loadFile(path.join(__dirname, 'src', 'pages', pages[page]));
    return { success: true };
  }
  return { success: false, error: 'Page not found' };
});
