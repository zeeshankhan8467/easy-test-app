/**
 * EasyTest Live - Main Process
 * Classroom clicker-based exam app. Connects to EasyTest backend and same
 * clicker hardware (EasyTestSDK/koffi) as acadally-electron-app.
 */
const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');

// ============ Configuration ============
const DEFAULT_API_URL = 'https://easytestlive.com/api/';
let configPath = null;
let logPath = null;
function getLogPath() {
  if (!logPath) logPath = path.join(app.getPath('userData'), 'easytest-live.log');
  return logPath;
}
function log(msg, data) {
  const line = `[${new Date().toISOString()}] ${msg}${data != null ? ' ' + JSON.stringify(data) : ''}\n`;
  console.log(msg, data != null ? data : '');
  try {
    fs.appendFileSync(getLogPath(), line);
  } catch (e) { console.error('log write:', e); }
}
function getConfigPath() {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'config.json');
  return configPath;
}
function getConfig() {
  try {
    const p = getConfigPath();
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e) { console.error('getConfig:', e); }
  return {};
}

/** Create default config.json in userData if missing, so user can find and edit it (e.g. clickerSubmitMode). */
function ensureConfigFile() {
  const p = getConfigPath();
  if (fs.existsSync(p)) return;
  try {
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const defaultConfig = {
      apiUrl: DEFAULT_API_URL,
      clickerSubmitMode: 0,
      clickerDisplayMode: 0,
      _comment: 'clickerSubmitMode: try 0, 1, or 2. clickerDisplayMode: try 1. Restart app after editing.'
    };
    fs.writeFileSync(p, JSON.stringify(defaultConfig, null, 2), 'utf8');
    console.log('[EasyTest Live] Created config file at:', p);
  } catch (e) { console.error('[EasyTest Live] Could not create config file:', e); }
}
function getApiBaseUrl() {
  let source = 'default';
  let url = DEFAULT_API_URL;
  try {
    const cfg = getConfig();
    if (cfg.apiUrl && typeof cfg.apiUrl === 'string') {
      const raw = cfg.apiUrl.trim();
      // Prefer easytestlive.com over old IP; treat old IP as "use default"
      const normalized = raw.replace(/\/*$/, '');
      const isOldIp = normalized === 'http://168.144.18.139' || normalized === 'https://168.144.18.139' ||
        normalized.startsWith('http://168.144.18.139/') || normalized.startsWith('https://168.144.18.139/');
      if (isOldIp) {
        url = DEFAULT_API_URL;
        source = 'default';
      } else {
        url = raw.endsWith('/') ? raw : raw + '/';
        source = 'config.json';
      }
    }
  } catch (e) { console.error('getApiBaseUrl config:', e); }
  if (source === 'default' && process.env.EASYTEST_API_URL) {
    url = (process.env.EASYTEST_API_URL || '').replace(/\/*$/, '/');
    source = 'env';
  } else if (source === 'default') {
    url = (url || DEFAULT_API_URL).replace(/\/*$/, '/');
  }
  return url;
}

function makeRequest(url, options = {}) {
  const TIMEOUT_MS = 20000;
  log('API request', { method: options.method || 'GET', url });
  return new Promise((resolve, reject) => {
    const request = net.request({ method: options.method || 'GET', url });
    const timeout = setTimeout(() => {
      request.abort();
      const errMsg = 'Connection timed out. Check server address and network.';
      log('API error', { url, error: errMsg });
      reject(new Error(errMsg));
    }, TIMEOUT_MS);

    if (options.headers) {
      Object.entries(options.headers).forEach(([k, v]) => request.setHeader(k, v));
    }

    let responseData = '';
    request.on('response', (response) => {
      clearTimeout(timeout);
      response.on('data', (chunk) => { responseData += chunk.toString(); });
      response.on('end', () => {
        if (response.statusCode >= 400) {
          log('API response', { url, status: response.statusCode, body: responseData?.slice(0, 200) });
        }
        try {
          const data = JSON.parse(responseData);
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data });
        } catch (e) {
          resolve({ ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, data: responseData });
        }
      });
    });
    request.on('error', (err) => {
      clearTimeout(timeout);
      log('API error', { url, error: err.message || String(err) });
      reject(err);
    });
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

// Base station USB VID/PID from SDK log (e.g. "device disconnected:: ... VID_2F70&PID_EA10 ...")
const BASE_STATION_VID = '2f70';
const BASE_STATION_PID = 'ea10';
let usbPollInterval = null;

/** On Windows: check if base station USB device is present. Returns true if present, false otherwise. */
function checkBaseStationUsbPresent() {
  if (process.platform !== 'win32') return null;
  return new Promise((resolve) => {
    // DeviceID contains VID&PID (e.g. USB\VID_2F70&PID_EA10\...). When unplugged device is usually removed or Status != OK.
    const ps1 = `@(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.DeviceID -match '${BASE_STATION_VID}' -and $_.DeviceID -match '${BASE_STATION_PID}' }).Count`;
    const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -Command "try { $n = ${ps1}; Write-Output $n } catch { Write-Output 0 }"`;
    exec(cmd, { timeout: 5000, windowsHide: true }, (err, stdout) => {
      if (err) {
        resolve(false);
        return;
      }
      const out = String(stdout || '').trim();
      const count = parseInt(out, 10);
      resolve(!isNaN(count) && count > 0);
    });
  });
}

/** Notify renderer that connection state changed (so UI updates). */
function notifyConnectionState(connected) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('sdk-connect-event', {
    baseId: connected ? 0 : 0,
    mode: connected ? 1 : 0,
    info: '',
  });
}

/** Poll USB and update connection state; notify renderer when state changes. */
function pollUsbAndUpdateConnection() {
  if (!sdkLoaded || process.platform !== 'win32') return;
  checkBaseStationUsbPresent().then((present) => {
    if (present === null) return;
    if (connectedBaseId >= 0 && !present) {
      connectedBaseId = -1;
      notifyConnectionState(false);
      console.log('[EasyTest Live] Base station USB removed – set disconnected, UI notified');
    } else if (connectedBaseId < 0 && present && sdk) {
      try {
        const result = sdk.Connect(1, '');
        if (result >= 0) {
          console.log('[EasyTest Live] Base station USB detected – Connect(1) called');
        }
      } catch (e) {
        // ignore
      }
    }
  });
}

function startUsbPolling() {
  if (usbPollInterval) return;
  if (process.platform !== 'win32') return;
  usbPollInterval = setInterval(pollUsbAndUpdateConnection, 2000);
  console.log('[EasyTest Live] USB base station polling started (every 2s)');
  pollUsbAndUpdateConnection();
}

function stopUsbPolling() {
  if (usbPollInterval) {
    clearInterval(usbPollInterval);
    usbPollInterval = null;
  }
}

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
      const keyNum = typeof keyId === 'number' ? keyId : parseInt(keyId, 10);
      let answer = '';
      const infoStr = (info && typeof info === 'string') ? info.trim() : '';
      if (infoStr) {
        const upper = infoStr.toUpperCase().charAt(0);
        const num = parseInt(infoStr, 10);
        if (num >= 1 && num <= 10) answer = String.fromCharCode(64 + num);
        else if (upper >= 'A' && upper <= 'J') answer = upper;
        else {
          console.log('[EasyTest Live] Clicker key ignored: raw_info="' + infoStr + '" (not A-J / 1-10)');
          return;
        }
      }
      if (!answer) {
        if (keyNum >= 0 && keyNum <= 9) answer = String.fromCharCode(65 + keyNum);
        else if (keyNum >= 1 && keyNum <= 10) answer = String.fromCharCode(64 + keyNum);
      }
      const validAnswers = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
      if (!answer || !validAnswers.includes(answer)) return;
      if (mainWindow && !mainWindow.isDestroyed()) {
        const keySNStr = keySN != null ? String(keySN).trim() : '';
        if (!keySNStr && !loggedEmptyKeySN) {
          loggedEmptyKeySN = true;
          console.log('[EasyTest Live] Clicker keySN is empty from SDK (type=' + typeof keySN + '). Syncing with deviceId fallback (e.g. d1_123).');
        }
        const payload = {
          baseId, clicker_id: keyId, keySN: keySNStr || (keySN != null ? String(keySN) : ''), mode, time, answer, raw_info: info, timestamp: Date.now()
        };
        console.log('[EasyTest Live] Clicker response from SDK: keyId=' + keyId + ', keySN="' + keySNStr + '", answer=' + answer + ', raw_info="' + (info != null ? String(info) : '') + '"');
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
  ensureConfigFile();
  loadSDK();
  createWindow();
  const userData = app.getPath('userData');
  const configPathOut = getConfigPath();
  console.log('[EasyTest Live] Config file path (edit for API URL or clickerSubmitMode):', configPathOut);
  log('EasyTest Live started', {
    apiBaseUrl: getApiBaseUrl(),
    userData,
    logFile: getLogPath(),
    configPath: configPathOut,
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  stopUsbPolling();
  if (sdkLoaded && sdk) {
    try { sdk.VoteStop2(0); sdk.Disconnect(0); sdk.StopTaskAndFree(); } catch (e) { console.error(e); }
  }
  if (process.platform !== 'darwin') app.quit();
});

// ============ Auth (EasyTest: email + password -> token, user) ============
ipcMain.handle('auth:login', async (event, { email, password }) => {
  try {
    const response = await makeRequest(`${getApiBaseUrl()}auth/login/`, {
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
    const response = await makeRequest(`${getApiBaseUrl()}exams/`, { headers: authHeaders() });
    if (response.ok) {
      const list = Array.isArray(response.data) ? response.data : (response.data?.results || []);
      list.forEach((exam, i) => {
        console.log('[EasyTest Live] Exam API exam[' + i + ']: id=' + exam.id + ', title=' + (exam.title || '') + ', revisable=' + JSON.stringify(exam.revisable) + ' (type: ' + typeof exam.revisable + ')');
      });
      log('Exam list API response', { count: list.length, revisablePerExam: list.map(e => ({ id: e.id, title: e.title, revisable: e.revisable })) });
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
    const response = await makeRequest(`${getApiBaseUrl()}exams/${examId}/snapshot/`, { headers: authHeaders() });
    if (response.ok) {
      const data = response.data;
      const revisable = data != null ? data.revisable : undefined;
      console.log('[EasyTest Live] Exam snapshot API: examId=' + examId + ', revisable=' + JSON.stringify(revisable) + ' (type: ' + typeof revisable + ')');
      log('Exam snapshot API response', { examId, revisable, revisableType: typeof revisable });
      // Print full API response so you can check (terminal + log file)
      const snapshotJson = JSON.stringify(data, null, 2);
      console.log('[EasyTest Live] ========== Exam snapshot API response (full) ==========');
      console.log(snapshotJson);
      console.log('[EasyTest Live] ============================================================');
      try {
        fs.appendFileSync(getLogPath(), '\n--- Exam snapshot full JSON ---\n' + snapshotJson + '\n---\n');
      } catch (e) { console.error('append snapshot to log:', e); }
      return { success: true, data };
    }
    return { success: false, error: response.data?.detail || 'Failed to fetch snapshot' };
  } catch (e) {
    return { success: false, error: e.message };
  }
});

ipcMain.handle('api:fetchParticipants', async (event, examId) => {
  if (!getStore().token) return { success: false, error: 'Not authenticated' };
  try {
    const url = examId != null ? `${getApiBaseUrl()}participants/?exam_id=${examId}` : `${getApiBaseUrl()}participants/`;
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

ipcMain.handle('api:syncLiveResults', async (event, { examId, responses, attendance, exam_started_at }) => {
  if (!getStore().token) {
    console.log('[EasyTest Live] Sync skipped: not authenticated');
    return { success: false, error: 'Not authenticated' };
  }
  const respCount = (responses && responses.length) || 0;
  const attCount = (attendance && attendance.length) || 0;
  console.log(`[EasyTest Live] Submitting to backend: examId=${examId}, responses=${respCount}, attendance=${attCount}`);
  if (exam_started_at) {
    console.log('[EasyTest Live] TIME_TAKEN DEBUG: exam_started_at sent to backend:', exam_started_at);
  }
  if (respCount > 0 && responses[0]) {
    const r = responses[0];
    console.log('[EasyTest Live] First response: participant_id=' + (r.participant_id ?? 'none') + ', clicker_id="' + (r.clicker_id ?? '') + '", question_id=' + (r.question_id ?? ''));
    if (r.answered_at && exam_started_at) {
      const startMs = new Date(exam_started_at).getTime();
      const answeredMs = new Date(r.answered_at).getTime();
      const sec = Math.max(0, Math.round((answeredMs - startMs) / 1000));
      console.log('[EasyTest Live] TIME_TAKEN DEBUG: first response answered_at=' + r.answered_at + ', expected time_taken (sec)=' + sec);
    }
  }
  if (responses && responses.length > 0) {
    log('Sync payload (time data: answered_at per response)', {
      examId,
      responseCount: responses.length,
      responses: responses.map(r => ({
        question_id: r.question_id,
        selected_answer: r.selected_answer,
        answered_at: r.answered_at,
        participant_id: r.participant_id ?? null,
        clicker_id: r.clicker_id ?? null,
      })),
      exam_started_at: exam_started_at || null,
    });
  }
  try {
    const response = await makeRequest(`${getApiBaseUrl()}exams/${examId}/sync_live_results/`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        responses: responses || [],
        attendance: attendance || [],
        exam_started_at: exam_started_at || undefined,
      }),
    });
    if (response.ok) {
      const d = response.data;
      console.log(
        '[EasyTest Live] Backend saved: synced=' + (d?.synced ?? 0) +
        (d?.answers_updated != null ? ', answers_updated=' + d.answers_updated : '') +
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
// Start voting session — VoteType_Choice setting: minSelect,maxSelect,submitMode,displayMode,timeout,optionCount
// Per EasyTest SDK: Keypad_Config (WriteHDParam mode 17) = "ReportMode, offtime, SubmisMode, Buzzer, LCD, Vib, Lang" — set SubmisMode=0 so clicker does not require OK
ipcMain.handle('sdk:startSession', async (event, settings = {}) => {
  if (!sdkLoaded || !sdk) return { success: false, error: 'SDK not loaded' };
  try {
    const cfg = getConfig();
    const baseId = settings.baseId || 0;
    const voteType = settings.voteType || 10; // 10 = Choice/MCQ
    const optionCount = settings.optionCount || 4;
    const timeout = settings.timeout || 30; // 0 from renderer becomes 30 so clicker does not go blank
    const minSelect = settings.minSelect || 1;
    const maxSelect = settings.maxSelect || 1;
    // Prefer config.json clickerSubmitMode so user can try 0,1,2 without code change (some devices: 1=no OK)
    const submitMode = cfg.clickerSubmitMode !== undefined && cfg.clickerSubmitMode !== null
      ? Number(cfg.clickerSubmitMode)
      : (settings.submitMode ?? 1);
    // displayMode: 0 = blank, 1 = active. Some devices: try clickerDisplayMode=1 in config to avoid OK step
    const displayMode = cfg.clickerDisplayMode !== undefined && cfg.clickerDisplayMode !== null
      ? Number(cfg.clickerDisplayMode)
      : (settings.displayMode ?? 0);
    const settingStr = `${minSelect},${maxSelect},${submitMode},${displayMode},${timeout},${optionCount}`;

    // EasyTest SDK KeyPad_config (mode 17 in latest guide): "Report Mode, Auto Power off Time Mode, Send Mode, Buzz Mode, LCD Backlight Mode, Vibration Switch, Language Mode"
    // Send Mode: 0 = require Submit/OK button, 1 = auto-submit on key press.
    // To match the official C# demo behaviour (and avoid pressing OK), force Send Mode = 1 here.
    const keypadSendMode = 1;
    const keypadConfigStr = `0,0,${keypadSendMode},1,1,0,0`; // Report=0, AutoPowerOff=0 (default), Send=1 (auto-submit), Buzzer=1, LCD=1, Vib=0, Lang=0
    try {
      const wr = sdk.WriteHDParam(baseId, 17, keypadConfigStr);
      console.log('[EasyTest Live] WriteHDParam(KeyPad_config=17) for SendMode=' + keypadSendMode + ': result=' + wr + ', setting="' + keypadConfigStr + '"');
      log('WriteHDParam KeyPad_config', { baseId, mode: 17, setting: keypadConfigStr, result: wr });
    } catch (e) {
      console.warn('[EasyTest Live] WriteHDParam(17) failed (continuing with VoteStart2):', e.message);
    }

    // Print session start settings to console so you can verify what is sent to the clicker
    console.log('========== [EasyTest Live] SESSION START SETTINGS ==========');
    console.log('[EasyTest Live] baseId:', baseId);
    console.log('[EasyTest Live] voteType:', voteType, '(10 = Choice/MCQ)');
    console.log('[EasyTest Live] setting string sent to SDK:', '"' + settingStr + '"');
    console.log('[EasyTest Live] Parsed: minSelect=' + minSelect + ', maxSelect=' + maxSelect + ', submitMode=' + submitMode + ', displayMode=' + displayMode + ', timeout=' + timeout + ', optionCount=' + optionCount);
    console.log('[EasyTest Live] config: clickerSubmitMode=' + (cfg.clickerSubmitMode !== undefined && cfg.clickerSubmitMode !== null ? cfg.clickerSubmitMode : '(default)') + ', clickerDisplayMode=' + (cfg.clickerDisplayMode !== undefined && cfg.clickerDisplayMode !== null ? cfg.clickerDisplayMode : '(default)'));
    if (submitMode === 0 || submitMode === 1) {
      console.log('[EasyTest Live] If clicker STILL requires OK: some SunVote devices ignore submitMode. Try clickerDisplayMode=1 in config.json, or check base station / clicker manual for "instant submit" or "confirm off".');
    }
    console.log('============================================================');
    log('VoteStart2', { baseId, voteType, setting: settingStr, submitMode, fromConfig: cfg.clickerSubmitMode });

    const result = sdk.VoteStart2(baseId, voteType, settingStr);
    return { success: result >= 0, result, message: result >= 0 ? 'Session started' : 'Failed to start session' };
  } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('sdk:stopSession', async (event, baseId = 0) => {
  if (!sdkLoaded || !sdk) return { success: false, error: 'SDK not loaded' };
  try { return { success: sdk.VoteStop2(baseId) >= 0, result: sdk.VoteStop2(baseId) }; } catch (e) { return { success: false, error: e.message }; }
});
ipcMain.handle('sdk:getStatus', async () => {
  const baseConnected = connectedBaseId >= 0;
  if (process.platform === 'win32' && sdkLoaded) {
    const usbPresent = await checkBaseStationUsbPresent();
    const connected = baseConnected && (usbPresent === null || usbPresent === true);
    return { loaded: sdkLoaded, connected, baseId: connectedBaseId };
  }
  return { loaded: sdkLoaded, connected: baseConnected, baseId: connectedBaseId };
});

// Navigation
ipcMain.handle('nav:goto', async (event, page) => {
  const pages = { 'login': 'login.html', 'dashboard': 'dashboard.html', 'live': 'live.html' };
  if (pages[page]) {
    mainWindow.loadFile(path.join(__dirname, 'src', 'pages', pages[page]));
    return { success: true };
  }
  return { success: false, error: 'Page not found' };
});
