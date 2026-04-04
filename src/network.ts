import type { Page, Request, Response } from 'playwright';
import { writeFileSync } from 'fs';

export interface NetworkEntry {
  url: string;
  method: string;
  resourceType: string;
  status: number;
  statusText: string;
  contentType: string;
  size: number;
  startTime: number;
  endTime: number;
  duration: number;
  failed: boolean;
  failureText?: string;
}

export class NetworkTracker {
  private entries: NetworkEntry[] = [];
  private pending = new Map<string, { request: Request; startTime: number }>();
  private responsePromises: Promise<void>[] = [];
  private pageStartTime = 0;

  attach(page: Page): void {
    this.pageStartTime = Date.now();

    page.on('request', (request: Request) => {
      this.pending.set(request.url() + request.method(), {
        request,
        startTime: Date.now() - this.pageStartTime,
      });
    });

    page.on('response', (response: Response) => {
      const p = this.handleResponse(response);
      this.responsePromises.push(p);
    });

    page.on('requestfailed', (request: Request) => {
      const key = request.url() + request.method();
      const pendingEntry = this.pending.get(key);
      const startTime = pendingEntry?.startTime ?? 0;
      const endTime = Date.now() - this.pageStartTime;

      this.entries.push({
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        status: 0,
        statusText: '',
        contentType: '',
        size: 0,
        startTime,
        endTime,
        duration: endTime - startTime,
        failed: true,
        failureText: request.failure()?.errorText,
      });

      this.pending.delete(key);
    });
  }

  private async handleResponse(response: Response): Promise<void> {
    const request = response.request();
    const key = request.url() + request.method();
    const pendingEntry = this.pending.get(key);
    const startTime = pendingEntry?.startTime ?? 0;
    const endTime = Date.now() - this.pageStartTime;

    let size = 0;
    try {
      const body = await response.body();
      size = body.length;
    } catch {
      const contentLength = response.headers()['content-length'];
      if (contentLength) size = parseInt(contentLength, 10);
    }

    this.entries.push({
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
      statusText: response.statusText(),
      contentType: response.headers()['content-type'] ?? '',
      size,
      startTime,
      endTime,
      duration: endTime - startTime,
      failed: response.status() >= 400,
    });

    this.pending.delete(key);
  }

  /** Wait for all async response handlers to complete. */
  async flush(): Promise<void> {
    await Promise.all(this.responsePromises);
    this.responsePromises = [];
  }

  getEntries(filter?: string, errorsOnly?: boolean): NetworkEntry[] {
    let entries = [...this.entries];
    if (filter) {
      const pattern = globToRegex(filter);
      entries = entries.filter((e) => pattern.test(e.url));
    }
    if (errorsOnly) {
      entries = entries.filter((e) => e.failed);
    }
    return entries.sort((a, b) => a.startTime - b.startTime);
  }

  getStats(): { totalRequests: number; totalSize: number; totalTime: number; byType: Record<string, number> } {
    const totalRequests = this.entries.length;
    const totalSize = this.entries.reduce((sum, e) => sum + e.size, 0);
    const totalTime = this.entries.length > 0
      ? Math.max(...this.entries.map((e) => e.endTime))
      : 0;
    const byType: Record<string, number> = {};
    for (const e of this.entries) {
      byType[e.resourceType] = (byType[e.resourceType] ?? 0) + 1;
    }
    return { totalRequests, totalSize, totalTime, byType };
  }

  formatSummary(filter?: string, errorsOnly?: boolean): string {
    const entries = this.getEntries(filter, errorsOnly);
    if (entries.length === 0) return 'No network requests captured.\n';

    const lines: string[] = [];
    const methodWidth = 6;
    const statusWidth = 5;
    const sizeWidth = 10;
    const timeWidth = 8;

    lines.push(
      `${'METHOD'.padEnd(methodWidth)} ${'CODE'.padEnd(statusWidth)} ${'SIZE'.padStart(sizeWidth)} ${'TIME'.padStart(timeWidth)}  URL`
    );
    lines.push('─'.repeat(80));

    for (const e of entries) {
      const method = e.method.padEnd(methodWidth);
      const status = e.failed && e.status === 0
        ? 'FAIL'.padEnd(statusWidth)
        : String(e.status).padEnd(statusWidth);
      const size = formatBytes(e.size).padStart(sizeWidth);
      const time = `${e.duration}ms`.padStart(timeWidth);
      const url = truncateUrl(e.url, 120);
      lines.push(`${method} ${status} ${size} ${time}  ${url}`);
    }

    const stats = this.getStats();
    lines.push('─'.repeat(80));
    lines.push(
      `${stats.totalRequests} requests | ${formatBytes(stats.totalSize)} total | ${stats.totalTime}ms`
    );

    return lines.join('\n') + '\n';
  }

  formatWaterfall(filter?: string): string {
    const entries = this.getEntries(filter);
    if (entries.length === 0) return 'No network requests captured.\n';

    const maxTime = Math.max(...entries.map((e) => e.endTime), 1);
    const barWidth = 40;
    const lines: string[] = [];

    lines.push(
      `${'METHOD'.padEnd(4)} ${'CODE'.padEnd(4)} ${'TIME'.padStart(6)}  ${''.padEnd(barWidth)}  URL`
    );
    lines.push('─'.repeat(100));

    for (const e of entries) {
      const method = e.method.substring(0, 4).padEnd(4);
      const status = e.failed && e.status === 0
        ? 'FAIL'
        : String(e.status).padEnd(4);
      const time = `${e.duration}ms`.padStart(6);

      const startPos = Math.floor((e.startTime / maxTime) * barWidth);
      const endPos = Math.max(startPos + 1, Math.ceil((e.endTime / maxTime) * barWidth));
      const bar = '░'.repeat(startPos) + '█'.repeat(endPos - startPos) + '░'.repeat(Math.max(0, barWidth - endPos));

      const url = truncateUrl(e.url, 60);
      lines.push(`${method} ${status} ${time}  ${bar}  ${url}`);
    }

    lines.push('─'.repeat(100));
    lines.push(`Timeline: 0ms to ${maxTime}ms`);

    return lines.join('\n') + '\n';
  }

  toHAR(): object {
    return {
      log: {
        version: '1.2',
        creator: { name: 'bcurl', version: '1.0.0' },
        entries: this.entries.map((e) => ({
          startedDateTime: new Date(this.pageStartTime + e.startTime).toISOString(),
          time: e.duration,
          request: {
            method: e.method,
            url: e.url,
            httpVersion: 'HTTP/1.1',
            headers: [],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status: e.status,
            statusText: e.statusText,
            httpVersion: 'HTTP/1.1',
            headers: [],
            cookies: [],
            content: {
              size: e.size,
              mimeType: e.contentType,
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: e.size,
          },
          cache: {},
          timings: {
            send: 0,
            wait: e.duration,
            receive: 0,
          },
        })),
      },
    };
  }

  saveHAR(filePath: string): void {
    writeFileSync(filePath, JSON.stringify(this.toHAR(), null, 2));
  }
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function truncateUrl(url: string, maxLen: number): string {
  if (url.length <= maxLen) return url;
  return url.substring(0, maxLen - 3) + '...';
}

function globToRegex(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(escaped);
}
