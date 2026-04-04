# bcurl

**Like curl, but returns a browser-rendered screenshot instead of source code.**

bcurl renders web pages in a headless Chromium browser and captures them as PNG, JPEG, or PDF — with a curl-compatible CLI interface.

## Quick Start

```bash
# Install
./install.sh

# Basic screenshot
bcurl -o screenshot.png https://example.com

# Custom viewport
bcurl --window-size 1920x1080 -o page.png https://example.com

# Mobile device
bcurl --device iphone-14 -o mobile.png https://example.com

# Full scrollable page as PDF
bcurl --full-page --format pdf -o page.pdf https://example.com
```

## Features

### Curl-Compatible Flags

Works like curl where it makes sense — same flags, same muscle memory:

```bash
bcurl -o file.png URL              # Output to file
bcurl -H "Auth: Bearer tok" URL    # Custom headers
bcurl -A "MyBot/1.0" URL           # User-Agent
bcurl -b "session=abc" URL         # Cookies
bcurl -u user:pass URL             # Basic Auth
bcurl -x http://proxy:8080 URL     # Proxy
bcurl -k URL                       # Ignore SSL errors
bcurl -v URL                       # Verbose output
bcurl -s -w '%{http_code}\n' URL   # Silent + stats
bcurl -I URL                       # Headers only
bcurl -d 'key=val' -X POST URL    # POST data
```

### Browser Features

```bash
bcurl --window-size 1920x1080 URL          # Viewport size
bcurl --device iphone-14 URL               # Device emulation
bcurl --full-page URL                      # Full scrollable page
bcurl --dark-mode URL                      # Dark color scheme
bcurl --selector "main article" URL        # Capture specific element
bcurl --hide ".cookie-banner" URL          # Hide elements
bcurl --click "#load-more" --wait 1000 URL # Interact before capture
bcurl --javascript 'document.body.style.zoom="150%"' URL
bcurl --format pdf URL                     # PDF output
```

Available devices: `iphone-12`, `iphone-14`, `iphone-14-pro-max`, `pixel-7`, `ipad`, `ipad-pro`, `galaxy-s23`, `desktop-hd`, `desktop-4k`, `macbook-pro-16`

### Form Login + Session Persistence

Log into web apps and reuse the session across invocations:

```bash
# Step 1: Login and save session
bcurl \
  --form-login https://app.example.com/login \
  --form-field 'input[name="username"]=admin' \
  --form-field 'input[type="password"]=secret' \
  --form-submit 'button:text-is("Sign In")' \
  --session session.json \
  -o dashboard.png https://app.example.com/dashboard

# Step 2: Reuse session — no login needed
bcurl --session session.json -o dashboard.png https://app.example.com/dashboard
```

The session file stores cookies and localStorage (including JWT tokens, auth state). Subsequent calls skip the login entirely.

## Installation

### Requirements

- Node.js >= 18
- npm

### Install System-Wide

```bash
git clone https://github.com/christianbuerckert/bcurl.git
cd bcurl
./install.sh
```

This installs `bcurl` to `/usr/local/bin`. Custom location:

```bash
BCURL_INSTALL_DIR=$HOME/.local ./install.sh
```

### Uninstall

```bash
./uninstall.sh
```

## Documentation

See [USAGE.md](USAGE.md) for the complete flag reference, all `--write-out` variables, recipes, and detailed examples.

```bash
bcurl --help    # Quick reference with examples
```

## License

MIT
