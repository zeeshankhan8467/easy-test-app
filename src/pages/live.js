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
let nextQuestionTimeout = null; // for auto-advance when all submitted
let revisable = false; // from snapshot: if true, students can change their answer (reattempt)
let examStartedAt = null;
/** From snapshot: show option breakdown / answers as they arrive */
let showLiveResponse = false;
/** From snapshot: when show_live_response is false, reveal breakdown after all students submit per question */
let showResponseAfterCompletion = true;
/** From snapshot: auto-advance question when time is up or all answered; false = teacher uses Next */
let questionChangeAutomatic = false;

/** Must match main-process Referer used for YouTube (see app:youtubeEmbedOrigin). */
let youtubeEmbedOriginParam = 'https://easytestlive.com';

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
const liveModeHintEl = document.getElementById('liveModeHint');
const responsesPanelSubEl = document.getElementById('responsesPanelSub');
let participantNames = {}; // participantId -> name (for response list)

function snapshotBool(val, defaultVal) {
  if (val === true || val === 'true' || val === 1 || val === '1') return true;
  if (val === false || val === 'false' || val === 0 || val === '0') return false;
  return defaultVal;
}

function totalParticipantCount() {
  return Object.keys(clickerToParticipant).length || 0;
}

/** All mapped students have submitted for question index qIdx */
function allStudentsAnsweredForQuestionIndex(qIdx) {
  const total = totalParticipantCount();
  if (total <= 0) return false;
  const map = allResponsesByQuestion[qIdx];
  if (!map || typeof map !== 'object') return false;
  return Object.keys(map).length >= total;
}

/** Show option bars / per-option % and student answer letters */
function shouldRevealOptionStatsForQuestionIndex(qIdx) {
  if (examState === 'ended') return true;
  if (showLiveResponse) return true;
  if (showResponseAfterCompletion && allStudentsAnsweredForQuestionIndex(qIdx)) return true;
  return false;
}

function updateLiveModeHints() {
  if (liveModeHintEl) {
    const parts = [];
    if (showLiveResponse) {
      parts.push('Option breakdown updates live as students answer.');
    } else if (showResponseAfterCompletion) {
      parts.push('Option breakdown appears after every student has submitted on this question.');
    } else {
      parts.push('Option breakdown stays hidden until the exam ends.');
    }
    if (questionChangeAutomatic) {
      parts.push('Questions advance automatically when the timer ends or everyone has answered.');
    } else {
      parts.push('Use Next to go to the next question (no auto-advance).');
    }
    liveModeHintEl.textContent = parts.join(' ');
  }
  if (responsesPanelSubEl) {
    if (showLiveResponse) {
      responsesPanelSubEl.textContent = 'Showing selected options as they arrive.';
    } else if (showResponseAfterCompletion) {
      responsesPanelSubEl.textContent = 'Selected options shown after all students submit (this question).';
    } else {
      responsesPanelSubEl.textContent = 'Selected options hidden until the exam ends.';
    }
  }
  if (nextBtn) {
    nextBtn.title = questionChangeAutomatic
      ? 'Move to next question (also happens automatically when everyone answers or time runs out).'
      : 'Move to next question — required when auto question change is off.';
  }
}

function letterToIndex(letter) {
  const c = (letter || '').toString().toUpperCase().charAt(0);
  if (c >= 'A' && c <= 'J') return c.charCodeAt(0) - 65;
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
  // Ensure each question has options as a real array (snapshot can have array, string, or object)
  questions.forEach(q => {
    let o = q.options;
    if (o == null) o = [];
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch (e) { o = []; } }
    if (!Array.isArray(o) && o && typeof o === 'object') {
      o = Object.keys(o)
        .filter(k => /^\d+$/.test(k))
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
        .map(k => o[k]);
    }
    if (!Array.isArray(o)) o = [];
    q.options = o;
  });
  // Debug: what live page has after load (open DevTools on the live window)
  console.log('[EasyTest Live] Loaded exam from storage. Snapshot:', data.snapshot);
  console.log('[EasyTest Live] Questions after normalize:', questions.length);
  questions.forEach((q, i) => {
    console.log(`[EasyTest Live] Q${i + 1} options count=${(q.options || []).length}`, q.options);
  });
  examTitle.textContent = snapshot.title || 'Exam';
  revisable = !!(snapshot && (snapshot.revisable === true || snapshot.revisable === 'true'));
  showLiveResponse = snapshotBool(snapshot.show_live_response, false);
  showResponseAfterCompletion = snapshotBool(snapshot.show_response_after_completion, true);
  questionChangeAutomatic = snapshotBool(snapshot.question_change_automatic, false);
  updateLiveModeHints();
  participantNames = {};
  Object.values(clickerToParticipant).forEach(p => { if (p && p.id != null) participantNames[p.id] = p.name || 'Participant'; });
  // Timer: backend sends duration per question in seconds (snapshot.duration) — show this value on the timer
  perQuestionSeconds = 30;
  const durationSec = snapshot && (snapshot.duration != null) ? Number(snapshot.duration) : 0;
  if (durationSec > 0) {
    perQuestionSeconds = Math.max(1, Math.round(durationSec));
    console.log('[EasyTest Live] Timer: duration per question =', perQuestionSeconds, 'sec (from backend)');
  } else if (questions.length > 0) {
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
    if (questionText) {
      questionText.textContent = 'No questions in this exam. Add questions in the EasyTest web app and freeze the exam.';
    }
    if (optionsList) optionsList.innerHTML = '';
    updateStartButtonState();
    return;
  }
  const q = questions[currentIndex];
  // Normalize options to array (snapshot may have array, stringified JSON, or object with numeric keys)
  let opts = q.options;
  if (opts == null) opts = [];
  if (typeof opts === 'string') {
    try { opts = JSON.parse(opts); } catch (e) { opts = []; }
  }
  if (!Array.isArray(opts)) {
    if (opts && typeof opts === 'object' && !Array.isArray(opts)) {
      opts = Object.keys(opts)
        .filter(k => /^\d+$/.test(k))
        .sort((a, b) => parseInt(a, 10) - parseInt(b, 10))
        .map(k => opts[k]);
    } else {
      opts = [];
    }
  }
  const optionCount = Math.max(1, opts.length);

  if (questionNumber) questionNumber.textContent = `Q${currentIndex + 1}`;
  if (questionTypeEl) questionTypeEl.textContent = (q.type || 'MCQ').toUpperCase();
  if (questionText) {
    const raw = q.text || '';
    const safe = sanitizeQuestionHtml(raw);
    if (safe) {
      questionText.innerHTML = safe;
    } else {
      const plain = stripHtml(raw).trim();
      questionText.textContent = plain || '—';
    }
  }

  // Option display is per-question: use this question's option_display, then exam-level default
  const rawOptionDisplay = (q.option_display != null && q.option_display !== '')
    ? q.option_display
    : (snapshot && snapshot.option_display != null ? snapshot.option_display : '');
  let optionDisplay = String(rawOptionDisplay).toLowerCase().trim();
  if (optionDisplay !== 'numeric' && optionDisplay !== 'alpha' && opts && opts.length > 0) {
    const allNumeric = opts.every(o => /^\d+$/.test(String(o).trim()));
    optionDisplay = allNumeric ? 'numeric' : 'alpha';
  }
  if (optionDisplay !== 'numeric') optionDisplay = 'alpha';
  const useNumericLabels = optionDisplay === 'numeric';
  const n = optionCount;
  // Build labels: numeric -> 1,2,3,4; alpha -> A,B,C,D
  const optionKeys = [];
  const alphaKeys = []; // always A,B,C,D for mapping clicker responses
  for (let i = 0; i < n; i++) {
    optionKeys.push(useNumericLabels ? String(i + 1) : (i < 26 ? String.fromCharCode(65 + i) : String(i + 1)));
    alphaKeys.push(i < 26 ? String.fromCharCode(65 + i) : String(i + 1));
  }

  const revealStats = shouldRevealOptionStatsForQuestionIndex(currentIndex);
  const counts = {};
  alphaKeys.forEach(k => { counts[k] = 0; });
  Object.values(responses).forEach(r => {
    if (r.answer && counts[r.answer] !== undefined) counts[r.answer]++;
  });
  const totalResponses = Object.keys(responses).length || 1;

  optionsList.innerHTML = optionKeys.map((key, idx) => {
    const rawLabel = (opts && opts[idx] != null) ? (typeof opts[idx] === 'string' ? opts[idx] : (opts[idx].text || opts[idx].label || key)) : key;
    const label = stripHtml(String(rawLabel)) || key;
    const count = revealStats ? (counts[alphaKeys[idx]] || 0) : 0;
    const pct = revealStats && totalResponses > 0 ? Math.round((count / totalResponses) * 100) : 0;
    const mutedClass = revealStats ? '' : ' option-item-stats-hidden';
    return `
      <div class="option-item${mutedClass}">
        <div class="option-key">${optionKeys[idx]}</div>
        <div class="option-content">
          <div class="option-text-row">${escapeHtml(label)}</div>
          <div class="option-bar"><div class="option-bar-fill" style="width:${pct}%"></div></div>
        </div>
        <div class="option-count">${revealStats ? pct + '%' : '—'}</div>
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

/** Strip HTML tags and return plain text (so <p>, <strong>, etc. are not shown). */
function stripHtml(html) {
  if (html == null) return '';
  const str = String(html).trim();
  if (!str) return '';
  const div = document.createElement('div');
  div.innerHTML = str;
  return (div.textContent || div.innerText || '').trim();
}

const QUESTION_ALLOWED_TAGS = new Set([
  'div', 'p', 'br', 'span', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'blockquote',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr',
]);

function isAllowedIframeSrc(src) {
  if (!src || typeof src !== 'string') return false;
  try {
    const u = new URL(src.trim());
    const host = u.hostname.replace(/^www\./, '');
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return false;
    return u.pathname.startsWith('/embed/');
  } catch (e) {
    return false;
  }
}

/** Prefer youtube-nocookie embed URL (fewer cookie issues in embedded players). */
function normalizeYouTubeEmbedSrc(src) {
  if (!src || typeof src !== 'string') return src;
  try {
    const u = new URL(src.trim());
    const host = u.hostname.replace(/^www\./, '');
    if (host !== 'youtube.com' && host !== 'youtube-nocookie.com') return src;
    if (!u.pathname.startsWith('/embed/')) return src;
    u.hostname = 'www.youtube-nocookie.com';
    return u.toString();
  } catch (e) {
    return src;
  }
}

function isAllowedImgSrc(src) {
  if (!src || typeof src !== 'string') return false;
  const s = src.trim();
  if (s.startsWith('data:image/') && /;base64,/i.test(s)) {
    return s.length <= 40 * 1024 * 1024;
  }
  try {
    const u = new URL(s);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (e) {
    return false;
  }
}

function stripUnsafeAttrs(el, tag) {
  Array.from(el.attributes).forEach((attr) => {
    const n = attr.name.toLowerCase();
    if (n.startsWith('on')) {
      el.removeAttribute(attr.name);
      return;
    }
    if (n === 'style' || n === 'id') {
      el.removeAttribute(attr.name);
      return;
    }
    if (n === 'class' && (tag === 'div' || tag === 'span')) return;
    el.removeAttribute(attr.name);
  });
}

/**
 * Allow safe HTML from exam snapshot: YouTube embeds, http(s)/data: images, basic typography.
 * Everything else is stripped or unwrapped to reduce XSS risk.
 */
function sanitizeQuestionHtml(html) {
  if (html == null || !String(html).trim()) return '';
  let doc;
  try {
    doc = new DOMParser().parseFromString(String(html), 'text/html');
  } catch (e) {
    return '';
  }
  const root = doc.body;
  if (!root) return '';

  // Only walk body's *children* — never push <body> itself or it gets "unwrapped" as an unknown
  // tag, detached from the document, and root.innerHTML becomes empty (nothing shows).
  const postOrder = [];
  function collectPost(n) {
    if (n.nodeType !== Node.ELEMENT_NODE) return;
    for (let c = n.firstChild; c; c = c.nextSibling) collectPost(c);
    postOrder.push(n);
  }
  for (let c = root.firstChild; c; c = c.nextSibling) {
    if (c.nodeType === Node.ELEMENT_NODE) collectPost(c);
  }

  for (const node of postOrder) {
    const parent = node.parentNode;
    if (!parent) continue;
    const tag = node.tagName.toLowerCase();

    if (tag === 'script' || tag === 'style') {
      parent.removeChild(node);
      continue;
    }
    if (tag === 'iframe') {
      const src = (node.getAttribute('src') || '').trim();
      if (isAllowedIframeSrc(src)) {
        const embedSrc = normalizeYouTubeEmbedSrc(src);
        const iframe = doc.createElement('iframe');
        iframe.setAttribute('src', embedSrc);
        iframe.setAttribute('allowfullscreen', 'true');
        iframe.setAttribute('frameborder', '0');
        iframe.setAttribute('loading', 'lazy');
        iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        iframe.setAttribute(
          'allow',
          'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share'
        );
        iframe.className = 'question-youtube-embed';
        parent.replaceChild(iframe, node);
      } else {
        parent.removeChild(node);
      }
      continue;
    }
    if (tag === 'img') {
      const src = (node.getAttribute('src') || '').trim();
      if (isAllowedImgSrc(src)) {
        const img = doc.createElement('img');
        img.setAttribute('src', src);
        const alt = node.getAttribute('alt');
        if (alt) img.setAttribute('alt', alt);
        img.className = 'question-inline-img';
        img.setAttribute('decoding', 'async');
        parent.replaceChild(img, node);
      } else {
        parent.removeChild(node);
      }
      continue;
    }
    if (tag === 'a') {
      const span = doc.createElement('span');
      while (node.firstChild) span.appendChild(node.firstChild);
      parent.replaceChild(span, node);
      continue;
    }
    if (!QUESTION_ALLOWED_TAGS.has(tag)) {
      if (tag === 'body' || tag === 'html') continue;
      while (node.firstChild) parent.insertBefore(node.firstChild, node);
      parent.removeChild(node);
      continue;
    }
    stripUnsafeAttrs(node, tag);
  }

  return root.innerHTML.trim();
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
  const revealAnswers = shouldRevealOptionStatsForQuestionIndex(currentIndex);
  const sorted = Object.entries(responses).sort((a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0));
  responsesListEl.innerHTML = sorted.map(([, data]) => {
    const name = data.name || (data.participantId != null && (participantNames[data.participantId] || participantNames[String(data.participantId)])) || 'Student';
    const initials = name.split(/\s+/).map(n => n[0]).join('').toUpperCase().substring(0, 2) || '?';
    const ans = (data.answer || '').toString().toUpperCase().charAt(0);
    const answerHtml = revealAnswers && ans >= 'A' && ans <= 'J'
      ? `<span class="response-answer">${escapeHtml(ans)}</span>`
      : '<span class="response-answer pending">Submitted</span>';
    return `
      <div class="response-item">
        <div class="response-student">
          <div class="response-avatar">${escapeHtml(initials)}</div>
          <span>${escapeHtml(name)}</span>
        </div>
        ${answerHtml}
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
  // Include ALL loaded participants in attendance (so absent ones also get assigned to the exam)
  Object.values(clickerToParticipant).forEach(p => {
    if (p && p.id != null) attendanceSet.add(p.id);
  });
  const byParticipant = responsesList.filter(r => r.participant_id != null).length;
  const byClickerId = responsesList.filter(r => r.clicker_id != null).length;
  if (responsesList.length || attendanceSet.size) {
    console.log('[EasyTest Live] buildSyncPayload:', responsesList.length, 'total (by participant_id:', byParticipant, ', by clicker_id:', byClickerId, '), attendance:', attendanceSet.size);
  }
  return { responses: responsesList, attendance: Array.from(attendanceSet), exam_started_at: examStartedAt || undefined };
}

/**
 * Submit a single response to the backend immediately (like acadally per-response save).
 */
async function syncSingleResponse(payloadItem, attendanceIds) {
  if (!examId || !payloadItem) return;
  const responses = [payloadItem];
  const attendance = Array.isArray(attendanceIds) ? attendanceIds : (payloadItem.participant_id != null ? [payloadItem.participant_id] : []);
  try {
    const result = await window.electronAPI.syncLiveResults({ examId, responses, attendance, exam_started_at: examStartedAt || undefined });
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
  const result = await window.electronAPI.syncLiveResults({ examId, responses: payload.responses, attendance: payload.attendance, exam_started_at: payload.exam_started_at });
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
  if (!(answer >= 'A' && answer <= 'J')) return;

  // Do not accept answers beyond the number of options for the current question.
  // Example: if question has 4 options (A–D), ignore E, F, ...
  const optionCountForQuestion = getCurrentQuestionOptionCount();
  const answerIndex = answer.charCodeAt(0) - 65; // A=0, B=1, ...
  if (answerIndex < 0 || answerIndex >= optionCountForQuestion) {
    console.log('[EasyTest Live] Ignoring response: answer', answer, 'is beyond option count', optionCountForQuestion, 'for current question.');
    return;
  }

  // SDK sends clicker_id = keyId (1-9); keySN = device serial (may be empty from some DLLs).
  const keySN = (data.keySN != null && String(data.keySN).trim() !== '') ? String(data.keySN).trim() : '';
  // Stable device id so we accept only one response per device per question (no timestamp in key)
  const deviceId = keySN || ('d' + (data.baseId ?? 0) + '_' + (data.clicker_id ?? data.keyId ?? '0'));
  const participant =
    clickerToParticipant[keySN] ||
    clickerToParticipant[deviceId] ||
    (data.clicker_id != null && clickerToParticipant[String(data.clicker_id)]) ||
    (data.clicker_id != null && clickerToParticipant[Number(data.clicker_id)]);

  console.log('[EasyTest Live] Response received: clicker_id=' + data.clicker_id + ', keySN="' + keySN + '", deviceId="' + deviceId + '", matched=' + (participant ? (participant.name + ' (id=' + participant.id + ')') : 'none') + ', map keys=' + Object.keys(clickerToParticipant).join(','));

  // Only accept responses from clickers assigned to a participant (student). Ignore unassigned clickers.
  if (!participant) {
    console.log('[EasyTest Live] Ignoring response: clicker not assigned to any student. Assign Clicker ID in the web app (Participants) then try again.');
    return;
  }

  // When revisable is false: one response per device per question. When revisable is true: allow reattempt (overwrite).
  if (!revisable && responses[deviceId]) return;

  const timestamp = data.timestamp || Date.now();
  const record = {
    answer,
    participantId: participant.id,
    name: participant.name,
    timestamp,
    keySN: keySN || undefined,
    deviceId,
  };
  responses[deviceId] = record;

  // Store for sync. When revisable: always update and sync so backend gets latest answer.
  if (!allResponsesByQuestion[currentIndex]) allResponsesByQuestion[currentIndex] = {};
  const q = questions[currentIndex];
  const questionId = q && q.question_id != null ? q.question_id : null;
  const answeredAt = new Date(timestamp).toISOString();
  const payloadItem = questionId != null ? {
    question_id: questionId,
    selected_answer: letterToIndex(answer),
    answered_at: answeredAt,
  } : null;

  const participantId = participant.id;
  const alreadyHad = !!allResponsesByQuestion[currentIndex][participantId];
  allResponsesByQuestion[currentIndex][participantId] = { answer, timestamp };
  if (revisable || !alreadyHad) {
    persistPending();
    if (payloadItem) {
      const item = { ...payloadItem, participant_id: participantId };
      syncSingleResponse(item, [participantId]);
    }
  }

  updateResponsesUI();
  renderQuestion();

  // Auto-advance when everyone answered (only if exam setting allows automatic question change)
  const totalParticipants = totalParticipantCount();
  if (
    questionChangeAutomatic &&
    examState === 'running' &&
    totalParticipants > 0 &&
    Object.keys(responses).length >= totalParticipants
  ) {
    if (nextQuestionTimeout) clearTimeout(nextQuestionTimeout);
    nextQuestionTimeout = setTimeout(() => {
      nextQuestionTimeout = null;
      nextQuestion();
    }, 1500);
  }
}

function startTimer(resume) {
  if (perQuestionSeconds <= 0 && !resume) return;
  if (!resume) questionTimerSec = perQuestionSeconds;
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
      if (questionChangeAutomatic) nextQuestion();
    }
  }, 1000);
}

function stopTimer() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  // Do not reset questionTimerSec or display here - allows resume to continue from same time
}

function resetTimerDisplay() {
  questionTimerSec = 0;
  timerDisplay.textContent = '00:00';
  timerDisplay.classList.remove('warning', 'danger');
}

function nextQuestion() {
  if (nextQuestionTimeout) {
    clearTimeout(nextQuestionTimeout);
    nextQuestionTimeout = null;
  }
  stopTimer();
  // End clicker session for the current question before moving on
  window.electronAPI.stopSession(0);
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
  // Start a fresh clicker session for the new current question
  if (examState === 'running') {
    startClickerSessionForCurrentQuestion();
    startTimer(false);
  }
}

// Get option count for the current question (what is shown on screen).
function getCurrentQuestionOptionCount() {
  if (!questions.length || currentIndex < 0 || currentIndex >= questions.length) return 4;
  const q = questions[currentIndex];
  const opts = Array.isArray(q.options) ? q.options : [];
  const n = opts.length || 0;
  // Clicker supports 4–10 options; keep within that range
  return Math.min(10, Math.max(4, n || 4));
}

// Start a clicker session for the question currently shown on screen.
async function startClickerSessionForCurrentQuestion() {
  const optionCount = getCurrentQuestionOptionCount();
  const result = await window.electronAPI.startSession({
    baseId: 0,
    voteType: 10,   // Multiple Choice
    optionCount,
    timeout: 0,     // no timeout; main process uses || 30 so SDK gets 30
    minSelect: 1,
    maxSelect: 1,
    submitMode: 1,
    displayMode: 0,
  });
  if (!result.success) console.warn('[EasyTest Live] startSession (current question):', result.error);
  return result;
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

  // Start clicker session for the question currently shown (currentIndex)
  const startResult = await startClickerSessionForCurrentQuestion();
  if (!startResult.success) console.warn('SDK startSession:', startResult.error);

  examStartedAt = new Date().toISOString(); // so backend can compute time_taken from exam start
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
  startTimer(false);
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
  // Resume clicker session for the question currently shown
  startClickerSessionForCurrentQuestion();
  startTimer(true); // continue from remaining time, do not reset
}

async function endExam() {
  examState = 'ended';
  stopTimer();
  resetTimerDisplay();
  if (nextQuestionTimeout) {
    clearTimeout(nextQuestionTimeout);
    nextQuestionTimeout = null;
  }
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
  // Reveal full stats in teacher view after exam ends (respects ended branch in shouldRevealOptionStatsForQuestionIndex)
  renderQuestion();
  updateResponsesUI();
  // Explicitly submit responses when session ends
  if (syncStatus) syncStatus.textContent = 'Submitting responses...';
  const payload = buildSyncPayload();
  console.log('========== [EasyTest Live] EXAM END – data sent to backend ==========');
  console.log('[EasyTest Live] Exam ID:', examId, '| Responses count:', payload.responses.length, '| Attendance count:', payload.attendance.length);
  if (payload.responses.length > 0) {
    payload.responses.forEach((r, i) => {
      console.log('[EasyTest Live] Response[' + i + ']:', {
        question_id: r.question_id,
        selected_answer: r.selected_answer,
        answered_at: r.answered_at,
        participant_id: r.participant_id ?? '(none)',
        clicker_id: r.clicker_id ?? '(none)',
      });
    });
    console.log('[EasyTest Live] Time data: each response includes answered_at (ISO) – backend uses this to compute time_taken per question.');
  } else {
    console.log('[EasyTest Live] No responses to send.');
  }
  console.log('================================================================');
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

function setInitialConnectionStatus() {
  window.electronAPI.getSDKStatus().then((s) => {
    if (!connectionStatus) return;
    if (s.connected) {
      connectionStatus.textContent = 'Clicker connected';
      connectionStatus.classList.remove('disconnected');
      connectionStatus.classList.add('connected');
    } else {
      connectionStatus.textContent = 'Clicker disconnected';
      connectionStatus.classList.remove('connected');
      connectionStatus.classList.add('disconnected');
    }
  });
}

async function initLivePage() {
  try {
    if (window.electronAPI?.getYoutubeEmbedOrigin) {
      const o = await window.electronAPI.getYoutubeEmbedOrigin();
      if (o && typeof o === 'string') youtubeEmbedOriginParam = o.replace(/\/$/, '');
    }
  } catch (e) {
    /* keep default origin */
  }
  loadExamFromStorage();
  setInitialConnectionStatus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    initLivePage();
  });
} else {
  initLivePage();
}
