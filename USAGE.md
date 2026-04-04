# bcurl — Browser-rendered curl

`bcurl` works like `curl`, but instead of returning HTML source code it renders the page
in a headless Chromium browser and returns a **screenshot image** (PNG, JPEG, or PDF).

## Installation

```bash
# From the project directory:
./install.sh

# Custom install location:
BCURL_INSTALL_DIR=$HOME/.local ./install.sh

# Uninstall:
./uninstall.sh
```

**Requirements:** Node.js >= 18, npm

---

## Quick Start

```bash
# Basic screenshot (writes PNG to stdout or terminal inline image)
bcurl https://example.com

# Save to file
bcurl -o screenshot.png https://example.com

# Custom viewport
bcurl --window-size 1920x1080 -o hd.png https://example.com

# Mobile device emulation
bcurl --device iphone-14 -o mobile.png https://example.com

# Full scrollable page
bcurl --full-page -o full.png https://example.com

# PDF output
bcurl --format pdf -o page.pdf https://example.com
```

---

## Flag Reference

### Output Flags

| Flag | Argument | Description |
|------|----------|-------------|
| `-o, --output` | `<file>` | Write screenshot to file instead of stdout |
| `-O, --remote-name` | — | Derive output filename from URL |
| `--output-dir` | `<dir>` | Directory to save files in |
| `--create-dirs` | — | Create necessary local directory hierarchy |
| `--format` | `png\|jpeg\|pdf` | Screenshot format (default: `png`) |
| `--quality` | `<0-100>` | JPEG quality |

### HTTP Flags (curl-compatible)

| Flag | Argument | Description |
|------|----------|-------------|
| `-H, --header` | `<header>` | Custom header, repeatable: `-H "Accept: text/html"` |
| `-A, --user-agent` | `<name>` | User-Agent string |
| `-e, --referer` | `<URL>` | Referrer URL |
| `-b, --cookie` | `<data>` | Send cookies: `"name=val"` or cookie file path. Repeatable |
| `-c, --cookie-jar` | `<file>` | Save cookies to Netscape-format file after capture |
| `-u, --user` | `<user:pass>` | HTTP Basic Auth credentials |
| `--oauth2-bearer` | `<token>` | OAuth 2 Bearer Token |
| `-X, --request` | `<method>` | HTTP method: GET, POST, PUT, etc. |
| `-d, --data` | `<data>` | HTTP POST data. Repeatable, joined with `&` |
| `--data-raw` | `<data>` | POST data without `@` file processing |
| `--data-urlencode` | `<data>` | URL-encoded POST data |
| `--json` | `<data>` | JSON POST data (sets Content-Type automatically) |
| `-F, --form` | `<name=content>` | Multipart form data. Repeatable |
| `-G, --get` | — | Send `-d` data as query string with GET |
| `-I, --head` | — | Show response headers only, no screenshot |
| `-L, --location` | — | Follow redirects (browser default — always on) |
| `--max-redirs` | `<num>` | Maximum number of redirects allowed |
| `--compressed` | — | Accept compressed responses (browser default) |
| `--resolve` | `<host:port:addr>` | Resolve host+port to specific address. Repeatable |

### Connection Flags

| Flag | Argument | Description |
|------|----------|-------------|
| `-x, --proxy` | `<[proto://]host[:port]>` | HTTP/SOCKS proxy |
| `-U, --proxy-user` | `<user:pass>` | Proxy authentication |
| `-k, --insecure` | — | Ignore SSL certificate errors |
| `-m, --max-time` | `<seconds>` | Maximum time for the entire operation |
| `--connect-timeout` | `<seconds>` | Maximum time for initial connection |
| `-4, --ipv4` | — | Resolve names to IPv4 only |
| `-6, --ipv6` | — | Resolve names to IPv6 only |

### Verbosity & Diagnostics

| Flag | Argument | Description |
|------|----------|-------------|
| `-v, --verbose` | — | Show request/response details on stderr |
| `-s, --silent` | — | Suppress all non-error output |
| `-S, --show-error` | — | Show errors even when `-s` is used |
| `-i, --include` | — | Print response headers before image output |
| `-D, --dump-header` | `<file>` | Write response headers to file |
| `-w, --write-out` | `<format>` | Print formatted info after completion (see below) |

#### `--write-out` Variables

```
%{http_code}          — HTTP status code (e.g. 200)
%{url_effective}      — Final URL after redirects
%{content_type}       — Content type (image/png, image/jpeg, etc.)
%{time_total}         — Total time in seconds
%{time_namelookup}    — DNS resolution time
%{time_connect}       — TCP connect time
%{time_starttransfer} — Time to first byte
%{size_download}      — Screenshot size in bytes
%{filename_effective} — Output filename
```

**Example:** `bcurl -s -w '%{http_code} %{time_total}s %{size_download}B\n' -o f.png url`

### Browser-Specific Flags

| Flag | Argument | Description |
|------|----------|-------------|
| `--window-size` | `<WxH>` | Viewport dimensions, e.g. `1920x1080` |
| `--full-page` | — | Capture entire scrollable page |
| `--device` | `<name>` | Emulate a device (see device list below) |
| `--dark-mode` | — | Emulate dark color scheme |
| `--javascript` | `<code>` | Execute JS before taking screenshot |
| `--no-javascript` | — | Disable JavaScript entirely |
| `--selector` | `<css>` | Screenshot only this CSS element |
| `--wait-for` | `<selector>` | Wait for element to appear before capture |
| `--wait` | `<ms>` | Wait N milliseconds after page load |
| `--delay` | `<ms>` | Alias for `--wait` |
| `--hide` | `<selector>` | Hide elements (e.g. cookie banners). Repeatable |
| `--click` | `<selector>` | Click element before capture. Repeatable |
| `--scroll-to` | `<selector>` | Scroll to element before capture |
| `--emulate-media` | `<type>` | CSS media type: `screen` or `print` |
| `--timezone` | `<tz>` | Timezone: `Europe/Berlin`, `America/New_York` |
| `--locale` | `<locale>` | Locale: `de-DE`, `en-US`, `ja-JP` |
| `--geolocation` | `<lat,lng>` | Fake GPS: `48.8566,2.3522` |
| `--block-images` | — | Block all image loading |
| `--scale` | `<factor>` | Device pixel ratio / scale factor |

#### Available Devices

```
iphone-12          (390x844, 3x)
iphone-14          (393x852, 3x)
iphone-14-pro-max  (430x932, 3x)
pixel-7            (412x915, 2.625x)
ipad               (810x1080, 2x)
ipad-pro           (1024x1366, 2x)
galaxy-s23         (360x780, 3x)
desktop-hd         (1920x1080, 1x)
desktop-4k         (3840x2160, 1x)
macbook-pro-16     (1728x1117, 2x)
```

### Session Persistence

Save and reuse browser sessions (cookies + localStorage) across invocations.
This avoids re-logging in every time.

| Flag | Argument | Description |
|------|----------|-------------|
| `--session` | `<file>` | Load session if file exists, save after capture. All-in-one. |
| `--save-session` | `<file>` | Save session state to file after capture (only save) |
| `--load-session` | `<file>` | Load session state from file before capture (only load) |

The session file is a JSON file containing cookies and localStorage entries
(Playwright `storageState` format).

**Typical workflow:**

```bash
# Step 1: Login and save session
bcurl --form-login https://app.example.com/login \
  --form-field 'input[name="user"]=admin' \
  --form-field 'input[type="password"]=secret' \
  --form-submit 'button:text-is("Login")' \
  --session session.json \
  -o dashboard.png https://app.example.com/dashboard

# Step 2: Reuse session — no login needed, fast!
bcurl --session session.json -o dashboard.png https://app.example.com/dashboard

# Step 3: Also works for other pages in the same app
bcurl --session session.json -o settings.png https://app.example.com/settings
```

**Split load/save for advanced use:**

```bash
# Save session from login, don't load anything
bcurl --form-login ... --save-session prod.json -o x.png https://app/dashboard

# Load session, don't overwrite the file
bcurl --load-session prod.json -o y.png https://app/other-page
```

### Form Login (Multi-Step Authentication)

For pages that require login before capture:

| Flag | Argument | Description |
|------|----------|-------------|
| `--form-login` | `<url>` | Navigate to this URL first to perform login |
| `--form-field` | `<selector=value>` | Fill a form field by CSS selector. Repeatable |
| `--form-submit` | `<selector>` | Click this element to submit the form |

CSS selectors support Playwright's extended syntax: `input[name="user"]`,
`input[placeholder*="Password"]`, `button:text-is("Login")`, `#submit-btn`, etc.

**Example — Login then capture dashboard:**

```bash
bcurl \
  --form-login 'https://app.example.com/login' \
  --form-field 'input[name="username"]=admin' \
  --form-field 'input[type="password"]=secret' \
  --form-submit 'button:text-is("Sign In")' \
  -o dashboard.png \
  https://app.example.com/dashboard
```

The tool will:
1. Open the `--form-login` URL
2. Fill each `--form-field` using `page.fill(selector, value)`
3. Click `--form-submit` and wait for navigation / SPA route change
4. Navigate to the target URL and take the screenshot

---

## Recipes

### Compare Desktop vs Mobile

```bash
bcurl --window-size 1920x1080 -o desktop.png https://example.com
bcurl --device iphone-14 -o mobile.png https://example.com
```

### Remove Cookie Banners

```bash
bcurl --hide '.cookie-banner, #consent-popup, [class*="cookie"]' \
  -o clean.png https://example.com
```

### Screenshot After Interaction

```bash
bcurl --click '#show-more-btn' --wait 1000 \
  -o expanded.png https://example.com
```

### Capture Specific Element

```bash
bcurl --selector 'main article' -o article.png https://blog.example.com/post
```

### Dark Mode Screenshot

```bash
bcurl --dark-mode -o dark.png https://example.com
```

### Inject Custom CSS/JS Before Capture

```bash
bcurl --javascript 'document.body.style.zoom = "150%"' \
  -o zoomed.png https://example.com
```

### Full-Page PDF

```bash
bcurl --format pdf --full-page -o report.pdf https://example.com
```

### Curl-Style Status Check

```bash
bcurl -s -w 'HTTP %{http_code} | %{size_download} bytes | %{time_total}s\n' \
  -o /dev/null https://example.com
```

### Via Proxy

```bash
bcurl -x http://proxy.corp:8080 -U user:pass -o page.png https://internal.app
```

### Batch Capture Multiple URLs

```bash
bcurl --output-dir ./screenshots --create-dirs -O \
  https://example.com https://example.org https://example.net
```

---

## Output Behavior

- **File (`-o`):** Writes raw image bytes to the specified path.
- **Piped stdout:** Writes raw image bytes (pipe to `> file.png` or another tool).
- **Terminal (TTY):** Auto-detects inline image support:
  - **iTerm2 / WezTerm:** Uses iTerm2 inline image protocol
  - **Kitty:** Uses Kitty graphics protocol
  - **Other terminals:** Warns and writes raw bytes

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `BCURL_INSTALL_DIR` | Custom install prefix (default: `/usr/local`) |

---

## Differences from curl

| Behavior | curl | bcurl |
|----------|------|-------|
| Output | HTML/text source | Rendered screenshot image |
| JS execution | None | Full browser JavaScript engine |
| Redirects | Requires `-L` | Always follows (browser behavior) |
| Compression | Requires `--compressed` | Always handled by browser |
| Cookies | Text-based | Full browser cookie jar |
| Rendering | None | Full CSS, fonts, images, layout |
| Protocols | HTTP, FTP, SMTP, ... | HTTP/HTTPS only (browser) |
