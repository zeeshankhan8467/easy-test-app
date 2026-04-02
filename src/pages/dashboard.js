const userNameEl = document.getElementById('userName');
const examListEl = document.getElementById('examList');
const noExamsEl = document.getElementById('noExams');
const studentListEl = document.getElementById('studentList');
const noStudentsEl = document.getElementById('noStudents');
const logoutBtn = document.getElementById('logoutBtn');
const baseStationStatusEl = document.getElementById('baseStationStatus');
const baseStationLabelEl = baseStationStatusEl?.querySelector('.base-station-label');

const attendanceModal = document.getElementById('attendanceModal');
const attendanceModalTitle = document.getElementById('attendanceModalTitle');
const attendanceModalPresent = document.getElementById('attendanceModalPresent');
const attendanceModalTotal = document.getElementById('attendanceModalTotal');
const attendanceModalList = document.getElementById('attendanceModalList');
const attendanceModalClose = document.getElementById('attendanceModalClose');
const attendanceConnectBtn = document.getElementById('attendanceConnectBtn');
const attendanceDoneBtn = document.getElementById('attendanceDoneBtn');
const attendanceRunExamBtn = document.getElementById('attendanceRunExamBtn');
const attendanceSubmitBtn = document.getElementById('attendanceSubmitBtn');
const dailyAttendanceBtn = document.getElementById('dailyAttendanceBtn');

let attendanceState = {
  active: false,
  mode: 'daily',
  examId: null,
  examTitle: '',
  dateStr: '',
  participants: [],
  clickerToParticipant: {},
  presentIds: new Set(),
  clickerListener: null,
};

function localISODate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function isAuthError(result) {
  const err = (result && result.error) ? String(result.error) : '';
  return !result.success && (err.includes('authenticated') || err.includes('Authentication') || err.includes('401'));
}

async function loadUser() {
  const user = await window.electronAPI.getUser();
  const token = await window.electronAPI.getToken();
  if (!token) {
    await window.electronAPI.nav('login');
    return false;
  }
  let displayName = 'Instructor';
  if (user && typeof user === 'object') {
    displayName = user.first_name && user.last_name
      ? `${user.first_name} ${user.last_name}`.trim()
      : (user.first_name || user.last_name || user.email || user.username || user.displayName || 'Instructor');
  } else if (typeof user === 'string' && user.trim()) {
    displayName = user.trim();
  }
  if (userNameEl) userNameEl.textContent = displayName;
  return true;
}

async function loadExams() {
  const [examsResult, participantsResult] = await Promise.all([
    window.electronAPI.fetchExams(),
    window.electronAPI.fetchParticipants(null),
  ]);
  if (!examsResult.success) {
    if (isAuthError(examsResult)) {
      await window.electronAPI.nav('login');
      return;
    }
    examListEl.innerHTML = `<div class="no-exams">${escapeHtml(examsResult.error || 'Failed to load exams')}</div>`;
    noExamsEl.classList.add('hidden');
    return;
  }

  // Show all exams from API. Previously we only showed status==='frozen', which hid draft exams
  // even though the list API returned them (see main process logs).
  const exams = examsResult.data || [];
  const totalStudents = Array.isArray(participantsResult?.data) ? participantsResult.data.length : 0;
  if (exams.length === 0) {
    noExamsEl.classList.remove('hidden');
    examListEl.innerHTML = '';
    return;
  }
  noExamsEl.classList.add('hidden');

  function examSyncReady(exam) {
    const s = exam.status;
    return s === 'frozen' || s === 'completed' || exam.frozen === true;
  }

  function statusBadge(exam) {
    const s = exam.status || 'draft';
    if (s === 'frozen' || exam.frozen) {
      return '<span class="status-badge status-frozen">Frozen</span>';
    }
    if (s === 'completed') {
      return '<span class="status-badge status-completed">Completed</span>';
    }
    return '<span class="status-badge status-draft">Draft</span>';
  }

  examListEl.innerHTML = exams.map(exam => {
    const enrolled = exam.participant_count ?? 0;
    const displayCount = enrolled > 0 ? enrolled : totalStudents;
    const syncNote = examSyncReady(exam)
      ? ''
      : '<div class="exam-warn">Freeze this exam in the EasyTest web app so clicker results can sync to the server.</div>';
    return `
    <div class="exam-item" data-exam-id="${exam.id}">
      <div>
        <h3>${escapeHtml(exam.title)}</h3>
        <div class="meta">Questions: ${exam.question_count ?? 0} · Participants: ${displayCount}</div>
        ${syncNote}
      </div>
      <div class="actions">
        ${statusBadge(exam)}
        <button type="button" class="btn btn-primary run-exam-btn" data-exam-id="${exam.id}">Run exam</button>
      </div>
    </div>
  `;
  }).join('');

  examListEl.querySelectorAll('.run-exam-btn').forEach(btn => {
    btn.addEventListener('click', () => runExam(btn.dataset.examId));
  });
}

async function loadStudents() {
  if (!studentListEl) return;
  const result = await window.electronAPI.fetchParticipants(null);
  if (!result.success) {
    if (isAuthError(result)) {
      await window.electronAPI.nav('login');
      return;
    }
    studentListEl.innerHTML = `<div class="no-exams">${escapeHtml(result.error || 'Failed to load students')}</div>`;
    if (noStudentsEl) noStudentsEl.classList.add('hidden');
    return;
  }

  const students = result.data || [];
  if (students.length === 0) {
    if (noStudentsEl) noStudentsEl.classList.remove('hidden');
    studentListEl.innerHTML = '';
    return;
  }
  if (noStudentsEl) noStudentsEl.classList.add('hidden');
  studentListEl.innerHTML = `
    <div class="student-list-header">
      <span class="student-col name">Name</span>
      <span class="student-col email">Email</span>
      <span class="student-col clicker">Clicker ID</span>
    </div>
    ${students.map(s => `
      <div class="student-item">
        <span class="student-col name">${escapeHtml(s.name || '—')}</span>
        <span class="student-col email">${escapeHtml(s.email || '—')}</span>
        <span class="student-col clicker">${escapeHtml(s.clicker_id != null && s.clicker_id !== '' ? String(s.clicker_id) : '—')}</span>
      </div>
    `).join('')}
  `;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

function updateBaseStationStatus(connected) {
  if (!baseStationStatusEl || !baseStationLabelEl) return;
  baseStationStatusEl.classList.toggle('connected', connected);
  baseStationStatusEl.classList.toggle('disconnected', !connected);
  baseStationLabelEl.textContent = connected ? 'Base station: Connected' : 'Base station: Disconnected';
}

function attendanceRowVisual(p) {
  const { presentIds } = attendanceState;
  if (presentIds.has(p.id)) {
    return { row: 'present', badge: 'badge-present', label: 'Present' };
  }
  const hasClicker = p.clicker_id != null && String(p.clicker_id).trim() !== '';
  if (hasClicker) {
    return { row: 'absent', badge: 'badge-absent', label: 'Absent' };
  }
  return { row: 'unmarked', badge: 'badge-noclicker', label: 'No clicker' };
}

function renderAttendanceList() {
  const { participants, presentIds } = attendanceState;
  const total = participants.length;
  const present = participants.filter(p => presentIds.has(p.id)).length;
  if (attendanceModalTotal) attendanceModalTotal.textContent = total;
  if (attendanceModalPresent) attendanceModalPresent.textContent = present;
  if (!attendanceModalList) return;
  if (total === 0) {
    attendanceModalList.innerHTML = '<div class="attendance-placeholder">No participants in your roster.</div>';
    return;
  }
  const sorted = [...participants].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  attendanceModalList.innerHTML = sorted.map(p => {
    const v = attendanceRowVisual(p);
    return `
      <div class="attendance-modal-item ${v.row}">
        <span class="attendance-name">${escapeHtml(p.name || 'Participant')}</span>
        <span class="attendance-badge ${v.badge}">${escapeHtml(v.label)}</span>
      </div>
    `;
  }).join('');
}

function onAttendanceClickerResponse(data) {
  if (!attendanceState.active || !attendanceState.clickerToParticipant) return;
  const keySN = (data.keySN != null && String(data.keySN).trim() !== '') ? String(data.keySN).trim() : '';
  const participant =
    attendanceState.clickerToParticipant[keySN] ||
    (data.clicker_id != null && attendanceState.clickerToParticipant[String(data.clicker_id)]) ||
    (data.clicker_id != null && attendanceState.clickerToParticipant[Number(data.clicker_id)]);
  if (participant && participant.id != null) {
    attendanceState.presentIds.add(participant.id);
    renderAttendanceList();
  }
}

async function openDailyAttendance() {
  const partResult = await window.electronAPI.fetchParticipants(null);
  if (!partResult.success) {
    if (isAuthError(partResult)) {
      await window.electronAPI.nav('login');
      return;
    }
    alert(partResult.error || 'Failed to load participants');
    return;
  }

  const allParticipants = partResult.data || [];
  const clickerToParticipant = {};
  allParticipants.forEach(p => {
    if (p.clicker_id == null || p.clicker_id === '') return;
    const info = { id: p.id, name: p.name, email: p.email };
    const str = String(p.clicker_id).trim();
    clickerToParticipant[str] = info;
    if (str !== p.clicker_id) clickerToParticipant[p.clicker_id] = info;
    const num = Number(p.clicker_id);
    if (!isNaN(num)) clickerToParticipant[num] = info;
  });

  const uniqueParticipants = [];
  const seenIds = new Set();
  allParticipants.forEach(p => {
    if (!p || p.id == null) return;
    if (seenIds.has(p.id)) return;
    seenIds.add(p.id);
    uniqueParticipants.push(p);
  });

  const dateStr = localISODate();
  attendanceState = {
    active: true,
    mode: 'daily',
    examId: null,
    examTitle: '',
    dateStr,
    participants: uniqueParticipants,
    clickerToParticipant,
    presentIds: new Set(),
    clickerListener: null,
  };

  if (attendanceModalTitle) attendanceModalTitle.textContent = 'Attendance — ' + dateStr;
  const hintEl = document.querySelector('.attendance-modal-hint');
  if (hintEl) {
    hintEl.textContent =
      'Students with clickers press any key (A–D) to be marked present. Click Submit attendance to save today\'s roster to the server (no exam).';
  }
  if (attendanceSubmitBtn) attendanceSubmitBtn.classList.remove('hidden');
  if (attendanceRunExamBtn) attendanceRunExamBtn.classList.add('hidden');

  renderAttendanceList();
  attendanceModal.classList.remove('hidden');

  attendanceState.clickerListener = onAttendanceClickerResponse;
  window.electronAPI.onClickerResponse(onAttendanceClickerResponse);
}

async function startAttendanceSession() {
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
  const startResult = await window.electronAPI.startSession({
    baseId: 0,
    voteType: 10,
    optionCount: 4,
    minSelect: 1,
    maxSelect: 1,
    optionDisplay: 'alpha',
  });
  if (startResult.success) {
    if (attendanceConnectBtn) attendanceConnectBtn.textContent = 'Connected';
    if (attendanceConnectBtn) attendanceConnectBtn.disabled = true;
  } else {
    alert('Could not start clicker session: ' + (startResult.error || 'Unknown error'));
  }
}

function closeAttendance(runExamAfter) {
  const examIdToRun = attendanceState.examId;
  window.electronAPI.stopSession(0).catch(() => {});
  window.electronAPI.removeAllSDKListeners();
  attendanceState.active = false;
  attendanceState.examId = null;
  attendanceState.dateStr = '';
  attendanceState.mode = 'daily';
  if (attendanceModal) attendanceModal.classList.add('hidden');
  if (attendanceSubmitBtn) {
    attendanceSubmitBtn.classList.add('hidden');
    attendanceSubmitBtn.disabled = false;
  }
  if (attendanceRunExamBtn) attendanceRunExamBtn.classList.remove('hidden');
  const hintEl = document.querySelector('.attendance-modal-hint');
  if (hintEl) {
    hintEl.textContent = 'Students press any key (A–D) on their clicker to be marked present.';
  }
  if (attendanceConnectBtn) {
    attendanceConnectBtn.textContent = 'Connect & start';
    attendanceConnectBtn.disabled = false;
  }
  if (runExamAfter && examIdToRun != null) {
    runExam(String(examIdToRun));
  }
}

async function submitDailyAttendance() {
  if (!attendanceState.active || attendanceState.mode !== 'daily' || !attendanceState.dateStr) return;
  const parts = attendanceState.participants;
  if (!parts.length) {
    alert('No participants to save.');
    return;
  }
  const entries = parts.map((p) => {
    let status;
    if (attendanceState.presentIds.has(p.id)) status = 'present';
    else {
      const hasClicker = p.clicker_id != null && String(p.clicker_id).trim() !== '';
      status = hasClicker ? 'absent' : 'unmarked';
    }
    return { participant_id: p.id, status };
  });

  if (attendanceSubmitBtn) attendanceSubmitBtn.disabled = true;
  try {
    const res = await window.electronAPI.saveDailyAttendance({
      date: attendanceState.dateStr,
      entries,
    });
    if (!res.success) {
      alert(res.error || 'Failed to save attendance');
      return;
    }
    const saved = res.data && res.data.saved != null ? res.data.saved : entries.length;
    const errs = res.data && res.data.errors;
    if (errs && errs.length) console.warn('[EasyTest Live] Attendance save warnings:', errs);
    alert(`Attendance saved for ${attendanceState.dateStr} (${saved} record(s)).`);
    closeAttendance(false);
    await loadStudents();
  } catch (e) {
    alert(e.message || 'Failed to save attendance');
  } finally {
    if (attendanceSubmitBtn) attendanceSubmitBtn.disabled = false;
  }
}

async function runExam(examId) {
  const examIdNum = parseInt(examId, 10);
  const [snapResult, partResult, allPartResult] = await Promise.all([
    window.electronAPI.fetchExamSnapshot(examIdNum),
    window.electronAPI.fetchParticipants(examIdNum),
    window.electronAPI.fetchParticipants(null),
  ]);

  if (!snapResult.success) {
    alert('Could not load exam snapshot: ' + (snapResult.error || 'Unknown error'));
    return;
  }

  const snapshot = snapResult.data;
  // Print API response so you can check (DevTools Console)
  console.log('[EasyTest Live] ========== Exam snapshot API response ==========');
  console.log('[EasyTest Live] option_display:', snapshot?.option_display, '| duration:', snapshot?.duration, '| revisable:', snapshot?.revisable);
  console.log('[EasyTest Live] Full snapshot:', JSON.stringify(snapshot, null, 2));
  console.log('[EasyTest Live] =================================================');
  if (snapshot && Array.isArray(snapshot.questions)) {
    snapshot.questions.forEach((q, i) => {
      const opts = q.options;
      const type = opts == null ? 'null' : Array.isArray(opts) ? 'array' : typeof opts;
      const len = Array.isArray(opts) ? opts.length : (opts && typeof opts === 'object' ? Object.keys(opts).length : 0);
      console.log(`[EasyTest Live] Q${i + 1} options: type=${type}, length=${len}`, opts);
    });
  }
  const participants = partResult.success ? (partResult.data || []) : [];
  const allParticipants = allPartResult.success ? (allPartResult.data || []) : [];
  const clickerToParticipant = {};
  // Build map from ALL participants with a clicker_id so we match clicker 1 -> zeeshan even if not yet in this exam
  allParticipants.forEach(p => {
    if (p.clicker_id == null || p.clicker_id === '') return;
    const info = { id: p.id, name: p.name, email: p.email };
    const str = String(p.clicker_id).trim();
    clickerToParticipant[str] = info;
    if (str !== p.clicker_id) clickerToParticipant[p.clicker_id] = info;
    const num = Number(p.clicker_id);
    if (!isNaN(num)) clickerToParticipant[num] = info;
  });

  sessionStorage.setItem('easytest_live_exam', JSON.stringify({
    examId: examIdNum,
    snapshot,
    participants,
    clickerToParticipant,
  }));
  await window.electronAPI.nav('live');
}

logoutBtn.addEventListener('click', async () => {
  await window.electronAPI.logout();
  await window.electronAPI.nav('login');
});

// One-time bind attendance modal buttons
if (attendanceModalClose) attendanceModalClose.addEventListener('click', () => closeAttendance(false));
const attendanceModalBackdrop = document.getElementById('attendanceModalBackdrop');
if (attendanceModalBackdrop) attendanceModalBackdrop.addEventListener('click', () => closeAttendance(false));
if (attendanceConnectBtn) attendanceConnectBtn.addEventListener('click', () => startAttendanceSession());
if (attendanceDoneBtn) attendanceDoneBtn.addEventListener('click', () => closeAttendance(false));
if (attendanceRunExamBtn) attendanceRunExamBtn.addEventListener('click', () => closeAttendance(true));
if (attendanceSubmitBtn) attendanceSubmitBtn.addEventListener('click', () => submitDailyAttendance());
if (dailyAttendanceBtn) dailyAttendanceBtn.addEventListener('click', () => openDailyAttendance());

(async function init() {
  const ok = await loadUser();
  if (!ok) return;
  updateBaseStationStatus(false);
  const status = await window.electronAPI.getSDKStatus();
  updateBaseStationStatus(!!status.connected);
  window.electronAPI.onConnectEvent((data) => {
    const connected = data.mode === 1;
    updateBaseStationStatus(connected);
    setTimeout(() => {
      window.electronAPI.getSDKStatus().then((s) => updateBaseStationStatus(!!s.connected));
    }, 100);
  });
  if (status.loaded && !status.connected) {
    window.electronAPI.connectClicker(1).then((conn) => {
      if (conn.success) {
        window.electronAPI.getSDKStatus().then((s) => updateBaseStationStatus(!!s.connected));
      }
    });
    setTimeout(() => {
      window.electronAPI.getSDKStatus().then((s) => updateBaseStationStatus(!!s.connected));
    }, 1500);
  }
  const statusInterval = setInterval(() => {
    window.electronAPI.getSDKStatus().then((s) => updateBaseStationStatus(!!s.connected));
  }, 2000);
  window.addEventListener('beforeunload', () => clearInterval(statusInterval));
  await Promise.all([loadExams(), loadStudents()]);
})();
