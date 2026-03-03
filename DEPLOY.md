# EasyTest Live – Deployment & Login Timeout

Logs are written to a file so you can see the API URL and errors even when running the packaged app.

**Log file location:**
- **Windows:** `%APPDATA%\easytest-live\easytest-live.log` (or your app name folder)
- **macOS:** `~/Library/Application Support/easytest-live/easytest-live.log`

Each line is timestamped. You’ll see:
- `EasyTest Live started` with `apiBaseUrl`, `userData`, and `logFile`
- `API request` with `method` and full `url` for each request
- `API error` with `url` and `error` on timeout or connection failure

When running from terminal (`npm start` or `electron .`), the same lines are printed to the console.

---

## If you get `ERR_CONNECTION_TIMED_OUT` on login

The app cannot reach the API server. Fix either **network/server** or **API URL**.

---

### 1. Check where the app runs vs where the server is

- **Same machine as the server:** Use `http://127.0.0.1/api/` or `http://localhost/api/` (see config below).
- **Another PC on the same LAN:** Use the server’s LAN IP, e.g. `http://169.144.18.139/api/`. That PC must be able to reach the server (same subnet, no firewall blocking).
- **Different network (e.g. home vs office):** `169.144.18.139` is only reachable on the same network. Use a **public URL** (domain or public IP) and ensure the server is reachable from the internet (port 80/443 open, reverse proxy if needed).

---

### 2. Override API URL without rebuilding (config file)

You can point the app to a different API without changing code or env:

1. Find the app’s **user data** folder:
   - Windows: `%APPDATA%\easytest-live\` (or your app name)
   - macOS: `~/Library/Application Support/easytest-live/`
2. Create or edit `config.json` in that folder:

```json
{
  "apiUrl": "http://169.144.18.139/api/"
}
```

Use your real API base URL (with trailing slash). Examples:

- Same machine: `"apiUrl": "http://127.0.0.1:8000/api/"`
- Server on port 80: `"apiUrl": "http://169.144.18.139/api/"`
- HTTPS: `"apiUrl": "https://your-domain.com/api/"`

3. Restart the app and try login again.

---

### 3. Server-side checklist (backend at `169.144.18.139`)

On the server:

1. **Django is listening on all interfaces**  
   Run with:
   - `python manage.py runserver 0.0.0.0:8000` (dev), or  
   - Gunicorn/uWSGI bound to `0.0.0.0` (not only `127.0.0.1`).

2. **ALLOWED_HOSTS**  
   In `.env` or `settings.py`:
   ```bash
   ALLOWED_HOSTS=169.144.18.139,localhost,127.0.0.1
   ```

3. **Firewall**  
   Allow incoming TCP on the port the API uses (e.g. 80 for nginx, 8000 if you use runserver).

4. **Reverse proxy (nginx)**  
   If you use nginx, ensure it proxies to Django and listens on 80 (or 443). Test from the server:
   ```bash
   curl -I http://127.0.0.1/api/
   ```

---

### 4. Test reachability from the PC where the app runs

- In a browser open: `http://169.144.18.139/api/`  
  You should get JSON or a 404 from Django, not “can’t connect” or timeout.
- From Command Prompt / PowerShell:
  ```bash
  curl -I http://169.144.18.139/api/
  ```
  or
  ```bash
  ping 169.144.18.139
  ```

If this fails, the problem is network/firewall or the server not listening; fix that before changing the app.

---

### 5. Rebuild after changing `main.js`

If you edit `main.js` (e.g. default API URL) and then build the Electron app, run a full rebuild so the packaged app includes your changes:

```bash
npm run build
# or
electron-builder
```

Using the **config file** (step 2) avoids rebuilding when you only need to change the API URL.
