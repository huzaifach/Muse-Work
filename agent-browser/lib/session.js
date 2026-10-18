// Session management: one persistent headless Chromium per profile,
// owned by a detached daemon (lib/daemon.js). CLI commands attach over CDP.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { SESSIONS_DIR, PROFILES_DIR, ensureDir } = require('./util');

const SHELL = process.env.AGENT_BROWSER_CHROMIUM ||
  path.join(os.homedir(), '.cache/ms-playwright/chromium_headless_shell-1148/chrome-linux/headless_shell');

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

async function startDaemon(profile) {
  ensureDir(SESSIONS_DIR);
  if (!fs.existsSync(SHELL)) {
    throw {
      code: 'BROWSER_LAUNCH_FAILED',
      message: `headless Chromium shell not found at ${SHELL}`,
      hint: 'set AGENT_BROWSER_CHROMIUM to a Chromium/Chrome binary, or install one (npx playwright install chromium)',
    };
  }
  const sf = sessionFile(profile);
  try { fs.unlinkSync(sf + '.err'); } catch {}
  const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js'), sf, profile, SHELL], {
    detached: true,
    stdio: 'ignore',
  });
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
  throw { code: 'SESSION_START_FAILED', message: 'browser daemon did not start within 25s', hint: 'check disk space and that the Chromium shell runs' };
}

async function ensureSession(profile) {
  ensureDir(SESSIONS_DIR);
  const s = readSession(profile);
  if (s && s.wsEndpoint) {
    try {
      const browser = await chromium.connectOverCDP(s.wsEndpoint, { timeout: 5000 });
      return { browser, session: s };
    } catch {
      try { process.kill(s.pid); } catch {} // stale daemon, clean up
    }
  }
  const fresh = await startDaemon(profile);
  const browser = await chromium.connectOverCDP(fresh.wsEndpoint, { timeout: 20000 });
  return { browser, session: fresh };
}

// Run fn(page) against the session's active tab (or a fresh tab).
async function withPage(profile, fn, opts = {}) {
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
    page = opts.newPage ? await context.newPage() : (context.pages()[0] || await context.newPage());
  } catch (e) {
    throw { code: 'BROWSER_LAUNCH_FAILED', message: `could not create page: ${e.message}` };
  }
  try {
    return await fn(page);
  } catch (e) {
    if (e && /timeout/i.test(e.message || '')) {
      throw { code: 'TIMEOUT', message: e.message.split('\n')[0], hint: 'raise --timeout-ms or add an explicit wait' };
    }
    if (e && /strict mode violation|no element found|waiting for selector/i.test(e.message || '')) {
      throw { code: 'NOT_FOUND', message: e.message.split('\n')[0], hint: 'check the selector with: extract --selector ... or dump' };
    }
    throw e && e.code ? e : { code: 'ACTION_FAILED', message: String((e && e.message) || e).split('\n')[0] };
  } finally {
    try { await browser.close(); } catch {} // disconnects CDP; daemon keeps the browser alive
  }
}

async function listSessions() {
  ensureDir(SESSIONS_DIR);
  const out = [];
  for (const f of fs.readdirSync(SESSIONS_DIR)) {
    if (!f.endsWith('.json')) continue;
    const profile = f.slice(0, -5);
    const s = readSession(profile);
    if (!s) continue;
    let alive = false;
    try { process.kill(s.pid, 0); alive = true; } catch {}
    out.push({ profile, pid: s.pid, alive, startedAt: s.startedAt });
  }
  return out;
}

async function closeSession(profile, all) {
  ensureDir(SESSIONS_DIR);
  const targets = all
    ? fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5))
    : [profile];
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
    if (s && s.pid) { try { process.kill(s.pid, 'SIGTERM'); closed++; } catch {} }
    try { fs.unlinkSync(sessionFile(p)); } catch {}
  }
  return { closed, summary: closed ? `closed ${closed} session(s)` : 'no live sessions to close' };
}

module.exports = { SHELL, ensureSession, withPage, listSessions, closeSession, profileDir, storageStatePath };
