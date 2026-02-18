# How acadally-electron-app Receives and Saves Clicker Responses

## 1. SDK → Main process (main.js)

- **KeyEventCallback** receives from DLL: `(baseId, keyId, keySN, mode, time, info)`.
- **keyId** = key pressed (1=A, 2=B, 3=C, 4=D). Only 1–4 are accepted.
- **keySN** = device serial from SDK (passed through as-is; may be empty string).
- Main process logs: `Key Event: { baseId, keyId, keySN, mode, time, info }`.
- It sends to renderer: `clicker-response` with **`clicker_id: keyId`**, **`keySN`**, `answer`, `timestamp`, etc.  
  So the renderer always gets **clicker_id = 1, 2, 3, or 4** (the key number).

## 2. Renderer: matching to student (session.js)

- **clickerId** is set from the event:  
  `const clickerId = data.clicker_id || data.keyId || data.keypad_id;`  
  So **clicker_id** in the app is the **key number (1–4)** from the SDK.

- **Assignments** come from `localStorage.deviceAssignments`:  
  `{ [studentId]: { clickerId, mappingId, clickerSn } }` or `{ [studentId]: clickerId }`.  
  So each student is linked to one **clickerId** (1, 2, 3, or 4).

- To find the student for a response:
  - Find the assignment whose **clickerId** equals the incoming **clickerId** (keyId).
  - So: **one response with keyId 1** → student with **assignment.clickerId === 1**.

- No use of **keySN** for matching in this flow; matching is by **clicker_id / keyId** (1–4).

## 3. Saving / submitting (session.js + main.js)

- Each response is **submitted immediately** to the backend (no batch at session end).
- **submitData** sent to server:
  - `session_id`
  - `question_id` / `question_number`
  - **`clicker_id`** = clickerId (1, 2, 3, or 4)
  - **`student_id`** = studentId if a student was found from assignments, else null
  - `answer`, `response_time`, `timestamp`

- Main process: **api:submitClickerResponse** does a **POST** to  
  `API_BASE_URL + 'onboarding/clicker/responses/'` with that payload.

- Backend (acadally) receives **clicker_id** as the number **1, 2, 3, or 4** and **student_id** when the app matched a student.

## 4. Difference vs EasyTest Live

| Aspect              | acadally-electron-app              | EasyTest Live                          |
|---------------------|------------------------------------|----------------------------------------|
| Clicker id from SDK | Uses **keyId** (1–4) as clicker_id | Same keyId; also build deviceId if keySN empty |
| Student mapping     | **assignments**: studentId → clickerId (1–4) | **clickerToParticipant**: clicker_id (e.g. "1") → participant |
| When to submit      | **Per response** (immediate POST)  | **Batch at session end** (sync_live_results) |
| What is sent        | clicker_id (1–4), student_id, answer | participant_id or clicker_id, answers, attendance |

So in acadally, **response is received** (keyId + keySN from SDK), **matched by clicker_id = keyId (1–4)** to a student via assignments, and **saved by posting each response** to the backend with **clicker_id** and **student_id**.
