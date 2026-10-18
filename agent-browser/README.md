# agent-browser

A **command-only, agent-first headless browser CLI**. No GUI, no dashboard, no LLM API key, no cloud subscription — just deterministic commands an AI agent can run from a shell, with **bulk mode** for running one action template across hundreds of URLs in parallel.

Built on headless Chromium via `playwright-core`. It does not reinvent the rendering engine; it is a thin, opinionated agent layer on top of the best one that already exists.

## Why another browser tool?

| Tool | What it is | The gap |
|---|---|---|
| [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser) | Fast Rust CLI + daemon, interactive sessions, accessibility snapshots | Single-session and interactive; no built-in parallel bulk runs, no token-budgeted dumps |
| [Stagehand](https://github.com/browserbase/stagehand) / [browser-use](https://github.com/browser-use/browser-use) / [Skyvern](https://github.com/Skyvern-AI/skyvern) | Agent frameworks with LLM-driven actions | Every step costs LLM tokens; built for *reasoning* agents, not for cheap deterministic batch jobs |

**agent-browser's differentiators:**

1. **Bulk mode is the headline, not an afterthought.** `bulk --input urls.jsonl --actions actions.json --concurrency 5` runs an action template across many URLs with per-item timeouts, retries, structured JSONL output, a progress log, and a failure report. Built for the jobs agents actually batch: price checks, content extraction, screenshot audits, link validation.
2. **LLM-context-native output.** `dump` returns page content as clean Markdown *optimized for agent context windows*, with a built-in token estimate and a `--max-tokens` budget flag. Every command speaks `--json`; errors are machine-readable with non-zero exit codes.
3. **Zero-daemon, zero-install browser.** Single Node.js CLI, no background service to configure, no LLM key, no per-step billing. Polite by default when you ask it to be: `--respect-robots` and `--rate-limit-ms`.

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

# structured extraction
agent-browser extract --selector "h1" --json

# interact, then verify
agent-browser type --selector "#search" --text "headless browsers" --submit
agent-browser eval --js "return document.title" --json

# screenshot / pdf
agent-browser shot --out shot.png --full-page
agent-browser pdf --out page.pdf

# bulk: one action template × many URLs, 5 at a time
agent-browser bulk --input urls.jsonl --actions actions.json --concurrency 5
```

## Commands

Single-page commands share one stateful session: `open` first, then the rest act on the active tab. The browser lives in a detached background daemon per `--profile`; it survives between CLI invocations until `close`.

| Command | Purpose | Key flags |
|---|---|---|
| `open <url>` | Navigate the active tab | `--wait load\|networkidle\|domcontentloaded\|<ms>` |
| `shot` | Screenshot → PNG | `--out`, `--full-page`, `--selector css` |
| `dump` | Page → clean Markdown + token estimate | `--max-tokens N`, `--out` |
| `extract` | CSS selector → JSON items | `--selector` (required), `--attr a,b`, `--limit N` |
| `click` | Click an element | `--selector` (required), `--wait-nav` |
| `type` | Type into an input | `--selector`, `--text` (required), `--clear`, `--submit` |
| `scroll` | Scroll the page | `--to bottom\|top\|<px>`, `--selector css` |
| `wait` | Wait | `--ms N`, `--selector css [--state visible\|attached\|hidden]`, `--load networkidle` |
| `eval` | Run JS in page context | `--js "..."` (return a JSON-serializable value) |
| `pdf` | Save page as PDF | `--out` |
| `sessions` | List live browser sessions | — |
| `close` | Kill session daemon(s) | `--profile name`, `--all` |

Global flags: `--json`, `--profile <name>` (persistent cookies/logins on disk; default profile is ephemeral), `--timeout-ms <n>` (default 30000), `--respect-robots`.

Exit codes: `0` ok · `1` action failed · `2` browser/session failure · `3` usage error · `4` blocked by robots.txt. Errors are JSON on stderr with `--json`:

```json
{"ok":false,"error":"NOT_FOUND","message":"locator.waitFor: Timeout 30000ms exceeded.","hint":"check the selector with: extract --selector ... or dump"}
```

## Bulk mode

```bash
agent-browser bulk --input urls.jsonl --actions actions.json \
  --concurrency 5 --retries 1 --item-timeout-ms 60000 \
  --out results.jsonl --failures failures.jsonl \
  --rate-limit-ms 500 --respect-robots --shots-dir shots
```

**urls.jsonl** — one URL per line, or JSON per line for custom ids:

```
https://example.com
{"url": "https://example.org", "id": "example-org"}
```

**actions.json** — the template every URL runs through:

```json
{
  "actions": [
    {"op": "goto", "wait": "domcontentloaded"},
    {"op": "wait", "load": "networkidle"},
    {"op": "dump", "as": "content", "maxTokens": 3000},
    {"op": "extract", "as": "headings", "selector": "h1, h2", "limit": 20},
    {"op": "shot", "out": "shots/{{slug}}.png", "fullPage": true}
  ]
}
```

Supported ops and params:

| op | Params |
|---|---|
| `goto` | `url` (defaults to the item URL), `wait` |
| `wait` | `ms`, `selector` + `state`, `load` |
| `click` | `selector`, `waitNav` |
| `type` | `selector`, `text`, `clear`, `submit` |
| `scroll` | `to`, `selector` |
| `shot` | `out` (default `shots/<slug>-<index>.png`), `fullPage`, `selector` |
| `dump` | `maxTokens`, `out` |
| `extract` | `selector`, `attr` (comma-separated), `limit` |
| `eval` | `js` |
| `pdf` | `out` |

- `as` names the result key in the output (defaults to the op name; duplicates get `_2`, `_3`…).
- Template variables in `out`/`url` fields: `{{url}}`, `{{id}}`, `{{index}}`, `{{host}}`, `{{slug}}`.
- Each item runs in an **isolated browser context** (no cookie leakage between URLs). One persistent browser per worker is reused across items.
- **results.jsonl** — one JSON object per URL, appended as items finish: `{id, url, index, status: "ok"|"failed"|"skipped", attempts, ms, data: {...}, error?}`.
- Progress goes to stderr (`[3/50] OK example-org (1204ms)`); the final summary goes to stdout.
- Exit code is `1` if any item failed (results are still written).

## Agent ergonomics

- `--json` on **every** command: parseable output, no scraping stdout prose.
- **Token budgets**: `dump` reports `tokens` (chars/4 estimate) and `truncated`; `--max-tokens` hard-caps context cost.
- **Profiles**: `--profile shop` persists cookies across runs via an explicit storage-state file (`~/.agent-browser/profiles/shop/storage-state.json`), saved on `close` and restored on next launch. localStorage is not restored in v1 — cookie-based logins work, token-in-localStorage logins may not.
- **Polite crawling**: `--respect-robots` checks (and caches) robots.txt per host; `--rate-limit-ms` spaces item starts.
- **Network environments**: if `HTTPS_PROXY`/`HTTP_PROXY` is set, the CLI routes Chromium through a local shim that injects preemptive proxy authentication (some egress proxies 403 unauthenticated CONNECT tunnels, which Chromium cannot handle alone). `ignoreHTTPSErrors` is enabled because such proxies typically MITM TLS — see Limits.

## Honest limits

- **Not a reasoning agent.** It executes the commands you give it; it does not decide what to click. Pair it with an LLM driver for adaptive tasks (that's the intended architecture — deterministic browser, smart driver).
- **No CAPTCHA / 2FA / bot-evasion.** Headless Chromium is detectable by hardened anti-bot stacks (Cloudflare, PerimeterX, DataDome). Log in once with `--profile` and reuse the profile instead.
- **Logins are manual-first.** It can *reuse* a logged-in profile, but it won't solve SSO puzzles for you.
- **Heuristic extraction.** `dump` uses DOM heuristics (skips nav/footer, keeps leaf blocks); unusual layouts may need `extract`/`eval` instead. Token estimate is chars/4, not a real tokenizer.
- **Single tab per session.** Multi-tab workflows aren't modeled; use bulk mode or multiple profiles.
- **TLS verification is disabled** (`ignoreHTTPSErrors`) to survive MITM egress proxies in sandboxed environments. On a normal network this weakens security; set `AGENT_BROWSER_STRICT_TLS=1`… (not yet implemented — see roadmap).
- **No request interception / HAR / video recording yet.** On the roadmap.

## Project layout

```
bin/agent-browser.js   CLI entry: argv parsing + dispatch
lib/util.js            output, errors, token estimates, robots.txt, proxy config
lib/session.js         session attach/start, page handling
lib/daemon.js          detached per-profile Chromium owner (persistent context + CDP port)
lib/proxy-agent.js     local proxy shim for preemptive proxy auth
lib/ops.js             single-page ops (also the bulk action implementations)
lib/bulk.js            parallel bulk runner
examples/              urls.jsonl + actions.json to copy
demo/                  real run output (proof it works)
```

## Roadmap

Strict-TLS mode, HAR capture, request blocking (ad/tracker lists for faster bulk), accessibility-tree snapshots, `--viewport`, cookie jar import/export, `form-fill` op from a JSON object.
