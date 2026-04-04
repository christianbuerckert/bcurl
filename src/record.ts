import { chromium, type Page } from 'playwright';
import { writeFileSync } from 'fs';

export interface RecordingStep {
  action: 'goto' | 'fill' | 'click' | 'select' | 'check' | 'uncheck' | 'hover'
    | 'press' | 'type' | 'scroll' | 'wait' | 'waitForSelector' | 'waitForNavigation' | 'evaluate';
  selector?: string;
  value?: string;
  url?: string;
  ms?: number;
  key?: string;
  code?: string;
}

export interface Recording {
  version: 1;
  startUrl: string;
  recordedAt: string;
  steps: RecordingStep[];
}

/**
 * Open a visible browser, record user interactions, save to file.
 */
export async function recordInteractions(
  startUrl: string,
  outputFile: string,
  windowSize?: string
): Promise<void> {
  const viewport = windowSize
    ? { width: parseInt(windowSize.split('x')[0]), height: parseInt(windowSize.split('x')[1]) }
    : { width: 1280, height: 720 };

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ viewport });
  const page = await context.newPage();

  const steps: RecordingStep[] = [];
  let lastUrl = '';

  process.stderr.write('Recording started. Interact with the browser.\n');
  process.stderr.write('Close the browser window or press Ctrl+C to stop and save.\n\n');

  // Expose function for the page to send events back
  await page.exposeFunction('__bcurl_record', (event: string) => {
    try {
      const step = JSON.parse(event) as RecordingStep;
      steps.push(step);
      process.stderr.write(`  [${steps.length}] ${step.action} ${step.selector ?? step.url ?? ''} ${step.value ?? ''}\n`);
    } catch {}
  });

  // Inject recording script
  await page.addInitScript(() => {
    function getSelector(el: Element): string {
      // Prefer stable selectors
      if (el.id) return `#${el.id}`;
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
      if (testId) return `[data-testid="${testId}"]`;
      const name = el.getAttribute('name');
      if (name) return `${el.tagName.toLowerCase()}[name="${name}"]`;
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return `${el.tagName.toLowerCase()}[placeholder="${placeholder}"]`;
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return `[aria-label="${ariaLabel}"]`;

      // Build a CSS path
      const parts: string[] = [];
      let current: Element | null = el;
      while (current && current !== document.body) {
        let selector = current.tagName.toLowerCase();
        if (current.id) {
          selector = `#${current.id}`;
          parts.unshift(selector);
          break;
        }
        const parent = current.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children).filter((c) => c.tagName === current!.tagName);
          if (siblings.length > 1) {
            const index = siblings.indexOf(current) + 1;
            selector += `:nth-child(${index})`;
          }
        }
        parts.unshift(selector);
        current = current.parentElement;
      }
      return parts.join(' > ');
    }

    // Track clicks
    document.addEventListener('click', (e) => {
      const target = e.target as Element;
      if (!target) return;
      const selector = getSelector(target);
      (window as any).__bcurl_record(JSON.stringify({
        action: 'click',
        selector,
      }));
    }, true);

    // Track input changes
    document.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (!target) return;
      const selector = getSelector(target);
      if (target.type === 'checkbox' || target.type === 'radio') return;
      (window as any).__bcurl_record(JSON.stringify({
        action: 'fill',
        selector,
        value: target.value,
      }));
    }, true);

    // Track checkbox/radio changes
    document.addEventListener('change', (e) => {
      const target = e.target as HTMLInputElement;
      if (!target) return;
      if (target.type === 'checkbox') {
        (window as any).__bcurl_record(JSON.stringify({
          action: target.checked ? 'check' : 'uncheck',
          selector: getSelector(target),
        }));
      } else if (target.tagName.toLowerCase() === 'select') {
        (window as any).__bcurl_record(JSON.stringify({
          action: 'select',
          selector: getSelector(target),
          value: (target as unknown as HTMLSelectElement).value,
        }));
      }
    }, true);

    // Track keyboard Enter (form submissions)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const target = e.target as Element;
        (window as any).__bcurl_record(JSON.stringify({
          action: 'press',
          selector: getSelector(target),
          key: 'Enter',
        }));
      }
    }, true);
  });

  // Track navigations
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) {
      const currentUrl = frame.url();
      if (currentUrl !== lastUrl && currentUrl !== 'about:blank') {
        if (lastUrl) {
          steps.push({ action: 'waitForNavigation' });
          process.stderr.write(`  [${steps.length}] waitForNavigation\n`);
        }
        lastUrl = currentUrl;
      }
    }
  });

  // Navigate to start URL
  steps.push({ action: 'goto', url: startUrl });
  process.stderr.write(`  [1] goto ${startUrl}\n`);
  await page.goto(startUrl, { waitUntil: 'networkidle' });
  lastUrl = startUrl;

  // Wait for browser to close
  await new Promise<void>((resolve) => {
    const cleanup = () => {
      resolve();
    };
    page.on('close', cleanup);
    browser.on('disconnected', cleanup);
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  });

  // Deduplicate consecutive fill actions on the same selector (keep last value)
  const deduped = deduplicateFills(steps);

  const recording: Recording = {
    version: 1,
    startUrl,
    recordedAt: new Date().toISOString(),
    steps: deduped,
  };

  writeFileSync(outputFile, JSON.stringify(recording, null, 2));
  process.stderr.write(`\nRecording saved to ${outputFile} (${deduped.length} steps)\n`);

  await browser.close().catch(() => {});
}

function deduplicateFills(steps: RecordingStep[]): RecordingStep[] {
  const result: RecordingStep[] = [];
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.action === 'fill') {
      // Look ahead: if next step is also a fill on the same selector, skip this one
      const next = steps[i + 1];
      if (next?.action === 'fill' && next?.selector === step.selector) {
        continue;
      }
    }
    result.push(step);
  }
  return result;
}

/**
 * Replay recorded steps on a page.
 */
export async function replaySteps(page: Page, steps: RecordingStep[], timeout = 30000): Promise<void> {
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const stepNum = i + 1;

    try {
      switch (step.action) {
        case 'goto':
          if (step.url) {
            await page.goto(step.url, { waitUntil: 'networkidle', timeout });
          }
          break;

        case 'fill':
          if (step.selector && step.value !== undefined) {
            await page.fill(step.selector, step.value, { timeout });
          }
          break;

        case 'click':
          if (step.selector) {
            await page.click(step.selector, { timeout });
          }
          break;

        case 'select':
          if (step.selector && step.value) {
            await page.selectOption(step.selector, step.value, { timeout });
          }
          break;

        case 'check':
          if (step.selector) {
            await page.check(step.selector, { timeout });
          }
          break;

        case 'uncheck':
          if (step.selector) {
            await page.uncheck(step.selector, { timeout });
          }
          break;

        case 'hover':
          if (step.selector) {
            await page.hover(step.selector, { timeout });
          }
          break;

        case 'press':
          if (step.selector && step.key) {
            await page.press(step.selector, step.key, { timeout });
          }
          break;

        case 'type':
          if (step.selector && step.value) {
            await page.locator(step.selector).pressSequentially(step.value, { timeout });
          }
          break;

        case 'scroll':
          if (step.selector) {
            await page.evaluate((sel: string) => {
              document.querySelector(sel)?.scrollIntoView({ behavior: 'instant' });
            }, step.selector);
          }
          break;

        case 'wait':
          await page.waitForTimeout(step.ms ?? 1000);
          break;

        case 'waitForSelector':
          if (step.selector) {
            await page.waitForSelector(step.selector, { timeout });
          }
          break;

        case 'waitForNavigation':
          await page.waitForLoadState('networkidle').catch(() => {});
          break;

        case 'evaluate':
          if (step.code) {
            await page.evaluate(step.code);
          }
          break;
      }
    } catch (err: any) {
      throw new Error(`Replay failed at step ${stepNum} (${step.action} ${step.selector ?? ''}): ${err.message}`);
    }
  }
}
