import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { chromium, type Browser, type Page } from 'playwright';
import { z } from 'zod';
import { NetworkTracker } from './network.js';
import { DEVICES } from './types.js';

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
  return page;
}

async function applyViewport(
  p: Page,
  opts: { device?: string; windowSize?: string; darkMode?: boolean }
): Promise<void> {
  const device = opts.device ? DEVICES[opts.device] : undefined;
  if (opts.windowSize) {
    const [w, h] = opts.windowSize.split('x').map(Number);
    await p.setViewportSize({ width: w, height: h });
  } else if (device) {
    await p.setViewportSize(device.viewport);
  }
  if (opts.darkMode) {
    await p.emulateMedia({ colorScheme: 'dark' });
  }
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
  const server = new McpServer({
    name: 'bcurl',
    version: '2.0.0',
  });

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
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            status: response?.status() ?? 0,
            title,
            url: p.url(),
          }),
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
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ ok: true, url: p.url() }) }],
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
    'Execute JavaScript in the page context and return the result.',
    { code: z.string().describe('JavaScript code to execute') },
    async ({ code }) => {
      const p = await ensurePage();
      const result = await p.evaluate(code);
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

  // ==================== OUTPUT TOOLS ====================

  server.tool(
    'screenshot',
    'Take a screenshot of the current page. Returns a base64-encoded image.',
    {
      format: z.enum(['png', 'jpeg']).optional().describe('Image format (default: png)'),
      quality: z.number().optional().describe('JPEG quality 0-100'),
      fullPage: z.boolean().optional().describe('Capture full scrollable page'),
      selector: z.string().optional().describe('Capture only this CSS element'),
      device: z.string().optional().describe('Emulate device viewport before capture'),
      windowSize: z.string().optional().describe('Viewport WxH (e.g. 1920x1080)'),
      darkMode: z.boolean().optional().describe('Emulate dark mode'),
      hide: z.array(z.string()).optional().describe('CSS selectors of elements to hide'),
    },
    async ({ format, quality, fullPage, selector, device, windowSize, darkMode, hide }) => {
      const p = await ensurePage();
      const fmt = format ?? 'png';

      // Apply viewport changes
      await applyViewport(p, { device, windowSize, darkMode });

      // Hide elements
      if (hide && hide.length > 0) await hideElements(p, hide);

      let buffer: Buffer;
      if (selector) {
        const element = await p.$(selector);
        if (!element) throw new Error(`Selector "${selector}" not found`);
        buffer = await element.screenshot({
          type: fmt,
          quality: fmt === 'jpeg' ? (quality ?? 80) : undefined,
        }) as Buffer;
      } else {
        buffer = await p.screenshot({
          type: fmt,
          quality: fmt === 'jpeg' ? (quality ?? 80) : undefined,
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
    'Get HTML content of the current page or a specific element.',
    {
      selector: z.string().optional().describe('CSS selector (default: entire page)'),
      outer: z.boolean().optional().describe('Return outerHTML instead of innerHTML (default: true)'),
    },
    async ({ selector, outer }) => {
      const p = await ensurePage();
      const useOuter = outer ?? true;

      let html: string;
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

      return {
        content: [{ type: 'text' as const, text: html }],
      };
    }
  );

  server.tool(
    'text',
    'Get visible text content of the current page or a specific element.',
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

  // ==================== START ====================

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Cleanup on exit
  process.on('SIGTERM', async () => {
    if (page && !page.isClosed()) await page.context().close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  });
  process.on('SIGINT', async () => {
    if (page && !page.isClosed()) await page.context().close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    process.exit(0);
  });
}
