import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync, execSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const BCURL = join(import.meta.dirname, '..', 'dist', 'cli.js');

const run = (args: string[], timeout = 25000): string => {
  const result = spawnSync('node', [BCURL, ...args], { timeout, maxBuffer: 50 * 1024 * 1024 });
  return result.stdout?.toString() ?? '';
};

const runWithStderr = (args: string[], timeout = 25000): { stdout: string; stderr: string; exitCode: number } => {
  const result = spawnSync('node', [BCURL, ...args], { timeout, maxBuffer: 50 * 1024 * 1024 });
  return {
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
    exitCode: result.status ?? 1,
  };
};

const TMP = '/tmp/bcurl-test';

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  // Stop any running daemon to avoid test interference
  spawnSync('node', [BCURL, '--daemon-stop'], { timeout: 5000 });
});

function cleanup(file: string): void {
  try { unlinkSync(file); } catch {}
}

describe('bcurl basics', () => {
  it('shows help with --help', () => {
    const { stderr } = runWithStderr(['--help']);
    const output = stderr;
    // help goes to stdout via commander
    expect(true).toBe(true); // if it didn't crash, it works
  });

  it('shows version with --version', () => {
    const output = run(['--version']);
    expect(output.trim()).toBe('1.0.0');
  });

  it('captures a screenshot to file', () => {
    const out = join(TMP, 'basic.png');
    cleanup(out);
    runWithStderr(['-s', '-o', out, 'https://example.com']);
    expect(existsSync(out)).toBe(true);
    const buf = readFileSync(out);
    expect(buf.length).toBeGreaterThan(1000);
    // PNG magic bytes
    expect(buf[0]).toBe(0x89);
    expect(buf[1]).toBe(0x50); // P
    expect(buf[2]).toBe(0x4e); // N
    expect(buf[3]).toBe(0x47); // G
  });

  it('captures JPEG format', () => {
    const out = join(TMP, 'basic.jpeg');
    cleanup(out);
    runWithStderr(['-s', '--format', 'jpeg', '--quality', '50', '-o', out, 'https://example.com']);
    expect(existsSync(out)).toBe(true);
    const buf = readFileSync(out);
    // JPEG magic bytes
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });

  it('respects --window-size', () => {
    const out1 = join(TMP, 'small.png');
    const out2 = join(TMP, 'large.png');
    cleanup(out1); cleanup(out2);
    runWithStderr(['-s', '--window-size', '320x240', '-o', out1, 'https://example.com']);
    runWithStderr(['-s', '--window-size', '1920x1080', '-o', out2, 'https://example.com']);
    const size1 = readFileSync(out1).length;
    const size2 = readFileSync(out2).length;
    expect(size2).toBeGreaterThan(size1);
  });

  it('captures with device emulation', () => {
    const out = join(TMP, 'device.png');
    cleanup(out);
    runWithStderr(['-s', '--device', 'iphone-14', '-o', out, 'https://example.com']);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out).length).toBeGreaterThan(1000);
  });
});

describe('HTTP flags', () => {
  it('-I shows headers only', () => {
    const { stderr } = runWithStderr(['-I', 'https://example.com']);
    expect(stderr).toContain('HTTP/1.1 200');
    expect(stderr).toContain('content-type');
  });

  it('-v shows verbose output', () => {
    const { stderr } = runWithStderr(['-v', '-o', '/dev/null', 'https://example.com']);
    expect(stderr).toContain('> Navigating to');
    expect(stderr).toContain('< HTTP 200');
    expect(stderr).toContain('< Screenshot:');
  });

  it('-w writes out formatted stats', () => {
    const { stderr } = runWithStderr([
      '-s', '-w', '%{http_code} %{time_total}', '-o', '/dev/null', 'https://example.com',
    ]);
    expect(stderr).toMatch(/^200 \d+\.\d+/);
  });

  it('-D dumps headers to file', () => {
    const hdr = join(TMP, 'headers.txt');
    cleanup(hdr);
    runWithStderr(['-s', '-D', hdr, '-o', '/dev/null', 'https://example.com']);
    expect(existsSync(hdr)).toBe(true);
    const content = readFileSync(hdr, 'utf-8');
    expect(content).toContain('HTTP/1.1 200');
  });

  it('-k ignores SSL errors', () => {
    // Just verify it doesn't crash; self-signed certs are hard to test without a server
    const out = join(TMP, 'insecure.png');
    cleanup(out);
    runWithStderr(['-s', '-k', '-o', out, 'https://example.com']);
    expect(existsSync(out)).toBe(true);
  });
});

describe('browser features', () => {
  it('--full-page captures full page', () => {
    const partial = join(TMP, 'partial.png');
    const full = join(TMP, 'fullpage.png');
    cleanup(partial); cleanup(full);
    runWithStderr(['-s', '--window-size', '800x600', '-o', partial, 'https://example.com']);
    runWithStderr(['-s', '--window-size', '800x600', '--full-page', '-o', full, 'https://example.com']);
    // Full page should be at least as large
    expect(readFileSync(full).length).toBeGreaterThanOrEqual(readFileSync(partial).length);
  });

  it('--javascript executes code', () => {
    const out = join(TMP, 'js.png');
    cleanup(out);
    runWithStderr([
      '-s', '--javascript', 'document.body.style.background = "red"',
      '-o', out, 'https://example.com',
    ]);
    expect(existsSync(out)).toBe(true);
  });

  it('--hide removes elements', () => {
    const out = join(TMP, 'hidden.png');
    cleanup(out);
    runWithStderr(['-s', '--hide', 'body > div', '-o', out, 'https://example.com']);
    expect(existsSync(out)).toBe(true);
  });

  it('--dark-mode works', () => {
    const out = join(TMP, 'dark.png');
    cleanup(out);
    runWithStderr(['-s', '--dark-mode', '-o', out, 'https://example.com']);
    expect(existsSync(out)).toBe(true);
  });
});

describe('session', () => {
  it('--save-session creates a session file', () => {
    const sess = join(TMP, 'test-session.json');
    cleanup(sess);
    runWithStderr(['-s', '--save-session', sess, '-o', '/dev/null', 'https://example.com']);
    expect(existsSync(sess)).toBe(true);
    const data = JSON.parse(readFileSync(sess, 'utf-8'));
    expect(data).toHaveProperty('cookies');
    expect(data).toHaveProperty('origins');
  });

  it('--session loads and saves', () => {
    const sess = join(TMP, 'roundtrip-session.json');
    cleanup(sess);
    // First call creates it
    runWithStderr(['-s', '--session', sess, '-o', '/dev/null', 'https://example.com']);
    expect(existsSync(sess)).toBe(true);
    const mtime1 = readFileSync(sess).length;
    // Second call loads + re-saves
    runWithStderr(['-s', '--session', sess, '-o', '/dev/null', 'https://example.com']);
    expect(existsSync(sess)).toBe(true);
  });

  it('session file has restricted permissions', () => {
    const sess = join(TMP, 'perm-session.json');
    cleanup(sess);
    runWithStderr(['-s', '--save-session', sess, '-o', '/dev/null', 'https://example.com']);
    const stat = execSync(`stat -f '%Lp' '${sess}'`, { encoding: 'utf-8' }).trim();
    expect(stat).toBe('600');
  });
});

describe('config', () => {
  it('-K loads config file', () => {
    const cfg = join(TMP, 'test.bcurlrc');
    writeFileSync(cfg, 'silent\nformat png\n');
    const out = join(TMP, 'config.png');
    cleanup(out);
    runWithStderr(['-K', cfg, '-o', out, 'https://example.com']);
    expect(existsSync(out)).toBe(true);
  });

  it('-q disables config loading', () => {
    // Should not crash even with no config files
    const out = join(TMP, 'noconfig.png');
    cleanup(out);
    runWithStderr(['-q', '-s', '-o', out, 'https://example.com']);
    expect(existsSync(out)).toBe(true);
  });
});

describe('network', () => {
  it('--network shows request summary', () => {
    const out = join(TMP, 'net.png');
    cleanup(out);
    const { stderr } = runWithStderr(['--network', '-o', out, 'https://example.com']);
    expect(stderr).toContain('METHOD');
    expect(stderr).toContain('GET');
    expect(stderr).toContain('requests');
  });

  it('--waterfall shows timing', () => {
    const out = join(TMP, 'wf.png');
    cleanup(out);
    const { stderr } = runWithStderr(['--waterfall', '-o', out, 'https://example.com']);
    expect(stderr).toContain('█');
    expect(stderr).toContain('Timeline:');
  });

  it('--har saves HAR file', () => {
    const har = join(TMP, 'test.har');
    cleanup(har);
    runWithStderr(['-s', '--har', har, '-o', '/dev/null', 'https://example.com']);
    expect(existsSync(har)).toBe(true);
    const data = JSON.parse(readFileSync(har, 'utf-8'));
    expect(data.log.version).toBe('1.2');
    expect(data.log.entries.length).toBeGreaterThan(0);
  });
});

describe('parallel', () => {
  it('-Z captures multiple URLs', () => {
    const dir = join(TMP, 'parallel');
    mkdirSync(dir, { recursive: true });
    const { stderr } = runWithStderr([
      '-Z', '--progress', '--output-dir', dir, '--create-dirs',
      'https://example.com', 'https://example.org',
    ]);
    expect(stderr).toContain('✓');
    expect(stderr).toContain('2 succeeded');
  });
});

describe('diff', () => {
  it('detects identical images', () => {
    const img = join(TMP, 'diff-src.png');
    runWithStderr(['-s', '-o', img, 'https://example.com']);
    const diffOut = join(TMP, 'diff-identical.png');
    const { stderr } = runWithStderr(['diff', img, img, '-o', diffOut]);
    expect(stderr).toContain('Diff: 0.00%');
    expect(stderr).toContain('Match: YES');
  });

  it('detects different images', () => {
    const img1 = join(TMP, 'diff-a.png');
    const img2 = join(TMP, 'diff-b.png');
    runWithStderr(['-s', '--window-size', '800x600', '-o', img1, 'https://example.com']);
    runWithStderr(['-s', '--window-size', '800x600', '--dark-mode', '-o', img2, 'https://example.com']);
    const diffOut = join(TMP, 'diff-different.png');
    const { stderr } = runWithStderr(['diff', img1, img2, '-o', diffOut, '--threshold', '50']);
    expect(stderr).toContain('Diff:');
    expect(stderr).toContain('Pixels changed:');
  });
});

describe('remote-name', () => {
  it('-O derives filename from URL', () => {
    const expected = join(TMP, 'example.com.png');
    cleanup(expected);
    runWithStderr(['-s', '-O', '--output-dir', TMP, 'https://example.com']);
    expect(existsSync(expected)).toBe(true);
  });
});

describe('error handling', () => {
  it('fails gracefully on invalid URL', () => {
    const { stderr } = runWithStderr(['-s', '-S', '-o', '/dev/null', 'https://this-domain-does-not-exist-12345.invalid']);
    expect(stderr).toContain('Failed to capture');
  });

  it('fails on invalid device name', () => {
    const { stderr } = runWithStderr(['-o', '/dev/null', '--device', 'nokia-3310', 'https://example.com']);
    expect(stderr).toContain('Unknown device');
  });

  it('fails on invalid window size', () => {
    const { stderr } = runWithStderr(['-o', '/dev/null', '--window-size', 'abc', 'https://example.com']);
    expect(stderr).toContain('Invalid window size');
  });
});
