export interface BcurlOptions {
  // --- Output ---
  output?: string;
  outputDir?: string;
  createDirs?: boolean;
  format?: 'png' | 'jpeg' | 'pdf';
  quality?: number;

  // --- HTTP ---
  header?: string[];
  userAgent?: string;
  referer?: string;
  cookie?: string[];
  cookieJar?: string;
  user?: string;
  oauth2Bearer?: string;
  request?: string;
  data?: string[];
  dataRaw?: string[];
  dataUrlencode?: string[];
  json?: string[];
  form?: string[];
  get?: boolean;
  head?: boolean;
  location?: boolean;
  maxRedirs?: number;
  compressed?: boolean;

  // --- Connection ---
  proxy?: string;
  proxyUser?: string;
  insecure?: boolean;
  maxTime?: number;
  connectTimeout?: number;
  resolve?: string[];
  interface?: string;
  ipv4?: boolean;
  ipv6?: boolean;

  // --- Verbosity / Info ---
  verbose?: boolean;
  silent?: boolean;
  showError?: boolean;
  include?: boolean;
  writeOut?: string;
  dumpHeader?: string;

  // --- Browser-specific ---
  windowSize?: string;
  fullPage?: boolean;
  device?: string;
  darkMode?: boolean;
  javascript?: string;
  noJavascript?: boolean;
  selector?: string;
  waitFor?: string;
  wait?: number;
  hide?: string[];
  click?: string[];
  scrollTo?: string;
  emulateMedia?: string;
  extraHttpHeaders?: Record<string, string>;
  timezone?: string;
  locale?: string;
  geolocation?: string;
  permissions?: string[];
  colorScheme?: 'light' | 'dark' | 'no-preference';
  blockImages?: boolean;
  noImages?: boolean;

  // --- Session ---
  session?: string;
  saveSession?: string;
  loadSession?: string;

  // --- Form Login ---
  formLogin?: string;
  formField?: string[];
  formSubmit?: string;

  // --- Internal ---
  urls: string[];
}

export interface CaptureResult {
  url: string;
  buffer: Buffer;
  format: 'png' | 'jpeg' | 'pdf';
  headers?: Record<string, string>;
  status?: number;
  timing?: {
    dns?: number;
    connect?: number;
    ttfb?: number;
    domLoaded?: number;
    loaded?: number;
    total: number;
  };
}

export interface WriteOutVars {
  url: string;
  status: number;
  contentType: string;
  timeTotal: number;
  timeDns: number;
  timeConnect: number;
  timeTtfb: number;
  sizeDownload: number;
  filename: string;
}

export const DEVICES: Record<string, { viewport: { width: number; height: number }; userAgent: string; deviceScaleFactor: number; isMobile: boolean; hasTouch: boolean }> = {
  'iphone-12': {
    viewport: { width: 390, height: 844 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iphone-14': {
    viewport: { width: 393, height: 852 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'iphone-14-pro-max': {
    viewport: { width: 430, height: 932 },
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
  'pixel-7': {
    viewport: { width: 412, height: 915 },
    userAgent: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
    deviceScaleFactor: 2.625,
    isMobile: true,
    hasTouch: true,
  },
  'ipad': {
    viewport: { width: 810, height: 1080 },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  'ipad-pro': {
    viewport: { width: 1024, height: 1366 },
    userAgent: 'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  'desktop-hd': {
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  'desktop-4k': {
    viewport: { width: 3840, height: 2160 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
  'macbook-pro-16': {
    viewport: { width: 1728, height: 1117 },
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    deviceScaleFactor: 2,
    isMobile: false,
    hasTouch: false,
  },
  'galaxy-s23': {
    viewport: { width: 360, height: 780 },
    userAgent: 'Mozilla/5.0 (Linux; Android 13; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
  },
};
