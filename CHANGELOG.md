# Changelog

## [2.4.0] - 2026-04-07

### Added
- **`screenshot({ savePath })`** — Save screenshots directly to a file instead of returning base64. Much cheaper on context when visual inspection by the agent is not needed.

## [2.3.0] - 2026-04-06

### Added
- **`query` tool** — DOM query shortcut: extract text and attributes from elements without writing JavaScript. Replaces most `evaluate` calls.
- **`download` tool** — Download files using the browser session (cookies/auth). No more manual cookie extraction for PDFs, CSVs, etc.
- **`scroll_and_collect` tool** — Scroll through virtualized lists/grids, collect items, and deduplicate. Ideal for lazy-loaded tables.
- **`html({ compact: true })`** — Stripped-down HTML output: no scripts, styles, SVGs, comments, hidden elements. Returns only structural/interactive HTML (~100x smaller).
- **Login form auto-detection** — `navigate` and `click` responses include detected login form fields with CSS selectors.

### Changed
- **Screenshot default** changed from PNG to JPEG quality 40 (~10x smaller context usage).
- **`text` tool** promoted as preferred over screenshot in tool descriptions.
- **`evaluate` tool** — Always wraps in async IIFE (no manual async/sync distinction), auto-returns single expressions, result always stringified (no more undefined/Promise errors), errors returned as JSON.

## [2.2.0] - 2026-04-06

### Added
- **Live Dashboard** — HTTPS dashboard with real-time browser screenshots, activity log, and secrets management. Open once, stays open for the session.
- **Secure secret input** (`fill_form`) — Agent requests passwords/2FA codes without ever seeing them. User enters credentials via the dashboard. Supports multiple fields at once (username + password + TOTP in one prompt).
- **Session cache** — Secrets are cached in memory for the session (except TOTP). No re-entry needed for repeated logins.
- **Login form auto-detection** — `navigate` and `click` responses include detected login form fields with selectors, so the agent doesn't need to guess.
- **Session persistence** (`save_session` / `load_session`) — Save browser state (cookies, localStorage) to file and restore later. Secrets stay in memory only, never written to disk.
- **Activity auto-logging** — Every MCP tool call is logged to the dashboard with sensitive values masked.
- **Secrets tab** in dashboard — View and delete cached credentials.
- New MCP tools: `dashboard`, `fill_form`, `wait_for_secret`, `list_secrets`, `save_session`, `load_session`

## [2.1.0] - 2026-03-29

### Added
- **Login tool** — One-call form login: navigate, fill credentials, submit, wait for redirect.
- **Upload tool** — Upload files to file inputs (path or base64 content).
- **Assert tool** — QA-style assertions: check elements, text, URL, title with pass/fail results.
- **Async evaluate** — `evaluate` tool now supports top-level `await`.
- Device emulation fix for MCP screenshot tool.

## [2.0.0] - 2026-03-22

### Added
- **MCP server mode** (`bcurl --mcp`) — 24 tools for AI agent browser automation.
- Navigation tools: navigate, click, fill, select, hover, press, scroll, back, forward, reload.
- Output tools: screenshot, html, text, pdf, network.
- Session tools: new_context, cookies.
- Homebrew formula.

## [1.0.0] - 2026-03-15

### Added
- **Daemon mode** (`bcurl --daemon`) — Background browser for fast repeated captures.
- **Network analysis** — HAR export, request logging.
- **Parallel capture** — Multiple URLs with concurrency control.
- **Visual diff** — Pixel-by-pixel screenshot comparison.
- **Record & replay** — Capture and replay browser interactions.
- **Config files** — `/etc/bcurlrc`, `~/.bcurlrc`, `./.bcurlrc`.
- Retry support, improved error UX.
- Test suite.

## [0.1.0] - 2026-03-08

### Added
- Initial release: browser-rendered curl.
- Screenshot capture (PNG, JPEG, PDF).
- HTTP Basic Auth, OAuth2 Bearer, form-based login with session persistence.
- Cookie management (inline and Netscape jar format).
- Device emulation, viewport control, dark mode.
- Custom headers, POST data, JavaScript execution.
- `--write-out` variable expansion (like curl).
