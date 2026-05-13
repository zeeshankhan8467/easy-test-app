# EasyTest Live — Exam screen logic, APIs, and parameters

This document describes what the **EasyTest Live** exam screen implements (conditions, data flow, and HTTP APIs). Use it to mirror behavior in other clients (e.g. Android).

---

## Base URL and authentication

- **API root**: Configurable (e.g. `https://easytestlive.com/api/`). Paths below are relative; the Electron app typically uses a trailing slash on the base.
- **Login**
  - **Method / URL:** `POST auth/login/`
  - **Headers:** `Content-Type: application/json`, `Accept: application/json`
  - **Body:** `{ "email": "<string>", "password": "<string>" }`
  - **Success:** Response includes `token` (and usually `user`).
- **Authenticated requests:** Header  
  `Authorization: Bearer <token>`  
  plus `Content-Type: application/json`, `Accept: application/json`.

---

## HTTP APIs used for the live exam flow

| Purpose | Method | URL | Notes |
|--------|--------|-----|--------|
| List exams | GET | `exams/` | Response may be a list or `{ results: [...] }` |
| Frozen exam snapshot | GET | `exams/{examId}/snapshot/` | Drives all exam UI flags and questions |
| Participants for this exam | GET | `participants/?exam_id={examId}` | Exam roster |
| All participants | GET | `participants/` | No `exam_id` — used to map **clicker_id → participant** globally |
| Submit live results | POST | `exams/{examId}/sync_live_results/` | JSON body (see below) |

### Participant / clicker mapping (dashboard → live)

Before opening the exam screen, the app:

1. Fetches `GET participants/` (all participants).
2. Builds `clickerToParticipant`: for every participant with non-empty `clicker_id`, map:
   - `String(clicker_id).trim()`
   - original key if different
   - `Number(clicker_id)` when numeric  
   to `{ id, name, email }`.

This allows hardware responses keyed by serial or numeric id to resolve even if the student is not only in the exam-scoped participant list.

---

## Snapshot response (`GET exams/{id}/snapshot/`)

The frozen snapshot is the source of truth for questions and behavior flags.

### Exam-level fields

| Field | Type (typical) | Default if missing | Effect |
|--------|----------------|-------------------|--------|
| `title` | string | — | Exam title |
| `revisable` | bool / string / int | false | If **false**: one submission per device per question (ignore duplicates). If **true**: overwrite and re-sync. |
| `show_live_response` | bool / string / int | false | If **true**: show option breakdown and each student’s choice as answers arrive. |
| `show_response_after_completion` | bool / string / int | true | If `show_live_response` is false: when **true**, reveal breakdown when **this question’s countdown reaches zero** (does not wait for all students to answer). If duration is 0 / no countdown, reveal immediately for that question. |
| `question_change_automatic` | bool / string / int | false | If **true**: auto-advance when timer reaches 0 **or** all students answered (~1.5 s delay). If **false**: teacher must go **Next** manually. |
| `duration` | number | 0 | If **> 0**: per-question countdown in seconds. Else fallback: first question’s `timeout` if set; else **30**. |
| `option_display` | string | — | Exam-wide default when a question has no `option_display` |
| `snapshot_version` | any | — | Optional version for client validation |
| `questions` | array | [] | Ordered by `order` after load |

**Boolean normalization (client):** Treat as true for `true`, `"true"`, `1`, `"1"`; false for `false`, `"false"`, `0`, `"0"`; otherwise use the documented default.

### Per-question objects (`questions[]`)

| Field | Usage |
|--------|--------|
| `question_id` | **Required** for sync — must appear in each `sync_live_results` row |
| `order` | Sort key for display order |
| `text` | Question HTML (sanitize for display — see below) |
| `type` | e.g. MCQ (display only) |
| `options` | Array, JSON string, or object with numeric keys `"0","1",...` → normalize to ordered array |
| `option_display` | `"alpha"` or `"numeric"`; if missing/invalid, infer: if every option is digits-only → `numeric`, else `alpha` |
| `positive_marks`, `negative_marks`, `correct_answer`, etc. | Present in snapshot; live UI focuses on collection and sync |

### Answer encoding

- **Internal / clicker:** Responses are handled as letters **A–J** = option indices **0–9**.
- **API `selected_answer`:** **0-based index** (A → 0, B → 1, …), same as the letter index.

---

## Exam screen state machine

- **States:** `idle` → `running` ↔ `paused` → `ended`
- **Start:** Requires at least one question (and on Electron: clicker SDK loaded/connected).
- **Accept hardware (or simulated) answers only when** `running` or `paused`.

---

## Conditions and rules (parity checklist)

1. **Validate answer:** Must be A–J. **Reject** if option index ≥ number of options for the **current** question (options length; clicker hardware uses 4–10 clamp for VoteStart2).
2. **Resolve student:** Lookup `clickerToParticipant` by: trimmed `keySN`, then `deviceId` (`keySN` or `d{baseId}_{clicker_id}`), then `String(clicker_id)` and `Number(clicker_id)`. **Ignore** response if no participant matched.
3. **Revisable:** If false and device already answered this question → ignore. If true → overwrite and sync again.
4. **Reveal option stats / student choices** (`shouldRevealOptionStatsForQuestionIndex`):
   - If exam **`ended`** → always reveal.
   - Else if **`show_live_response`** → reveal.
   - Else if **`show_response_after_completion`** and this question’s timer has reached **0** (or there is no per-question countdown) → reveal.
   - Else hide detailed breakdown (e.g. show “Submitted” without letter/number).
5. **Timer:** Countdown `perQuestionSeconds` from `duration` / `timeout` / default 30. At 0: if `question_change_automatic` → next question.
6. **Auto-advance when all answered:** If `question_change_automatic` and response count ≥ total mapped participants → after ~1.5 s → next question.
7. **Next question:** Stop vote session (if any), increment index, reload stored answers for that index from `allResponsesByQuestion`, restart session + timer if `running`.
8. **Pause:** Stop timer and vote session. **Resume:** Start vote session again, **restart** question start time for `time_taken`, resume countdown from remaining value.
9. **Question nav:** While `running`, switching question may confirm; restores answers for that index into the live map.

---

## `POST exams/{examId}/sync_live_results/`

### Headers

`Authorization: Bearer <token>`  
`Content-Type: application/json`  
`Accept: application/json`

### Body

```json
{
  "responses": [],
  "attendance": [],
  "exam_started_at": "2026-04-02T12:00:00.000+05:30"
}
```

- **`responses`:** Array of answer objects (see below).
- **`attendance`:** Array of **participant_id** integers (the app includes **all** students in `clickerToParticipant` so absent students still get exam attendance).
- **`exam_started_at`:** Optional ISO 8601 with timezone offset. The Electron app uses **Asia/Kolkata (`+05:30`)** for `answered_at` and exam start.

### Each response object

| Field | Required | Description |
|--------|----------|-------------|
| `question_id` | Yes | From snapshot |
| `selected_answer` | Yes | **0-based** option index (MCQ) |
| `answered_at` | Yes | ISO 8601 with offset |
| `time_taken` | No | Seconds spent on **that question** (wall time since question started) |
| `participant_id` | One of participant or clicker | Direct participant id |
| `clicker_id` | | String; server resolves to participant |

### Server constraints

- Exam must be **`frozen`** or **`completed`**, or the API returns **400** with a message such as: `Exam must be frozen to accept live results`.

### Client sync timing (Electron reference)

- After each answer when `revisable` or first answer for that participant on that question.
- Periodic **30 s** sync while running.
- Persist pending payload locally; final sync on **end exam**.

---

## Question HTML and media (display parity)

- Allow basic typography, lists, images (`http`/`https` or bounded `data:image/...`), and **YouTube embed** iframes only (`youtube.com` / `youtube-nocookie.com`, path `/embed/...`).
- Strip `script` and `style`; remove unsafe attributes; replace generic links with spans.
- Embedded YouTube may require a valid **Referer** / **origin** in some environments.

---

## Electron-only (not REST)

- **SunVote / EasyTest native DLL:** `Connect`, `VoteStart2`, `VoteStop2`, key callbacks — used only on desktop. Android would use its own hardware integration or another input path; **sync payload and snapshot rules stay the same**.

---

## File references in this repo

- Renderer logic: `easytest-live/src/pages/live.js`
- Dashboard load + session payload: `easytest-live/src/pages/dashboard.js`
- HTTP + sync IPC: `easytest-live/main.js` (`api:fetchExamSnapshot`, `api:fetchParticipants`, `api:syncLiveResults`, `auth:login`)
- Backend contract: `backend/api/views.py` — `sync_live_results` action and snapshot builder on the exam viewset

---

*Generated to document EasyTest Live behavior for cross-platform clients.*
