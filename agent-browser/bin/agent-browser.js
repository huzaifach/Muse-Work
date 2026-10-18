#!/usr/bin/env node
// agent-browser: command-only, agent-first headless browser CLI.
// Single entry point: parses argv, dispatches to single-page ops or bulk mode.
const path = require('path');
const { parseArgv, setJsonMode, printResult, fail, readJsonFile } = require('../lib/util');
const session = require('../lib/session');
const ops = require('../lib/ops');
const { runBulk } = require('../lib/bulk');

const VERSION = '1.0.0';

const HELP = `agent-browser v${VERSION} — command-only, agent-first headless browser.

USAGE
  agent-browser <command> [args] [flags]

SINGLE-PAGE COMMANDS (stateful session; run 'open' first)
  open <url> [--wait load|networkidle|domcontentloaded|<ms>]
  shot [--out path] [--full-page] [--selector css]
  dump [--max-tokens N] [--out path]
  extract --selector css [--attr a,b] [--limit N]
  click --selector css [--wait-nav]
  type --selector css --text "..." [--clear] [--submit]
  scroll [--to bottom|top|<px>] [--selector css]
  wait (--ms N | --selector css [--state visible|attached|hidden] | --load networkidle)
  eval --js "..."                       # JS runs in page context; return JSON-serializable value
  pdf [--out path]
  sessions                              # list live sessions
  close [--profile name | --all]

BULK MODE (parallel action templates across many URLs)
  bulk --input urls.jsonl --actions actions.json [--concurrency 5] [--retries 1]
       [--item-timeout-ms 60000] [--out results.jsonl] [--failures failures.jsonl]
       [--rate-limit-ms 0] [--respect-robots] [--shots-dir shots]

GLOBAL FLAGS
  --json              machine-readable JSON output (every command)
  --profile <name>    persistent profile (cookies/logins saved); default is ephemeral
  --timeout-ms <n>    default navigation/action timeout (default 30000)
  --respect-robots    check robots.txt before fetching (single + bulk)
  --help, --version

EXIT CODES
  0 ok · 1 action failed · 2 browser/session failure · 3 usage error · 4 blocked by robots.txt

EXAMPLES
  agent-browser open https://example.com --json
  agent-browser dump --max-tokens 2000 --json
  agent-browser extract --selector "h1" --json
  agent-browser bulk --input urls.jsonl --actions actions.json --concurrency 5
`;

function intFlag(flags, name, def) {
  const v = flags[name];
  if (v === undefined || v === true) return def;
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) fail(3, { code: 'BAD_FLAG', message: `--${name} expects a number, got '${v}'` });
  return n;
}

async function main() {
  const { command, positional, flags } = parseArgv(process.argv.slice(2));
  setJsonMode(!!flags.json);

  if (flags.version || command === 'version') { console.log(VERSION); return; }
  if (flags.help || !command || command === 'help') { console.log(HELP); return; }

  const profile = String(flags.profile || 'default');
  const timeoutMs = intFlag(flags, 'timeout-ms', 30000);

  const needPage = ['shot', 'dump', 'extract', 'click', 'type', 'scroll', 'wait', 'eval', 'pdf'];

  try {
    switch (command) {
      case 'open': {
        const url = positional[0];
        if (!url) fail(3, { code: 'MISSING_URL', message: 'open requires a URL', hint: 'agent-browser open https://example.com' });
        if (flags['respect-robots']) await require('../lib/util').assertRobotsAllowed(url);
        const res = await session.withPage(profile, (page) =>
          ops.goto(page, url, { timeout: timeoutMs, wait: flags.wait || 'load' }));
        printResult({ ok: !res.timedOut, command: 'open', ...res, summary: `opened ${res.url} — "${res.title}" (HTTP ${res.status})${res.timedOut ? ' [navigation timed out]' : ''}` });
        if (res.timedOut) process.exitCode = 1;
        break;
      }
      case 'shot': {
        const res = await session.withPage(profile, (page) =>
          ops.shot(page, { out: flags.out, fullPage: !!flags['full-page'], selector: flags.selector, timeout: timeoutMs }));
        printResult({ ok: true, command: 'shot', ...res, summary: `screenshot saved: ${res.path} (${res.bytes} bytes)` });
        break;
      }
      case 'dump': {
        const res = await session.withPage(profile, (page) =>
          ops.dump(page, { maxTokens: intFlag(flags, 'max-tokens', 0) || undefined, out: flags.out }));
        if (flags.out && !flags.json) console.log(res.summary);
        else printResult({ ok: true, command: 'dump', tokens: res.tokens, truncated: res.truncated, title: res.title, url: res.url, markdown: flags.out ? undefined : res.markdown, savedTo: res.savedTo, summary: res.summary });
        break;
      }
      case 'extract': {
        if (!flags.selector) fail(3, { code: 'MISSING_SELECTOR', message: 'extract requires --selector' });
        const res = await session.withPage(profile, (page) =>
          ops.extract(page, { selector: flags.selector, attr: flags.attr, limit: intFlag(flags, 'limit', 100), timeout: timeoutMs }));
        printResult({ ok: true, command: 'extract', selector: flags.selector, count: res.items.length, items: res.items, summary: `extracted ${res.items.length} element(s) for '${flags.selector}'` });
        break;
      }
      case 'click': {
        if (!flags.selector) fail(3, { code: 'MISSING_SELECTOR', message: 'click requires --selector' });
        const res = await session.withPage(profile, (page) =>
          ops.click(page, { selector: flags.selector, waitNav: !!flags['wait-nav'], timeout: timeoutMs }));
        printResult({ ok: true, command: 'click', ...res, summary: `clicked '${flags.selector}'${res.navigatedTo ? ` → navigated to ${res.navigatedTo}` : ''}` });
        break;
      }
      case 'type': {
        if (!flags.selector) fail(3, { code: 'MISSING_SELECTOR', message: 'type requires --selector' });
        if (flags.text === undefined) fail(3, { code: 'MISSING_TEXT', message: 'type requires --text' });
        const res = await session.withPage(profile, (page) =>
          ops.type(page, { selector: flags.selector, text: String(flags.text), clear: !!flags.clear, submit: !!flags.submit, timeout: timeoutMs }));
        printResult({ ok: true, command: 'type', ...res, summary: `typed into '${flags.selector}' (${String(flags.text).length} chars)${res.submitted ? ' + submitted' : ''}` });
        break;
      }
      case 'scroll': {
        const res = await session.withPage(profile, (page) =>
          ops.scroll(page, { to: flags.to || 'bottom', selector: flags.selector }));
        printResult({ ok: true, command: 'scroll', ...res, summary: `scrolled to ${res.to}` });
        break;
      }
      case 'wait': {
        const res = await session.withPage(profile, (page) =>
          ops.wait(page, { ms: intFlag(flags, 'ms', 0) || undefined, selector: flags.selector, state: flags.state || 'visible', load: flags.load, timeout: timeoutMs }));
        printResult({ ok: true, command: 'wait', ...res, summary: `waited: ${res.what}` });
        break;
      }
      case 'eval': {
        if (!flags.js) fail(3, { code: 'MISSING_JS', message: 'eval requires --js "expression-or-statements"' });
        const res = await session.withPage(profile, (page) => ops.evalJs(page, { js: String(flags.js), timeout: timeoutMs }));
        printResult({ ok: true, command: 'eval', result: res.result, summary: `eval returned: ${JSON.stringify(res.result).slice(0, 200)}` });
        break;
      }
      case 'pdf': {
        const res = await session.withPage(profile, (page) => ops.pdf(page, { out: flags.out }));
        printResult({ ok: true, command: 'pdf', ...res, summary: `PDF saved: ${res.path} (${res.bytes} bytes)` });
        break;
      }
      case 'sessions': {
        const list = await session.listSessions();
        printResult({ ok: true, command: 'sessions', sessions: list, summary: list.length ? list.map(s => `${s.profile}: ${s.alive ? 'alive' : 'stale'} (pid ${s.pid})`).join('\n') : 'no sessions' });
        break;
      }
      case 'close': {
        const res = await session.closeSession(flags.all ? null : profile, !!flags.all);
        printResult({ ok: true, command: 'close', ...res, summary: res.summary });
        break;
      }
      case 'bulk': {
        if (!flags.input) fail(3, { code: 'MISSING_INPUT', message: 'bulk requires --input urls.jsonl' });
        if (!flags.actions) fail(3, { code: 'MISSING_ACTIONS', message: 'bulk requires --actions actions.json' });
        const summary = await runBulk({
          input: flags.input,
          actionsFile: flags.actions,
          concurrency: intFlag(flags, 'concurrency', 5),
          retries: intFlag(flags, 'retries', 1),
          itemTimeoutMs: intFlag(flags, 'item-timeout-ms', 60000),
          out: flags.out || 'results.jsonl',
          failures: flags.failures || null,
          rateLimitMs: intFlag(flags, 'rate-limit-ms', 0),
          respectRobots: !!flags['respect-robots'],
          shotsDir: flags['shots-dir'] || 'shots',
          timeoutMs,
          json: !!flags.json,
        });
        printResult({ ok: summary.failed === 0, command: 'bulk', ...summary, summary: `bulk done: ${summary.succeeded}/${summary.total} ok, ${summary.failed} failed, ${summary.skipped} skipped in ${summary.ms}ms` });
        process.exitCode = summary.failed === 0 ? 0 : 1;
        break;
      }
      default:
        fail(3, { code: 'UNKNOWN_COMMAND', message: `unknown command '${command}'`, hint: 'run with --help to list commands' });
    }
  } catch (e) {
    if (e && e.code) {
      const exit = { NOT_FOUND: 1, TIMEOUT: 1, ACTION_FAILED: 1, ROBOTS_BLOCKED: 4, BROWSER_LAUNCH_FAILED: 2, SESSION_START_FAILED: 2, NO_PAGE: 1 }[e.code] || 1;
      fail(exit, e);
    }
    throw e;
  }
}

main().catch((e) => fail(2, { code: 'UNEXPECTED', message: String((e && e.stack) || e) }));
