import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'http';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { existsSync, writeFileSync, readFileSync, unlinkSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { captureWithContext } from './browser.js';
import type { BcurlOptions, CaptureResult } from './types.js';

const SOCKET_PATH = '/tmp/bcurl-daemon.sock';
const PID_FILE = '/tmp/bcurl-daemon.pid';
const LOG_FILE = '/tmp/bcurl-daemon.log';
const DEFAULT_IDLE_TIMEOUT = 300_000; // 5 minutes
const DEFAULT_POOL_SIZE = 3;

let browser: Browser | null = null;
let server: Server | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let idleTimeout = DEFAULT_IDLE_TIMEOUT;
let activeRequests = 0;

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  try {
    appendFileSync(LOG_FILE, line);
  } catch {
    // ignore
  }
}

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (activeRequests === 0) {
    idleTimer = setTimeout(async () => {
      log('Idle timeout reached, shutting down');
      await shutdown();
    }, idleTimeout);
  }
}

async function shutdown(): Promise<void> {
  log('Shutting down daemon');
  if (server) {
    server.close();
    server = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  process.exit(0);
}

async function ensureBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    log('Launching browser');
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'running',
      pid: process.pid,
      browserConnected: browser?.isConnected() ?? false,
      activeRequests,
      uptime: process.uptime(),
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'shutting_down' }));
    setTimeout(() => shutdown(), 100);
    return;
  }

  if (req.method !== 'POST' || req.url !== '/capture') {
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  activeRequests++;
  if (idleTimer) clearTimeout(idleTimer);

  try {
    const body = await readBody(req);
    const { url, opts } = JSON.parse(body) as { url: string; opts: BcurlOptions };

    log(`Capture request: ${url}`);
    const b = await ensureBrowser();
    const result = await captureWithContext(b, url, opts);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      url: result.url,
      buffer: result.buffer.toString('base64'),
      format: result.format,
      headers: result.headers,
      status: result.status,
      timing: result.timing,
    }));
    log(`Capture complete: ${url} (${result.buffer.length} bytes)`);
  } catch (err: any) {
    log(`Capture error: ${err.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: err.message }));
  } finally {
    activeRequests--;
    resetIdleTimer();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

export async function startDaemon(poolSize?: number, timeout?: number): Promise<void> {
  idleTimeout = (timeout ?? 300) * 1000;

  // Clean up stale socket
  if (existsSync(SOCKET_PATH)) {
    try { unlinkSync(SOCKET_PATH); } catch {}
  }

  // Launch browser eagerly
  await ensureBrowser();

  server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      res.writeHead(500);
      res.end(JSON.stringify({ error: err.message }));
    });
  });

  server.listen(SOCKET_PATH, () => {
    writeFileSync(PID_FILE, String(process.pid));
    log(`Daemon started (pid=${process.pid}, socket=${SOCKET_PATH}, idle=${idleTimeout / 1000}s)`);
    console.error(`bcurl daemon started (pid ${process.pid})`);
    resetIdleTimer();
  });

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

export function isDaemonRunning(): boolean {
  if (!existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0); // Test if process exists
    return existsSync(SOCKET_PATH);
  } catch {
    // Stale PID file
    try { unlinkSync(PID_FILE); } catch {}
    return false;
  }
}

export function getDaemonStatus(): { running: boolean; pid?: number } {
  if (!existsSync(PID_FILE)) return { running: false };
  try {
    const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
    process.kill(pid, 0);
    return { running: true, pid };
  } catch {
    return { running: false };
  }
}

export async function stopDaemon(): Promise<boolean> {
  const status = getDaemonStatus();
  if (!status.running || !status.pid) {
    return false;
  }
  try {
    process.kill(status.pid, 'SIGTERM');
    // Wait for cleanup
    await new Promise((resolve) => setTimeout(resolve, 500));
    return true;
  } catch {
    return false;
  }
}

export async function captureViaDaemon(url: string, opts: BcurlOptions): Promise<CaptureResult> {
  const http = await import('http');

  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({ url, opts });

    const req = http.request(
      {
        socketPath: SOCKET_PATH,
        path: '/capture',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (res.statusCode !== 200) {
              reject(new Error(body.error || `Daemon returned ${res.statusCode}`));
              return;
            }
            resolve({
              url: body.url,
              buffer: Buffer.from(body.buffer, 'base64'),
              format: body.format,
              headers: body.headers,
              status: body.status,
              timing: body.timing,
            });
          } catch (err: any) {
            reject(new Error(`Failed to parse daemon response: ${err.message}`));
          }
        });
      }
    );

    req.on('error', (err) => {
      reject(new Error(`Cannot connect to daemon: ${err.message}`));
    });

    req.write(postData);
    req.end();
  });
}

export function spawnDaemon(poolSize?: number, timeout?: number): void {
  const currentFile = fileURLToPath(import.meta.url);
  const entry = join(dirname(currentFile), 'daemon-entry.js');

  const child = spawn(process.execPath, [entry, String(poolSize ?? DEFAULT_POOL_SIZE), String(timeout ?? 300)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  console.error(`bcurl daemon starting (pid ${child.pid})`);
}
