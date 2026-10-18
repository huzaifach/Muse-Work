# agent-browser

A **command-only, agent-first browser CLI**. No GUI, no dashboard, no LLM API key, no cloud subscription — just deterministic commands an AI agent can run from a shell, with **bulk mode** for running one action template across hundreds of URLs in parallel.

Built on Chromium via `playwright-core`. It does not reinvent the rendering engine; it is a thin, opinionated agent layer on top of the best one that already exists. The release pattern is the ArtCraft one: **CLI (scripts) + MCP server (agents)** in one package.

## Why another browser tool?

| Tool | What it is | The gap |
|---|---|---|
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Fast Rust CLI + daemon, interactive sessions, accessibility snapshots | Single-session and interactive; no built-in parallel bulk runs, no token-budgeted dumps |
| [Stagehand](https://github.com/browserbase/stagehand) / [browser-use](https://github.com/browser-use/browser-use) / [Skyvern](https://github.com/Skyvern-AI/skyvern) | Agent frameworks with LLM-driven actions | Every step costs LLM tokens; built for *reasoning* agents, not for cheap deterministic batch jobs |

**agent-browser's differentiators:**

1. **Bulk mode is the headline, not an afterthought.** `bulk --input urls.jsonl --actions actions.json --concurrency 5` runs an action template across many URLs with per-item timeouts, retries, per-URL complete output files, conditional steps, chained variables, incremental runs, and resume. Built for the jobs agents actually batch: price checks, content extraction, screenshot audits, link validation.
2. **LLM-context-native output.** `dump` returns page content as clean Markdown *optimized for agent context windows*, with a built-in token estimate and a `--max-tokens` budget flag. Every command speaks `--json`; errors are machine-readable with non-zero exit codes.
3. **Zero-install browser.** Single Node.js CLI, no background service to configure, no LLM key, no per-step billing. Polite by default when you ask it to be: `--respect-robots` and `--delay-ms`.
4. **Headed stealth mode.** `--headed` opens a real Chromium window on a virtual display (Xvfb) with webdriver-hiding and fingerprint evasions — measured honestly against bot-detection pages (see Limits).

## Install

Requirements: **Node.js 18+** and a Chromium binary.

```bash
git clone <this-repo> agent-browser
cd agent-browser
npm install
```

Chromium resolution order:
1. `AGENT_BROWSER_CHROMIUM` env var (path to a Chrome/Chromium binary)
2. Playwright's cached headless shell (`~/.cache/ms-playwright/...`)
3. Otherwise install one: `npx playwright install chromium`

For `--headed` you need a **full** Chromium (headless_shell cannot open a window):
- `AGENT_BROWSER_CHROMIUM_HEADED` env var, or the newest `~/.cache/ms-playwright/chromium-*/chrome-linux/chrome`
- Xvfb for the virtual display (`apt install xvfb`); the CLI starts and owns one automatically

Verify:

```bash
node bin/agent-browser.js open https://example.com --json
# {"ok":true,"command":"open","url":"https://example.com/","title":"Example Domain","status":200}
```

Tip: symlink it onto your PATH — `ln -s $PWD/bin/agent-browser.js /usr/local/bin/agent-browser`.

## Quick start

```bash
# open a page (starts a persistent background browser on first run)
agent-browser open https://example.com

# LLM-ready markdown of the page + token estimate
agent-browser dump --max-tokens 2000 --json

# structured extraction (full text — never truncated)
agent-browser extract --selector "h1" --json

# HTML tables → JSON rows or CSV
agent-browser extract --selector "table.data" --table --json

# interact, then verify
agent-browser type --selector "#search" --text "headless browsers" --submit
agent-browser fill --fields '{"#name":"Ali","#email":"a@b.c"}' --submit
agent-browser upload --selector "#file" --file ./report.pdf
agent-browser eval --js "document.title" --json

# assert for QA audits (non-zero exit on failure)
agent-browser assert --selector h1 --text "Example Domain"

# screenshot / pdf / visual diff
agent-browser shot --out shot.png --full-page
agent-browser shot-diff --a old.png --b new.png --out diff.png

# network log (request/response/failed → JSONL)
agent-browser netlog https://example.com --out netlog.jsonl

# bulk: one action template × many URLs, 5 at a time
agent-browser bulk --input urls.jsonl --actions actions.json --concurrency 5 --out-dir out/

# crawl a site → URL list → straight into bulk
agent-browser crawl https://example.com --max-pages 50 --max-depth 2 --out urls.jsonl

# schedule a recurring bulk job
agent-browser schedule add --cron "0 9 * * *" -- bulk --input urls.jsonl --actions actions.json --out-dir out/

# expose everything as MCP tools for any agent
agent-browser mcp
```

## Commands

Single-page commands share one stateful session: `open` first, then the rest act on the active tab. The browser lives in a detached background daemon per `--profile`; it survives between CLI invocations until `close`. Sessions are health-checked before reuse and auto-recovered (close + fresh open) on timeout.

| Command | Purpose | Key flags |
|---|---|---|
| `open <url>` | Navigate the active tab | `--wait load\|networkidle\|domcontentloaded\|<ms>`, `--proxy <url>` |
| `shot` | Screenshot → PNG | `--out`, `--full-page`, `--selector css` |
| `shot-diff` | Pixel-diff two screenshots | `--a`, `--b` (required), `--out`, `--threshold N` → diff % + diff image |
| `dump` | Page → clean Markdown/text/HTML + token estimate | `--format markdown\|text\|html`, `--max-tokens N`, `--out` |
| `extract` | CSS selector → JSON items (full text) | `--selector` (required), `--attr a,b`, `--limit N` (opt-in item cap), `--table`, `--csv` |
| `click` | Click an element | `--selector` (required), `--wait-nav` |
| `type` | Type into an input | `--selector`, `--text` (required), `--clear`, `--submit` |
| `fill` | Fill many fields at once | `--fields '{"#a":"x"}'` (required; handles text/select/checkbox), `--submit` |
| `upload` | Set a file input's file | `--selector` (required), `--file` (required) |
| `scroll` | Scroll the page | `--to bottom\|top\|<px>`, `--selector css` |
| `move` | Move the cursor the human way (never clicks) | `--selector css` or `--x N --y N` |
| `wait` | Wait | `--ms N`, `--selector css [--state visible\|attached\|hidden]`, `--load networkidle` |
| `eval` | Run JS in page context | `--js "..."` (return a JSON-serializable value) |
| `assert` | QA assertion (exit 1 on fail) | `--selector css --text expected` or `--js "expression"` |
| `netlog` | Capture network traffic → JSONL | `--out`, `--wait-ms N` |
| `pdf` | Save page as PDF | `--out` |
| `tab-new` | Open a new tab | `--url` |
| `tab-list` | List tabs (stable ids, `*` = active) | — |
| `tab-switch <id>` | Switch the active tab | — |
| `tab-close [id]` | Close a tab (default: active) | — |
| `crawl <url>` | BFS crawl → JSONL URL list | `--max-pages N`, `--max-depth D`, `--same-domain` (default), `--all-domains`, `--out` |
| `sessions` | List live sessions (marks stale PIDs) | — |
| `close` | Kill session daemon(s) | `--profile name`, `--all` |

Global flags: `--json`, `--profile <name>` (persistent cookies/logins on disk; the default profile is ephemeral), `--timeout-ms <n>` (default 30000), `--proxy <url>` (new sessions), `--respect-robots`, `--headed`.

Exit codes: `0` ok · `1` action/assertion failed · `2` browser/session failure · `3` usage error · `4` blocked by robots.txt. Errors are JSON with `--json`:

```json
{"ok":false,"error":"NOT_FOUND","message":"locator.waitFor: Timeout 30000ms exceeded.","hint":"check the selector with: extract --selector ... or dump"}
```

## Headed stealth mode (`--headed`)

`--headed` launches a **full Chromium with a real window** on a virtual display (Xvfb is started and owned automatically; reuses `:99` if already up), with stealth evasions: `--disable-blink-features=AutomationControlled`, hidden `navigator.webdriver`, realistic Linux Chrome user-agent, faked plugins (pass `instanceof PluginArray`) and languages, 1366×768 viewport. Headed and headless sessions are fully separate (`default-headed` vs `default`) so the flag never hijacks the wrong browser.

**Honest measurement** (2026-10-18, headed Chromium 143 on Xvfb, https://bot.sannysoft.com):

| Check | Result |
|---|---|
| User Agent, Chrome object, Permissions, Languages, Broken-image dims | ✅ pass |
| WebDriver (basic + advanced) | ✅ pass (`navigator.webdriver === false`, prototype-shaped like real Chrome) |
| Plugins length + `instanceof PluginArray` | ✅ pass |
| WebGL vendor | ✅ pass |
| **WebGL renderer** | ❌ **fail** — SwiftShader (software GL; this VM has no GPU) |
| Fingerprint Scanner suite (20 tests) | ✅ all ok |

### Human-behavior mimicry (`lib/humanize.js`)

Fingerprint evasions beat *static* checks. Behavioral detection watches *how* you act: teleporting cursors, metronomic typing, instant jumps. In headed mode, `click`/`type`/`scroll`/`fill`/`move` automatically take the human path:

- **Mouse**: bezier-curve paths (never straight lines), ease in/out + jitter → variable speed, ~4% micro-pauses, ~35% slight overshoot + correction on longer moves.
- **Typing**: variable 40–140ms keystroke cadence, ~3% typo → pause → backspace → retype.
- **Scroll**: real wheel events with momentum-like easing (fast start, gentle landing), not instant `scrollTo` jumps.
- **Ambient**: ~18% of actions are preceded by a safe drift (small mouse move, net-zero scroll). **Never clicks anything unasked** — a random click could hit logout/delete/buy, so ambient behavior is movement/scroll only, and the humanize layer only ever performs the action the task already requested.

**Honest behavioral measurement** (2026-10-18, headed mode, instrumented local page recording exactly what a site observes):

| Signal (as the page saw it) | Result |
|---|---|
| `mousemove` events during a click | 68 events (a synthetic `el.click()` produces **zero**) |
| Path curvature (path ÷ straight-line) | **1.52** — clearly curved, not a bot line |
| Typing cadence (16 chars) | min 47ms / max 137ms / mean 91ms — variable, in the human band |
| `wheel` events during scroll | 24 events with decaying deltas (270→…→133) — visible momentum |
| Typo correction | occurred and self-corrected; final field value exact |

External check: [CreepJS](https://abrahamjuliot.github.io/creepjs/) reports **0% stealth-tool signatures**, but still rates the browser 33–50% "headless-like" (it is Chromium; software WebGL; VM tells like 2 cores remain). Behavioral mimicry raises the bar; it does not make a VM browser indistinguishable from a human's laptop.

What this means: the evasions beat naive checks (webdriver flag, plugin/languages presence, headless tells). They do **not** defeat hardened stacks (Cloudflare, PerimeterX, DataDome), IP-reputation blocks, or behavior analysis — and nothing here solves CAPTCHAs. `shots/botcheck-headed.png` in this repo is the screenshot proof. Never trust a stealth claim without a screenshot like that one.

## Bulk mode

```bash
agent-browser bulk --input urls.jsonl --actions actions.json \
  --concurrency 5 --retries 1 --item-timeout-ms 60000 \
  --out-dir out/ --failures failures.jsonl \
  --delay-ms 500 --max-per-domain 2 --respect-robots \
  --since state.json --resume --proxy-list proxies.txt --headed
```

**urls.jsonl** — one URL per line, or JSON per line for custom ids:

```
https://example.com
{"url": "https://example.org", "id": "example-org"}
```

**actions.json** — the template every URL runs through. Each item is implicitly navigated to its URL first (unless the first step is an explicit `goto`, the v1.0 pattern):

```json
{
  "actions": [
    {"op": "dump", "as": "content", "maxTokens": 3000, "format": "markdown"},
    {"op": "extract", "as": "headings", "selector": "h1, h2", "if": {"selector": "h1"}},
    {"op": "eval", "as": "note", "js": "'saw ' + '{{headings}}'.length + ' chars of headings'"},
    {"op": "shot", "out": "shots/{{slug}}.png", "fullPage": true}
  ]
}
```

| op | Params |
|---|---|
| `goto` | `url` (defaults to the item URL), `wait` |
| `wait` | `ms`, `selector` + `state`, `load` |
| `click` | `selector`, `waitNav` |
| `type` | `selector`, `text`, `clear`, `submit` |
| `scroll` | `to`, `selector` |
| `move` | `selector` or `x` + `y` — human cursor move, no click |
| `shot` | `out` (default `shots/<slug>-<index>.png`), `fullPage`, `selector` |
| `shot-diff` | *single-page command; in bulk use two `shot` steps and diff afterwards* |
| `dump` | `maxTokens`, `format` (markdown/text/html), `out` |
| `extract` | `selector`, `attr` (comma-separated), `limit`, `table`, `csv` |
| `eval` | `js` |
| `upload` | `selector`, `file` |
| `pdf` | `out` |

- `as` names the result key (defaults to the op name; duplicates get `_2`, `_3`…).
- **Conditionals:** any step accepts `"if": {"selector": css}` / `{"text": "..."}` / `{"js": "expression"}` — the step is skipped (marked `{skipped: true}`) unless the condition holds.
- **Chaining:** `{{var}}` in any string field expands to earlier steps' results (`{{url}}`, `{{id}}`, `{{index}}`, `{{host}}`, `{{slug}}` plus every `as` name). Unknown vars are left as-is.
- Each item runs in an **isolated browser context** (no cookie leakage between URLs). One persistent browser per worker is reused across items.
- `--out-dir <dir>`: **per-URL COMPLETE output files** — each URL's full actual output is saved as its own `item-<id>.json`. `results.jsonl` is the **index only** (`{id, url, status, ms, attempts, files: [...]}`) — deliverables are never merged or summarized.
- `--since <state.json>`: content-hash compare (sha256 of the page dump) — skips URLs whose content hasn't changed; state is updated after the run.
- `--resume`: skips items already `ok`/`skipped`/`unchanged` in the existing results file (append mode — the file is never truncated).
- `--max-per-domain N`: caps concurrent items per host. `--delay-ms N`: pause between item starts (politeness).
- `--proxy <url>` / `--proxy-list <file>`: per-item proxy rotation (round-robin by item index).
- `--headed`: run the whole fleet in headed stealth mode.
- **results.jsonl** — one JSON object per URL, appended as items finish. Progress goes to stderr (`[3/50] OK example-org (1204ms)`); the final summary goes to stdout.
- Exit code is `1` if any item failed (results are still written). `--failures <file>` writes a separate failure report.

### Crawl → bulk pipeline

```bash
agent-browser crawl https://example.com --max-pages 50 --max-depth 2 --out urls.jsonl
agent-browser bulk --input urls.jsonl --actions actions.json --out-dir out/
```

`crawl` does a breadth-first crawl (same-domain by default; `--all-domains` to leave it) and writes `{url}` per line — directly feedable to `bulk --input`.

### Scheduler

Simple, robust recurring jobs (no system cron needed — the daemon loop is self-contained):

```bash
# install: runs bulk every day at 09:00, timestamped outputs per run
agent-browser schedule add --name daily-audit --cron "0 9 * * *" -- \
  bulk --input urls.jsonl --actions actions.json --out-dir out/

agent-browser schedule list
agent-browser schedule run-now --name daily-audit   # run immediately
agent-browser schedule remove --name daily-audit

# the loop that fires due jobs (run it in background / on boot)
agent-browser schedule daemon --foreground
```

Each run writes to `~/.agent-browser/schedule/<name>/runs/<timestamp>/` (`results.jsonl` + `run.log`). Cron is the standard 5-field format (ranges, steps, and day-of-month/day-of-week OR semantics supported).

### MCP server

```bash
agent-browser mcp   # MCP server over stdio
```

Exposes 21 tools (`browser_open`, `browser_dump`, `browser_extract`, `browser_click`, `browser_type`, `browser_move`, `browser_fill`, `browser_upload`, `browser_scroll`, `browser_wait`, `browser_eval`, `browser_shot`, `browser_pdf`, `browser_tab_new/list/switch/close`, `browser_crawl`, `browser_netlog`, `browser_assert_text`, `browser_assert_js`) — any MCP-capable agent can drive the browser as tools. Speaks JSON-RPC 2.0 (`initialize`, `tools/list`, `tools/call`).

## Agent ergonomics

- `--json` on **every** command: parseable output, no scraping stdout prose.
- **Token budgets**: `dump` reports `tokens` (chars/4 estimate) and `truncated`; `--max-tokens` hard-caps context cost.
- **Profiles**: `--profile shop` persists cookies across runs via an explicit storage-state file (`~/.agent-browser/profiles/shop/storage-state.json`), saved on `close` and restored on next launch. localStorage is not restored — cookie-based logins work, token-in-localStorage logins may not.
- **Polite crawling**: `--respect-robots` checks (and caches) robots.txt per host; `--delay-ms` spaces item starts; `--max-per-domain` caps per-host concurrency.
- **Network environments**: if `HTTPS_PROXY`/`HTTP_PROXY` is set, the CLI routes Chromium through a local shim that injects preemptive proxy authentication (some egress proxies 403 unauthenticated CONNECT tunnels, which Chromium cannot handle alone). `ignoreHTTPSErrors` is enabled because such proxies typically MITM TLS — see Limits.

## Honest limits

- **Not a reasoning agent.** It executes the commands you give it; it does not decide what to click. Pair it with an LLM driver for adaptive tasks (that's the intended architecture — deterministic browser, smart driver).
- **Stealth is measured, not magic.** Headed mode passes naive bot checks (see the table above, screenshot in `shots/botcheck-headed.png`), but WebGL still reports SwiftShader (no GPU here), and hardened anti-bot stacks (Cloudflare, PerimeterX, DataDome), IP reputation, and behavior analysis are **not** defeated. No CAPTCHA/2FA solving.
- **Logins are manual-first.** It can *reuse* a logged-in profile, but it won't solve SSO puzzles for you. Human-in-the-loop (you log in once on your phone/PC, the agent reuses the profile) is the supported pattern for hard sites.
- **Heuristic extraction.** `dump` uses DOM heuristics (skips nav/footer, keeps leaf blocks); unusual layouts may need `extract`/`eval` instead. Token estimate is chars/4, not a real tokenizer.
- **TLS verification is disabled** (`ignoreHTTPSErrors`) to survive MITM egress proxies in sandboxed environments. On a normal network this weakens security.
- **No cross-origin iframe locators.** Playwright selectors don't pierce cross-origin iframes; use `eval` with explicit frame handling for those.
- **Scheduler is self-contained**, not system cron: `schedule daemon` must be running for jobs to fire (run it in background or on boot).
- **Bulk implicit navigation**: items navigate to their URL automatically unless the template starts with `goto`. `{{var}}` chaining supports flat names only (no dotted paths like `{{d.content}}`).

## Project layout

```
bin/agent-browser.js   CLI entry: argv parsing + dispatch
lib/util.js            output, errors, token estimates, robots.txt, proxy config
lib/session.js         session attach/start, health checks, auto-recovery, tab registry
lib/daemon.js          detached per-profile Chromium owner (persistent context + CDP port)
lib/proxy-agent.js     local proxy shim for preemptive proxy auth
lib/stealth.js         headed-mode evasions (webdriver hiding, UA, plugins, Xvfb)
lib/humanize.js        human-behavior mimicry (bezier mouse, typing cadence, momentum scroll)
lib/ops.js             single-page ops (also the bulk action implementations)
lib/bulk.js            parallel bulk runner (out-dir, conditionals, chaining, since/resume)
lib/crawl.js           BFS crawler → JSONL
lib/schedule.js        cron-backed job scheduler + daemon loop
lib/mcp.js             MCP server over stdio (20 tools)
examples/              urls.jsonl + actions.json to copy
demo/                  real run output (proof it works)
shots/                 proof screenshots (incl. headed bot-check)
```

## Roadmap

- `AGENT_BROWSER_STRICT_TLS=1` to re-enable TLS verification on normal networks
- Cross-origin iframe locators
- `dump` readability-mode upgrade (Mozilla Readability)
- Video recording of bulk items (`--video`)
- Request interception / HAR via `--har` on `open` (today: `netlog` command)
- Playwright codegen-style `record` command (record a session → actions.json)
