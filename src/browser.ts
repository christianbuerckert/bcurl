import { chromium, type Browser, type BrowserContext, type Page, type Route } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { BcurlOptions, CaptureResult, DEVICES } from './types.js';

interface PageTiming {
  dns?: number;
  connect?: number;
  ttfb?: number;
  domLoaded?: number;
  loaded?: number;
  total: number;
}

function parseViewport(windowSize?: string): { width: number; height: number } | undefined {
  if (!windowSize) return undefined;
  const [w, h] = windowSize.split('x').map(Number);
  return { width: w, height: h };
}

function parseGeolocation(geo?: string): { latitude: number; longitude: number } | undefined {
  if (!geo) return undefined;
  const [lat, lng] = geo.split(',').map(Number);
  if (isNaN(lat) || isNaN(lng)) return undefined;
  return { latitude: lat, longitude: lng };
}

function buildPostData(opts: BcurlOptions): { body?: string; contentType?: string } {
  // --json takes priority
  if (opts.json && opts.json.length > 0) {
    return {
      body: opts.json.join(''),
      contentType: 'application/json',
    };
  }

  const allData: string[] = [
    ...(opts.data ?? []),
    ...(opts.dataRaw ?? []),
  ];

  if (opts.dataUrlencode && opts.dataUrlencode.length > 0) {
    const encoded = opts.dataUrlencode.map((d) => {
      if (d.includes('=')) {
        const [key, ...rest] = d.split('=');
        return `${encodeURIComponent(key)}=${encodeURIComponent(rest.join('='))}`;
      }
      return encodeURIComponent(d);
    });
    allData.push(...encoded);
  }

  if (allData.length > 0) {
    return {
      body: allData.join('&'),
      contentType: 'application/x-www-form-urlencoded',
    };
  }

  return {};
}

export async function launchAndCapture(url: string, opts: BcurlOptions): Promise<CaptureResult> {
  const startTime = Date.now();

  // --- Build browser launch options ---
  const launchOpts: Parameters<typeof chromium.launch>[0] = {
    headless: true,
  };

  if (opts.proxy) {
    const proxyUrl = opts.proxy.includes('://') ? opts.proxy : `http://${opts.proxy}`;
    launchOpts.proxy = {
      server: proxyUrl,
      username: opts.proxyUser?.split(':')[0],
      password: opts.proxyUser?.split(':').slice(1).join(':'),
    };
  }

  const browser: Browser = await chromium.launch(launchOpts);

  try {
    // --- Build context options ---
    const device = opts.device ? DEVICES[opts.device] : undefined;
    const viewport = parseViewport(opts.windowSize)
      ?? device?.viewport
      ?? { width: 1280, height: 720 };

    // Load session state (--session or --load-session)
    const sessionLoadPath = opts.loadSession ?? (opts.session && existsSync(opts.session) ? opts.session : undefined);
    let storageState: string | undefined;
    if (sessionLoadPath && existsSync(sessionLoadPath)) {
      storageState = sessionLoadPath;
    }

    const contextOpts: Parameters<Browser['newContext']>[0] = {
      viewport,
      ignoreHTTPSErrors: opts.insecure ?? false,
      userAgent: opts.userAgent ?? device?.userAgent,
      deviceScaleFactor: device?.deviceScaleFactor ?? 1,
      isMobile: device?.isMobile ?? false,
      hasTouch: device?.hasTouch ?? false,
      javaScriptEnabled: opts.noJavascript ? false : true,
      locale: opts.locale,
      timezoneId: opts.timezone,
      colorScheme: opts.darkMode ? 'dark' : undefined,
      geolocation: parseGeolocation(opts.geolocation),
      permissions: opts.geolocation ? ['geolocation'] : undefined,
      storageState,
    };

    // Extra HTTP headers (from -H flags + auth + referer)
    const extraHeaders: Record<string, string> = { ...(opts.extraHttpHeaders ?? {}) };
    if (opts.referer) {
      extraHeaders['Referer'] = opts.referer;
    }
    if (opts.user) {
      const encoded = Buffer.from(opts.user).toString('base64');
      extraHeaders['Authorization'] = `Basic ${encoded}`;
    }
    if (opts.oauth2Bearer) {
      extraHeaders['Authorization'] = `Bearer ${opts.oauth2Bearer}`;
    }
    if (Object.keys(extraHeaders).length > 0) {
      contextOpts.extraHTTPHeaders = extraHeaders;
    }

    const context: BrowserContext = await browser.newContext(contextOpts);

    // Set cookies from -b flag
    if (opts.cookie && opts.cookie.length > 0) {
      const cookies = parseCookieStrings(opts.cookie, url);
      if (cookies.length > 0) {
        await context.addCookies(cookies);
      }
    }

    // Emulate media type
    const page: Page = await context.newPage();

    if (opts.emulateMedia) {
      await page.emulateMedia({ media: opts.emulateMedia as 'screen' | 'print' });
    }
    if (opts.darkMode && !opts.emulateMedia) {
      await page.emulateMedia({ colorScheme: 'dark' });
    }

    // Block images if requested
    if (opts.blockImages || opts.noImages) {
      await page.route('**/*', (route: Route) => {
        if (route.request().resourceType() === 'image') {
          return route.abort();
        }
        return route.continue();
      });
    }

    // --- Form Login (pre-step) ---
    const timeout = opts.maxTime ? opts.maxTime * 1000 : 30000;

    if (opts.formLogin) {
      const loginUrl = opts.formLogin.includes('://') ? opts.formLogin : `https://${opts.formLogin}`;
      await page.goto(loginUrl, { waitUntil: 'networkidle', timeout });

      // Fill form fields
      if (opts.formField && opts.formField.length > 0) {
        for (const field of opts.formField) {
          const { selector, value } = parseFormField(field);
          await page.fill(selector, value);
        }
      }

      // Submit the form
      if (opts.formSubmit) {
        const currentUrl = page.url();
        await page.click(opts.formSubmit);

        // Wait for either a real navigation or SPA route change
        try {
          await Promise.race([
            page.waitForNavigation({ waitUntil: 'networkidle', timeout: 10000 }),
            page.waitForURL((url) => url.toString() !== currentUrl, { timeout: 10000 }),
          ]);
        } catch {
          // SPA may not trigger navigation — wait for network to settle
        }
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(500);
      }
    }

    // --- Navigate to target ---
    let responseStatus: number | undefined;
    let responseHeaders: Record<string, string> | undefined;

    // Handle POST data - intercept the first request to add POST body
    const postData = buildPostData(opts);
    const method = opts.request?.toUpperCase()
      ?? (postData.body ? 'POST' : 'GET');

    if (method !== 'GET' || postData.body) {
      // Intercept the navigation request to modify method/body
      await page.route(url, async (route) => {
        const headers: Record<string, string> = {};
        if (postData.contentType) {
          headers['Content-Type'] = postData.contentType;
        }
        await route.continue({
          method,
          postData: postData.body,
          headers: {
            ...route.request().headers(),
            ...headers,
          },
        });
      });
    }

    const response = await page.goto(url, {
      waitUntil: 'networkidle',
      timeout,
    });

    responseStatus = response?.status();
    responseHeaders = {};
    if (response) {
      const allHeaders = await response.allHeaders();
      for (const [k, v] of Object.entries(allHeaders)) {
        responseHeaders[k] = v;
      }
    }

    // --- Post-load actions ---

    // Wait for selector to appear
    if (opts.waitFor) {
      await page.waitForSelector(opts.waitFor, { timeout });
    }

    // Wait fixed time
    if (opts.wait && opts.wait > 0) {
      await page.waitForTimeout(opts.wait);
    }

    // Execute custom JavaScript
    if (opts.javascript) {
      await page.evaluate(opts.javascript);
    }

    // Click elements
    if (opts.click && opts.click.length > 0) {
      for (const sel of opts.click) {
        await page.click(sel);
      }
    }

    // Scroll to element
    if (opts.scrollTo) {
      await page.evaluate((sel: string) => {
        const el = document.querySelector(sel);
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'start' });
      }, opts.scrollTo);
      await page.waitForTimeout(300);
    }

    // Hide elements
    if (opts.hide && opts.hide.length > 0) {
      for (const sel of opts.hide) {
        await page.evaluate((s: string) => {
          document.querySelectorAll(s).forEach((el) => {
            (el as HTMLElement).style.display = 'none';
          });
        }, sel);
      }
    }

    // --- Capture ---
    const format = opts.format ?? 'png';
    let buffer: Buffer;

    if (format === 'pdf') {
      buffer = await page.pdf({
        format: 'A4',
        printBackground: true,
      });
    } else if (opts.selector) {
      const element = await page.$(opts.selector);
      if (!element) {
        throw new Error(`Selector "${opts.selector}" not found on page`);
      }
      buffer = await element.screenshot({
        type: format as 'png' | 'jpeg',
        quality: format === 'jpeg' ? (opts.quality ?? 80) : undefined,
      }) as Buffer;
    } else {
      buffer = await page.screenshot({
        type: format as 'png' | 'jpeg',
        quality: format === 'jpeg' ? (opts.quality ?? 80) : undefined,
        fullPage: opts.fullPage ?? false,
      }) as Buffer;
    }

    // Collect timing
    const timing: PageTiming = { total: Date.now() - startTime };
    try {
      const perfTiming = await page.evaluate(() => {
        const perf = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
        if (!perf) return null;
        return {
          dns: perf.domainLookupEnd - perf.domainLookupStart,
          connect: perf.connectEnd - perf.connectStart,
          ttfb: perf.responseStart - perf.requestStart,
          domLoaded: perf.domContentLoadedEventEnd - perf.startTime,
          loaded: perf.loadEventEnd - perf.startTime,
        };
      });
      if (perfTiming) {
        timing.dns = perfTiming.dns;
        timing.connect = perfTiming.connect;
        timing.ttfb = perfTiming.ttfb;
        timing.domLoaded = perfTiming.domLoaded;
        timing.loaded = perfTiming.loaded;
      }
    } catch {
      // Timing not available
    }

    // Save session state (--session or --save-session)
    const sessionSavePath = opts.saveSession ?? opts.session;
    if (sessionSavePath) {
      const state = await context.storageState();
      writeFileSync(sessionSavePath, JSON.stringify(state, null, 2), { mode: 0o600 });
    }

    // Save cookies to jar
    if (opts.cookieJar) {
      const cookies = await context.cookies();
      const cookieLines = cookies.map(
        (c) => `${c.domain}\tTRUE\t${c.path}\t${c.secure ? 'TRUE' : 'FALSE'}\t${c.expires}\t${c.name}\t${c.value}`
      );
      writeFileSync(opts.cookieJar, '# Netscape HTTP Cookie File\n' + cookieLines.join('\n') + '\n');
    }

    await context.close();

    return {
      url,
      buffer,
      format: format as 'png' | 'jpeg' | 'pdf',
      headers: responseHeaders,
      status: responseStatus,
      timing,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Parse a form field spec like 'input[placeholder*="Benutzername"]=admin'.
 * Finds the first '=' that is NOT inside [...] brackets or quotes.
 */
function parseFormField(field: string): { selector: string; value: string } {
  let bracketDepth = 0;
  let inDoubleQuote = false;
  let inSingleQuote = false;

  for (let i = 0; i < field.length; i++) {
    const ch = field[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '"' && !inSingleQuote) { inDoubleQuote = !inDoubleQuote; continue; }
    if (ch === "'" && !inDoubleQuote) { inSingleQuote = !inSingleQuote; continue; }
    if (inDoubleQuote || inSingleQuote) continue;
    if (ch === '[' || ch === '(') { bracketDepth++; continue; }
    if (ch === ']' || ch === ')') { bracketDepth--; continue; }
    if (ch === '=' && bracketDepth === 0) {
      return {
        selector: field.substring(0, i),
        value: field.substring(i + 1),
      };
    }
  }
  throw new Error(`Invalid --form-field: "${field}". Expected format: CSS_SELECTOR=value`);
}

function parseCookieStrings(
  cookieArgs: string[],
  url: string
): Array<{ name: string; value: string; url: string }> {
  const cookies: Array<{ name: string; value: string; url: string }> = [];

  for (const arg of cookieArgs) {
    // Could be a file path or inline cookies
    if (arg.includes('=') && !arg.startsWith('/') && !arg.startsWith('.')) {
      // Inline cookie string: "name=value; name2=value2"
      const pairs = arg.split(';');
      for (const pair of pairs) {
        const trimmed = pair.trim();
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          cookies.push({
            name: trimmed.substring(0, eqIdx).trim(),
            value: trimmed.substring(eqIdx + 1).trim(),
            url,
          });
        }
      }
    } else {
      // Try to read as Netscape cookie file
      try {
        const content = readFileSync(arg, 'utf-8');
        for (const line of content.split('\n')) {
          if (line.startsWith('#') || !line.trim()) continue;
          const parts = line.split('\t');
          if (parts.length >= 7) {
            cookies.push({
              name: parts[5],
              value: parts[6],
              url,
            });
          }
        }
      } catch {
        // Treat as inline cookie
        const pairs = arg.split(';');
        for (const pair of pairs) {
          const trimmed = pair.trim();
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0) {
            cookies.push({
              name: trimmed.substring(0, eqIdx).trim(),
              value: trimmed.substring(eqIdx + 1).trim(),
              url,
            });
          }
        }
      }
    }
  }

  return cookies;
}
