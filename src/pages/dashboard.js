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

let attendanceState = {
  active: false,
  examId: null,
  examTitle: '',
  participants: [],
  clickerToParticipant: {},
  presentIds: new Set(),
  clickerListener: null,
};

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
  const result = await window.electronAPI.fetchExams();
  if (!result.success) {
    if (isAuthError(result)) {
      await window.electronAPI.nav('login');
      return;
    }
    examListEl.innerHTML = `<div class="no-exams">${escapeHtml(result.error || 'Failed to load exams')}</div>`;
    noExamsEl.classList.add('hidden');
    return;
  }

  const exams = (result.data || []).filter(e => e.status === 'frozen');
  if (exams.length === 0) {
    noExamsEl.classList.remove('hidden');
    examListEl.innerHTML = '';
    return;
  }
  noExamsEl.classList.add('hidden');
  examListEl.innerHTML = exams.map(exam => `
    <div class="exam-item" data-exam-id="${exam.id}">
      <div>
        <h3>${escapeHtml(exam.title)}</h3>
        <div class="meta">Questions: ${exam.question_count ?? 0} · Participants: ${exam.participant_count ?? 0}</div>
      </div>
      <div class="actions">
        <span class="status-badge status-frozen">Frozen</span>
        <button type="button" class="btn btn-secondary attendance-btn" data-exam-id="${exam.id}" data-exam-title="${escapeHtml(exam.title)}">Take attendance</button>
        <button type="button" class="btn btn-primary run-exam-btn" data-exam-id="${exam.id}">Run exam</button>
      </div>
    </div>
  `).join('');

  examListEl.querySelectorAll('.run-exam-btn').forEach(btn => {
    btn.addEventListener('click', () => runExam(btn.dataset.examId));
  });
  examListEl.querySelectorAll('.attendance-btn').forEach(btn => {
    btn.addEventListener('click', () => openAttendance(btn.dataset.examId, btn.dataset.examTitle || ''));
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

function renderAttendanceList() {
  const { participants, presentIds } = attendanceState;
  const total = participants.length;
  const present = participants.filter(p => presentIds.has(p.id)).length;
  if (attendanceModalTotal) attendanceModalTotal.textContent = total;
  if (attendanceModalPresent) attendanceModalPresent.textContent = present;
  if (!attendanceModalList) return;
  if (total === 0) {
    attendanceModalList.innerHTML = '<div class="attendance-placeholder">No participants with clicker ID in this exam.</div>';
    return;
  }
  const sorted = [...participants].sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  attendanceModalList.innerHTML = sorted.map(p => {
    const isPresent = presentIds.has(p.id);
    return `
      <div class="attendance-modal-item ${isPresent ? 'present' : 'absent'}">
        <span class="attendance-name">${escapeHtml(p.name || 'Participant')}</span>
        <span class="attendance-badge ${isPresent ? 'badge-present' : 'badge-absent'}">${isPresent ? 'Present' : 'Absent'}</span>
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

async function openAttendance(examId, examTitle) {
  const examIdNum = parseInt(examId, 10);
  const [partResult, allPartResult] = await Promise.all([
    window.electronAPI.fetchParticipants(examIdNum),
    window.electronAPI.fetchParticipants(null),
  ]);
  const participants = partResult.success ? (partResult.data || []) : [];
  const allParticipants = allPartResult.success ? (allPartResult.data || []) : [];
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
  participants.forEach(p => {
    if (p && p.id != null && !seenIds.has(p.id)) {
      seenIds.add(p.id);
      uniqueParticipants.push(p);
    }
  });

  attendanceState = {
    active: true,
    examId: examIdNum,
    examTitle: examTitle || 'Exam',
    participants: uniqueParticipants,
    clickerToParticipant,
    presentIds: new Set(),
    clickerListener: null,
  };

  if (attendanceModalTitle) attendanceModalTitle.textContent = 'Attendance – ' + (examTitle || 'Exam');
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
    timeout: 0,
    minSelect: 1,
    maxSelect: 1,
    submitMode: 0,
    displayMode: 0,
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
  if (attendanceModal) attendanceModal.classList.add('hidden');
  if (attendanceConnectBtn) {
    attendanceConnectBtn.textContent = 'Connect & start';
    attendanceConnectBtn.disabled = false;
  }
  if (runExamAfter && examIdToRun != null) {
    runExam(String(examIdToRun));
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

(async function init() {
  const ok = await loadUser();
  if (!ok) return;
  updateBaseStationStatus(false);
  const status = await window.electronAPI.getSDKStatus();
  updateBaseStationStatus(status.connected);
  window.electronAPI.onConnectEvent((data) => {
    updateBaseStationStatus(data.mode === 1);
  });
  await Promise.all([loadExams(), loadStudents()]);
})();
