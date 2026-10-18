// Session management: one Chromium per profile, owned by a detached daemon
// (lib/daemon.js). CLI commands attach over CDP. Two modes:
//   - headless (default): the small headless_shell binary.
//   - headed (--headed → AGENT_BROWSER_HEADED=1): full Chromium with a REAL
//     window on a virtual display (Xvfb) + stealth evasions (lib/stealth.js).
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { SESSIONS_DIR, PROFILES_DIR, ensureDir } = require('./util');
const { findFullChromium, ensureXvfb } = require('./stealth');
const humanize = require('./humanize');

const SHELL = process.env.AGENT_BROWSER_CHROMIUM ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell');

const HEADED = () => process.env.AGENT_BROWSER_HEADED === '1';

// Headed and headless sessions are fully separate identities: --headed never
// hijacks a headless browser (and vice versa). Applied once at the entry
// points (withPage/withContext); everything downstream uses the key as-is.
const sessionKey = (profile) => (HEADED() ? `${profile}-headed` : profile);

function sessionFile(profile) {
  return path.join(SESSIONS_DIR, `${profile}.json`);
}
function profileDir(profile) {
  return path.join(PROFILES_DIR, profile);
}
function storageStatePath(profile) {
  return path.join(profileDir(profile), 'storage-state.json');
}

function readSession(profile) {
  try { return JSON.parse(fs.readFileSync(sessionFile(profile), 'utf8')); }
  catch { return null; }
}

// Active-tab tracking (stores the STABLE tab number from the registry above).
function activeTabFile(profile) {
  return path.join(SESSIONS_DIR, `${profile}.tab`);
}
function getActiveTab(profile) {
  try {
    const n = parseInt(fs.readFileSync(activeTabFile(profile), 'utf8'), 10);
    return Number.isNaN(n) ? 0 : n;
  } catch { return 0; }
}
function setActiveTab(profile, i) {
  try { ensureDir(SESSIONS_DIR); fs.writeFileSync(activeTabFile(profile), String(i)); } catch {}
}
// ---- stable tab identities ----
// Chromium's Target.getTargets returns NEWEST-FIRST on a fresh CDP connection,
// so raw pages() indices shift between CLI invocations. We keep a per-profile
// registry mapping stable tab numbers → CDP targetIds.
async function pageTargetId(page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { targetInfo } = await cdp.send('Target.getTargetInfo');
    return targetInfo.targetId;
  } finally { await cdp.detach().catch(() => {}); }
}
function tabRegFile(profile) {
  return path.join(SESSIONS_DIR, `${profile}.tabs.json`);
}
function loadTabReg(profile) {
  try {
    const r = JSON.parse(fs.readFileSync(tabRegFile(profile), 'utf8'));
    if (r && typeof r.next === 'number' && r.tabs) return r;
  } catch {}
  return { next: 0, tabs: {} };
}
function saveTabReg(profile, reg) {
  try { ensureDir(SESSIONS_DIR); fs.writeFileSync(tabRegFile(profile), JSON.stringify(reg)); } catch {}
}
// Returns [{num, page, targetId, url, title}] with stable numbers; prunes dead tabs.
async function resolveTabNumbers(profile, context) {
  const reg = loadTabReg(profile);
  const out = [];
  for (const p of context.pages()) {
    const tid = await pageTargetId(p).catch(() => null);
    if (!tid) continue;
    let num = Object.keys(reg.tabs).find((k) => reg.tabs[k] === tid);
    if (num === undefined) { num = reg.next++; reg.tabs[num] = tid; }
    out.push({ num: parseInt(num, 10), page: p, targetId: tid });
  }
  const live = new Set(out.map((o) => o.targetId));
  for (const k of Object.keys(reg.tabs)) if (!live.has(reg.tabs[k])) delete reg.tabs[k];
  saveTabReg(profile, reg);
  out.sort((a, b) => a.num - b.num);
  for (const o of out) {
    o.url = o.page.url();
    o.title = await o.page.title().catch(() => '');
  }
  return out;
}
async function registerNewTab(profile, page) {
  const tid = await pageTargetId(page);
  const reg = loadTabReg(profile);
  const num = reg.next++;
  reg.tabs[num] = tid;
  saveTabReg(profile, reg);
  return num;
}
async function pageForTab(profile, context, num) {
  const list = await resolveTabNumbers(profile, context);
  const hit = list.find((o) => o.num === parseInt(num, 10));
  if (!hit) throw { code: 'NOT_FOUND', message: `no tab ${num}`, hint: 'run tab-list to see tabs' };
  return hit.page;
}

function killSessionRecord(s) {
  if (s && s.pid) { try { process.kill(s.pid, 'SIGTERM'); } catch {} }
  if (s && s.xvfbOwned && s.xvfbPid) { try { process.kill(s.xvfbPid, 'SIGTERM'); } catch {} }
}

async function startDaemon(profile) {
  ensureDir(SESSIONS_DIR);
  const headed = HEADED();
  humanize.setEnabled(headed); // headed sessions get the human-behavior layer
  let exe = SHELL;
  if (headed) {
    exe = findFullChromium();
    if (!exe) {
      throw {
        code: 'NO_HEADED_CHROMIUM',
        message: 'no full Chromium found for --headed (headless_shell cannot open a window)',
        hint: 'npx playwright-core install chromium, or set AGENT_BROWSER_CHROMIUM_HEADED=/path/to/chrome',
      };
    }
  }
  if (!fs.existsSync(exe)) {
    throw {
      code: 'BROWSER_LAUNCH_FAILED',
      message: `Chromium not found at ${exe}`,
      hint: 'set AGENT_BROWSER_CHROMIUM to a Chromium/Chrome binary, or install one (npx playwright install chromium)',
    };
  }
  let xvfb = { display: process.env.DISPLAY || null, pid: null, owned: false };
  if (headed) xvfb = await ensureXvfb();
  const sf = sessionFile(profile);
  try { fs.unlinkSync(sf + '.err'); } catch {}
  const env = { ...process.env };
  if (headed && xvfb.display) env.DISPLAY = xvfb.display;
  if (xvfb.pid) { env.XVFB_PID = String(xvfb.pid); env.XVFB_OWNED = '1'; }
  // --proxy <url>: explicit egress proxy for this session (overrides the shim).
  if (process.env.AGENT_BROWSER_PROXY) env.PROXY_URL = process.env.AGENT_BROWSER_PROXY;
  const child = spawn(
    process.execPath,
    [path.join(__dirname, 'daemon.js'), sf, profile, exe, headed ? '1' : '0'],
    { detached: true, stdio: 'ignore', env },
  );
  child.unref();

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    const s = readSession(profile);
    if (s && s.wsEndpoint) return s;
    try {
      const err = fs.readFileSync(sf + '.err', 'utf8');
      if (err) throw { code: 'SESSION_START_FAILED', message: `browser daemon failed to start:\n${err.slice(0, 500)}` };
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (xvfb.owned && xvfb.pid) { try { process.kill(xvfb.pid); } catch {} }
  throw { code: 'SESSION_START_FAILED', message: 'browser daemon did not start within 25s', hint: 'check disk space and that the Chromium binary runs' };
}

// Health probe: is the daemon's browser ACTUALLY usable? Catches zombie
// sessions (daemon alive, CDP connects, but the browser is wedged — the
// exact failure QA hit: `open` hanging until timeout).
async function probeBrowser(browser) {
  try {
    const ctx = browser.contexts()[0];
    if (!ctx) return false;
    let page = ctx.pages()[0];
    let temp = false;
    if (!page) { page = await ctx.newPage(); temp = true; }
    const ok = await Promise.race([
      page.evaluate('1').then((v) => v === 1).catch(() => false),
      new Promise((r) => setTimeout(() => r(false), 5000)),
    ]);
    if (temp) await page.close().catch(() => {});
    return ok;
  } catch { return false; }
}

async function ensureSession(profile) {
  ensureDir(SESSIONS_DIR);
  const s = readSession(profile);
  if (s && s.wsEndpoint) {
    if (process.env.AGENT_BROWSER_PROXY) {
      console.error('note: --proxy applies to NEW sessions; this session is already running (close it first to switch proxy)');
    }
    try {
      const browser = await chromium.connectOverCDP(s.wsEndpoint, { timeout: 5000 });
      if (await probeBrowser(browser)) return { browser, session: s };
      console.error(`session '${profile}' failed health check (wedged?) — restarting it fresh`);
      try { await browser.close(); } catch {} // disconnect a dead browser
    } catch {
      // CDP unreachable: stale record, fall through to fresh start
    }
    killSessionRecord(s);
    try { fs.unlinkSync(sessionFile(profile)); } catch {}
  }
  const fresh = await startDaemon(profile);
  const browser = await chromium.connectOverCDP(fresh.wsEndpoint, { timeout: 20000 });
  return { browser, session: fresh };
}

// Run fn(page) against the session's active tab (or a fresh tab).
async function withPage(profile, fn, opts = {}) {
  profile = sessionKey(profile);
  humanize.setEnabled(HEADED()); // headed → human-behavior mimicry on click/type/scroll
  let conn;
  try {
    conn = await ensureSession(profile);
  } catch (e) {
    throw e && e.code ? e : { code: 'BROWSER_LAUNCH_FAILED', message: String((e && e.message) || e) };
  }
  const { browser } = conn;
  let context = browser.contexts()[0];
  if (!context) context = await browser.newContext();
  let page;
  try {
    if (opts.newPage) {
      page = await context.newPage();
    } else {
      const pages = context.pages();
      if (pages.length <= 1) {
        page = pages[0] || await context.newPage();
      } else {
        // Map the stored stable tab number → live page (CDP reorders targets).
        try { page = await pageForTab(profile, context, getActiveTab(profile)); }
        catch { page = pages[0]; }
      }
    }
  } catch (e) {
    throw { code: 'BROWSER_LAUNCH_FAILED', message: `could not create page: ${e.message}` };
  }
  try {
    return await fn(page);
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/timeout/i.test(msg) && !opts.retried) {
      // Auto-recover: the session is wedged — close it and retry ONCE on a
      // fresh browser. Logged to stderr so --json stdout stays clean.
      console.error('timeout hit — auto-recovering: closing wedged session and retrying once on a fresh browser');
      try { await closeSession(profile, false); } catch {}
      return withPage(profile, fn, { ...opts, retried: true });
    }
    if (e && e.code) throw e;
    if (/timeout/i.test(msg)) {
      throw { code: 'TIMEOUT', message: msg.split('\n')[0], hint: 'raise --timeout-ms or add an explicit wait' };
    }
    if (/strict mode violation|no element found|waiting for selector/i.test(msg)) {
      throw { code: 'NOT_FOUND', message: msg.split('\n')[0], hint: 'check the selector with: extract --selector ... or dump' };
    }
    throw { code: 'ACTION_FAILED', message: msg.split('\n')[0] };
  } finally {
    try { await browser.close(); } catch {} // disconnects CDP; daemon keeps the browser alive
  }
}

// Run fn(context) against the session's browser context (for multi-tab ops).
async function withContext(profile, fn) {
  profile = sessionKey(profile);
  humanize.setEnabled(HEADED());
  let conn;
  try {
    conn = await ensureSession(profile);
  } catch (e) {
    throw e && e.code ? e : { code: 'BROWSER_LAUNCH_FAILED', message: String((e && e.message) || e) };
  }
  try {
    let context = conn.browser.contexts()[0];
    if (!context) context = await conn.browser.newContext();
    return await fn(context);
  } finally {
    try { await conn.browser.close(); } catch {} // disconnects CDP; daemon keeps the browser alive
  }
}

async function listSessions() {
  ensureDir(SESSIONS_DIR);
  const out = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json') || f.endsWith('.tabs.json')) continue;
    const profile = f.slice(0, -5);
    const s = readSession(profile);
    if (!s || !s.wsEndpoint) continue; // not a live session record
    let alive = false;
    try { process.kill(s.pid, 0); alive = true; } catch {}
    out.push({ profile, pid: s.pid, alive, headed: !!s.headed, startedAt: s.startedAt });
  }
  return out;
}

async function closeSession(profile, all) {
  ensureDir(SESSIONS_DIR);
  // A plain `close` cleans up BOTH the headless and headed variants of the profile.
  const base = String(profile).replace(/-headed$/, '');
  const targets = all
    ? fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.tabs.json')).map((f) => f.slice(0, -5))
    : [base, `${base}-headed`];
  let closed = 0;
  for (const p of targets) {
    const s = readSession(p);
    // Persist cookies explicitly: this Chromium build does not reliably flush
    // the cookie DB on shutdown, so save storage state before killing.
    if (s && s.wsEndpoint && p !== 'default') {
      try {
        const browser = await chromium.connectOverCDP(s.wsEndpoint, { timeout: 5000 });
        const ctx = browser.contexts()[0];
        if (ctx) {
          ensureDir(profileDir(p));
          await ctx.storageState({ path: storageStatePath(p) });
        }
        await browser.close().catch(() => {}); // disconnect CDP; daemon still alive
      } catch {}
    }
    if (s && s.pid) {
      try { process.kill(s.pid, 'SIGTERM'); closed++; } catch {}
    }
    if (s && s.xvfbOwned && s.xvfbPid) {
      try { process.kill(s.xvfbPid, 'SIGTERM'); } catch {} // our virtual display
    }
    try { fs.unlinkSync(sessionFile(p)); } catch {}
    try { fs.unlinkSync(activeTabFile(p)); } catch {}
    try { fs.unlinkSync(tabRegFile(p)); } catch {}
  }
  return { closed, summary: closed ? `closed ${closed} session(s)` : 'no live sessions to close' };
}

module.exports = { SHELL, HEADED, ensureSession, withPage, withContext, getActiveTab, setActiveTab, pageTargetId, resolveTabNumbers, registerNewTab, pageForTab, listSessions, closeSession, profileDir, storageStatePath };
