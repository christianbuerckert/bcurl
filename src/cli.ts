#!/usr/bin/env node

import { Command, Option } from 'commander';
import { resolve, join, dirname, basename, extname } from 'path';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { BcurlOptions, DEVICES } from './types.js';
import { launchAndCapture } from './browser.js';
import { formatWriteOut, outputResult, printHeaders } from './output.js';

const VERSION = '1.0.0';

function parseWindowSize(val: string): string {
  if (!/^\d+x\d+$/.test(val)) {
    throw new Error(`Invalid window size: ${val}. Expected format: WIDTHxHEIGHT (e.g. 1920x1080)`);
  }
  return val;
}

function collect(val: string, prev: string[]): string[] {
  return prev.concat([val]);
}

function buildProgram(): Command {
  const program = new Command();

  program
    .name('bcurl')
    .version(VERSION, '-V, --version')
    .description(
      'Like curl, but returns a browser-rendered screenshot instead of source code.\n'
      + '\n'
      + 'Examples:\n'
      + '  bcurl https://example.com                          Screenshot to stdout/terminal\n'
      + '  bcurl -o page.png https://example.com              Save to file\n'
      + '  bcurl --window-size 1920x1080 -o hd.png URL        Custom viewport\n'
      + '  bcurl --device iphone-14 -o mobile.png URL         Mobile emulation\n'
      + '  bcurl --full-page -o full.png URL                  Full scrollable page\n'
      + '  bcurl --format pdf -o page.pdf URL                 PDF output\n'
      + '  bcurl --dark-mode -o dark.png URL                  Dark mode\n'
      + '  bcurl --selector "main" -o main.png URL            Capture specific element\n'
      + '  bcurl --hide ".cookie-banner" -o clean.png URL     Hide cookie banners\n'
      + '  bcurl -I URL                                       Response headers only\n'
      + '  bcurl -v -w \'%{http_code} %{time_total}s\\n\' URL   Verbose + stats\n'
      + '\n'
      + 'Form Login + Session:\n'
      + '  bcurl --form-login URL                             Login before capture\n'
      + '    --form-field \'input[name="user"]=admin\'          Fill form field\n'
      + '    --form-field \'input[type="password"]=secret\'     Fill password\n'
      + '    --form-submit \'button:text-is("Login")\'          Submit form\n'
      + '    --session session.json                           Save session for reuse\n'
      + '    -o dashboard.png https://app/dashboard\n'
      + '\n'
      + '  bcurl --session session.json -o dash.png URL       Reuse saved session\n'
      + '\n'
      + 'Devices: iphone-12, iphone-14, iphone-14-pro-max, pixel-7,\n'
      + '         ipad, ipad-pro, galaxy-s23, desktop-hd, desktop-4k, macbook-pro-16\n'
      + '\n'
      + 'Full documentation: see USAGE.md'
    )
    .argument('[urls...]', 'URL(s) to capture')
    .allowExcessArguments(true);

  // --- Output options ---
  program
    .option('-o, --output <file>', 'Write screenshot to <file> instead of stdout')
    .option('--output-dir <dir>', 'Directory to save files in')
    .option('--create-dirs', 'Create necessary local directory hierarchy')
    .addOption(new Option('--format <format>', 'Screenshot format').choices(['png', 'jpeg', 'pdf']).default('png'))
    .option('--quality <number>', 'JPEG quality (0-100)', parseInt)
    .option('-O, --remote-name', 'Derive output filename from URL');

  // --- HTTP options ---
  program
    .option('-H, --header <header>', 'Custom header(s) to send (repeatable)', collect, [])
    .option('-A, --user-agent <name>', 'User-Agent string')
    .option('-e, --referer <URL>', 'Referrer URL')
    .option('-b, --cookie <data>', 'Send cookies (repeatable)', collect, [])
    .option('-c, --cookie-jar <file>', 'Save cookies to file after capture')
    .option('-u, --user <user:password>', 'HTTP Basic Auth credentials')
    .option('--oauth2-bearer <token>', 'OAuth 2 Bearer Token')
    .option('-X, --request <method>', 'HTTP method (GET, POST, etc.)')
    .option('-d, --data <data>', 'HTTP POST data (repeatable)', collect, [])
    .option('--data-raw <data>', 'HTTP POST data without @ processing (repeatable)', collect, [])
    .option('--data-urlencode <data>', 'URL-encoded POST data (repeatable)', collect, [])
    .option('--json <data>', 'JSON POST data (repeatable)', collect, [])
    .option('-F, --form <name=content>', 'Multipart form data (repeatable)', collect, [])
    .option('-G, --get', 'Send data as query string with GET')
    .option('-I, --head', 'Show response headers only (no screenshot)')
    .option('-L, --location', 'Follow redirects (browser default, this is a no-op)')
    .option('--max-redirs <num>', 'Maximum number of redirects', parseInt)
    .option('--compressed', 'Accept compressed responses (browser default)')
    .option('--resolve <host:port:addr>', 'Resolve host+port to address (repeatable)', collect, []);

  // --- Connection options ---
  program
    .option('-x, --proxy <[protocol://]host[:port]>', 'Use proxy')
    .option('-U, --proxy-user <user:password>', 'Proxy user and password')
    .option('-k, --insecure', 'Allow insecure server connections (ignore SSL errors)')
    .option('-m, --max-time <seconds>', 'Maximum time allowed for the whole operation', parseFloat)
    .option('--connect-timeout <seconds>', 'Maximum time allowed for connection', parseFloat)
    .option('-4, --ipv4', 'Resolve names to IPv4 addresses only')
    .option('-6, --ipv6', 'Resolve names to IPv6 addresses only');

  // --- Verbosity & Info ---
  program
    .option('-v, --verbose', 'Make the operation more talkative')
    .option('-s, --silent', 'Silent mode')
    .option('-S, --show-error', 'Show error even when -s is used')
    .option('-i, --include', 'Include response headers in output (printed before image)')
    .option('-w, --write-out <format>', 'Output format string after completion')
    .option('-D, --dump-header <file>', 'Write response headers to file');

  // --- Browser-specific options ---
  program
    .option('--window-size <WxH>', 'Browser viewport size (e.g. 1920x1080)', parseWindowSize)
    .option('--full-page', 'Capture the full scrollable page')
    .option('--device <name>', `Emulate device (${Object.keys(DEVICES).join(', ')})`)
    .option('--dark-mode', 'Emulate dark color scheme')
    .option('--javascript <code>', 'Execute JavaScript before screenshot')
    .option('--no-javascript', 'Disable JavaScript')
    .option('--selector <css>', 'Capture only this CSS selector element')
    .option('--wait-for <selector>', 'Wait for this CSS selector to appear')
    .option('--wait <ms>', 'Wait time in ms after page load before screenshot', parseInt)
    .option('--hide <selector>', 'Hide elements matching selector before screenshot (repeatable)', collect, [])
    .option('--click <selector>', 'Click element before screenshot (repeatable)', collect, [])
    .option('--scroll-to <selector>', 'Scroll to element before screenshot')
    .option('--emulate-media <type>', 'Emulate CSS media type (screen, print)')
    .option('--timezone <tz>', 'Emulate timezone (e.g. America/New_York)')
    .option('--locale <locale>', 'Emulate locale (e.g. de-DE)')
    .option('--geolocation <lat,lng>', 'Emulate geolocation')
    .option('--block-images', 'Block all image requests')
    .option('--no-images', 'Alias for --block-images')
    .option('--scale <factor>', 'Device scale factor', parseFloat)
    .option('--delay <ms>', 'Alias for --wait', parseInt);

  // --- Session options ---
  program
    .option('--session <file>', 'Load session if file exists, save after capture (cookies + localStorage)')
    .option('--save-session <file>', 'Save session state to file after capture')
    .option('--load-session <file>', 'Load session state from file before capture');

  // --- Form Login options ---
  program
    .option('--form-login <url>', 'Navigate to this URL and perform form login before capturing target')
    .option('--form-field <selector=value>', 'Fill form field: CSS_SELECTOR=value (repeatable)', collect, [])
    .option('--form-submit <selector>', 'Click this element to submit the login form');

  return program;
}

function normalizeUrl(url: string): string {
  if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url)) {
    return `https://${url}`;
  }
  return url;
}

function deriveFilename(url: string, format: string): string {
  try {
    const u = new URL(url);
    let name = u.hostname.replace(/[^a-zA-Z0-9.-]/g, '_');
    const path = u.pathname.replace(/\/$/, '');
    if (path && path !== '/') {
      name += path.replace(/\//g, '_').replace(/[^a-zA-Z0-9._-]/g, '_');
    }
    return `${name}.${format}`;
  } catch {
    return `screenshot.${format}`;
  }
}

function parseHeaders(headerStrings: string[]): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const h of headerStrings) {
    const colonIdx = h.indexOf(':');
    if (colonIdx > 0) {
      const key = h.substring(0, colonIdx).trim();
      const value = h.substring(colonIdx + 1).trim();
      headers[key] = value;
    }
  }
  return headers;
}

async function main(): Promise<void> {
  const program = buildProgram();
  program.parse(process.argv);

  const rawOpts = program.opts();
  const urls = program.args;

  if (urls.length === 0) {
    program.help();
    process.exit(0);
  }

  // Build options
  const opts: BcurlOptions = {
    urls: urls.map(normalizeUrl),
    output: rawOpts.output,
    outputDir: rawOpts.outputDir,
    createDirs: rawOpts.createDirs,
    format: rawOpts.format ?? 'png',
    quality: rawOpts.quality,
    header: rawOpts.header,
    userAgent: rawOpts.userAgent,
    referer: rawOpts.referer,
    cookie: rawOpts.cookie,
    cookieJar: rawOpts.cookieJar,
    user: rawOpts.user,
    oauth2Bearer: rawOpts.oauth2Bearer,
    request: rawOpts.request,
    data: rawOpts.data,
    dataRaw: rawOpts.dataRaw,
    dataUrlencode: rawOpts.dataUrlencode,
    json: rawOpts.json,
    form: rawOpts.form,
    get: rawOpts.get,
    head: rawOpts.head,
    location: rawOpts.location ?? true,
    maxRedirs: rawOpts.maxRedirs,
    compressed: rawOpts.compressed ?? true,
    proxy: rawOpts.proxy,
    proxyUser: rawOpts.proxyUser,
    insecure: rawOpts.insecure,
    maxTime: rawOpts.maxTime,
    connectTimeout: rawOpts.connectTimeout,
    resolve: rawOpts.resolve,
    verbose: rawOpts.verbose,
    silent: rawOpts.silent,
    showError: rawOpts.showError,
    include: rawOpts.include,
    writeOut: rawOpts.writeOut,
    dumpHeader: rawOpts.dumpHeader,
    windowSize: rawOpts.windowSize,
    fullPage: rawOpts.fullPage,
    device: rawOpts.device,
    darkMode: rawOpts.darkMode,
    javascript: rawOpts.javascript,
    noJavascript: rawOpts.noJavascript ?? rawOpts.javascript === false,
    selector: rawOpts.selector,
    waitFor: rawOpts.waitFor,
    wait: rawOpts.wait ?? rawOpts.delay,
    hide: rawOpts.hide,
    click: rawOpts.click,
    scrollTo: rawOpts.scrollTo,
    emulateMedia: rawOpts.emulateMedia,
    timezone: rawOpts.timezone,
    locale: rawOpts.locale,
    geolocation: rawOpts.geolocation,
    blockImages: rawOpts.blockImages || rawOpts.noImages,
    extraHttpHeaders: parseHeaders(rawOpts.header ?? []),
    session: rawOpts.session,
    saveSession: rawOpts.saveSession,
    loadSession: rawOpts.loadSession,
    formLogin: rawOpts.formLogin,
    formField: rawOpts.formField,
    formSubmit: rawOpts.formSubmit,
  };

  // Validate device
  if (opts.device && !DEVICES[opts.device]) {
    const available = Object.keys(DEVICES).join(', ');
    error(`Unknown device: ${opts.device}. Available: ${available}`);
    process.exit(1);
  }

  // Handle --remote-name
  const remoteName: boolean = rawOpts.remoteName;

  for (let i = 0; i < opts.urls.length; i++) {
    const url = opts.urls[i];

    if (!opts.silent) {
      if (opts.verbose) {
        log(`> Navigating to ${url}`);
        if (opts.windowSize) log(`> Viewport: ${opts.windowSize}`);
        if (opts.device) log(`> Device emulation: ${opts.device}`);
        if (opts.proxy) log(`> Using proxy: ${opts.proxy}`);
        if (opts.insecure) log(`> SSL verification disabled`);
      }
    }

    try {
      const startTime = Date.now();
      const result = await launchAndCapture(url, opts);
      const elapsed = Date.now() - startTime;

      if (opts.verbose && !opts.silent) {
        log(`< HTTP ${result.status}`);
        if (result.headers) {
          for (const [k, v] of Object.entries(result.headers)) {
            log(`< ${k}: ${v}`);
          }
        }
        log(`< Screenshot: ${result.buffer.length} bytes (${result.format})`);
        log(`< Total time: ${(elapsed / 1000).toFixed(3)}s`);
      }

      // -I/--head: print headers only
      if (opts.head) {
        printHeaders(result.status, result.headers);
        continue;
      }

      // -i/--include: print headers before image
      if (opts.include) {
        printHeaders(result.status, result.headers);
      }

      // -D/--dump-header
      if (opts.dumpHeader) {
        const headerText = formatHeaderText(result.status, result.headers);
        const dumpPath = opts.dumpHeader === '-' ? '/dev/stdout' : opts.dumpHeader;
        if (dumpPath === '/dev/stdout') {
          process.stdout.write(headerText);
        } else {
          writeFileSync(dumpPath, headerText);
        }
      }

      // Determine output file path
      let outputPath: string | undefined = opts.output;
      if (remoteName && !outputPath) {
        outputPath = deriveFilename(url, result.format);
      }
      if (outputPath && opts.outputDir) {
        outputPath = join(opts.outputDir, outputPath);
      } else if (!outputPath && opts.outputDir) {
        outputPath = join(opts.outputDir, deriveFilename(url, result.format));
      }

      // For multiple URLs without explicit output, generate names
      if (opts.urls.length > 1 && !outputPath) {
        outputPath = deriveFilename(url, result.format);
        if (opts.outputDir) {
          outputPath = join(opts.outputDir, outputPath);
        }
      }

      // Create directories if needed
      if (outputPath && opts.createDirs) {
        const dir = dirname(outputPath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
      }

      await outputResult(result, outputPath, opts);

      // -w/--write-out
      if (opts.writeOut) {
        const writeOutStr = formatWriteOut(opts.writeOut, {
          url,
          status: result.status ?? 0,
          contentType: `image/${result.format}`,
          timeTotal: elapsed / 1000,
          timeDns: (result.timing?.dns ?? 0) / 1000,
          timeConnect: (result.timing?.connect ?? 0) / 1000,
          timeTtfb: (result.timing?.ttfb ?? 0) / 1000,
          sizeDownload: result.buffer.length,
          filename: outputPath ?? '<stdout>',
        });
        process.stderr.write(writeOutStr);
      }

      // Save cookies
      if (opts.cookieJar) {
        // Cookies are handled inside browser.ts and saved there
      }
    } catch (err: any) {
      if (!opts.silent || opts.showError) {
        error(`Failed to capture ${url}: ${err.message}`);
      }
      process.exit(1);
    }
  }
}

function formatHeaderText(status?: number, headers?: Record<string, string>): string {
  let text = `HTTP/1.1 ${status ?? 0}\r\n`;
  if (headers) {
    for (const [k, v] of Object.entries(headers)) {
      text += `${k}: ${v}\r\n`;
    }
  }
  text += '\r\n';
  return text;
}

function log(msg: string): void {
  process.stderr.write(msg + '\n');
}

function error(msg: string): void {
  process.stderr.write(`bcurl: ${msg}\n`);
}

main().catch((err) => {
  process.stderr.write(`bcurl: ${err.message}\n`);
  process.exit(1);
});
