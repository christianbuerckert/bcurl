#!/usr/bin/env node

import { Command, Option } from 'commander';
import { join, dirname } from 'path';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { BcurlOptions, CaptureResult, DEVICES } from './types.js';
import { launchAndCapture, launchAndCaptureParallel } from './browser.js';
import { formatWriteOut, outputResult, printHeaders } from './output.js';
import { loadConfig, isConfigDisabled, getExplicitConfig } from './config.js';
import { isDaemonRunning, getDaemonStatus, stopDaemon, captureViaDaemon, spawnDaemon } from './daemon.js';
import { handleDiff } from './diff.js';
import { recordInteractions } from './record.js';
import { startMcpServer } from './mcp.js';

const VERSION = '2.3.0';

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
      + '  bcurl --form-login URL \\                           Login before capture\n'
      + '    --form-field \'input[name="user"]=admin\' \\        Fill form field\n'
      + '    --form-field \'input[type="password"]=secret\' \\   Fill password\n'
      + '    --form-submit \'button:text-is("Login")\' \\        Submit form\n'
      + '    --session session.json \\                          Save session for reuse\n'
      + '    -o dashboard.png https://app/dashboard\n'
      + '  bcurl --session session.json -o dash.png URL       Reuse saved session\n'
      + '\n'
      + 'Network Analysis:\n'
      + '  bcurl --network URL                                Show all network requests\n'
      + '  bcurl --waterfall URL                              ASCII timing waterfall\n'
      + '  bcurl --har requests.har URL                       Save HAR file\n'
      + '\n'
      + 'Parallel Capture:\n'
      + '  bcurl -Z -O url1 url2 url3                         Capture URLs in parallel\n'
      + '\n'
      + 'Visual Diff:\n'
      + '  bcurl diff old.png new.png -o diff.png             Compare two screenshots\n'
      + '  bcurl diff --reference base.png URL -o diff.png    Compare URL vs baseline\n'
      + '\n'
      + 'Record & Replay:\n'
      + '  bcurl record -o flow.json URL                      Record browser interactions\n'
      + '  bcurl --replay flow.json -o page.png URL           Replay then capture\n'
      + '\n'
      + 'Daemon (fast mode):\n'
      + '  bcurl --daemon                                     Start background browser\n'
      + '  bcurl -o fast.png URL                              Auto-uses daemon if running\n'
      + '  bcurl --daemon-stop                                Stop daemon\n'
      + '\n'
      + 'Config: ~/.bcurlrc (same format as .curlrc)\n'
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

  // --- Daemon options ---
  program
    .option('--daemon', 'Start background browser daemon for fast captures')
    .option('--daemon-stop', 'Stop the running daemon')
    .option('--daemon-status', 'Check if daemon is running')
    .option('--no-daemon', 'Force standalone mode (skip daemon even if running)')
    .option('--pool-size <n>', 'Browser context pool size for daemon (default 3)', parseInt)
    .option('--idle-timeout <seconds>', 'Daemon auto-shutdown after idle (default 300)', parseInt);

  // --- Network options ---
  program
    .option('--network', 'Show network request summary on stderr')
    .option('--har <file>', 'Save HAR (HTTP Archive) file')
    .option('--network-filter <glob>', 'Filter network output by URL pattern')
    .option('--network-errors', 'Show only failed network requests')
    .option('--waterfall', 'Show ASCII timing waterfall of network requests');

  // --- Parallel options ---
  program
    .option('-Z, --parallel', 'Capture multiple URLs in parallel')
    .option('--parallel-max <num>', 'Maximum parallel captures (default 4)', parseInt)
    .option('--progress', 'Show progress for parallel captures');

  // --- Config options ---
  program
    .option('-K, --config <file>', 'Read config from file')
    .option('-q, --disable', 'Disable automatic config file loading');

  // --- Retry options ---
  program
    .option('--retry <num>', 'Retry on transient failures (default 0)', parseInt)
    .option('--retry-delay <seconds>', 'Wait between retries (default 1)', parseFloat)
    .option('--retry-max-time <seconds>', 'Maximum total time for retries', parseFloat);

  // --- Replay option ---
  program
    .option('--replay <file>', 'Replay recorded interactions before capture');

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
      headers[h.substring(0, colonIdx).trim()] = h.substring(colonIdx + 1).trim();
    }
  }
  return headers;
}

async function main(): Promise<void> {
  // Load config files before parsing
  const rawArgv = process.argv.slice(2);
  const disabled = isConfigDisabled(rawArgv);
  const explicitConfig = getExplicitConfig(rawArgv);

  let configArgs: string[] = [];
  try {
    configArgs = loadConfig(explicitConfig, disabled);
  } catch (err: any) {
    process.stderr.write(`bcurl: ${err.message}\n`);
    process.exit(1);
  }

  // Prepend config args (CLI args override config)
  const fullArgv = ['node', 'bcurl', ...configArgs, ...rawArgv];

  // Check for subcommands before parsing
  const subcommand = rawArgv[0];

  if (subcommand === '--mcp' || subcommand === 'mcp') {
    await startMcpServer();
    return;
  }

  if (subcommand === 'diff') {
    const diffArgs = rawArgv.slice(1);
    const diffOpts: any = {};
    const inputs: string[] = [];
    for (let i = 0; i < diffArgs.length; i++) {
      const arg = diffArgs[i];
      if (arg === '-o' || arg === '--output') { diffOpts.output = diffArgs[++i]; }
      else if (arg === '--threshold') { diffOpts.threshold = diffArgs[++i]; }
      else if (arg === '--reference') { diffOpts.reference = diffArgs[++i]; }
      else if (arg === '--stats') { diffOpts.stats = true; }
      else if (arg === '--window-size') { diffOpts.windowSize = diffArgs[++i]; }
      else if (arg === '--device') { diffOpts.device = diffArgs[++i]; }
      else if (arg === '--session') { diffOpts.session = diffArgs[++i]; }
      else if (!arg.startsWith('-')) { inputs.push(arg); }
    }
    await handleDiff(inputs, diffOpts);
    return;
  }

  if (subcommand === 'record') {
    const recordArgs = rawArgv.slice(1);
    let outputFile = '';
    let startUrl = '';
    let windowSize: string | undefined;
    for (let i = 0; i < recordArgs.length; i++) {
      const arg = recordArgs[i];
      if (arg === '-o' || arg === '--output') { outputFile = recordArgs[++i]; }
      else if (arg === '--window-size') { windowSize = recordArgs[++i]; }
      else if (!arg.startsWith('-')) { startUrl = arg; }
    }
    if (!startUrl || !outputFile) {
      process.stderr.write('Usage: bcurl record -o <output.json> <url>\n');
      process.exit(1);
    }
    startUrl = normalizeUrl(startUrl);
    await recordInteractions(startUrl, outputFile, windowSize);
    return;
  }

  const program = buildProgram();
  program.parse(fullArgv);

  const rawOpts = program.opts();
  const urls = program.args;

  // --- Handle daemon commands ---
  if (rawOpts.daemonStatus) {
    const status = getDaemonStatus();
    if (status.running) {
      console.log(`bcurl daemon running (pid ${status.pid})`);
    } else {
      console.log('bcurl daemon not running');
    }
    return;
  }

  if (rawOpts.daemonStop) {
    const stopped = await stopDaemon();
    console.log(stopped ? 'bcurl daemon stopped' : 'bcurl daemon not running');
    return;
  }

  if (rawOpts.daemon && urls.length === 0) {
    spawnDaemon(rawOpts.poolSize, rawOpts.idleTimeout);
    return;
  }

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
    retry: rawOpts.retry,
    retryDelay: rawOpts.retryDelay,
    retryMaxTime: rawOpts.retryMaxTime,
    network: rawOpts.network,
    har: rawOpts.har,
    networkFilter: rawOpts.networkFilter,
    networkErrors: rawOpts.networkErrors,
    waterfall: rawOpts.waterfall,
    parallel: rawOpts.parallel,
    parallelMax: rawOpts.parallelMax,
    progress: rawOpts.progress,
    replay: rawOpts.replay,
    noDaemon: rawOpts.noDaemon ?? rawOpts.daemon === false,
  };

  // Validate device
  if (opts.device && !DEVICES[opts.device]) {
    error(`Unknown device: ${opts.device}. Available: ${Object.keys(DEVICES).join(', ')}`);
    process.exit(1);
  }

  const remoteName: boolean = rawOpts.remoteName;
  const useDaemon = !opts.noDaemon && isDaemonRunning();

  // --- Parallel mode ---
  if (opts.parallel && opts.urls.length > 1) {
    await handleParallel(opts, remoteName);
    return;
  }

  // --- Sequential mode ---
  for (let i = 0; i < opts.urls.length; i++) {
    const url = opts.urls[i];

    if (!opts.silent && opts.verbose) {
      log(`> Navigating to ${url}`);
      if (opts.windowSize) log(`> Viewport: ${opts.windowSize}`);
      if (opts.device) log(`> Device emulation: ${opts.device}`);
      if (useDaemon) log(`> Using daemon`);
    }

    try {
      const startTime = Date.now();
      const result = await captureWithRetry(url, opts, useDaemon);
      const elapsed = Date.now() - startTime;

      if (opts.verbose && !opts.silent) {
        log(`< HTTP ${result.status}`);
        if (result.headers) {
          for (const [k, v] of Object.entries(result.headers)) log(`< ${k}: ${v}`);
        }
        log(`< Screenshot: ${result.buffer.length} bytes (${result.format})`);
        log(`< Total time: ${(elapsed / 1000).toFixed(3)}s`);
      }

      if (opts.head) { printHeaders(result.status, result.headers); continue; }
      if (opts.include) printHeaders(result.status, result.headers);

      if (opts.dumpHeader) {
        const headerText = formatHeaderText(result.status, result.headers);
        if (opts.dumpHeader === '-') process.stdout.write(headerText);
        else writeFileSync(opts.dumpHeader, headerText);
      }

      let outputPath = resolveOutputPath(opts, url, result.format, remoteName, i);

      if (outputPath && opts.createDirs) {
        const dir = dirname(outputPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      }

      await outputResult(result, outputPath, opts);

      if (opts.writeOut) {
        process.stderr.write(formatWriteOut(opts.writeOut, {
          url, status: result.status ?? 0, contentType: `image/${result.format}`,
          timeTotal: elapsed / 1000,
          timeDns: (result.timing?.dns ?? 0) / 1000,
          timeConnect: (result.timing?.connect ?? 0) / 1000,
          timeTtfb: (result.timing?.ttfb ?? 0) / 1000,
          sizeDownload: result.buffer.length,
          filename: outputPath ?? '<stdout>',
        }));
      }
    } catch (err: any) {
      if (!opts.silent || opts.showError) {
        const msg = formatError(err);
        error(`Failed to capture ${url}: ${msg}`);
      }
      process.exit(1);
    }
  }
}

async function captureWithRetry(
  url: string, opts: BcurlOptions, useDaemon: boolean
): Promise<CaptureResult> {
  const maxRetries = opts.retry ?? 0;
  const retryDelay = (opts.retryDelay ?? 1) * 1000;
  const retryMaxTime = opts.retryMaxTime ? opts.retryMaxTime * 1000 : Infinity;
  const retryStart = Date.now();

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (useDaemon) {
        try {
          return await captureViaDaemon(url, opts);
        } catch (daemonErr: any) {
          // Daemon failed — fall back to standalone with a warning
          if (!opts.silent) {
            process.stderr.write(`bcurl: daemon error, falling back to standalone: ${daemonErr.message}\n`);
          }
          return await launchAndCapture(url, opts);
        }
      }
      return await launchAndCapture(url, opts);
    } catch (err: any) {
      const elapsed = Date.now() - retryStart;
      if (attempt < maxRetries && elapsed < retryMaxTime) {
        if (!opts.silent) {
          process.stderr.write(
            `bcurl: attempt ${attempt + 1}/${maxRetries + 1} failed: ${err.message}\n`
            + `bcurl: retrying in ${retryDelay / 1000}s...\n`
          );
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Unreachable');
}

async function handleParallel(opts: BcurlOptions, remoteName: boolean): Promise<void> {
  const maxConc = opts.parallelMax ?? 4;
  const total = opts.urls.length;
  let succeeded = 0;
  let failed = 0;
  const globalStart = Date.now();

  if (!opts.silent) log(`Capturing ${total} URLs (max ${maxConc} parallel)...`);

  for await (const { url, result, error: err, index } of launchAndCaptureParallel(opts.urls, opts, maxConc)) {
    const num = succeeded + failed + 1;

    if (err) {
      failed++;
      if (opts.progress || !opts.silent) {
        process.stderr.write(`[${num}/${total}] \u2717 ${new URL(url).hostname} \u2014 Error: ${err}\n`);
      }
      continue;
    }

    succeeded++;
    const outputPath = resolveOutputPath(opts, url, result!.format, remoteName || true, index);

    if (outputPath) {
      if (opts.createDirs) {
        const dir = dirname(outputPath);
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      }
      writeFileSync(outputPath, result!.buffer);

      if (opts.progress || !opts.silent) {
        const elapsed = (result!.timing?.total ?? 0) / 1000;
        process.stderr.write(
          `[${num}/${total}] \u2713 ${new URL(url).hostname} \u2192 ${outputPath} (${elapsed.toFixed(1)}s)\n`
        );
      }
    }
  }

  const totalTime = ((Date.now() - globalStart) / 1000).toFixed(1);
  if (!opts.silent) {
    log(`\nDone: ${succeeded} succeeded, ${failed} failed in ${totalTime}s`);
  }

  if (failed > 0) process.exit(1);
}

function resolveOutputPath(
  opts: BcurlOptions, url: string, format: string, remoteName: boolean, index: number
): string | undefined {
  let outputPath: string | undefined = opts.output;
  if (remoteName && !outputPath) outputPath = deriveFilename(url, format);
  if (outputPath && opts.outputDir) outputPath = join(opts.outputDir, outputPath);
  else if (!outputPath && opts.outputDir) outputPath = join(opts.outputDir, deriveFilename(url, format));
  if (opts.urls.length > 1 && !outputPath) {
    outputPath = deriveFilename(url, format);
    if (opts.outputDir) outputPath = join(opts.outputDir, outputPath);
  }
  return outputPath;
}

function formatHeaderText(status?: number, headers?: Record<string, string>): string {
  let text = `HTTP/1.1 ${status ?? 0}\r\n`;
  if (headers) {
    for (const [k, v] of Object.entries(headers)) text += `${k}: ${v}\r\n`;
  }
  return text + '\r\n';
}

function log(msg: string): void { process.stderr.write(msg + '\n'); }
function error(msg: string): void { process.stderr.write(`bcurl: ${msg}\n`); }

function formatError(err: any): string {
  const msg: string = err.message ?? String(err);

  // Playwright-specific error messages → human-friendly
  if (msg.includes('net::ERR_NAME_NOT_RESOLVED'))
    return `DNS lookup failed — could not resolve hostname`;
  if (msg.includes('net::ERR_CONNECTION_REFUSED'))
    return `Connection refused — is the server running?`;
  if (msg.includes('net::ERR_CONNECTION_TIMED_OUT'))
    return `Connection timed out`;
  if (msg.includes('net::ERR_CERT_'))
    return `SSL certificate error (use -k to ignore): ${msg}`;
  if (msg.includes('Timeout') && msg.includes('exceeded'))
    return `Page load timeout exceeded (use -m to increase)`;
  if (msg.includes('Cannot connect to daemon'))
    return `Daemon connection failed — try --daemon-stop && --daemon, or use --no-daemon`;
  if (msg.includes('not found on page'))
    return msg; // Selector not found — already clear
  if (msg.includes('Replay failed'))
    return msg; // Replay error — already clear

  return msg;
}

main().catch((err) => {
  process.stderr.write(`bcurl: ${err.message}\n`);
  process.exit(1);
});
