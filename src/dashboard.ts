import http from 'http';
import https from 'https';
import { execSync } from 'child_process';
import { mkdirSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { Page } from 'playwright';

// ─── Types ────────────────────────────────────────────────────────

export interface PromptField {
  name: string;           // key in the response, e.g. "username", "password"
  label: string;          // shown to user, e.g. "GitHub Passwort"
  type: 'text' | 'password' | 'totp';
  secret: boolean;        // secret=true → cached & masked, secret=false → plain text
}

interface PendingPrompt {
  id: string;
  fields: PromptField[];
  resolve: (values: Record<string, string>) => void;
  reject: (err: Error) => void;
}

interface LogEntry {
  time: string;
  tool: string;
  args: string;
}

// ─── State ────────────────────────────────────────────────────────

let server: https.Server | null = null;
let serverPort = 0;
let pending: PendingPrompt | null = null;
let pageRef: Page | null = null;
let dashboardVersion = '0.0.0';

// Session cache: "credentialId.fieldName" → value (only for secret fields, never totp)
const sessionCache = new Map<string, string>();

const activityLog: LogEntry[] = [];
const sseClients: Set<http.ServerResponse> = new Set();

// ─── Public API ───────────────────────────────────────────────────

export function getCachedSecret(id: string, fieldName: string): string | undefined {
  return sessionCache.get(`${id}.${fieldName}`);
}

export function listCachedIds(): string[] {
  return [...sessionCache.keys()];
}

/** Export all cached secrets as a plain object (for session save) */
export function exportSecrets(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of sessionCache) out[k] = v;
  return out;
}

/** Import secrets from a plain object (for session restore) */
export function importSecrets(data: Record<string, string>): void {
  for (const [k, v] of Object.entries(data)) {
    sessionCache.set(k, v);
  }
}

export function setPage(p: Page): void {
  pageRef = p;
}

export function setVersion(v: string): void {
  dashboardVersion = v;
}

/** Log a tool call to the dashboard activity feed */
export function logActivity(tool: string, args?: Record<string, unknown>): void {
  const entry: LogEntry = {
    time: new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
    tool,
    args: args ? JSON.stringify(args) : '',
  };
  activityLog.push(entry);
  if (activityLog.length > 100) activityLog.shift();
  broadcast({ type: 'log', data: entry });
}

/** Get the dashboard URL, starting the server if needed */
export async function ensureDashboard(): Promise<string> {
  if (server && serverPort > 0) {
    return `https://127.0.0.1:${serverPort}`;
  }
  const port = await startServer();
  return `https://127.0.0.1:${port}`;
}

/**
 * Request multiple field values from the user via the dashboard.
 * Returns a promise that resolves with { fieldName: value } for each field.
 * Secret fields are cached per session (except totp).
 */
export async function requestFields(
  page: Page,
  id: string,
  fields: PromptField[],
): Promise<{ dashboardUrl: string; promise: Promise<Record<string, string>> }> {
  pageRef = page;
  const dashboardUrl = await ensureDashboard();

  const promise = new Promise<Record<string, string>>((resolve, reject) => {
    pending = { id, fields, resolve, reject };
    broadcast({
      type: 'prompt',
      data: { id, fields: fields.map(f => ({ name: f.name, label: f.label, type: f.type, secret: f.secret })) },
    });
  });

  return { dashboardUrl, promise };
}

export function stopServer(): void {
  for (const client of sseClients) {
    client.end();
  }
  sseClients.clear();
  if (server) {
    server.close();
    server = null;
    serverPort = 0;
  }
  sessionCache.clear();
}

export function isDashboardRunning(): boolean {
  return server !== null && serverPort > 0;
}

export function getDashboardUrl(): string | null {
  if (!server || serverPort === 0) return null;
  return `https://127.0.0.1:${serverPort}`;
}

// ─── TLS Cert Generation ─────────────────────────────────────────

function ensureTlsCerts(): { key: string; cert: string } {
  const tlsDir = join(homedir(), '.bcurl', 'tls');
  const keyPath = join(tlsDir, 'key.pem');
  const certPath = join(tlsDir, 'cert.pem');

  if (existsSync(keyPath) && existsSync(certPath)) {
    return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
  }

  mkdirSync(tlsDir, { recursive: true });

  execSync(
    `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 ` +
    `-keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes ` +
    `-subj "/CN=bcurl-dashboard/O=bcurl" ` +
    `-addext "subjectAltName=IP:127.0.0.1"`,
    { stdio: 'pipe' }
  );

  try { execSync(`chmod 600 "${keyPath}"`, { stdio: 'pipe' }); } catch {}

  return { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
}

// ─── Server ───────────────────────────────────────────────────────

function startServer(): Promise<number> {
  return new Promise((resolve, reject) => {
    const { key, cert } = ensureTlsCerts();

    server = https.createServer({ key, cert }, handleRequest);
    server.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      if (typeof addr === 'object' && addr) {
        serverPort = addr.port;
        startScreenshotLoop();
        resolve(serverPort);
      } else {
        reject(new Error('Failed to start dashboard server'));
      }
    });
    server.on('error', reject);
  });
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', `https://${req.headers.host}`);

  // ── SSE endpoint ──
  if (req.method === 'GET' && url.pathname === '/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(':\n\n');
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
    return;
  }

  // ── Live screenshot ──
  if (req.method === 'GET' && url.pathname === '/screenshot.png') {
    if (!pageRef || pageRef.isClosed()) {
      res.writeHead(204);
      res.end();
      return;
    }
    pageRef.screenshot({ type: 'jpeg', quality: 60 })
      .then((buf) => {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'no-store' });
        res.end(buf);
      })
      .catch(() => { res.writeHead(204); res.end(); });
    return;
  }

  // ── Submit form values ──
  if (req.method === 'POST' && url.pathname === '/submit') {
    if (!pending) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'No pending prompt' }));
      return;
    }
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body) as Record<string, string>;
        // Cache secret fields (except totp)
        for (const field of pending!.fields) {
          const val = data[field.name];
          if (val !== undefined && field.secret && field.type !== 'totp') {
            sessionCache.set(`${pending!.id}.${field.name}`, val);
          }
        }
        pending!.resolve(data);
        pending = null;
        broadcast({ type: 'prompt_resolved' });
        broadcast({ type: 'secrets_changed' });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
    return;
  }

  // ── List cached secrets (keys only) ──
  if (req.method === 'GET' && url.pathname === '/secrets') {
    const entries = [...sessionCache.keys()].map(key => {
      const [id, ...rest] = key.split('.');
      return { key, id, field: rest.join('.') };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(entries));
    return;
  }

  // ── Delete a cached secret ──
  if (req.method === 'DELETE' && url.pathname.startsWith('/secrets/')) {
    const key = decodeURIComponent(url.pathname.slice('/secrets/'.length));
    const deleted = sessionCache.delete(key);
    broadcast({ type: 'secrets_changed' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, deleted }));
    return;
  }

  // ── Clear all cached secrets ──
  if (req.method === 'DELETE' && url.pathname === '/secrets') {
    sessionCache.clear();
    broadcast({ type: 'secrets_changed' });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  // ── Dashboard HTML ──
  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(renderDashboard());
    return;
  }

  res.writeHead(404);
  res.end('Not found');
}

// ─── SSE Broadcast ────────────────────────────────────────────────

export function broadcast(msg: { type: string; data?: unknown }): void {
  const payload = `event: ${msg.type}\ndata: ${JSON.stringify(msg.data ?? {})}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

// ─── Screenshot Loop ──────────────────────────────────────────────

let screenshotInterval: ReturnType<typeof setInterval> | null = null;

function startScreenshotLoop(): void {
  if (screenshotInterval) return;
  screenshotInterval = setInterval(() => {
    if (sseClients.size === 0) return;
    if (!pageRef || pageRef.isClosed()) return;

    pageRef.screenshot({ type: 'jpeg', quality: 50 })
      .then((buf) => {
        broadcast({ type: 'screenshot', data: buf.toString('base64') });
        // Also broadcast current URL
        try {
          const currentUrl = pageRef?.url();
          if (currentUrl) broadcast({ type: 'url', data: currentUrl });
        } catch {}
      })
      .catch(() => {});
  }, 1000);
}

// ─── Dashboard HTML ───────────────────────────────────────────────

function renderDashboard(): string {
  const version = dashboardVersion;
  const initialLog = JSON.stringify(activityLog);

  return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>bcurl Dashboard</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    background: #0a0e17; color: #c9d1d9; min-height: 100vh;
  }
  header {
    background: #161b22; border-bottom: 1px solid #30363d;
    padding: 0.75rem 1.5rem; display: flex; align-items: center; gap: 1rem;
  }
  header h1 { font-size: 1rem; font-weight: 600; color: #e6edf3; }
  .status { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; color: #8b949e; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #3fb950; }
  .dot.waiting { background: #d29922; animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }

  .layout { display: grid; grid-template-columns: 1fr 360px; height: calc(100vh - 49px); }

  .screen-panel { padding: 1rem; overflow: hidden; display: flex; flex-direction: column; }
  .screen-panel .url-bar {
    background: #161b22; border: 1px solid #30363d; border-radius: 6px;
    padding: 0.4rem 0.75rem; margin-bottom: 0.75rem; font-size: 0.8rem;
    color: #58a6ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .screen-wrap { flex: 1; border-radius: 8px; overflow: hidden; border: 1px solid #30363d;
                  background: #000; position: relative; }
  .screen-wrap img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .no-screen { color: #484f58; text-align: center; padding-top: 40%; font-size: 0.9rem; }

  .side-panel { border-left: 1px solid #30363d; display: flex; flex-direction: column;
                 overflow: hidden; }

  /* ── Prompt area ── */
  .prompt-area { padding: 1rem; border-bottom: 1px solid #30363d; display: none; }
  .prompt-area.active { display: block; }
  .prompt-area h2 { font-size: 0.9rem; margin-bottom: 0.75rem; color: #e6edf3; }
  .prompt-area .meta { font-size: 0.75rem; color: #8b949e; margin-bottom: 0.75rem; }
  .field-group { margin-bottom: 0.6rem; }
  .field-group label {
    display: block; font-size: 0.75rem; font-weight: 500; margin-bottom: 0.25rem; color: #8b949e;
  }
  .field-group input {
    width: 100%; padding: 0.5rem 0.75rem; border: 1px solid #30363d; border-radius: 6px;
    background: #0d1117; color: #e6edf3; font-size: 0.9rem; outline: none;
  }
  .field-group input:focus { border-color: #58a6ff; }
  .field-group input.totp {
    font-size: 1.5rem; text-align: center; letter-spacing: 0.4rem; font-family: monospace;
  }
  .prompt-area button {
    width: 100%; margin-top: 0.5rem; padding: 0.5rem; border: none; border-radius: 6px;
    background: #238636; color: #fff; font-weight: 600; cursor: pointer; font-size: 0.85rem;
  }
  .prompt-area button:hover { background: #2ea043; }
  .prompt-area .hint { font-size: 0.7rem; color: #d29922; margin-top: 0.5rem; }

  /* ── Tabs ── */
  .tabs { display: flex; border-bottom: 1px solid #30363d; }
  .tab { flex: 1; padding: 0.5rem; text-align: center; font-size: 0.8rem; font-weight: 600;
         color: #8b949e; cursor: pointer; border-bottom: 2px solid transparent;
         transition: color 0.2s, border-color 0.2s; }
  .tab:hover { color: #c9d1d9; }
  .tab.active { color: #e6edf3; border-bottom-color: #58a6ff; }
  .tab-content { display: none; flex: 1; overflow-y: auto; min-height: 0; }
  .tab-content.active { display: flex; flex-direction: column; }

  /* ── Log area ── */
  .log-area { padding: 0.75rem; flex: 1; overflow-y: auto; min-height: 0; }
  .log-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; }
  .log-clear { background: none; border: none; color: #484f58; font-size: 0.7rem;
               cursor: pointer; padding: 0.15rem 0.4rem; border-radius: 3px; }
  .log-clear:hover { color: #da3633; background: #21262d; }
  .log-area h2 { font-size: 0.8rem; color: #8b949e;
                  text-transform: uppercase; letter-spacing: 0.05em; }
  .log-entry { font-size: 0.75rem; padding: 0.3rem 0; border-bottom: 1px solid #21262d;
               display: flex; gap: 0.5rem; }
  .log-entry .time { color: #484f58; flex-shrink: 0; }
  .log-entry .tool { color: #d2a8ff; font-weight: 600; }
  .log-entry .args { color: #8b949e; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  /* ── Secrets area ── */
  .secrets-area { padding: 0.75rem; }
  .secrets-area h2 { font-size: 0.8rem; color: #8b949e; margin-bottom: 0.5rem;
                      text-transform: uppercase; letter-spacing: 0.05em; }
  .secret-entry { font-size: 0.8rem; padding: 0.4rem 0.5rem; border-bottom: 1px solid #21262d;
                   display: flex; align-items: center; justify-content: space-between; }
  .secret-entry .secret-id { color: #d2a8ff; font-weight: 600; }
  .secret-entry .secret-field { color: #8b949e; font-size: 0.75rem; }
  .secret-entry .secret-remove {
    background: none; border: 1px solid #da3633; color: #da3633; border-radius: 4px;
    padding: 0.15rem 0.4rem; font-size: 0.7rem; cursor: pointer; transition: all 0.2s;
  }
  .secret-entry .secret-remove:hover { background: #da3633; color: #fff; }
  .secrets-empty { color: #484f58; font-size: 0.8rem; padding: 1rem 0; text-align: center; }
  .clear-all-btn {
    width: 100%; margin-top: 0.75rem; padding: 0.4rem; border: 1px solid #da3633;
    border-radius: 6px; background: none; color: #da3633; font-size: 0.8rem;
    cursor: pointer; transition: all 0.2s;
  }
  .clear-all-btn:hover { background: #da3633; color: #fff; }

  @media (max-width: 768px) {
    .layout { grid-template-columns: 1fr; grid-template-rows: 1fr auto; }
    .side-panel { border-left: none; border-top: 1px solid #30363d; max-height: 40vh; }
  }
</style>
</head>
<body>

<header>
  <h1>bcurl <span style="font-weight:400;font-size:0.75rem;color:#484f58">v${version}</span></h1>
  <div class="status">
    <span class="dot" id="statusDot"></span>
    <span id="statusText">Verbunden</span>
  </div>
</header>

<div class="layout">
  <div class="screen-panel">
    <div class="url-bar" id="urlBar">about:blank</div>
    <div class="screen-wrap">
      <img id="screenImg" src="" alt="Live Screenshot" style="display:none">
      <div class="no-screen" id="noScreen">Warte auf Navigation...</div>
    </div>
  </div>

  <div class="side-panel">
    <div class="prompt-area" id="promptArea">
      <h2 id="promptTitle"></h2>
      <div class="meta" id="promptMeta"></div>
      <div id="promptFields"></div>
      <button id="promptSubmit" onclick="submitForm()">Absenden</button>
      <div class="hint" id="promptHint"></div>
    </div>

    <div class="tabs">
      <div class="tab active" onclick="switchTab('activity')">Activity</div>
      <div class="tab" onclick="switchTab('secrets')">Secrets <span id="secretsBadge"></span></div>
    </div>

    <div class="tab-content active" id="tab-activity">
      <div class="log-area">
        <div class="log-header">
          <h2>Activity</h2>
          <button class="log-clear" onclick="clearLog()">Clear</button>
        </div>
        <div id="logContainer"></div>
      </div>
    </div>

    <div class="tab-content" id="tab-secrets">
      <div class="secrets-area">
        <div id="secretsList"></div>
        <button class="clear-all-btn" id="clearAllBtn" onclick="clearAllSecrets()" style="display:none">
          Alle Secrets entfernen
        </button>
      </div>
    </div>
  </div>
</div>

<script>
const screenImg = document.getElementById('screenImg');
const noScreen = document.getElementById('noScreen');
const urlBar = document.getElementById('urlBar');
const promptArea = document.getElementById('promptArea');
const promptTitle = document.getElementById('promptTitle');
const promptMeta = document.getElementById('promptMeta');
const promptFields = document.getElementById('promptFields');
const promptHint = document.getElementById('promptHint');
const logContainer = document.getElementById('logContainer');
const statusDot = document.getElementById('statusDot');
const statusText = document.getElementById('statusText');

let currentFields = [];

const initialLog = ${initialLog};
initialLog.forEach(addLogEntry);

// ── SSE ──
function connectSSE() {
  const es = new EventSource('/events');
  es.addEventListener('screenshot', (e) => {
    const b64 = JSON.parse(e.data);
    screenImg.src = 'data:image/jpeg;base64,' + b64;
    screenImg.style.display = 'block';
    noScreen.style.display = 'none';
  });

  es.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    addLogEntry(entry);
    if (entry.tool === 'navigate' && entry.args) {
      try {
        const a = JSON.parse(entry.args);
        if (a.url) urlBar.textContent = a.url;
      } catch {}
    }
  });

  es.addEventListener('prompt', (e) => {
    const p = JSON.parse(e.data);
    showPrompt(p);
  });

  es.addEventListener('prompt_resolved', () => {
    hidePrompt();
  });

  es.addEventListener('url', (e) => {
    urlBar.textContent = JSON.parse(e.data);
  });

  es.addEventListener('login_detected', (e) => {
    const data = JSON.parse(e.data);
    // Flash the status bar
    statusDot.className = 'dot waiting';
    statusText.textContent = 'Login-Formular erkannt (' + data.fields.length + ' Felder)';
    setTimeout(() => {
      if (!document.getElementById('promptArea').classList.contains('active')) {
        statusDot.className = 'dot';
        statusText.textContent = 'Verbunden';
      }
    }, 5000);
  });

  es.addEventListener('secrets_changed', () => {
    // Refresh if secrets tab is visible
    if (document.getElementById('tab-secrets').classList.contains('active')) loadSecrets();
    // Update badge regardless
    fetch('/secrets').then(r => r.json()).then(entries => {
      document.getElementById('secretsBadge').textContent = entries.length > 0 ? '(' + entries.length + ')' : '';
    }).catch(() => {});
  });

  es.onopen = () => {
    statusDot.className = 'dot';
    statusText.textContent = 'Verbunden';
  };
  es.onerror = () => {
    statusDot.className = 'dot waiting';
    statusText.textContent = 'Verbindung unterbrochen...';
  };
}
connectSSE();

function addLogEntry(entry) {
  const div = document.createElement('div');
  div.className = 'log-entry';
  div.innerHTML =
    '<span class="time">' + esc(entry.time) + '</span>' +
    '<span class="tool">' + esc(entry.tool) + '</span>' +
    '<span class="args">' + esc(entry.args) + '</span>';
  logContainer.prepend(div);
  while (logContainer.children.length > 100) logContainer.lastChild.remove();
}

function showPrompt(p) {
  currentFields = p.fields;
  promptArea.classList.add('active');
  statusDot.className = 'dot waiting';
  statusText.textContent = 'Eingabe erforderlich';

  promptTitle.textContent = 'Eingabe: ' + p.id;
  promptMeta.textContent = 'Credential-ID: ' + p.id;

  // Build form fields dynamically
  promptFields.innerHTML = '';
  let hasTotp = false;
  p.fields.forEach((f, i) => {
    const group = document.createElement('div');
    group.className = 'field-group';

    const lbl = document.createElement('label');
    lbl.setAttribute('for', 'field_' + f.name);
    lbl.textContent = f.label + (f.secret ? '' : '');
    group.appendChild(lbl);

    const input = document.createElement('input');
    input.id = 'field_' + f.name;
    input.name = f.name;
    input.autocomplete = 'off';

    if (f.type === 'totp') {
      input.type = 'text';
      input.className = 'totp';
      input.inputMode = 'numeric';
      input.pattern = '[0-9]*';
      input.maxLength = 8;
      input.placeholder = '6-stelliger Code';
      hasTotp = true;
      // Auto-submit on 6 digits
      input.addEventListener('input', () => {
        if (input.value.length >= 6 && /^\\d+$/.test(input.value)) submitForm();
      });
    } else if (f.type === 'password') {
      input.type = 'password';
      input.placeholder = f.label + '...';
    } else {
      input.type = 'text';
      input.placeholder = f.label + '...';
    }

    // Enter on last field submits
    if (i === p.fields.length - 1) {
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitForm(); });
    } else {
      // Enter on non-last fields focuses next
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          const next = promptFields.querySelectorAll('input')[i + 1];
          if (next) next.focus();
        }
      });
    }

    group.appendChild(input);
    promptFields.appendChild(group);
  });

  // Build hint
  const secrets = p.fields.filter(f => f.secret && f.type !== 'totp');
  const totps = p.fields.filter(f => f.type === 'totp');
  const hints = [];
  if (secrets.length) hints.push('Secrets werden fuer diese Session gecached.');
  if (totps.length) hints.push('Einmal-Codes werden nicht gespeichert.');
  promptHint.textContent = hints.join(' ');

  // Focus first input
  const firstInput = promptFields.querySelector('input');
  if (firstInput) firstInput.focus();
}

function hidePrompt() {
  promptArea.classList.remove('active');
  statusDot.className = 'dot';
  statusText.textContent = 'Verbunden';
  currentFields = [];
}

async function submitForm() {
  const values = {};
  let valid = true;
  currentFields.forEach(f => {
    const input = document.getElementById('field_' + f.name);
    if (input) {
      values[f.name] = input.value;
      if (!input.value && f.secret) valid = false; // secrets are required
    }
  });
  if (!valid) return;

  try {
    await fetch('/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(values),
    });
    hidePrompt();
  } catch (err) {
    promptHint.textContent = 'Fehler: ' + err.message;
  }
}

function clearLog() {
  logContainer.innerHTML = '';
}

// ── Tabs ──
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelector('.tab[onclick*="' + name + '"]').classList.add('active');
  document.getElementById('tab-' + name).classList.add('active');
  if (name === 'secrets') loadSecrets();
}

// ── Secrets Management ──
async function loadSecrets() {
  try {
    const res = await fetch('/secrets');
    const entries = await res.json();
    const list = document.getElementById('secretsList');
    const badge = document.getElementById('secretsBadge');
    const clearBtn = document.getElementById('clearAllBtn');

    badge.textContent = entries.length > 0 ? '(' + entries.length + ')' : '';
    clearBtn.style.display = entries.length > 0 ? 'block' : 'none';

    if (entries.length === 0) {
      list.innerHTML = '<div class="secrets-empty">Keine Secrets im Cache.</div>';
      return;
    }

    list.innerHTML = entries.map(e =>
      '<div class="secret-entry">' +
        '<div><span class="secret-id">' + esc(e.id) + '</span> ' +
        '<span class="secret-field">' + esc(e.field) + '</span></div>' +
        '<button class="secret-remove" onclick="removeSecret(\\'' + esc(e.key).replace(/'/g, "\\\\'") + '\\')">Entfernen</button>' +
      '</div>'
    ).join('');
  } catch {}
}

async function removeSecret(key) {
  await fetch('/secrets/' + encodeURIComponent(key), { method: 'DELETE' });
  loadSecrets();
}

async function clearAllSecrets() {
  await fetch('/secrets', { method: 'DELETE' });
  loadSecrets();
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s || '';
  return d.innerHTML;
}
</script>
</body>
</html>`;
}
