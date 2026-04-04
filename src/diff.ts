import { chromium } from 'playwright';
import { readFileSync, existsSync } from 'fs';
import type { BcurlOptions } from './types.js';
import { launchAndCapture } from './browser.js';

export interface DiffResult {
  diffPercentage: number;
  changedPixels: number;
  totalPixels: number;
  diffBuffer: Buffer;
  match: boolean;
}

/**
 * Compare two images pixel-by-pixel using Playwright's browser canvas.
 * Returns a diff image and statistics.
 */
export async function compareImages(
  imageA: Buffer,
  imageB: Buffer,
  threshold: number = 0
): Promise<DiffResult> {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();

    const a64 = imageA.toString('base64');
    const b64 = imageB.toString('base64');

    const result = await page.evaluate(
      async ({ a, b, thresh }: { a: string; b: string; thresh: number }) => {
        function loadImage(base64: string): Promise<HTMLImageElement> {
          return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = `data:image/png;base64,${base64}`;
          });
        }

        const imgA = await loadImage(a);
        const imgB = await loadImage(b);

        const width = Math.max(imgA.width, imgB.width);
        const height = Math.max(imgA.height, imgB.height);

        // Canvas for image A
        const canvasA = document.createElement('canvas');
        canvasA.width = width;
        canvasA.height = height;
        const ctxA = canvasA.getContext('2d')!;
        ctxA.drawImage(imgA, 0, 0);
        const dataA = ctxA.getImageData(0, 0, width, height);

        // Canvas for image B
        const canvasB = document.createElement('canvas');
        canvasB.width = width;
        canvasB.height = height;
        const ctxB = canvasB.getContext('2d')!;
        ctxB.drawImage(imgB, 0, 0);
        const dataB = ctxB.getImageData(0, 0, width, height);

        // Diff canvas
        const canvasDiff = document.createElement('canvas');
        canvasDiff.width = width;
        canvasDiff.height = height;
        const ctxDiff = canvasDiff.getContext('2d')!;

        // Draw dimmed version of image A as background
        ctxDiff.globalAlpha = 0.3;
        ctxDiff.drawImage(imgA, 0, 0);
        ctxDiff.globalAlpha = 1.0;

        const diffData = ctxDiff.getImageData(0, 0, width, height);
        const pixelsA = dataA.data;
        const pixelsB = dataB.data;
        const pixelsDiff = diffData.data;

        let changedPixels = 0;
        const totalPixels = width * height;
        const colorThreshold = 30; // Per-channel tolerance

        for (let i = 0; i < pixelsA.length; i += 4) {
          const dr = Math.abs(pixelsA[i] - pixelsB[i]);
          const dg = Math.abs(pixelsA[i + 1] - pixelsB[i + 1]);
          const db = Math.abs(pixelsA[i + 2] - pixelsB[i + 2]);

          if (dr > colorThreshold || dg > colorThreshold || db > colorThreshold) {
            changedPixels++;
            // Highlight in magenta/red
            pixelsDiff[i] = 255;     // R
            pixelsDiff[i + 1] = 0;   // G
            pixelsDiff[i + 2] = 100; // B
            pixelsDiff[i + 3] = 220; // A
          }
        }

        ctxDiff.putImageData(diffData, 0, 0);

        // Convert to PNG base64
        const pngDataUrl = canvasDiff.toDataURL('image/png');
        const pngBase64 = pngDataUrl.split(',')[1];

        return {
          changedPixels,
          totalPixels,
          diffPercentage: totalPixels > 0 ? (changedPixels / totalPixels) * 100 : 0,
          pngBase64,
        };
      },
      { a: a64, b: b64, thresh: threshold }
    );

    await context.close();

    const diffBuffer = Buffer.from(result.pngBase64, 'base64');

    return {
      diffPercentage: result.diffPercentage,
      changedPixels: result.changedPixels,
      totalPixels: result.totalPixels,
      diffBuffer,
      match: result.diffPercentage <= threshold,
    };
  } finally {
    await browser.close();
  }
}

/**
 * Handle the `bcurl diff` subcommand.
 */
export async function handleDiff(args: string[], opts: any): Promise<void> {
  const threshold = parseFloat(opts.threshold ?? '0');
  const outputPath = opts.output;
  const showStats = opts.stats ?? true;

  // Determine inputs: can be files or URLs
  const inputs = args.filter((a) => !a.startsWith('-'));

  if (inputs.length < 2) {
    if (opts.reference && inputs.length >= 1) {
      // --reference mode: compare reference file against URL/file
      const refBuffer = readFileSync(opts.reference);
      let targetBuffer: Buffer;

      if (existsSync(inputs[0])) {
        targetBuffer = readFileSync(inputs[0]);
      } else {
        // It's a URL — capture it
        const captureOpts: BcurlOptions = { urls: [inputs[0]], ...opts };
        const result = await launchAndCapture(inputs[0], captureOpts);
        targetBuffer = result.buffer;
      }

      await runDiff(refBuffer, targetBuffer, threshold, outputPath, showStats);
      return;
    }
    process.stderr.write('Usage: bcurl diff <image1|url1> <image2|url2> [-o diff.png]\n');
    process.exit(1);
  }

  // Load or capture both inputs
  const buffers: Buffer[] = [];
  for (const input of inputs.slice(0, 2)) {
    if (existsSync(input)) {
      buffers.push(readFileSync(input));
    } else {
      // Treat as URL
      const url = input.includes('://') ? input : `https://${input}`;
      const captureOpts: BcurlOptions = { urls: [url], format: 'png' };
      if (opts.windowSize) captureOpts.windowSize = opts.windowSize;
      if (opts.device) captureOpts.device = opts.device;
      if (opts.session) captureOpts.session = opts.session;
      const result = await launchAndCapture(url, captureOpts);
      buffers.push(result.buffer);
    }
  }

  await runDiff(buffers[0], buffers[1], threshold, outputPath, showStats);
}

async function runDiff(
  bufA: Buffer,
  bufB: Buffer,
  threshold: number,
  outputPath?: string,
  showStats?: boolean
): Promise<void> {
  const result = await compareImages(bufA, bufB, threshold);

  if (showStats) {
    process.stderr.write(`Pixels changed: ${result.changedPixels} / ${result.totalPixels}\n`);
    process.stderr.write(`Diff: ${result.diffPercentage.toFixed(2)}%\n`);
    process.stderr.write(`Match: ${result.match ? 'YES' : 'NO'} (threshold: ${threshold}%)\n`);
  }

  if (outputPath) {
    const { writeFileSync } = await import('fs');
    writeFileSync(outputPath, result.diffBuffer);
    process.stderr.write(`Diff image saved to ${outputPath}\n`);
  } else {
    process.stdout.write(result.diffBuffer);
  }

  if (!result.match) {
    process.exit(1);
  }
}
