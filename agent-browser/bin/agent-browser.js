#!/usr/bin/env node
// agent-browser: command-only, agent-first headless browser CLI.
// Single entry point: parses argv, dispatches to single-page ops or bulk mode.
const path = require('path');
const { parseArgv, setJsonMode, printResult, fail, readJsonFile } = require('../lib/util');
const session = require('../lib/session');
const ops = require('../lib/ops');
const { runBulk } = require('../lib/bulk');

const VERSION = '1.1.0';

const HELP = `agent-browser v${VERSION} — command-only, agent-first headless browser.

USAGE
  agent-browser <command> [args] [flags]

SINGLE-PAGE COMMANDS (stateful session; run 'open' first)
  open <url> [--wait load|networkidle|domcontentloaded|<ms>] [--proxy <url>]
  shot [--out path] [--full-page] [--selector css]
  shot-diff --a old.png --b new.png [--out diff.png] [--threshold 0.1]
  dump [--max-tokens N] [--out path] [--format markdown|text|html]
  extract --selector css [--attr a,b] [--limit N] [--table] [--csv]   # full text, no truncation
  click --selector css [--wait-nav]
  type --selector css --text "..." [--clear] [--submit]
  fill --fields '{"#name":"Ali"}' [--submit]
  upload --selector css --file <local-path>         # file input upload
  scroll [--to bottom|top|<px>] [--selector css]
  move --selector <css> | --x <n> --y <n>  # human-like cursor move, NO click
  wait (--ms N | --selector css [--state visible|attached|hidden] | --load networkidle)
  eval --js "..."                       # bare expression ("1+1") or statements with return
  pdf [--out path]
  netlog --url <url> [--out netlog.jsonl] [--wait-ms 3000]
  assert --selector css --text <expected> | assert --js "<expression>"
  tab-new [--url <url>] | tab-list | tab-switch <id> | tab-close [id]
  sessions                              # list live sessions (marks stale ones)
  close [--profile name | --all]

CRAWL (link discovery → feeds bulk)
  crawl <start-url> [--max-pages 50] [--max-depth 2] [--all-domains] [--out urls.jsonl]

SCHEDULER (cron-backed bulk jobs with timestamped outputs)
  schedule add --cron "0 9 * * *" --name <n> -- bulk --input urls.jsonl --actions actions.json
  schedule list | schedule remove --name <n> | schedule run-now <n> | schedule daemon [--foreground]

MCP SERVER (any agent can use the browser as tools)
  mcp                                   # MCP server over stdio

BULK MODE (parallel action templates across many URLs)
  bulk --input urls.jsonl --actions actions.json [--concurrency 5] [--retries 1]
       [--item-timeout-ms 60000] [--out results.jsonl] [--failures failures.jsonl]
       [--out-dir outdir/]               # per-URL COMPLETE output files (index-only results.jsonl)
       [--since state.json] [--resume]  # incremental: skip unchanged / already-done
       [--max-per-domain N] [--delay-ms N] [--rate-limit-ms N]
       [--proxy <url>] [--proxy-list proxies.txt]
       [--respect-robots] [--shots-dir shots]
  actions.json supports: {"op": ..., "if": {"selector"|"text"|"js": ...}} (conditional),
  {{var}} chaining (url/id/index/host/slug + earlier steps' "as" names).

GLOBAL FLAGS
  --json              machine-readable JSON output (every command)
  --headed            REAL browser window on a virtual display (Xvfb) + stealth
                      evasions (hides webdriver flag, realistic UA/plugins).
                      For bot-walled sites; honest limits apply (see README).
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

  if (flags.headed) {
    process.env.AGENT_BROWSER_HEADED = '1';
    const { findFullChromium } = require('../lib/stealth');
    if (!findFullChromium()) {
      fail(2, {
        code: 'NO_HEADED_CHROMIUM',
        message: '--headed needs a full Chromium (headless_shell cannot open a window)',
        hint: 'npx playwright-core install chromium, or set AGENT_BROWSER_CHROMIUM_HEADED=/path/to/chrome',
      });
    }
  }

  if (flags.proxy) {
    process.env.AGENT_BROWSER_PROXY = String(flags.proxy);
  }

  const profile = String(flags.profile || 'default');
  const timeoutMs = intFlag(flags, 'timeout-ms', 30000);

  const needPage = ['shot', 'dump', 'extract', 'click', 'type', 'upload', 'fill', 'scroll', 'wait', 'eval', 'pdf', 'netlog', 'assert'];

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
          ops.dump(page, { maxTokens: intFlag(flags, 'max-tokens', 0) || undefined, out: flags.out, format: flags.format }));
        const content = flags.out ? undefined : (res.html || res.markdown);
        if (flags.out && !flags.json) console.log(res.summary);
        else printResult({ ok: true, command: 'dump', format: res.format, tokens: res.tokens, truncated: res.truncated, title: res.title, url: res.url, content, savedTo: res.savedTo, summary: res.summary });
        break;
      }
      case 'extract': {
        if (!flags.selector) fail(3, { code: 'MISSING_SELECTOR', message: 'extract requires --selector' });
        const res = await session.withPage(profile, (page) =>
          ops.extract(page, { selector: flags.selector, attr: flags.attr, limit: intFlag(flags, 'limit', 100), table: !!flags.table, csv: !!flags.csv, timeout: timeoutMs }));
        if (res.csv) {
          if (flags.json) printResult({ ok: true, command: 'extract', selector: flags.selector, csv: res.csv, summary: `extracted ${res.tables.length} table(s) as CSV` });
          else console.log(res.csv);
        } else {
          const items = res.items || res.tables;
          printResult({ ok: true, command: 'extract', selector: flags.selector, count: items.length, items, summary: `extracted ${items.length} item(s) for '${flags.selector}'` });
        }
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
        printResult({ ok: true, command: 'scroll', ...res, summary: `scrolled to ${res.to}${res.humanized ? ' (humanized)' : ''}` });
        break;
      }
      case 'move': {
        const res = await session.withPage(profile, (page) =>
          ops.move(page, { selector: flags.selector, x: flags.x, y: flags.y, timeout: timeoutMs }));
        printResult({ ok: true, command: 'move', ...res, summary: `cursor → (${res.x}, ${res.y}) in ${res.steps} steps (no click)` });
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
        const shown = JSON.stringify(res.result);
        printResult({ ok: true, command: 'eval', result: res.result, summary: `eval returned: ${(shown === undefined ? 'undefined' : shown).slice(0, 200)}` });
        break;
      }
      case 'upload': {
        if (!flags.selector) fail(3, { code: 'MISSING_SELECTOR', message: 'upload requires --selector' });
        if (!flags.file) fail(3, { code: 'MISSING_FILE', message: 'upload requires --file <local-path>' });
        const res = await session.withPage(profile, (page) =>
          ops.upload(page, { selector: flags.selector, file: String(flags.file), timeout: timeoutMs }));
        printResult({ ok: true, command: 'upload', ...res, summary: `uploaded ${res.file} (${res.bytes} bytes) into '${res.selector}'` });
        break;
      }
      case 'pdf': {
        const res = await session.withPage(profile, (page) => ops.pdf(page, { out: flags.out }));
        printResult({ ok: true, command: 'pdf', ...res, summary: `PDF saved: ${res.path} (${res.bytes} bytes)` });
        break;
      }
      case 'fill': {
        if (flags.fields === undefined) fail(3, { code: 'MISSING_FIELDS', message: 'fill requires --fields \'{...}\'', hint: `agent-browser fill --fields '{"#name":"Ali","#email":"a@b.c"}' --submit` });
        const res = await session.withPage(profile, (page) =>
          ops.fill(page, { fields: String(flags.fields), submit: !!flags.submit, timeout: timeoutMs }));
        printResult({ ok: true, command: 'fill', ...res, summary: `filled ${res.filled.length} field(s)${res.submitted ? ' + submitted' : ''}: ${res.filled.join(', ')}` });
        break;
      }
      case 'shot-diff': {
        if (!flags.a || !flags.b) fail(3, { code: 'MISSING_FILES', message: 'shot-diff requires --a old.png --b new.png' });
        const res = ops.shotDiff({
          a: String(flags.a), b: String(flags.b), out: flags.out,
          threshold: flags.threshold !== undefined ? parseFloat(flags.threshold) : 0.1,
        });
        printResult({ ok: true, command: 'shot-diff', ...res, summary: `diff: ${res.diffPercent}% (${res.diffPixels} px differ) → ${res.out}` });
        break;
      }
      case 'netlog': {
        const url = positional[0] || flags.url;
        if (!url) fail(3, { code: 'MISSING_URL', message: 'netlog requires a URL', hint: 'agent-browser netlog https://example.com --out netlog.jsonl' });
        const res = await session.withPage(profile, (page) =>
          ops.netlog(page, { url, out: flags.out, waitMs: intFlag(flags, 'wait-ms', 3000), timeout: timeoutMs }));
        printResult({ ok: true, command: 'netlog', ...res, summary: res.summary });
        break;
      }
      case 'assert': {
        let res;
        if (flags.selector && flags.text !== undefined) {
          res = await session.withPage(profile, (page) =>
            ops.assertText(page, { selector: flags.selector, text: String(flags.text), timeout: timeoutMs }));
        } else if (flags.js) {
          res = await session.withPage(profile, (page) =>
            ops.assertJs(page, { js: String(flags.js), timeout: timeoutMs }));
        } else {
          fail(3, { code: 'BAD_ASSERT', message: 'assert needs --selector + --text, or --js "<expression>"', hint: 'agent-browser assert --selector h1 --text "Example"' });
        }
        printResult({ ok: res.pass, command: 'assert', ...res, summary: res.pass ? `ASSERT PASS (${res.check})` : `ASSERT FAIL (${res.check}): ${JSON.stringify(res.expected !== undefined ? res.expected : res.js)} not satisfied` });
        if (!res.pass) process.exitCode = 1;
        break;
      }
      case 'tab-new': {
        const res = await session.withContext(profile, async (ctx) => {
          const page = await ctx.newPage();
          let navTimedOut = false;
          if (flags.url) {
            const r = await ops.goto(page, String(flags.url), { timeout: timeoutMs });
            navTimedOut = !!r.timedOut;
          }
          const num = await session.registerNewTab(profile, page);
          session.setActiveTab(profile, num);
          return { tab: num, url: page.url(), title: await page.title().catch(() => ''), navTimedOut };
        });
        printResult({ ok: true, command: 'tab-new', ...res, summary: `new tab [${res.tab}]${res.url && res.url !== 'about:blank' ? `: ${res.url}` : ''}` });
        break;
      }
      case 'tab-list': {
        const res = await session.withContext(profile, async (ctx) => {
          const tabs = await session.resolveTabNumbers(profile, ctx);
          return { tabs: tabs.map((t) => ({ tab: t.num, url: t.url, title: t.title })), count: tabs.length };
        });
        const active = session.getActiveTab(profile);
        printResult({
          ok: true, command: 'tab-list', ...res,
          summary: res.tabs.length
            ? res.tabs.map((t) => `${t.tab === active ? '*' : ' '} [${t.tab}] ${t.title || '(untitled)'} — ${t.url}`).join('\n')
            : 'no tabs',
        });
        break;
      }
      case 'tab-switch': {
        const idx = parseInt(positional[0], 10);
        if (Number.isNaN(idx)) fail(3, { code: 'BAD_TAB', message: 'tab-switch requires a numeric tab id', hint: 'run tab-list to see tabs' });
        const res = await session.withContext(profile, async (ctx) => {
          const page = await session.pageForTab(profile, ctx, idx);
          try { await page.bringToFront(); } catch {}
          session.setActiveTab(profile, idx);
          return { tab: idx, url: page.url(), title: await page.title().catch(() => '') };
        });
        printResult({ ok: true, command: 'tab-switch', ...res, summary: `active tab → [${res.tab}] ${res.title || res.url}` });
        break;
      }
      case 'tab-close': {
        const idx = positional[0] === undefined ? session.getActiveTab(profile) : parseInt(positional[0], 10);
        const res = await session.withContext(profile, async (ctx) => {
          const page = await session.pageForTab(profile, ctx, idx);
          const url = page.url();
          await page.close();
          return { closed: idx, url };
        });
        printResult({ ok: true, command: 'tab-close', ...res, summary: `closed tab [${res.closed}] (${res.url})` });
        break;
      }
      case 'crawl': {
        const url = positional[0];
        if (!url) fail(3, { code: 'MISSING_URL', message: 'crawl requires a start URL', hint: 'agent-browser crawl https://example.com --max-pages 50 --max-depth 2' });
        const { crawl } = require('../lib/crawl');
        const res = await crawl({
          url,
          maxPages: intFlag(flags, 'max-pages', 50),
          maxDepth: intFlag(flags, 'max-depth', 2),
          allDomains: !!flags['all-domains'],
          respectRobots: !!flags['respect-robots'],
          out: flags.out,
          timeoutMs,
        });
        printResult({ ok: true, command: 'crawl', ...res, summary: res.summary });
        break;
      }
      case 'schedule': {
        const sub = positional[0];
        const sched = require('../lib/schedule');
        if (sub === 'add') {
          const bulkIdx = positional.indexOf('bulk');
          const bulkArgs = bulkIdx >= 0 ? positional.slice(bulkIdx) : [];
          const res = sched.addJob({
            name: String(flags.name || ''),
            cron: String(flags.cron || ''),
            bulkArgs,
            cwd: process.cwd(),
            binPath: path.join(__dirname, 'agent-browser.js'),
          });
          printResult({ ok: true, command: 'schedule', action: 'add', ...res, summary: res.summary });
        } else if (sub === 'list') {
          const jobs = sched.listJobs();
          printResult({
            ok: true, command: 'schedule', action: 'list', jobs,
            summary: jobs.length
              ? jobs.map((j) => `${j.name}: "${j.cron}" (runs: ${j.runs}, last: ${j.lastRun || 'never'}${j.lastStatus ? `, ${j.lastStatus}` : ''})`).join('\n')
              : 'no scheduled jobs',
          });
        } else if (sub === 'remove') {
          const res = sched.removeJob(String(flags.name || positional[1] || ''));
          printResult({ ok: true, command: 'schedule', action: 'remove', ...res, summary: res.summary });
        } else if (sub === 'run-now') {
          const res = sched.runJobNow(String(flags.name || positional[1] || ''));
          printResult({ ok: true, command: 'schedule', action: 'run-now', ...res, summary: res.summary });
        } else if (sub === 'daemon') {
          const res = await sched.daemonLoop({ foreground: !!flags.foreground });
          printResult({ ok: true, command: 'schedule', action: 'daemon', ...res, summary: res.summary });
        } else {
          fail(3, { code: 'BAD_SUBCOMMAND', message: `schedule needs add|list|remove|run-now|daemon, got '${sub || ''}'` });
        }
        break;
      }
      case 'mcp': {
        // MCP server over stdio — takes over the process, never returns.
        await require('../lib/mcp');
        break;
      }
      case 'sessions': {
        const list = await session.listSessions();
        const age = (iso) => {
          if (!iso) return '?';
          const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
          return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.round(m / 60)}h`;
        };
        printResult({
          ok: true, command: 'sessions', sessions: list,
          summary: list.length ? list.map((s) => s.alive
            ? `${s.profile}: alive (pid ${s.pid}, ${s.headed ? 'headed' : 'headless'}, age ${age(s.startedAt)})`
            : `${s.profile}: STALE — pid ${s.pid} is dead; run 'close' to clean up`).join('\n') : 'no sessions',
        });
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
        const delayMs = intFlag(flags, 'delay-ms', 0) || intFlag(flags, 'rate-limit-ms', 0);
        const summary = await runBulk({
          input: flags.input,
          actionsFile: flags.actions,
          concurrency: intFlag(flags, 'concurrency', 5),
          retries: intFlag(flags, 'retries', 1),
          itemTimeoutMs: intFlag(flags, 'item-timeout-ms', 60000),
          out: flags.out || 'results.jsonl',
          outExplicit: !!flags.out,
          outDir: flags['out-dir'] || null,
          since: flags.since || null,
          resume: !!flags.resume,
          maxPerDomain: intFlag(flags, 'max-per-domain', 0),
          delayMs,
          rateLimitMs: 0,
          proxy: flags.proxy || null,
          proxyList: flags['proxy-list'] || null,
          failures: flags.failures || null,
          respectRobots: !!flags['respect-robots'],
          shotsDir: flags['shots-dir'] || 'shots',
          headed: !!flags.headed,
          timeoutMs,
          json: !!flags.json,
        });
        printResult({ ok: summary.failed === 0, command: 'bulk', ...summary, summary: `bulk done: ${summary.succeeded}/${summary.total} ok, ${summary.failed} failed, ${summary.skipped} skipped${summary.unchanged ? `, ${summary.unchanged} unchanged` : ''} in ${summary.ms}ms` });
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
