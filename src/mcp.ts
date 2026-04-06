import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium, type Browser, type Page } from 'playwright';
import { z } from 'zod';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { NetworkTracker } from './network.js';
import { DEVICES } from './types.js';
import {
  requestFields, getCachedSecret, listCachedIds, stopServer,
  logActivity, setPage, ensureDashboard, isDashboardRunning, getDashboardUrl,
  broadcast,
  type PromptField,
} from './dashboard.js';

let browser: Browser | null = null;
let page: Page | null = null;
let tracker: NetworkTracker | null = null;

async function ensureBrowser(): Promise<Browser> {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: true });
  }
  return browser;
}

async function ensurePage(): Promise<Page> {
  if (!page || page.isClosed()) {
    const b = await ensureBrowser();
    const context = await b.newContext({
      viewport: { width: 1280, height: 720 },
    });
    page = await context.newPage();
    tracker = new NetworkTracker();
    tracker.attach(page);
  }
  setPage(page);
  return page;
}

async function applyViewport(
  p: Page,
  opts: { device?: string; windowSize?: string; darkMode?: boolean }
): Promise<Page> {
  const device = opts.device ? DEVICES[opts.device] : undefined;

  // Device emulation requires a new context for userAgent, isMobile, hasTouch, deviceScaleFactor
  if (device) {
    const b = await ensureBrowser();
    const oldContext = p.context();
    const context = await b.newContext({
      viewport: device.viewport,
      userAgent: device.userAgent,
      deviceScaleFactor: device.deviceScaleFactor,
      isMobile: device.isMobile,
      hasTouch: device.hasTouch,
      colorScheme: opts.darkMode ? 'dark' : undefined,
    });
    const newPage = await context.newPage();
    // Transfer URL to new context
    if (p.url() !== 'about:blank') {
      await newPage.goto(p.url(), { waitUntil: 'domcontentloaded', timeout: 30000 });
      await newPage.waitForLoadState('networkidle').catch(() => {});
    }
    await oldContext.close();
    page = newPage;
    tracker = new NetworkTracker();
    tracker.attach(newPage);
    return newPage;
  }

  if (opts.windowSize) {
    const [w, h] = opts.windowSize.split('x').map(Number);
    await p.setViewportSize({ width: w, height: h });
  }
  if (opts.darkMode) {
    await p.emulateMedia({ colorScheme: 'dark' });
  }
  return p;
}

async function hideElements(p: Page, selectors: string[]): Promise<void> {
  for (const sel of selectors) {
    await p.evaluate((s: string) => {
      document.querySelectorAll(s).forEach((el) => {
        (el as HTMLElement).style.display = 'none';
      });
    }, sel);
  }
}

export async function startMcpServer(): Promise<void> {
  const mcpServer = new McpServer({
    name: 'bcurl',
    version: '2.2.0',
  });

  // Wrap server.tool to auto-log every tool call to the dashboard
  const originalTool = mcpServer.tool.bind(mcpServer);
  const server = Object.assign(mcpServer, {
    tool: (...toolArgs: any[]) => {
      // server.tool(name, description, schema, handler) - handler is always last
      const handler = toolArgs[toolArgs.length - 1] as Function;
      const toolName = toolArgs[0] as string;
      // Sensitive args that should be masked in the log
      const sensitiveKeys = new Set(['value', 'password', 'code', 'content']);
      toolArgs[toolArgs.length - 1] = (args: Record<string, unknown>) => {
        if (isDashboardRunning()) {
          const safeArgs: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(args ?? {})) {
            safeArgs[k] = sensitiveKeys.has(k) ? '***' : v;
          }
          logActivity(toolName, Object.keys(safeArgs).length > 0 ? safeArgs : undefined);
        }
        return handler(args);
      };
      return (originalTool as Function)(...toolArgs);
    },
  });

  // ─── Login form auto-detection ───────────────────────────────────

  async function detectLoginForm(p: Page): Promise<null | {
    fields: Array<{ name: string; label: string; selector: string; type: string; guessedRole: string }>;
  }> {
    return p.evaluate(() => {
      const pwInputs = document.querySelectorAll<HTMLInputElement>(
        'input[type="password"]:not([hidden]):not([style*="display:none"])'
      );
      if (pwInputs.length === 0) return null;

      const fields: Array<{ name: string; label: string; selector: string; type: string; guessedRole: string }> = [];

      // For each password field, find the associated username/email field
      for (const pw of pwInputs) {
        const form = pw.closest('form') ?? document.body;

        // Find text/email inputs in the same form BEFORE the password field
        const allInputs = Array.from(form.querySelectorAll<HTMLInputElement>(
          'input[type="text"], input[type="email"], input[type="tel"], input:not([type])'
        )).filter(el => {
          const style = getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && el.offsetParent !== null;
        });

        // Pick the input closest before the password field in DOM order
        const formInputs = Array.from(form.querySelectorAll('input'));
        const pwIndex = formInputs.indexOf(pw);
        const candidates = allInputs.filter(el => formInputs.indexOf(el) < pwIndex);
        const userInput = candidates[candidates.length - 1]; // last one before password

        if (userInput) {
          const uid = userInput.id || userInput.name || userInput.placeholder || 'username';
          const uType = userInput.type === 'email' ? 'email' : 'text';
          const uSelector = userInput.id
            ? `#${userInput.id}`
            : userInput.name
            ? `input[name="${userInput.name}"]`
            : `input[placeholder="${userInput.placeholder}"]`;

          fields.push({
            name: 'username',
            label: userInput.placeholder || userInput.getAttribute('aria-label') || 'Username / E-Mail',
            selector: uSelector,
            type: uType,
            guessedRole: 'username',
          });
        }

        const pwSelector = pw.id
          ? `#${pw.id}`
          : pw.name
          ? `input[name="${pw.name}"]`
          : 'input[type="password"]';

        fields.push({
          name: 'password',
          label: pw.placeholder || pw.getAttribute('aria-label') || 'Passwort',
          selector: pwSelector,
          type: 'password',
          guessedRole: 'password',
        });
      }

      // Check for TOTP fields (usually 6-digit code inputs)
      const otpInputs = document.querySelectorAll<HTMLInputElement>(
        'input[autocomplete="one-time-code"], input[name*="otp"], input[name*="totp"], input[name*="2fa"], input[name*="mfa"], input[inputmode="numeric"][maxlength="6"]'
      );
      for (const otp of otpInputs) {
        const otpSelector = otp.id ? `#${otp.id}` : otp.name ? `input[name="${otp.name}"]` : 'input[autocomplete="one-time-code"]';
        fields.push({
          name: 'totp',
          label: otp.placeholder || '2FA Code',
          selector: otpSelector,
          type: 'totp',
          guessedRole: 'totp',
        });
      }

      return fields.length > 0 ? { fields } : null;
    });
  }

  // Add login_form_detected hint to navigate/click responses
  async function withLoginDetection(p: Page, result: Record<string, unknown>): Promise<Record<string, unknown>> {
    try {
      const detected = await detectLoginForm(p);
      if (detected) {
        if (isDashboardRunning()) {
          broadcast({ type: 'login_detected', data: detected });
        }
        return { ...result, login_form_detected: detected };
      }
    } catch {}
    return result;
  }

  // ==================== NAVIGATION TOOLS ====================

  server.tool(
    'navigate',
    'Navigate to a URL. Returns page status, title, and final URL.',
    { url: z.string().describe('URL to navigate to') },
    async ({ url }) => {
      const p = await ensurePage();
      const normalizedUrl = url.includes('://') ? url : `https://${url}`;
      const response = await p.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForLoadState('networkidle').catch(() => {});
      const title = await p.title();
      const result = await withLoginDetection(p, {
        status: response?.status() ?? 0,
        title,
        url: p.url(),
      });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result),
        }],
      };
    }
  );

  server.tool(
    'click',
    'Click an element by CSS selector. Supports Playwright extended selectors like button:text-is("Login").',
    { selector: z.string().describe('CSS selector of element to click') },
    async ({ selector }) => {
      const p = await ensurePage();
      await p.click(selector, { timeout: 10000 });
      await p.waitForLoadState('networkidle').catch(() => {});
      const result = await withLoginDetection(p, { ok: true, url: p.url() });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify(result) }],
      };
    }
  );

  server.tool(
    'fill',
    'Fill a form field with a value.',
    {
      selector: z.string().describe('CSS selector of the input field'),
      value: z.string().describe('Value to fill in'),
    },
    async ({ selector, value }) => {
      const p = await ensurePage();
      await p.fill(selector, value, { timeout: 10000 });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  server.tool(
    'select',
    'Select an option from a dropdown.',
    {
      selector: z.string().describe('CSS selector of the select element'),
      value: z.string().describe('Option value to select'),
    },
    async ({ selector, value }) => {
      const p = await ensurePage();
      await p.selectOption(selector, value, { timeout: 10000 });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  server.tool(
    'hover',
    'Hover over an element.',
    { selector: z.string().describe('CSS selector of element to hover') },
    async ({ selector }) => {
      const p = await ensurePage();
      await p.hover(selector, { timeout: 10000 });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  server.tool(
    'press',
    'Press a keyboard key.',
    { key: z.string().describe('Key to press (e.g. Enter, Tab, Escape, ArrowDown)') },
    async ({ key }) => {
      const p = await ensurePage();
      await p.keyboard.press(key);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  server.tool(
    'evaluate',
    'Execute JavaScript in the page context and return the result. Supports top-level await (e.g. `await fetch(...)`). For multiple statements with await, use `return` to return the final value.',
    { code: z.string().describe('JavaScript code to execute (supports top-level await)') },
    async ({ code }) => {
      const p = await ensurePage();
      let wrappedCode = code;
      if (code.includes('await')) {
        const hasMultipleStatements = code.includes(';') || code.trim().includes('\n');
        if (hasMultipleStatements) {
          wrappedCode = `(async () => { ${code} })()`;
        } else {
          wrappedCode = `(async () => { return ${code} })()`;
        }
      }
      const result = await p.evaluate(wrappedCode);
      return {
        content: [{
          type: 'text' as const,
          text: typeof result === 'string' ? result : JSON.stringify(result, null, 2),
        }],
      };
    }
  );

  server.tool(
    'wait_for',
    'Wait for an element to appear on the page.',
    {
      selector: z.string().describe('CSS selector to wait for'),
      timeout: z.number().optional().describe('Timeout in ms (default 30000)'),
    },
    async ({ selector, timeout }) => {
      const p = await ensurePage();
      await p.waitForSelector(selector, { timeout: timeout ?? 30000 });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  server.tool(
    'wait',
    'Wait for a specified number of milliseconds.',
    { ms: z.number().describe('Milliseconds to wait') },
    async ({ ms }) => {
      const p = await ensurePage();
      await p.waitForTimeout(ms);
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  server.tool(
    'back',
    'Navigate back in browser history.',
    {},
    async () => {
      const p = await ensurePage();
      await p.goBack({ waitUntil: 'networkidle' });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, url: p.url() }) }],
      };
    }
  );

  server.tool(
    'forward',
    'Navigate forward in browser history.',
    {},
    async () => {
      const p = await ensurePage();
      await p.goForward({ waitUntil: 'networkidle' });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, url: p.url() }) }],
      };
    }
  );

  server.tool(
    'reload',
    'Reload the current page.',
    {},
    async () => {
      const p = await ensurePage();
      await p.reload({ waitUntil: 'networkidle' });
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, url: p.url() }) }],
      };
    }
  );

  server.tool(
    'scroll',
    'Scroll to an element or by pixel amount.',
    {
      selector: z.string().optional().describe('CSS selector to scroll to'),
      y: z.number().optional().describe('Pixels to scroll vertically (positive = down)'),
    },
    async ({ selector, y }) => {
      const p = await ensurePage();
      if (selector) {
        await p.evaluate((sel: string) => {
          document.querySelector(sel)?.scrollIntoView({ behavior: 'instant', block: 'start' });
        }, selector);
      } else if (y !== undefined) {
        await p.evaluate((pixels: number) => window.scrollBy(0, pixels), y);
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  server.tool(
    'upload',
    'Upload a file to a file input element. Provide either a file path or base64-encoded content.',
    {
      selector: z.string().describe('CSS selector of the file input element'),
      path: z.string().optional().describe('Absolute path to the file to upload'),
      content: z.string().optional().describe('Base64-encoded file content (requires filename)'),
      filename: z.string().optional().describe('Filename (required when using content)'),
      mimeType: z.string().optional().describe('MIME type (default: application/octet-stream, only with content)'),
    },
    async ({ selector, path, content, filename, mimeType }) => {
      const p = await ensurePage();
      if (path) {
        await p.setInputFiles(selector, path, { timeout: 10000 });
      } else if (content && filename) {
        const buffer = Buffer.from(content, 'base64');
        await p.setInputFiles(selector, { name: filename, mimeType: mimeType ?? 'application/octet-stream', buffer }, { timeout: 10000 });
      } else {
        throw new Error('Either path or content+filename must be provided');
      }
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
      };
    }
  );

  // ==================== CONVENIENCE TOOLS ====================

  server.tool(
    'login',
    'Convenience tool: navigate to a login page, fill credentials, submit, and wait for navigation. Handles the full form-fill+click+wait flow in one call.',
    {
      url: z.string().describe('Login page URL'),
      username: z.object({
        selector: z.string().describe('CSS selector for username/email field'),
        value: z.string().describe('Username/email value'),
      }),
      password: z.object({
        selector: z.string().describe('CSS selector for password field'),
        value: z.string().describe('Password value'),
      }),
      submit: z.string().optional().describe('CSS selector for submit button (default: auto-detect)'),
      waitFor: z.string().optional().describe('CSS selector to wait for after login to confirm success'),
    },
    async ({ url, username, password, submit, waitFor }) => {
      const p = await ensurePage();
      const normalizedUrl = url.includes('://') ? url : `https://${url}`;
      await p.goto(normalizedUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForLoadState('networkidle').catch(() => {});

      await p.fill(username.selector, username.value, { timeout: 10000 });
      await p.fill(password.selector, password.value, { timeout: 10000 });

      if (submit) {
        await p.click(submit, { timeout: 10000 });
      } else {
        const commonSelectors = [
          'button[type="submit"]',
          'input[type="submit"]',
          'button:text-is("Login")',
          'button:text-is("Sign in")',
          'button:text-is("Log in")',
          'button:text-is("Anmelden")',
        ];
        let clicked = false;
        for (const sel of commonSelectors) {
          try {
            await p.click(sel, { timeout: 2000 });
            clicked = true;
            break;
          } catch { /* try next */ }
        }
        if (!clicked) await p.keyboard.press('Enter');
      }

      await p.waitForLoadState('networkidle').catch(() => {});
      if (waitFor) await p.waitForSelector(waitFor, { timeout: 10000 });

      const title = await p.title();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ ok: true, url: p.url(), title }),
        }],
      };
    }
  );

  server.tool(
    'assert',
    'Assert that elements, text, URL, or title match expectations. Returns pass/fail for each check — ideal for QA verification.',
    {
      checks: z.array(z.object({
        type: z.enum(['element', 'text', 'url', 'title']).describe('What to check'),
        value: z.string().describe('Selector (element), substring (text), or pattern (url/title)'),
        absent: z.boolean().optional().describe('Assert that it should NOT be present (default: false)'),
      })).describe('List of assertions to check'),
    },
    async ({ checks }) => {
      const p = await ensurePage();
      const results = [];
      let allPassed = true;

      for (const check of checks) {
        let passed = false;
        let detail = '';

        switch (check.type) {
          case 'element': {
            const el = await p.$(check.value);
            const found = el !== null;
            passed = check.absent ? !found : found;
            detail = found ? 'found' : 'not found';
            break;
          }
          case 'text': {
            const bodyText = await p.evaluate(() => document.body.innerText);
            const found = bodyText.includes(check.value);
            passed = check.absent ? !found : found;
            detail = found ? 'found in page' : 'not found in page';
            break;
          }
          case 'url': {
            const currentUrl = p.url();
            const found = currentUrl.includes(check.value) || new RegExp(check.value).test(currentUrl);
            passed = check.absent ? !found : found;
            detail = `current: ${currentUrl}`;
            break;
          }
          case 'title': {
            const title = await p.title();
            const found = title.includes(check.value) || new RegExp(check.value).test(title);
            passed = check.absent ? !found : found;
            detail = `current: ${title}`;
            break;
          }
        }

        if (!passed) allPassed = false;
        results.push({ ...check, passed, detail });
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ passed: allPassed, total: checks.length, failed: results.filter(r => !r.passed).length, results }, null, 2),
        }],
      };
    }
  );

  // ==================== DASHBOARD & SECRET TOOLS ====================

  server.tool(
    'dashboard',
    'Open the live dashboard. Returns a URL the user can open to watch the browser in real-time ' +
    'and provide input when needed (passwords, 2FA codes). The dashboard stays open for the session.',
    {},
    async () => {
      await ensurePage(); // ensure page ref is set
      const url = await ensureDashboard();
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ url, message: `Dashboard verfügbar: ${url}` }),
        }],
      };
    }
  );

  // Pending fill promise — fill_form stores it, wait_for_secret awaits it
  let pendingFill: Promise<string> | null = null;

  server.tool(
    'fill_form',
    'Ask the user to provide form values (username, password, 2FA, etc.) via the live dashboard, then fill them into the page. ' +
    'Supports multiple fields at once. Each field has a name, label, type, CSS selector, and a secret flag. ' +
    'Non-secret fields (like username) are shown as plain text. Secret fields are masked. ' +
    'Secret fields are cached by id for the session (except TOTP). ' +
    'If all secret fields are cached, fills immediately without prompting. ' +
    'Otherwise returns the dashboard URL — the user opens it and submits the form. Then call wait_for_secret.',
    {
      id: z.string().describe('Credential identifier (e.g. "github"). Used for session caching.'),
      fields: z.array(z.object({
        name: z.string().describe('Field key, e.g. "username", "password", "totp"'),
        label: z.string().describe('Human-readable label shown to user, e.g. "GitHub Username"'),
        selector: z.string().describe('CSS selector of the input field on the page'),
        type: z.enum(['text', 'password', 'totp']).optional().describe('Input type (default: text)'),
        secret: z.boolean().optional().describe('Is this a secret value? Secrets are masked and cached. Default: true for password/totp, false for text.'),
        value: z.string().optional().describe('Value for non-secret fields (e.g. username/email). The agent can provide this directly. Secret fields MUST NOT have a value — they are entered by the user via the dashboard.'),
      })).describe('Fields to fill. Non-secret fields like username can include a value directly. Secret fields are entered by the user. Example: [{name:"user", label:"Username", selector:"#login", type:"text", secret:false, value:"chris@example.com"}, {name:"pass", label:"Password", selector:"#password", type:"password"}]'),
    },
    async ({ id, fields }) => {
      const p = await ensurePage();

      // Normalize fields: default secret based on type
      const normalized = fields.map(f => ({
        ...f,
        type: f.type ?? 'text' as const,
        secret: f.secret ?? (f.type === 'password' || f.type === 'totp'),
      }));

      // Resolve known values: agent-provided values for non-secrets + cached secrets
      const knownValues: Record<string, string> = {};
      const needsInput: typeof normalized = []; // fields the user must fill via dashboard

      for (const f of normalized) {
        // Non-secret with value provided by agent → fill directly
        if (!f.secret && f.value !== undefined) {
          knownValues[f.name] = f.value;
          continue;
        }
        // Secret (non-totp) that's cached → use cache
        if (f.secret && f.type !== 'totp') {
          const cached = getCachedSecret(id, f.name);
          if (cached !== undefined) {
            knownValues[f.name] = cached;
            continue;
          }
        }
        // Everything else needs user input via dashboard
        needsInput.push(f);
      }

      // If nothing needs user input, fill everything immediately
      if (needsInput.length === 0) {
        for (const f of normalized) {
          const val = knownValues[f.name];
          if (val !== undefined) {
            await p.fill(f.selector, val, { timeout: 10000 });
          }
        }
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, cached: true, filled: Object.keys(knownValues) }) }],
        };
      }

      // Build prompt fields for dashboard
      const promptFields: PromptField[] = needsInput
        .map(f => ({ name: f.name, label: f.label, type: f.type as 'text' | 'password' | 'totp', secret: f.secret }));

      const { dashboardUrl, promise } = await requestFields(p, id, promptFields);

      // Store fill promise
      pendingFill = (async () => {
        const userValues = await promise;
        // Merge all values, then fill every field
        const allValues = { ...knownValues, ...userValues };
        for (const f of normalized) {
          const val = allValues[f.name];
          if (val !== undefined) {
            await p.fill(f.selector, val, { timeout: 10000 });
          }
        }
        return JSON.stringify({ ok: true, filled: Object.keys(allValues) });
      })();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            action: 'waiting_for_user',
            dashboard: dashboardUrl,
            message: `Bitte Dashboard öffnen und Eingaben machen: ${dashboardUrl}`,
            fields_requested: promptFields.map(f => f.name),
          }),
        }],
      };
    }
  );

  server.tool(
    'wait_for_secret',
    'Wait for the user to submit values via the dashboard. Call this after fill_form returned a dashboard URL. Blocks until the user has submitted and all fields are filled.',
    {
      timeout: z.number().optional().describe('Timeout in ms (default: 120000 = 2 minutes)'),
    },
    async ({ timeout }) => {
      const timeoutMs = timeout ?? 120000;
      if (!pendingFill) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, message: 'No pending request' }) }],
        };
      }
      try {
        const result = await Promise.race([
          pendingFill,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('Timeout waiting for user input')), timeoutMs)
          ),
        ]);
        pendingFill = null;
        return {
          content: [{ type: 'text' as const, text: result }],
        };
      } catch (err: any) {
        pendingFill = null;
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: err.message }) }],
        };
      }
    }
  );

  server.tool(
    'list_secrets',
    'List secret IDs that are cached in the current session. Returns only IDs, never values.',
    {},
    async () => {
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ cached: listCachedIds() }),
        }],
      };
    }
  );

  // ==================== OUTPUT TOOLS ====================

  server.tool(
    'screenshot',
    'Take a screenshot of the current page. Returns a base64-encoded image. ' +
    'EXPENSIVE: uses significant context. Prefer the text tool for reading page content. ' +
    'Only use screenshot when you need to verify visual layout, check images, or debug rendering.',
    {
      format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: jpeg)'),
      quality: z.number().optional().describe('JPEG quality 0-100 (default: 40)'),
      fullPage: z.boolean().optional().describe('Capture full scrollable page'),
      selector: z.string().optional().describe('Capture only this CSS element'),
      device: z.string().optional().describe('Emulate device viewport before capture'),
      windowSize: z.string().optional().describe('Viewport WxH (e.g. 1920x1080)'),
      darkMode: z.boolean().optional().describe('Emulate dark mode'),
      hide: z.array(z.string()).optional().describe('CSS selectors of elements to hide'),
    },
    async ({ format, quality, fullPage, selector, device, windowSize, darkMode, hide }) => {
      let p = await ensurePage();
      const fmt = format ?? 'jpeg';
      const q = quality ?? 40;

      // Apply viewport changes (may create new context for device emulation)
      p = await applyViewport(p, { device, windowSize, darkMode });

      // Hide elements
      if (hide && hide.length > 0) await hideElements(p, hide);

      let buffer: Buffer;
      if (selector) {
        const element = await p.$(selector);
        if (!element) throw new Error(`Selector "${selector}" not found`);
        buffer = await element.screenshot({
          type: fmt,
          quality: fmt === 'jpeg' ? q : undefined,
        }) as Buffer;
      } else {
        buffer = await p.screenshot({
          type: fmt,
          quality: fmt === 'jpeg' ? q : undefined,
          fullPage: fullPage ?? false,
        }) as Buffer;
      }

      return {
        content: [{
          type: 'image' as const,
          data: buffer.toString('base64'),
          mimeType: `image/${fmt}`,
        }],
      };
    }
  );

  server.tool(
    'html',
    'Get HTML content of the current page or a specific element. ' +
    'Use compact: true to get a stripped-down version (no scripts, styles, SVGs, comments, data attributes) — ' +
    'ideal for understanding page structure and finding selectors with minimal context usage.',
    {
      selector: z.string().optional().describe('CSS selector (default: entire page)'),
      outer: z.boolean().optional().describe('Return outerHTML instead of innerHTML (default: true)'),
      compact: z.boolean().optional().describe('Strip scripts, styles, SVGs, comments, hidden elements, data-* attributes. Returns only structural/interactive HTML (default: false)'),
    },
    async ({ selector, outer, compact }) => {
      const p = await ensurePage();
      const useOuter = outer ?? true;
      const useCompact = compact ?? false;

      let html: string;
      if (useCompact) {
        html = await p.evaluate(({ sel }: { sel: string | undefined }) => {
          const root = sel ? document.querySelector(sel) : document.body;
          if (!root) return `<!-- Element "${sel}" not found -->`;

          const clone = root.cloneNode(true) as HTMLElement;

          // Remove non-content elements
          const removeSelectors = [
            'script', 'style', 'link[rel="stylesheet"]', 'noscript',
            'svg', 'iframe', 'video', 'audio', 'canvas', 'map',
            'template', '[hidden]', '[aria-hidden="true"]',
          ];
          for (const sel of removeSelectors) {
            clone.querySelectorAll(sel).forEach(el => el.remove());
          }

          // Remove elements hidden via inline style
          clone.querySelectorAll('[style]').forEach(el => {
            const s = (el as HTMLElement).style;
            if (s.display === 'none' || s.visibility === 'hidden' || s.opacity === '0') {
              el.remove();
            }
          });

          // Remove comments
          const walker = document.createTreeWalker(clone, NodeFilter.SHOW_COMMENT);
          const comments: Comment[] = [];
          while (walker.nextNode()) comments.push(walker.currentNode as Comment);
          comments.forEach(c => c.remove());

          // Clean attributes: keep only meaningful ones
          const keepAttrs = new Set([
            'href', 'src', 'alt', 'title', 'name', 'id', 'class',
            'type', 'value', 'placeholder', 'action', 'method',
            'for', 'role', 'aria-label', 'aria-expanded', 'aria-selected',
            'checked', 'disabled', 'readonly', 'selected', 'required',
            'min', 'max', 'maxlength', 'pattern', 'target',
          ]);
          clone.querySelectorAll('*').forEach(el => {
            const toRemove: string[] = [];
            for (const attr of el.attributes) {
              if (!keepAttrs.has(attr.name)) toRemove.push(attr.name);
            }
            toRemove.forEach(a => el.removeAttribute(a));
          });

          // Remove empty containers (divs/spans with no text and no interactive children)
          const interactive = new Set(['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'FORM', 'IMG']);
          function pruneEmpty(el: Element): boolean {
            // Prune children first (bottom-up)
            for (const child of Array.from(el.children)) {
              pruneEmpty(child);
            }
            // Keep interactive elements, elements with text, or meaningful tags
            if (interactive.has(el.tagName)) return false;
            if (['H1','H2','H3','H4','H5','H6','P','LI','TH','TD','LABEL','NAV','MAIN','HEADER','FOOTER','ARTICLE','SECTION'].includes(el.tagName)) return false;
            // Remove if no text content and no interactive descendants
            const hasText = el.textContent?.trim();
            const hasInteractive = el.querySelector(Array.from(interactive).join(','));
            if (!hasText && !hasInteractive) {
              el.remove();
              return true;
            }
            return false;
          }
          pruneEmpty(clone);

          // Collapse whitespace in output
          return clone.innerHTML
            .replace(/\n\s*\n/g, '\n')
            .replace(/^\s+$/gm, '')
            .trim();
        }, { sel: selector });
      } else {
        if (selector) {
          html = await p.evaluate(
            ({ sel, out }: { sel: string; out: boolean }) => {
              const el = document.querySelector(sel);
              if (!el) return `<!-- Element "${sel}" not found -->`;
              return out ? el.outerHTML : el.innerHTML;
            },
            { sel: selector, out: useOuter }
          );
        } else {
          html = await p.evaluate((out: boolean) => {
            return out ? document.documentElement.outerHTML : document.body.innerHTML;
          }, useOuter);
        }
      }

      return {
        content: [{ type: 'text' as const, text: html }],
      };
    }
  );

  server.tool(
    'text',
    'Get visible text content of the current page or a specific element. ' +
    'PREFERRED over screenshot for reading page content — much faster and uses far less context. ' +
    'Use this for navigation decisions, reading data, checking results. Only use screenshot when you need to see visual layout.',
    {
      selector: z.string().optional().describe('CSS selector (default: body)'),
    },
    async ({ selector }) => {
      const p = await ensurePage();
      const text = await p.evaluate((sel: string) => {
        const el = sel ? document.querySelector(sel) : document.body;
        return (el as HTMLElement)?.innerText ?? '';
      }, selector ?? 'body');

      return {
        content: [{ type: 'text' as const, text }],
      };
    }
  );

  server.tool(
    'pdf',
    'Generate a PDF of the current page. Returns base64-encoded PDF.',
    {
      format: z.string().optional().describe('Page format: A4, Letter, etc. (default: A4)'),
      printBackground: z.boolean().optional().describe('Include background graphics (default: true)'),
    },
    async ({ format, printBackground }) => {
      const p = await ensurePage();
      const buffer = await p.pdf({
        format: (format as any) ?? 'A4',
        printBackground: printBackground ?? true,
      });
      return {
        content: [{
          type: 'resource' as const,
          resource: {
            uri: 'data:application/pdf;base64,' + buffer.toString('base64'),
            mimeType: 'application/pdf',
            text: buffer.toString('base64'),
          },
        }],
      };
    }
  );

  server.tool(
    'network',
    'Get the network request log for the current page.',
    {
      filter: z.string().optional().describe('URL pattern filter (glob)'),
      errorsOnly: z.boolean().optional().describe('Show only failed requests'),
    },
    async ({ filter, errorsOnly }) => {
      if (!tracker) {
        return {
          content: [{ type: 'text' as const, text: 'No network data available. Navigate to a page first.' }],
        };
      }
      await tracker.flush();
      const summary = tracker.formatSummary(filter, errorsOnly);
      return {
        content: [{ type: 'text' as const, text: summary }],
      };
    }
  );

  // ==================== SESSION TOOLS ====================

  server.tool(
    'new_context',
    'Create a fresh browser context (clears cookies, localStorage, etc.). Optionally configure viewport and device emulation.',
    {
      device: z.string().optional().describe(`Device to emulate: ${Object.keys(DEVICES).join(', ')}`),
      windowSize: z.string().optional().describe('Viewport WxH (e.g. 1920x1080)'),
      locale: z.string().optional().describe('Locale (e.g. de-DE)'),
      timezone: z.string().optional().describe('Timezone (e.g. Europe/Berlin)'),
      darkMode: z.boolean().optional().describe('Dark color scheme'),
      ignoreHTTPSErrors: z.boolean().optional().describe('Ignore SSL errors'),
    },
    async ({ device: deviceName, windowSize, locale, timezone, darkMode, ignoreHTTPSErrors }) => {
      // Close existing
      if (page && !page.isClosed()) {
        const ctx = page.context();
        await page.close();
        await ctx.close();
      }

      const b = await ensureBrowser();
      const device = deviceName ? DEVICES[deviceName] : undefined;
      const viewport = windowSize
        ? { width: parseInt(windowSize.split('x')[0]), height: parseInt(windowSize.split('x')[1]) }
        : device?.viewport ?? { width: 1280, height: 720 };

      const context = await b.newContext({
        viewport,
        userAgent: device?.userAgent,
        deviceScaleFactor: device?.deviceScaleFactor ?? 1,
        isMobile: device?.isMobile ?? false,
        hasTouch: device?.hasTouch ?? false,
        locale,
        timezoneId: timezone,
        colorScheme: darkMode ? 'dark' : undefined,
        ignoreHTTPSErrors: ignoreHTTPSErrors ?? false,
      });

      page = await context.newPage();
      tracker = new NetworkTracker();
      tracker.attach(page);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            viewport,
            device: deviceName ?? 'desktop',
          }),
        }],
      };
    }
  );

  server.tool(
    'cookies',
    'Get or set cookies for the current browser context.',
    {
      action: z.enum(['get', 'set', 'clear']).describe('Action to perform'),
      cookies: z.array(z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string().optional(),
        path: z.string().optional(),
      })).optional().describe('Cookies to set (only for action=set)'),
    },
    async ({ action, cookies }) => {
      const p = await ensurePage();
      const context = p.context();

      if (action === 'get') {
        const all = await context.cookies();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(all, null, 2) }],
        };
      }
      if (action === 'set' && cookies) {
        await context.addCookies(cookies.map((c) => ({ ...c, url: p.url() })));
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, count: cookies.length }) }],
        };
      }
      if (action === 'clear') {
        await context.clearCookies();
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: true }) }],
        };
      }

      return { content: [{ type: 'text' as const, text: 'Invalid action' }] };
    }
  );

  server.tool(
    'save_session',
    'Save the current browser session (cookies, localStorage) to a file. ' +
    'Can be restored later with load_session, even across bcurl restarts. ' +
    'Does NOT save secrets — those stay only in memory.',
    {
      path: z.string().describe('File path to save session to (e.g. ~/.bcurl/sessions/github.json)'),
    },
    async ({ path: filePath }) => {
      const p = await ensurePage();
      const browserState = await p.context().storageState();

      const session = {
        version: 1,
        savedAt: new Date().toISOString(),
        url: p.url(),
        browserState,
      };

      writeFileSync(filePath, JSON.stringify(session, null, 2), { mode: 0o600 });

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            path: filePath,
            cookies: browserState.cookies.length,
            origins: browserState.origins.length,
          }),
        }],
      };
    }
  );

  server.tool(
    'load_session',
    'Restore a previously saved browser session (cookies, localStorage) from a file. ' +
    'Creates a new browser context with the saved state. Secrets are NOT restored — they must be re-entered.',
    {
      path: z.string().describe('File path to load session from'),
      navigate: z.boolean().optional().describe('Navigate to the URL that was active when saved (default: false)'),
    },
    async ({ path: filePath, navigate: nav }) => {
      if (!existsSync(filePath)) {
        return {
          content: [{ type: 'text' as const, text: JSON.stringify({ ok: false, error: 'File not found: ' + filePath }) }],
        };
      }

      const raw = readFileSync(filePath, 'utf8');
      const session = JSON.parse(raw);

      // Close existing context
      if (page && !page.isClosed()) {
        const ctx = page.context();
        await page.close();
        await ctx.close();
      }

      const b = await ensureBrowser();
      const context = await b.newContext({
        viewport: { width: 1280, height: 720 },
        storageState: session.browserState,
      });
      page = await context.newPage();
      tracker = new NetworkTracker();
      tracker.attach(page);
      setPage(page);

      // Optionally navigate to saved URL
      if (nav && session.url && session.url !== 'about:blank') {
        await page.goto(session.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForLoadState('networkidle').catch(() => {});
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ok: true,
            savedAt: session.savedAt,
            url: session.url,
            cookies: session.browserState?.cookies?.length ?? 0,
            navigated: nav ?? false,
          }),
        }],
      };
    }
  );

  // ==================== START ====================

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on('SIGTERM', async () => {
    stopServer();
    if (page && !page.isClosed()) await page.context().close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    stopServer();
    if (page && !page.isClosed()) await page.context().close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  });
}
