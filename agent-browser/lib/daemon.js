// Detached browser daemon: owns one headless Chromium per profile session.
// Started detached by lib/session.js; stays alive until SIGTERM (via `close`).
// Uses a persistent context (real profile dir on disk) and exposes CDP via
// --remote-debugging-port; the port is discovered from DevToolsActivePort and
// written to the session file so CLI commands can attach with connectOverCDP.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright-core');
const { proxyConfig } = require('./util');
const { startLocalProxy } = require('./proxy-agent');

const [sessionFile, profile, exe] = process.argv.slice(2);

(async () => {
  const userDataDir = profile === 'default'
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'agent-browser-'))
    : path.join(os.homedir(), '.agent-browser', 'profiles', profile);
  fs.mkdirSync(userDataDir, { recursive: true });

  // Local shim injects preemptive Proxy-Authorization for the egress proxy.
  const shim = await startLocalProxy();
  const proxy = shim ? { server: `http://127.0.0.1:${shim.port}` } : proxyConfig();

  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: exe,
    headless: true,
    proxy,
    ignoreHTTPSErrors: true, // egress proxy MITMs TLS; documented in README
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--remote-debugging-port=0'],
  });

  // Restore cookies saved by a previous `close`. (This Chromium build does not
  // reliably flush its cookie DB on shutdown, so profiles persist via an
  // explicit storage-state file instead. localStorage is not restored in v1.)
  if (profile !== 'default') {
    try {
      const state = JSON.parse(fs.readFileSync(
        path.join(os.homedir(), '.agent-browser', 'profiles', profile, 'storage-state.json'), 'utf8'));
      if (state && state.cookies && state.cookies.length) {
        await context.addCookies(state.cookies);
      }
    } catch {}
  }

  // Discover the CDP port Chromium chose.
  const portFile = path.join(userDataDir, 'DevToolsActivePort');
  const deadline = Date.now() + 15000;
  let port = null;
  while (Date.now() < deadline) {
    try {
      const content = fs.readFileSync(portFile, 'utf8').trim().split('\n')[0];
      if (/^\d+$/.test(content)) { port = content; break; }
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!port) throw new Error('could not discover CDP port from DevToolsActivePort');

  fs.writeFileSync(sessionFile, JSON.stringify({
    wsEndpoint: `http://127.0.0.1:${port}`,
    pid: process.pid,
    profile,
    startedAt: new Date().toISOString(),
  }));

  const shutdown = async () => { try { await context.close(); } catch {} try { shim.close(); } catch {} process.exit(0); };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  setInterval(() => {}, 3600 * 1000); // keep the event loop alive
})().catch((e) => {
  try { fs.writeFileSync(sessionFile + '.err', String((e && e.stack) || e)); } catch {}
  process.exit(1);
});
