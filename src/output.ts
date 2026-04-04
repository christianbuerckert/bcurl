import { writeFileSync } from 'fs';
import { CaptureResult, BcurlOptions, WriteOutVars } from './types.js';

/**
 * Detect if the terminal supports inline images (iTerm2, kitty, WezTerm, etc.)
 */
function detectInlineImageSupport(): 'iterm2' | 'kitty' | 'sixel' | null {
  const term = process.env.TERM_PROGRAM ?? '';
  const termExtra = process.env.LC_TERMINAL ?? '';
  const kitty = process.env.TERM ?? '';

  if (term === 'iTerm.app' || termExtra === 'iTerm2') {
    return 'iterm2';
  }
  if (kitty.includes('kitty') || process.env.KITTY_WINDOW_ID) {
    return 'kitty';
  }
  if (term === 'WezTerm') {
    return 'iterm2'; // WezTerm supports iTerm2 protocol
  }
  // TODO: sixel detection

  return null;
}

/**
 * Output image using iTerm2 inline image protocol
 */
function outputIterm2(buffer: Buffer, name?: string): void {
  const b64 = buffer.toString('base64');
  const params = [
    `size=${buffer.length}`,
    name ? `name=${Buffer.from(name).toString('base64')}` : '',
    'inline=1',
    'preserveAspectRatio=1',
  ].filter(Boolean).join(';');

  // ESC ] 1337 ; File=[params] : base64data BEL
  process.stdout.write(`\x1b]1337;File=${params}:${b64}\x07\n`);
}

/**
 * Output image using Kitty graphics protocol
 */
function outputKitty(buffer: Buffer): void {
  const b64 = buffer.toString('base64');
  const chunkSize = 4096;

  for (let i = 0; i < b64.length; i += chunkSize) {
    const chunk = b64.substring(i, i + chunkSize);
    const isLast = i + chunkSize >= b64.length;

    if (i === 0) {
      // First chunk: include action and format
      process.stdout.write(`\x1b_Ga=T,f=100,m=${isLast ? 0 : 1};${chunk}\x1b\\`);
    } else {
      process.stdout.write(`\x1b_Gm=${isLast ? 0 : 1};${chunk}\x1b\\`);
    }
  }
  process.stdout.write('\n');
}

/**
 * Output the capture result to file or stdout
 */
export async function outputResult(
  result: CaptureResult,
  outputPath: string | undefined,
  opts: BcurlOptions
): Promise<void> {
  if (outputPath) {
    writeFileSync(outputPath, result.buffer);
    if (!opts.silent) {
      process.stderr.write(`Screenshot saved to ${outputPath}\n`);
    }
    return;
  }

  // Output to stdout
  if (process.stdout.isTTY) {
    // Terminal — try inline image display
    const protocol = detectInlineImageSupport();
    if (protocol === 'iterm2') {
      outputIterm2(result.buffer, `screenshot.${result.format}`);
    } else if (protocol === 'kitty') {
      outputKitty(result.buffer);
    } else {
      // No inline image support — write raw to stdout with a warning
      process.stderr.write(
        'Warning: Terminal does not support inline images. Writing raw image data to stdout.\n'
        + 'Pipe to a file (bcurl url > file.png) or use -o flag.\n'
      );
      process.stdout.write(result.buffer);
    }
  } else {
    // Piped — write raw binary data
    process.stdout.write(result.buffer);
  }
}

/**
 * Print response headers to stderr
 */
export function printHeaders(status?: number, headers?: Record<string, string>): void {
  process.stderr.write(`HTTP/1.1 ${status ?? 0}\n`);
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      process.stderr.write(`${k}: ${v}\n`);
    }
  }
  process.stderr.write('\n');
}

/**
 * Format curl-style --write-out string
 * Supports: %{url}, %{http_code}, %{content_type}, %{time_total},
 * %{time_namelookup}, %{time_connect}, %{time_starttransfer},
 * %{size_download}, %{filename_effective}, %{exitcode}, \n, \t
 */
export function formatWriteOut(format: string, vars: WriteOutVars): string {
  let result = format;

  // Replace curl variables
  result = result.replace(/%\{url_effective\}/g, vars.url);
  result = result.replace(/%\{url\}/g, vars.url);
  result = result.replace(/%\{http_code\}/g, String(vars.status));
  result = result.replace(/%\{response_code\}/g, String(vars.status));
  result = result.replace(/%\{content_type\}/g, vars.contentType);
  result = result.replace(/%\{time_total\}/g, vars.timeTotal.toFixed(6));
  result = result.replace(/%\{time_namelookup\}/g, vars.timeDns.toFixed(6));
  result = result.replace(/%\{time_connect\}/g, vars.timeConnect.toFixed(6));
  result = result.replace(/%\{time_starttransfer\}/g, vars.timeTtfb.toFixed(6));
  result = result.replace(/%\{time_ttfb\}/g, vars.timeTtfb.toFixed(6));
  result = result.replace(/%\{size_download\}/g, String(vars.sizeDownload));
  result = result.replace(/%\{filename_effective\}/g, vars.filename);
  result = result.replace(/%\{exitcode\}/g, '0');

  // Escape sequences
  result = result.replace(/\\n/g, '\n');
  result = result.replace(/\\t/g, '\t');
  result = result.replace(/\\r/g, '\r');
  result = result.replace(/\\\\/g, '\\');

  return result;
}
