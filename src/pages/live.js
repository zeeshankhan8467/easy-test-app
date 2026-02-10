/**
 * EasyTest Live - Run exam page.
 * Collects clicker responses, stores locally, syncs to backend. One response per participant per question.
 */
let examId = null;
let snapshot = null;
let clickerToParticipant = {};
let questions = [];
let currentIndex = 0;
let examState = 'idle'; // idle | running | paused | ended
let responses = {};       // current question: { clickerId: { answer, participantId, name, timestamp } }
let allResponsesByQuestion = {}; // questionIndex -> { participantId: { answer, timestamp } }
let questionTimerSec = 0;
let timerInterval = null;
let syncInterval = null;
let perQuestionSeconds = 30; // default; 0 = no auto-advance

const timerDisplay = document.getElementById('timerDisplay');
const examTitle = document.getElementById('examTitle');
const connectionStatus = document.getElementById('connectionStatus');
const startBtn = document.getElementById('startBtn');
const pauseBtn = document.getElementById('pauseBtn');
const nextBtn = document.getElementById('nextBtn');
const endBtn = document.getElementById('endBtn');
const fullscreenBtn = document.getElementById('fullscreenBtn');
const backLink = document.getElementById('backLink');
const responseCount = document.getElementById('responseCount');
const totalStudentsEl = document.getElementById('totalStudents');
const responsePercentEl = document.getElementById('responsePercent');
const responsesListEl = document.getElementById('responsesList');
const syncStatus = document.getElementById('syncStatus');
const questionNumber = document.getElementById('questionNumber');
const questionText = document.getElementById('questionText');
const questionTypeEl = document.getElementById('questionType');
const optionsList = document.getElementById('optionsList');
const questionNavEl = document.getElementById('questionNav');
const sessionStatusEl = document.getElementById('sessionStatus');
let participantNames = {}; // participantId -> name (for response list)

function letterToIndex(letter) {
  const c = (letter || '').toString().toUpperCase().charAt(0);
  if (c >= 'A' && c <= 'D') return c.charCodeAt(0) - 65;
  return 0;
}

function loadExamFromStorage() {
  const raw = sessionStorage.getItem('easytest_live_exam');
  if (!raw) {
    window.electronAPI.nav('dashboard');
    return;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    sessionStorage.removeItem('easytest_live_exam');
    window.electronAPI.nav('dashboard');
    return;
  }
  if (!data || (data.examId == null && !data.snapshot)) {
    sessionStorage.removeItem('easytest_live_exam');
    window.electronAPI.nav('dashboard');
    return;
  }
  examId = data.examId;
  snapshot = data.snapshot || {};
  clickerToParticipant = data.clickerToParticipant || {};
  const rawQuestions = (snapshot.questions && Array.isArray(snapshot.questions)) ? snapshot.questions : [];
  questions = [...rawQuestions].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  examTitle.textContent = snapshot.title || 'Exam';
  participantNames = {};
  Object.values(clickerToParticipant).forEach(p => { if (p && p.id != null) participantNames[p.id] = p.name || 'Participant'; });
  perQuestionSeconds = 30;
  if (questions.length > 0) {
    const first = questions[0];
    const t = first.timeout;
    if (typeof t === 'number' && t > 0) perQuestionSeconds = t;
  }
  if (totalStudentsEl) totalStudentsEl.textContent = Object.keys(clickerToParticipant).length;
  renderQuestion();
  renderQuestionNav();
  updateResponsesUI();
  updateStartButtonState();
}

function updateStartButtonState() {
  if (!startBtn) return;
  const hasQuestions = questions.length > 0;
  startBtn.disabled = !hasQuestions || examState !== 'idle';
  startBtn.title = !hasQuestions ? 'No questions in this exam' : '';
}

function renderQuestion() {
  if (!questions.length) {
    if (questionNumber) questionNumber.textContent = '—';
    if (questionTypeEl) questionTypeEl.textContent = 'MCQ';
    if (questionText) questionText.textContent = 'No questions in this exam. Add questions in the EasyTest web app and freeze the exam.';
    if (optionsList) optionsList.innerHTML = '';
    updateStartButtonState();
    return;
  }
  const q = questions[currentIndex];
  const opts = q.options || [];
  if (questionNumber) questionNumber.textContent = `Q${currentIndex + 1}`;
  if (questionTypeEl) questionTypeEl.textContent = (q.type || 'MCQ').toUpperCase();
  if (questionText) questionText.textContent = q.text || '—';

  const counts = { A: 0, B: 0, C: 0, D: 0 };
  Object.values(responses).forEach(r => {
    if (r.answer && counts[r.answer] !== undefined) counts[r.answer]++;
  });
  const totalResponses = Object.keys(responses).length || 1;

  const optionKeys = ['A', 'B', 'C', 'D'];
  optionsList.innerHTML = optionKeys.slice(0, Math.max(4, (opts && opts.length) || 4)).map((key, idx) => {
    const label = (opts && opts[idx] != null) ? (typeof opts[idx] === 'string' ? opts[idx] : (opts[idx].text || opts[idx].label || key)) : key;
    const count = counts[key] || 0;
    const pct = Math.round((count / totalResponses) * 100);
    return `
      <div class="option-item">
        <div class="option-key">${key}</div>
        <div class="option-content">
          <div class="option-text-row">${escapeHtml(label)}</div>
          <div class="option-bar"><div class="option-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="option-count">${pct}%</div>
      </div>
    `;
  }).join('');
  updateStartButtonState();
}

function renderQuestionNav() {
  if (!questionNavEl || !questions.length) return;
  questionNavEl.innerHTML = questions.map((_, index) => {
    const hasResponses = allResponsesByQuestion[index] && Object.keys(allResponsesByQuestion[index]).length > 0;
    const isActive = index === currentIndex;
    const classes = ['question-nav-btn', isActive ? 'active' : '', hasResponses ? 'completed' : ''].filter(Boolean).join(' ');
    return `<button type="button" class="${classes}" data-index="${index}" ${examState === 'running' ? '' : ''}>${index + 1}</button>`;
  }).join('');
  questionNavEl.querySelectorAll('.question-nav-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.index, 10);
      if (isNaN(idx) || idx < 0 || idx >= questions.length) return;
      if (idx === currentIndex) return;
      if (examState === 'running' && !confirm('Switch question? Current question will be left as-is.')) return;
      currentIndex = idx;
      responses = {};
      if (allResponsesByQuestion[currentIndex]) {
        Object.entries(allResponsesByQuestion[currentIndex]).forEach(([key, data]) => {
          const isKeySN = key.startsWith('k:');
          const isDevice = key.startsWith('d:');
          const keySN = isKeySN ? (data.keySN || data.clickerIdForBackend || key.slice(2)) : null;
          const deviceOnly = isDevice ? (data.clickerIdForBackend || data.deviceId || key.slice(2)) : null;
          if (isKeySN && keySN) {
            responses[key] = { answer: data.answer, participantId: null, name: participantNames[keySN] || participantNames[key] || 'Student', timestamp: data.timestamp };
          } else if (isDevice && deviceOnly) {
            responses[key] = { answer: data.answer, participantId: null, name: participantNames[deviceOnly] || participantNames[key] || 'Student', timestamp: data.timestamp };
          } else {
            const pid = parseInt(key, 10);
            if (!isNaN(pid)) {
              responses['p' + pid] = { answer: data.answer, participantId: pid, name: participantNames[pid] || participantNames[String(pid)] || 'Student', timestamp: data.timestamp };
            }
          }
        });
      }
      renderQuestion();
      renderQuestionNav();
      updateResponsesUI();
    });
  });
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function updateResponsesUI() {
  const count = Object.keys(responses).length;
  const total = Object.keys(clickerToParticipant).length || 0;
  const percent = total > 0 ? Math.round((count / total) * 100) : 0;
  if (responseCount) responseCount.textContent = count;
  if (totalStudentsEl) totalStudentsEl.textContent = total;
  if (responsePercentEl) responsePercentEl.textContent = percent + '%';

  if (!responsesListEl) return;
  if (count === 0) {
    responsesListEl.innerHTML = '<div class="responses-placeholder">' + (examState === 'running' || examState === 'paused' ? 'Waiting for responses...' : 'No responses yet') + '</div>';
    return;
  }
  const sorted = Object.entries(responses).sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
  responsesListEl.innerHTML = sorted.map(([, data]) => {
    const name = data.name || (data.participantId != null && (participantNames[data.participantId] || participantNames[String(data.participantId)])) || 'Student';
    const initials = name.split(/\s+/).map(n => n[0]).join('').toUpperCase().substring(0, 2) || '?';
    return `
      <div class="response-item">
        <div class="response-student">
          <div class="response-avatar">${escapeHtml(initials)}</div>
          <span>${escapeHtml(name)}</span>
        </div>
        <span class="response-answer pending">Submitted</span>
      </div>
    `;
  }).join('');
}

function persistPending() {
  const payload = buildSyncPayload();
  if (!payload.responses.length && !payload.attendance.length) return;
  window.electronAPI.getPendingResponses().then(all => {
    const next = { ...all, [String(examId)]: payload };
    window.electronAPI.savePendingResponses(next);
  });
}

function buildSyncPayload() {
  const responsesList = [];
  const attendanceSet = new Set();
  if (!examId || !questions.length) return { responses: responsesList, attendance: Array.from(attendanceSet) };
  Object.keys(allResponsesByQuestion).forEach(qIdx => {
    const q = questions[parseInt(qIdx, 10)];
    if (!q || q.question_id == null) return;
    const questionId = q.question_id;
    Object.entries(allResponsesByQuestion[qIdx]).forEach(([key, data]) => {
      const isKeySN = key.startsWith('k:');
      const isDevice = key.startsWith('d:');
      const keySN = isKeySN ? (data.keySN || data.clickerIdForBackend || key.slice(2)) : null;
      const deviceOnly = isDevice ? (data.clickerIdForBackend || data.deviceId || key.slice(2)) : null;
      if (isKeySN && keySN) {
        responsesList.push({
          clicker_id: keySN,
          question_id: questionId,
          selected_answer: letterToIndex(data.answer),
          answered_at: data.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString(),
        });
      } else if (isDevice && deviceOnly) {
        responsesList.push({
          clicker_id: String(deviceOnly),
          question_id: questionId,
          selected_answer: letterToIndex(data.answer),
          answered_at: data.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString(),
        });
      } else if (!isKeySN && !isDevice) {
        const participantId = parseInt(key, 10);
        if (!isNaN(participantId)) {
          attendanceSet.add(participantId);
          responsesList.push({
            participant_id: participantId,
            question_id: questionId,
            selected_answer: letterToIndex(data.answer),
            answered_at: data.timestamp ? new Date(data.timestamp).toISOString() : new Date().toISOString(),
          });
        }
      }
    });
  });
  const byParticipant = responsesList.filter(r => r.participant_id != null).length;
  const byClickerId = responsesList.filter(r => r.clicker_id != null).length;
  if (responsesList.length) {
    console.log('[EasyTest Live] buildSyncPayload:', responsesList.length, 'total (by participant_id:', byParticipant, ', by clicker_id:', byClickerId, ')');
  }
  return { responses: responsesList, attendance: Array.from(attendanceSet) };
}

/**
 * Submit a single response to the backend immediately (like acadally per-response save).
 */
async function syncSingleResponse(payloadItem, attendanceIds) {
  if (!examId || !payloadItem) return;
  const responses = [payloadItem];
  const attendance = Array.isArray(attendanceIds) ? attendanceIds : (payloadItem.participant_id != null ? [payloadItem.participant_id] : []);
  try {
    const result = await window.electronAPI.syncLiveResults({ examId, responses, attendance });
    if (result.success) {
      if (syncStatus) syncStatus.textContent = 'Saved.';
      const names = result.data?.participant_names;
      if (names && typeof names === 'object') {
        Object.keys(names).forEach(k => { participantNames[k] = names[k]; });
        updateResponsesUI();
      }
    } else if (syncStatus) {
      syncStatus.textContent = 'Save failed. Will retry at session end.';
    }
  } catch (e) {
    if (syncStatus) syncStatus.textContent = 'Save failed. Will retry at session end.';
  }
}

async function runSync() {
  const payload = buildSyncPayload();
  if (!payload.responses.length && !payload.attendance.length) {
    syncStatus.textContent = 'Nothing to sync.';
    console.log('[EasyTest Live] runSync: nothing to sync (0 responses, 0 attendance). Check that clicker is matched: set participant Clicker ID to device serial (e.g. shown as "Clicker 206E396C5931" in live view).');
    return true;
  }
  console.log('[EasyTest Live] runSync: sending', payload.responses.length, 'responses,', payload.attendance.length, 'attendance for exam', examId);
  syncStatus.textContent = 'Syncing...';
  const result = await window.electronAPI.syncLiveResults({ examId, responses: payload.responses, attendance: payload.attendance });
  if (result.success) {
    const synced = result.data?.synced ?? 0;
    syncStatus.textContent = `Synced ${synced} responses.`;
    console.log('[EasyTest Live] runSync: backend saved', synced, 'responses. Full response:', result.data);
    const names = result.data?.participant_names;
    if (names && typeof names === 'object') {
      Object.keys(names).forEach(key => { participantNames[key] = names[key]; });
      Object.keys(responses).forEach(rid => {
        const r = responses[rid];
        const name = r.participantId != null ? names[String(r.participantId)] : (r.deviceId && names[r.deviceId]) || (r.keySN && names[r.keySN]);
        if (name) r.name = name;
      });
      updateResponsesUI();
    }
    await window.electronAPI.clearPendingForExam(examId);
    return true;
  }
  console.warn('[EasyTest Live] runSync failed:', result.error);
  syncStatus.textContent = `Sync failed: ${result.error}. Data saved locally.`;
  return false;
}

function onClickerResponse(data) {
  if (examState !== 'running' && examState !== 'paused') return;
  const answer = (data.answer || '').toUpperCase().charAt(0);
  if (!['A', 'B', 'C', 'D'].includes(answer)) return;

  // SDK sends clicker_id = keyId (1-4, the key pressed); keySN = device serial (may be empty from some DLLs).
  const keySN = (data.keySN != null && String(data.keySN).trim() !== '') ? String(data.keySN).trim() : '';
  const deviceId = keySN || ('d' + (data.clicker_id != null ? data.clicker_id : '') + '_' + (data.timestamp || Date.now()));
  const participant =
    clickerToParticipant[keySN] ||
    clickerToParticipant[deviceId] ||
    (data.clicker_id != null && clickerToParticipant[String(data.clicker_id)]) ||
    (data.clicker_id != null && clickerToParticipant[Number(data.clicker_id)]);

  console.log('[EasyTest Live] Response received: clicker_id=' + data.clicker_id + ', keySN="' + keySN + '", deviceId="' + deviceId + '", matched=' + (participant ? (participant.name + ' (id=' + participant.id + ')') : 'none') + ', map keys=' + Object.keys(clickerToParticipant).join(','));

  // One response per device per question (use deviceId so we don't duplicate)
  if (responses[deviceId]) return;

  const timestamp = data.timestamp || Date.now();
  const displayName = participant ? participant.name : 'Student';

  const record = {
    answer,
    participantId: participant ? participant.id : null,
    name: displayName,
    timestamp,
    keySN: keySN || undefined,
    deviceId,
  };
  responses[deviceId] = record;

  // Store for sync: always store every response so we never get "nothing to sync"
  // Matched: by participantId. Unmatched: by 'k:'+keySN or 'd:'+deviceId (when keySN empty)
  if (!allResponsesByQuestion[currentIndex]) allResponsesByQuestion[currentIndex] = {};
  const q = questions[currentIndex];
  const questionId = q && q.question_id != null ? q.question_id : null;
  const answeredAt = new Date(timestamp).toISOString();
  const payloadItem = questionId != null ? {
    question_id: questionId,
    selected_answer: letterToIndex(answer),
    answered_at: answeredAt,
  } : null;

  if (participant) {
    const participantId = participant.id;
    if (!allResponsesByQuestion[currentIndex][participantId]) {
      allResponsesByQuestion[currentIndex][participantId] = { answer, timestamp };
      persistPending();
      if (payloadItem) {
        const item = { ...payloadItem, participant_id: participantId };
        syncSingleResponse(item, [participantId]);
      }
    }
  } else {
    const syncKey = keySN ? 'k:' + keySN : 'd:' + deviceId;
    const clickerIdForBackend = keySN || deviceId;
    if (!allResponsesByQuestion[currentIndex][syncKey]) {
      allResponsesByQuestion[currentIndex][syncKey] = { answer, timestamp, keySN: keySN || undefined, deviceId, clickerIdForBackend };
      persistPending();
      if (payloadItem) {
        const item = { ...payloadItem, clicker_id: String(clickerIdForBackend) };
        syncSingleResponse(item, []);
      }
      console.log('[EasyTest Live] Unmatched clicker: keySN=' + (keySN || '(empty)') + ', deviceId=' + deviceId + '. To save to backend set participant Clicker ID to "' + clickerIdForBackend + '" in web app.');
    }
  }

  updateResponsesUI();
  renderQuestion();
}

function startTimer() {
  if (perQuestionSeconds <= 0) return;
  questionTimerSec = perQuestionSeconds;
  timerDisplay.textContent = `${String(Math.floor(questionTimerSec / 60)).padStart(2, '0')}:${String(questionTimerSec % 60).padStart(2, '0')}`;
  timerDisplay.classList.remove('warning', 'danger');
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    questionTimerSec--;
    const m = Math.floor(questionTimerSec / 60);
    const s = questionTimerSec % 60;
    timerDisplay.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    if (questionTimerSec <= 10) timerDisplay.classList.add('danger');
    else if (questionTimerSec <= 30) timerDisplay.classList.add('warning');
    if (questionTimerSec <= 0) {
      clearInterval(timerInterval);
      timerInterval = null;
      nextQuestion();
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerDisplay.textContent = '00:00';
  timerDisplay.classList.remove('warning', 'danger');
}

function nextQuestion() {
  stopTimer();
  if (questions.length === 0 || currentIndex >= questions.length - 1) {
    endExam();
    return;
  }
  currentIndex++;
  responses = {};
  if (allResponsesByQuestion[currentIndex]) {
    Object.entries(allResponsesByQuestion[currentIndex]).forEach(([key, data]) => {
      const isKeySN = key.startsWith('k:');
      const isDevice = key.startsWith('d:');
      const keySN = isKeySN ? (data.keySN || data.clickerIdForBackend || key.slice(2)) : null;
      const deviceOnly = isDevice ? (data.clickerIdForBackend || data.deviceId || key.slice(2)) : null;
      if (isKeySN && keySN) {
        responses[key] = { answer: data.answer, participantId: null, name: participantNames[keySN] || participantNames[key] || 'Student', timestamp: data.timestamp };
      } else if (isDevice && deviceOnly) {
        responses[key] = { answer: data.answer, participantId: null, name: participantNames[deviceOnly] || participantNames[key] || 'Student', timestamp: data.timestamp };
      } else {
        const pid = parseInt(key, 10);
        if (!isNaN(pid)) {
          responses['p' + pid] = { answer: data.answer, participantId: pid, name: participantNames[pid] || participantNames[String(pid)] || 'Student', timestamp: data.timestamp };
        }
      }
    });
  }
  renderQuestion();
  renderQuestionNav();
  updateResponsesUI();
  if (examState === 'running') startTimer();
}

async function startExam() {
  if (!questions.length) {
    alert('No questions in this exam. Add questions in the EasyTest web app and freeze the exam.');
    return;
  }
  const status = await window.electronAPI.getSDKStatus();
  if (!status.loaded) {
    alert('Clicker SDK not loaded. Ensure EasyTestSDK_x64.dll is in the app folder.');
    return;
  }
  if (!status.connected) {
    const conn = await window.electronAPI.connectClicker(1);
    if (!conn.success) {
      alert('Could not connect to clicker base: ' + (conn.error || 'Unknown error'));
      return;
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Same session start settings as acadally-electron-app (session.js)
  const startResult = await window.electronAPI.startSession({
    baseId: 0,
    voteType: 10,   // Multiple Choice
    optionCount: 4, // A, B, C, D
    timeout: 0,     // no timeout; main process uses || 30 so SDK gets 30 (clicker stays active, not blank)
    minSelect: 1,
    maxSelect: 1,
    submitMode: 0,  // Auto submit
    displayMode: 0,
  });
  if (!startResult.success) console.warn('SDK startSession:', startResult.error);

  examState = 'running';
  startBtn.classList.add('hidden');
  pauseBtn.classList.remove('hidden');
  nextBtn.classList.remove('hidden');
  endBtn.classList.remove('hidden');
  connectionStatus.textContent = 'Clicker connected';
  connectionStatus.classList.remove('disconnected');
  connectionStatus.classList.add('connected');
  if (sessionStatusEl) {
    sessionStatusEl.className = 'status-badge status-connected';
    sessionStatusEl.innerHTML = '<span class="status-dot"></span><span>Active</span>';
  }
  startTimer();
  // Background sync every 30s
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = setInterval(() => runSync(), 30000);
}

function pauseExam() {
  if (examState !== 'running') return;
  examState = 'paused';
  stopTimer();
  window.electronAPI.stopSession(0);
  pauseBtn.textContent = 'Resume';
  if (sessionStatusEl) {
    sessionStatusEl.className = 'status-badge status-pending';
    sessionStatusEl.innerHTML = '<span class="status-dot"></span><span>Paused</span>';
  }
}

function resumeExam() {
  if (examState !== 'paused') return;
  examState = 'running';
  pauseBtn.textContent = 'Pause';
  if (sessionStatusEl) {
    sessionStatusEl.className = 'status-badge status-connected';
    sessionStatusEl.innerHTML = '<span class="status-dot"></span><span>Active</span>';
  }
  window.electronAPI.startSession({ baseId: 0, voteType: 10, optionCount: 4, timeout: 0, minSelect: 1, maxSelect: 1, submitMode: 0, displayMode: 0 }); // same as acadally
  startTimer();
}

async function endExam() {
  examState = 'ended';
  stopTimer();
  if (syncInterval) clearInterval(syncInterval);
  syncInterval = null;
  // Save to local storage first so we don't lose data if sync fails
  persistPending();
  window.electronAPI.stopSession(0);
  startBtn.classList.add('hidden');
  pauseBtn.classList.add('hidden');
  nextBtn.classList.add('hidden');
  endBtn.classList.add('hidden');
  if (sessionStatusEl) {
    sessionStatusEl.className = 'status-badge status-pending';
    sessionStatusEl.innerHTML = '<span class="status-dot"></span><span>Ended</span>';
  }
  // Explicitly submit responses when session ends
  if (syncStatus) syncStatus.textContent = 'Submitting responses...';
  const synced = await runSync();
  if (!synced && syncStatus && !(syncStatus.textContent || '').includes('Nothing to sync')) {
    alert('Could not submit responses to server. Data is saved locally. Try syncing again from the dashboard or check your connection.');
  }
}

backLink.addEventListener('click', async (e) => {
  e.preventDefault();
  if (examState === 'running' || examState === 'paused') {
    if (!confirm('End exam and go back? Responses will be synced.')) return;
    await endExam();
  }
  window.electronAPI.nav('dashboard');
});

startBtn.addEventListener('click', startExam);
pauseBtn.addEventListener('click', () => {
  if (examState === 'running') pauseExam();
  else if (examState === 'paused') resumeExam();
});
nextBtn.addEventListener('click', nextQuestion);
endBtn.addEventListener('click', async () => {
  if (!confirm('End the exam and sync responses?')) return;
  await endExam();
});

fullscreenBtn.addEventListener('click', () => {
  document.getElementById('liveExam').classList.toggle('fullscreen');
});

window.electronAPI.onClickerResponse(onClickerResponse);
window.electronAPI.onConnectEvent((data) => {
  if (data.mode === 1) {
    connectionStatus.textContent = 'Clicker connected';
    connectionStatus.classList.remove('disconnected');
    connectionStatus.classList.add('connected');
  } else {
    connectionStatus.textContent = 'Clicker disconnected';
    connectionStatus.classList.remove('connected');
    connectionStatus.classList.add('disconnected');
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', loadExamFromStorage);
} else {
  loadExamFromStorage();
}
