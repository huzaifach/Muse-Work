// CRAWL: breadth-first link discovery from a start URL.
// Output is JSONL with one {"url": ...} per line — directly feedable to
// `bulk --input`. Polite by default: same-domain only unless --all-domains,
// robots.txt honored when --respect-robots is passed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');
const { SHELL } = require('./session');
const { ensureDir, slugifyUrl, robotsAllowed, proxyConfig } = require('./util');
const { startLocalProxy } = require('./proxy-agent');
const { findFullChromium, headedUserAgent, STEALTH_ARGS, applyStealth, ensureXvfb } = require('./stealth');

function norm(u) {
  try {
    const p = new URL(u);
    if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
    p.hash = '';
    return p.toString();
  } catch { return null; }
}

async function crawl(opts) {
  const startUrl = opts.url;
  const startHost = (() => { try { return new URL(startUrl).hostname; } catch { return ''; } })();
  const maxPages = Math.max(1, opts.maxPages || 50);
  const maxDepth = Math.max(0, opts.maxDepth === undefined ? 2 : opts.maxDepth);
  const sameDomain = opts.allDomains ? false : true;
  const timeoutMs = opts.timeoutMs || 30000;
  const headed = !!opts.headed || process.env.AGENT_BROWSER_HEADED === '1';

  let exe = SHELL;
  if (headed) {
    exe = findFullChromium();
    if (!exe) throw { code: 'NO_HEADED_CHROMIUM', message: 'no full Chromium found for --headed' };
    await ensureXvfb();
  }
  if (!fs.existsSync(exe)) throw { code: 'BROWSER_LAUNCH_FAILED', message: `Chromium not found at ${exe}` };

  const shim = await startLocalProxy();
  const proxy = shim ? { server: `http://127.0.0.1:${shim.port}` } : proxyConfig();
  const browser = await chromium.launch({
    executablePath: exe,
    headless: !headed,
    proxy,
    args: headed ? [...STEALTH_ARGS] : ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({
    viewport: { width: 1366, height: 768 },
    ignoreHTTPSErrors: true,
    ...(headed ? { userAgent: headedUserAgent(), locale: 'en-US' } : {}),
  });
  if (headed) await applyStealth(context);
  context.setDefaultNavigationTimeout(timeoutMs);

  const seen = new Set();
  const queue = [];
  const push = (url, depth) => {
    const n = norm(url);
    if (!n || seen.has(n)) return;
    if (sameDomain) { try { if (new URL(n).hostname !== startHost) return; } catch { return; } }
    seen.add(n);
    queue.push({ url: n, depth });
  };
  push(startUrl, 0);

  const t0 = Date.now();
  const pages = [];
  const log = (m) => console.error(m);
  while (queue.length && pages.length < maxPages) {
    const { url, depth } = queue.shift();
    const page = await context.newPage();
    const rec = { url, depth };
    try {
      if (opts.respectRobots && !(await robotsAllowed(url))) {
        rec.skipped = 'robots.txt'; pages.push(rec); await page.close().catch(() => {}); continue;
      }
      await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
      rec.title = await page.title().catch(() => '');
      rec.status = 'ok';
      const links = await page.$$eval('a[href]', (els) => els.map((e) => e.href)).catch(() => []);
      rec.linksFound = links.length;
      if (depth < maxDepth) for (const l of links) push(l, depth + 1);
    } catch (e) {
      rec.error = String((e && e.message) || e).split('\n')[0];
    }
    pages.push(rec);
    await page.close().catch(() => {});
    if (pages.length % 10 === 0) log(`crawl: ${pages.length}/${maxPages} pages, ${queue.length} queued`);
  }
  await browser.close().catch(() => {});
  if (shim) shim.close();

  const ok = pages.filter((p) => p.status === 'ok');
  const out = opts.out || `crawl-${slugifyUrl(startUrl)}.jsonl`;
  ensureDir(path.dirname(path.resolve(out)));
  // JSONL URL list — the exact format `bulk --input` accepts.
  fs.writeFileSync(out, ok.map((p) => JSON.stringify({ url: p.url })).join('\n') + (ok.length ? '\n' : ''));
  return {
    startUrl, maxPages, maxDepth, sameDomain,
    crawled: pages.length, ok: ok.length,
    queued: queue.length, ms: Date.now() - t0,
    out: path.resolve(out),
    summary: `crawled ${pages.length} pages (${ok.length} ok) from ${startUrl} → ${path.resolve(out)} (${ok.length} URLs for bulk)`,
  };
}

module.exports = { crawl };
