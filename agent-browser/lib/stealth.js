// Stealth profile for headed mode (--headed): realistic UA, webdriver hiding,
// plugins/languages spoofing, sane viewport, virtual display management.
// Honest scope: these evasions raise the bar against NAIVE bot checks
// (webdriver flag, missing plugins, headless tells). They do NOT defeat
// Cloudflare/Akamai-grade stacks, IP-reputation blocks, or behavior analysis.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Full Chromium binary (headless_shell CANNOT open a window). Prefers an
// explicit override, then the newest playwright-cached full chromium.
function findFullChromium() {
  const override = process.env.AGENT_BROWSER_CHROMIUM_HEADED;
  if (override && fs.existsSync(override)) return override;
  const base = path.join(os.homedir(), '.cache/ms-playwright');
  try {
    const dirs = fs.readdirSync(base).filter((d) => d.startsWith('chromium-')).sort().reverse();
    for (const d of dirs) {
      for (const sub of ['chrome-linux/chrome', 'chrome-linux64/chrome']) {
        const p = path.join(base, d, sub);
        if (fs.existsSync(p)) return p;
      }
    }
  } catch {}
  return null;
}

function headedUserAgent() {
  return 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36';
}

const STEALTH_ARGS = [
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-blink-features=AutomationControlled',
  '--disable-infobars',
  '--window-size=1366,768',
];

// Runs in page context before any page script: removes the classic
// automation tells. Best-effort; wrapped so one failure never breaks launch.
async function applyStealth(context) {
  await context.addInitScript(() => {
    try {
      // Real non-automated Chrome: navigator.webdriver === false, defined on
      // Navigator.prototype (NOT as an own property of navigator). Defining
      // it on the instance is itself a detectable tampering signal, so we
      // redefine it on the prototype to match real Chrome's shape exactly.
      Object.defineProperty(Navigator.prototype, 'webdriver', {
        get: () => false, configurable: true, enumerable: true,
      });
    } catch {}
    try {
      // Fake plugins that quack like a real PluginArray (instanceof + toString).
      const raw = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      const arr = raw.map((p) => {
        const o = { ...p };
        try { Object.setPrototypeOf(o, Plugin.prototype); } catch {}
        return o;
      });
      try { Object.setPrototypeOf(arr, PluginArray.prototype); } catch {}
      arr.item = (i) => arr[i] || null;
      arr.namedItem = (n) => arr.find((p) => p.name === n) || null;
      arr.refresh = () => {};
      Object.defineProperty(navigator, 'plugins', {
        get: () => arr, configurable: true, enumerable: true,
      });
      Object.defineProperty(navigator, 'mimeTypes', {
        get: () => [{ type: 'application/pdf', suffixes: 'pdf', description: '' }],
        configurable: true, enumerable: true,
      });
    } catch {}
    try {
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'], configurable: true });
    } catch {}
    try {
      if (!window.chrome) window.chrome = { runtime: {} };
    } catch {}
  });
}

// Start a virtual display for headed mode. Reuses :99 when already up
// (e.g. a previous session's Xvfb), otherwise spawns and owns one.
async function ensureXvfb(display = ':99') {
  if (process.env.DISPLAY) return { display: process.env.DISPLAY, pid: null, owned: false };
  const num = display.replace(':', '');
  const sock = `/tmp/.X11-unix/X${num}`;
  if (fs.existsSync(sock)) return { display, pid: null, owned: false };
  try { fs.unlinkSync(`/tmp/.X${num}-lock`); } catch {}
  const xv = spawn('Xvfb', [display, '-screen', '0', '1366x768x24'], {
    detached: true, stdio: 'ignore',
  });
  xv.unref();
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (fs.existsSync(sock)) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!fs.existsSync(sock)) {
    try { process.kill(xv.pid); } catch {}
    throw {
      code: 'XVFB_FAILED',
      message: `Xvfb did not come up on ${display}`,
      hint: 'is Xvfb installed? (apt install xvfb) — without it, --headed cannot open a real window',
    };
  }
  return { display, pid: xv.pid, owned: true };
}

module.exports = { findFullChromium, headedUserAgent, STEALTH_ARGS, applyStealth, ensureXvfb };
