// Shared utilities: argv parsing, output, errors, token estimates, robots.txt, templates.
const fs = require('fs');
const path = require('path');
const os = require('os');

const BASE = path.join(os.homedir(), '.agent-browser');
const SESSIONS_DIR = path.join(BASE, 'sessions');
const PROFILES_DIR = path.join(BASE, 'profiles');
const ROBOTS_CACHE = path.join(BASE, 'robots-cache.json');

let jsonMode = false;
function setJsonMode(v) { jsonMode = v; }

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// Flags that never take a value: the parser must not swallow the next
// positional as their value (e.g. `--headed open <url>`).
const BOOLEAN_FLAGS = new Set([
  'json', 'headed', 'submit', 'csv', 'table', 'resume', 'foreground',
  'all', 'clear', 'help', 'version',
  'all-domains', 'full-page', 'respect-robots', 'wait-nav', 'new-session',
]);

function parseArgv(argv) {
  const positional = [];
  const flags = {};
  let command = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { positional.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      let k, v;
      if (eq > 2) { k = a.slice(2, eq); v = a.slice(eq + 1); }
      else {
        k = a.slice(2);
        const nxt = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(k) && nxt !== undefined && !nxt.startsWith('--') && !/^-.$/.test(nxt)) { v = nxt; i++; }
        else v = true;
      }
      flags[k] = v;
    } else if (/^-[a-zA-Z]$/.test(a)) {
      const k = a[1];
      const nxt = argv[i + 1];
      if (nxt !== undefined && !nxt.startsWith('-')) { flags[k] = nxt; i++; }
      else flags[k] = true;
    } else if (!command) { command = a; }
    else positional.push(a);
  }
  return { command, positional, flags };
}

// Print a command result: JSON object with --json, else the human summary.
function printResult(obj) {
  if (jsonMode) {
    const { summary, ...rest } = obj;
    console.log(JSON.stringify(rest));
  } else {
    console.log(obj.summary || JSON.stringify(obj));
  }
}

// Machine-readable fatal error. Never throws — exits the process.
function fail(exitCode, err) {
  const e = {
    ok: false,
    error: (err && err.code) || 'ERROR',
    message: (err && err.message) || String(err),
  };
  if (err && err.hint) e.hint = err.hint;
  if (jsonMode) console.error(JSON.stringify(e));
  else console.error(`error [${e.error}]: ${e.message}` + (e.hint ? `\nhint: ${e.hint}` : ''));
  process.exit(exitCode);
}

// Rough token estimate for LLM context budgeting (chars / 4).
function estimateTokens(s) {
  return Math.ceil(String(s || '').length / 4);
}

function slugifyUrl(u) {
  try {
    const p = new URL(u);
    const s = (p.hostname + p.pathname).replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase();
    return s.slice(0, 80) || 'page';
  } catch { return 'page'; }
}

// Expand {{var}} templates in a string.
function expandTemplate(str, vars) {
  return String(str).replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`));
}

function readJsonFile(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); }
  catch (e) { fail(3, { code: 'BAD_FILE', message: `cannot read JSON file '${p}': ${e.message}` }); }
}

function readLines(p) {
  try { return fs.readFileSync(p, 'utf8').split('\n').map(l => l.trim()).filter(Boolean); }
  catch (e) { fail(3, { code: 'BAD_FILE', message: `cannot read file '${p}': ${e.message}` }); }
}

// ---- robots.txt (polite mode) ----

function loadRobotsCache() {
  try { return JSON.parse(fs.readFileSync(ROBOTS_CACHE, 'utf8')); }
  catch { return {}; }
}
function saveRobotsCache(c) {
  try { ensureDir(BASE); fs.writeFileSync(ROBOTS_CACHE, JSON.stringify(c)); } catch {}
}

function parseRobots(text) {
  // Group-aware: consecutive User-agent lines belong to ONE group; a new group
  // starts only when User-agent follows rule lines. Collect disallows from
  // every group matching '*' or 'agent-browser'.
  const groups = [];
  let cur = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.split('#')[0].trim();
    if (!line) continue;
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const field = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (field === 'user-agent') {
      if (!cur || cur.hasRules) { cur = { agents: [], disallows: [], hasRules: false }; groups.push(cur); }
      cur.agents.push(value.toLowerCase());
    } else if ((field === 'disallow' || field === 'allow') && cur) {
      cur.hasRules = true;
      if (field === 'disallow') cur.disallows.push(value);
    }
  }
  const rules = [];
  for (const g of groups) {
    if (g.agents.includes('*') || g.agents.includes('agent-browser')) rules.push(...g.disallows);
  }
  return rules;
}

async function robotsAllowed(targetUrl) {
  let u;
  try { u = new URL(targetUrl); } catch { return true; }
  const origin = u.origin;
  const cache = loadRobotsCache();
  let entry = cache[origin];
  if (!entry || Date.now() - entry.fetchedAt > 24 * 3600 * 1000) {
    entry = { rules: [], fetchedAt: Date.now() };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      const res = await fetch(origin + '/robots.txt', {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'agent-browser/1.1 (+polite mode)' },
      });
      clearTimeout(t);
      if (res.ok) entry.rules = parseRobots(await res.text());
    } catch { /* unreachable robots.txt = allow */ }
    cache[origin] = entry;
    saveRobotsCache(cache);
  }
  const pth = u.pathname || '/';
  for (const d of entry.rules) {
    if (!d) continue; // empty Disallow = allow all
    if (pth.startsWith(d)) return false;
  }
  return true;
}

async function assertRobotsAllowed(url) {
  if (!(await robotsAllowed(url))) {
    fail(4, {
      code: 'ROBOTS_BLOCKED',
      message: `robots.txt disallows fetching ${url}`,
      hint: 'remove --respect-robots to override (only if you have the right to crawl this path)',
    });
  }
}

// Egress proxy: this VM routes outbound traffic through an env-configured
// HTTP proxy (possibly with credentials). Never log the raw URL.
function proxyConfig() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    const cfg = { server: `${u.protocol}//${u.host}` };
    if (u.username) cfg.username = decodeURIComponent(u.username);
    if (u.password) cfg.password = decodeURIComponent(u.password);
    return cfg;
  } catch { return undefined; }
}

module.exports = {
  BASE, SESSIONS_DIR, PROFILES_DIR,
  setJsonMode, ensureDir, parseArgv, printResult, fail,
  estimateTokens, slugifyUrl, expandTemplate,
  readJsonFile, readLines, proxyConfig,
  robotsAllowed, assertRobotsAllowed, parseRobots,
};
