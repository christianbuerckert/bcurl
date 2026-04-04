import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const CONFIG_LOCATIONS = [
  '/etc/bcurlrc',
  join(homedir(), '.bcurlrc'),
  join(process.cwd(), '.bcurlrc'),
];

/**
 * Parse a .bcurlrc config file into argv-style arguments.
 *
 * Format (same as curl's .curlrc):
 *   # comment
 *   window-size 1920x1080
 *   format = png
 *   silent
 *   header "Accept-Language: de-DE"
 */
export function parseConfigFile(filePath: string): string[] {
  if (!existsSync(filePath)) return [];

  const content = readFileSync(filePath, 'utf-8');
  const args: string[] = [];

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) continue;

    // Split into key and optional value
    // Handle: "key value", "key=value", "key = value", "key" (boolean)
    const match = line.match(/^([a-zA-Z0-9_-]+)\s*(?:=\s*|\s+)?(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2]?.trim() ?? '';

    // Remove surrounding quotes from value
    if (value) {
      value = unquote(value);
    }

    args.push(`--${key}`);
    if (value) {
      args.push(value);
    }
  }

  return args;
}

/**
 * Load config from all standard locations + explicit -K path.
 * Returns argv-style arguments to prepend.
 */
export function loadConfig(explicitConfig?: string, disabled?: boolean): string[] {
  const args: string[] = [];

  // Load from standard locations (unless disabled with -q)
  if (!disabled) {
    for (const loc of CONFIG_LOCATIONS) {
      args.push(...parseConfigFile(loc));
    }
  }

  // Always load explicit -K config (even if -q is set)
  if (explicitConfig) {
    if (!existsSync(explicitConfig)) {
      throw new Error(`Config file not found: ${explicitConfig}`);
    }
    args.push(...parseConfigFile(explicitConfig));
  }

  return args;
}

/**
 * Check if -q/--disable is in raw argv (before full parsing).
 */
export function isConfigDisabled(argv: string[]): boolean {
  return argv.includes('-q') || argv.includes('--disable');
}

/**
 * Extract -K/--config value from raw argv (before full parsing).
 */
export function getExplicitConfig(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '-K' || argv[i] === '--config') {
      return argv[i + 1];
    }
    if (argv[i].startsWith('--config=')) {
      return argv[i].split('=').slice(1).join('=');
    }
  }
  return undefined;
}

function unquote(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    // Handle escaped quotes
    return inner.replace(/\\"/g, '"').replace(/\\'/g, "'");
  }
  return s;
}
