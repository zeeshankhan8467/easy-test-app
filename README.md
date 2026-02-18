# EasyTest Live

Windows desktop application for **running live clicker-based exams** with the EasyTest backend. Uses the same clicker hardware and SDK as the reference app (acadally-electron-app).

## Features

- **Instructor login** via EasyTest (email + password, JWT)
- **Exam loader**: fetch frozen exam snapshot (questions, marks, version) and cache locally
- **Clicker integration**: same EasyTest SDK (koffi + EasyTestSDK_x64.dll) as acadally-electron-app — connect, listen for A/B/C/D, map clicker ID → participant
- **Live execution**: start/pause/end, per-question countdown timer, auto-next when time expires
- **Response collection**: one response per participant per question, stored locally immediately
- **Live stats**: response count and A/B/C/D distribution (no correct answers shown during exam)
- **Offline mode**: exam continues if network fails; responses saved locally
- **Sync engine**: background sync to backend (`POST /api/exams/:id/sync_live_results/`); retry; clear local only after success

## Requirements

- **Node.js** (e.g. 18+)
- **Windows** (target OS for .exe)
- **EasyTest backend** running (e.g. `http://localhost:8000/api/`)
- **Clicker hardware** compatible with EasyTest SDK (same as acadally-electron-app)

## Hardware / SDK

The app uses the **same** clicker connection as **acadally-electron-app**:

- **EasyTestSDK_x64.dll** — copy this file from your existing `acadally-electron-app` folder into the `easytest-live` folder (same directory as `main.js`).
- **koffi** (Node native binding) loads the DLL; no change to device detection or protocol.

Without the DLL, the app runs but clicker connection will fail (SDK not loaded).

## Setup

1. **Copy the SDK DLL** (required for clicker):
   ```text
   copy path\to\acadally-electron-app\EasyTestSDK_x64.dll path\to\easytest\easytest-live\
   ```

2. **Install dependencies**
   ```bash
   cd easytest-live
   npm install
   ```

3. **Configure API URL** (optional)  
   Default is `http://localhost:8000/api/`. To override:
   ```bash
   set EASYTEST_API_URL=https://your-easytest-api.com/api/
   npm start
   ```

## Run

```bash
npm start
```

Development (with DevTools):

```bash
npm run dev
```

## Build Windows .exe

```bash
npm run build:win
```

Output: `dist/EasyTest Live-1.0.0-Setup.exe` (or similar). Ensure **EasyTestSDK_x64.dll** is in the project root before building so it is included in the package (see `package.json` → `build.files` and `asarUnpack`).

## Usage

1. **Login** with your EasyTest instructor email and password.
2. **Dashboard**: lists frozen exams. Click **Run exam** for an exam (loads snapshot + participants).
3. **Connect** the clicker base station (USB) before starting.
4. **Run exam**: click **Start** to connect to the clicker and start the session. Use **Next question** or wait for the per-question timer to move on; **End exam** to finish and sync.
5. Responses are stored locally and synced to the backend; if offline, data is synced when the connection is back.

## Backend

- **Auth**: `POST /api/auth/login/` → `{ token, user }`
- **Exams**: `GET /api/exams/` (list), `GET /api/exams/:id/snapshot/` (frozen snapshot + optional `snapshot_version`)
- **Participants**: `GET /api/participants/?exam_id=:id` (includes `clicker_id` for mapping)
- **Sync**: `POST /api/exams/:id/sync_live_results/` with `{ responses: [...], attendance: [...] }` (see backend API docs)

## Project structure

```text
easytest-live/
  main.js           # Main process: SDK, auth, API, storage, sync, IPC
  preload.js        # Context bridge for renderer
  package.json
  EasyTestSDK_x64.dll   # Copy from acadally-electron-app
  src/
    pages/
      login.html / login.js
      dashboard.html / dashboard.js
      live.html / live.js
    styles/
      main.css
```

## Quality notes

- **Stable over fancy**: same clicker flow as the reference app; no protocol changes.
- **No response loss**: responses saved locally first; sync retries; local data cleared only after successful sync.
- **Cached exam**: snapshot is loaded once when you click “Run exam”; exam runs from cache so it continues offline.
