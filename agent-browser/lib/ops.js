// Single-page browser operations. Each op takes (page, params) and returns a result object.
// The same ops power both the interactive CLI commands and bulk-mode action templates.
const fs = require('fs');
const path = require('path');
const { ensureDir, estimateTokens } = require('./util');

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function goto(page, url, { timeout = 30000, wait = 'load' } = {}) {
  const waitUntil = /^\d+$/.test(String(wait))
    ? (await page.waitForTimeout(parseInt(wait, 10)), 'load')
    : ({ load: 'load', networkidle: 'networkidle', domcontentloaded: 'domcontentloaded' }[wait] || 'load');
  let resp = null;
  try {
    resp = await page.goto(url, { timeout, waitUntil });
  } catch (e) {
    // Navigation timeouts still leave a usable page; surface honestly.
    if (!/timeout/i.test(e.message || '')) throw e;
    return { url: page.url(), title: await page.title().catch(() => ''), status: null, timedOut: true };
  }
  return { url: page.url(), title: await page.title().catch(() => ''), status: resp ? resp.status() : null };
}

async function shot(page, { out, fullPage = false, selector } = {}) {
  const dir = out ? path.dirname(path.resolve(out)) : path.resolve('shots');
  ensureDir(dir === '.' ? process.cwd() : dir);
  const file = out || path.join('shots', `shot-${stamp()}.png`);
  if (selector) await page.locator(selector).first().screenshot({ path: file });
  else await page.screenshot({ path: file, fullPage });
  const bytes = fs.statSync(file).size;
  return { path: path.resolve(file), bytes, fullPage };
}

// Heuristic DOM -> Markdown extractor tuned for LLM context:
// headings, leaf-block text with inline markdown links, meta description.
function extractorFn() {
  return () => {
    const BLOCKS = 'p,li,h1,h2,h3,h4,blockquote,pre,td,th,dt,dd,figcaption';
    const SKIP = new Set(['NAV', 'FOOTER', 'HEADER', 'ASIDE', 'SCRIPT', 'STYLE', 'NOSCRIPT']);
    const title = document.title || '';
    const meta = document.querySelector('meta[name="description"], meta[property="og:description"]');
    const description = meta ? (meta.getAttribute('content') || '').trim() : '';
    const lines = [];
    const inSkipped = (el) => {
      let n = el.parentElement;
      while (n && n !== document.body) { if (SKIP.has(n.tagName)) return true; n = n.parentElement; }
      return false;
    };
    const blocks = Array.from(document.querySelectorAll(BLOCKS))
      .filter((el) => !el.querySelector(BLOCKS) && !inSkipped(el))
      .slice(0, 3000);
    for (const el of blocks) {
      const tag = el.tagName;
      const clone = el.cloneNode(true);
      for (const a of clone.querySelectorAll('a[href]')) {
        const t = (a.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const href = a.getAttribute('href') || '';
        const md = document.createTextNode(t ? `[${t}](${href})` : href);
        a.replaceWith(md);
      }
      let text = (clone.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      if (text.length > 2000) text = text.slice(0, 2000) + '…';
      if (/^H[1-4]$/.test(tag)) lines.push('#'.repeat(Number(tag[1])) + ' ' + text);
      else if (tag === 'LI') lines.push('- ' + text);
      else if (tag === 'BLOCKQUOTE') lines.push('> ' + text);
      else lines.push(text);
    }
    return { title, description, lines };
  };
}

async function dump(page, { maxTokens, out, format = 'markdown' } = {}) {
  const fmt = String(format).toLowerCase();
  const url = page.url();
  if (fmt === 'html') {
    // Complete raw HTML — can be large; --out recommended for big pages.
    const html = await page.evaluate(() => document.documentElement.outerHTML);
    let tokens = estimateTokens(html);
    let truncated = false;
    let body = html;
    if (maxTokens && tokens > maxTokens) {
      body = html.slice(0, maxTokens * 4) + '\n<!-- truncated to token budget -->';
      tokens = estimateTokens(body);
      truncated = true;
    }
    let savedTo;
    if (out) {
      ensureDir(path.dirname(path.resolve(out)));
      fs.writeFileSync(out, body);
      savedTo = path.resolve(out);
    }
    return {
      url, title: await page.title().catch(() => ''), format: 'html', tokens, truncated,
      html: out ? undefined : body, savedTo,
      summary: `dumped ${url} as HTML: ${tokens} est. tokens${truncated ? ' (truncated)' : ''}${savedTo ? ` → ${savedTo}` : ''}`,
    };
  }
  const { title, description, lines } = await page.evaluate(extractorFn());
  const parts = [];
  if (title) parts.push('# ' + title);
  if (description) parts.push('> ' + description);
  parts.push(...lines);
  let markdown = parts.join('\n\n');
  if (fmt === 'text') {
    // Plain text: strip markdown decorations.
    markdown = markdown
      .replace(/^#{1,4} /gm, '')
      .replace(/^> /gm, '')
      .replace(/^- /gm, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  }
  let tokens = estimateTokens(markdown);
  let truncated = false;
  if (maxTokens && tokens > maxTokens) {
    markdown = markdown.slice(0, maxTokens * 4) + '\n\n…[truncated to token budget]';
    tokens = estimateTokens(markdown);
    truncated = true;
  }
  let savedTo;
  if (out) {
    ensureDir(path.dirname(path.resolve(out)));
    fs.writeFileSync(out, `# ${title}\n\nSource: ${url}\n\n` + markdown);
    savedTo = path.resolve(out);
  }
  return {
    url, title, format: fmt, tokens, truncated,
    markdown: out ? undefined : markdown,
    savedTo,
    summary: `dumped ${url} as ${fmt}: ${tokens} est. tokens${truncated ? ' (truncated)' : ''}${savedTo ? ` → ${savedTo}` : ''}`,
  };
}

async function extract(page, { selector, attr, limit = 100, timeout = 10000, table = false, csv = false } = {}) {
  const attrs = attr ? String(attr).split(',').map((s) => s.trim()).filter(Boolean) : [];
  if (table || csv) return extractTable(page, { selector, limit, csv });
  // Full text per element — never truncated. Use --limit to bound item COUNT (opt-in).
  const items = await page.$$eval(selector, (els, { attrs, limit }) => {
    return els.slice(0, limit).map((el, i) => {
      const item = { index: i, text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim() };
      for (const a of attrs) item[a] = el.getAttribute(a);
      return item;
    });
  }, { attrs, limit });
  return { items };
}

// --table: HTML <table> → { headers, rows } (rows as objects keyed by header).
// --csv: same data rendered as CSV text. Best-effort (colspan/rowspan not expanded).
async function extractTable(page, { selector, limit = 20, csv = false } = {}) {
  const tables = await page.$$eval(selector, (els, { limit }) => {
    return els.slice(0, limit).map((el) => {
      const t = el.tagName === 'TABLE' ? el : el.querySelector('table');
      if (!t) return null;
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      let headers = [...t.querySelectorAll('thead th')].map((h) => clean(h.innerText));
      const bodyRows = [];
      for (const tr of t.querySelectorAll('tr')) {
        if (tr.closest('thead')) continue;
        const cells = [...tr.querySelectorAll('th,td')].map((c) => clean(c.innerText));
        if (cells.length) bodyRows.push(cells);
      }
      if (!headers.length && bodyRows.length) headers = bodyRows.shift();
      if (!headers.length) headers = (bodyRows[0] || []).map((_, i) => `col${i + 1}`);
      const rows = bodyRows.map((r) => Object.fromEntries(headers.map((h, i) => [h || `col${i + 1}`, r[i] ?? ''])));
      return { headers, rowCount: rows.length, rows };
    }).filter(Boolean);
  }, { limit });
  if (!csv) return { tables };
  const q = (v) => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
  const parts = [];
  tables.forEach((t, i) => {
    if (tables.length > 1) parts.push(`# table ${i + 1}`);
    parts.push(t.headers.map(q).join(','));
    for (const r of t.rows) parts.push(t.headers.map((h) => q(r[h] ?? '')).join(','));
  });
  return { tables: tables.map((t) => ({ headers: t.headers, rowCount: t.rowCount })), csv: parts.join('\n') };
}

const humanize = require('./humanize');

async function click(page, { selector, waitNav = false, timeout = 10000 } = {}) {
  if (humanize.enabled()) {
    // Human path: bezier move, dwell, press — never a blind synthetic click.
    await humanize.maybeAmbient(page);
    const { x, y } = await humanize.humanClick(page, selector, { timeout, waitNav });
    return { selector, humanized: true, x: Math.round(x), y: Math.round(y), url: page.url() };
  }
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout });
  let navigatedTo = null;
  if (waitNav) {
    const [resp] = await Promise.all([
      page.waitForNavigation({ timeout }).catch(() => null),
      loc.click({ timeout }),
    ]);
    navigatedTo = resp ? resp.url() : page.url();
  } else {
    await loc.click({ timeout });
  }
  return { selector, navigatedTo, url: page.url() };
}

async function type(page, { selector, text, clear = false, submit = false, timeout = 10000 } = {}) {
  if (humanize.enabled()) {
    // Human path: variable 40–140ms cadence, occasional typo → correction.
    await humanize.maybeAmbient(page);
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout });
    if (clear) await loc.fill('');
    const { typed, typos } = await humanize.humanType(page, selector, text, { timeout, submit });
    const value = await loc.inputValue().catch(() => null);
    return { selector, chars: typed, typos, humanized: true, submitted: submit, value };
  }
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout });
  if (clear) await loc.fill('');
  else await loc.click({ timeout });
  await loc.pressSequentially(text, { delay: 15, timeout });
  let submitted = false;
  if (submit) { await loc.press('Enter'); submitted = true; }
  const value = await loc.inputValue().catch(() => null);
  return { selector, chars: text.length, submitted, value };
}

async function scroll(page, { to = 'bottom', selector } = {}) {
  if (humanize.enabled()) {
    // Human path: momentum-eased wheel events, not instant jumps.
    const r = await humanize.humanScroll(page, { to, selector });
    return { to, humanized: true, ...r };
  }
  if (selector) {
    await page.locator(selector).first().scrollIntoViewIfNeeded();
    return { to: `element ${selector}` };
  }
  const target = String(to).toLowerCase();
  const y = target === 'bottom'
    ? await page.evaluate(() => document.body.scrollHeight)
    : target === 'top' ? 0 : parseInt(target, 10) || 0;
  await page.evaluate((yy) => window.scrollTo(0, yy), y);
  return { to: target, y };
}

// move: reposition the cursor the human way, WITHOUT clicking.
// --selector <css> moves to inside that element; --x/--y move to coordinates.
async function move(page, { selector, x, y, timeout = 10000 } = {}) {
  let tx = x !== undefined ? Number(x) : null;
  let ty = y !== undefined ? Number(y) : null;
  if (selector) {
    const loc = page.locator(selector).first();
    await loc.waitFor({ state: 'visible', timeout });
    const box = await loc.boundingBox({ timeout });
    if (!box) throw { code: 'NOT_FOUND', message: `no visible bounding box for '${selector}'` };
    tx = box.x + box.width * (0.3 + Math.random() * 0.4);
    ty = box.y + box.height * (0.3 + Math.random() * 0.4);
  }
  if (tx === null || ty === null || Number.isNaN(tx) || Number.isNaN(ty)) {
    throw { code: 'BAD_FLAG', message: 'move needs --selector <css> or --x <n> --y <n>' };
  }
  const r = await humanize.humanMove(page, tx, ty);
  return { x: Math.round(r.to.x), y: Math.round(r.to.y), steps: r.steps, humanized: true };
}

async function wait(page, { ms, selector, state = 'visible', load, timeout = 30000 } = {}) {
  if (ms) { await page.waitForTimeout(ms); return { what: `${ms}ms` }; }
  if (selector) {
    await page.locator(selector).first().waitFor({ state, timeout });
    return { what: `selector '${selector}' → ${state}` };
  }
  if (load) {
    await page.waitForLoadState(load === 'networkidle' ? 'networkidle' : 'load', { timeout });
    return { what: `load state '${load}'` };
  }
  await page.waitForTimeout(1000);
  return { what: '1000ms (default)' };
}

// JS runs in page context (DOM APIs available). Accepts a bare expression
// ("1+1", "document.title", "location.href") or multi-statement code with an
// explicit return. Applies a REAL timeout via a race — page.evaluate itself
// has no timeout option (passing {timeout} as 2nd arg is silently ignored;
// it would just become the function's argument).
function evalTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

async function evalJs(page, { js, timeout = 30000 } = {}) {
  const src = String(js).trim();
  if (!src) throw { code: 'ACTION_FAILED', message: 'eval got empty --js', hint: 'pass an expression like "1+1" or "document.title"' };
  const run = (async () => {
    try {
      return await page.evaluate(src); // bare expression first
    } catch (e) {
      // Fall back to an async function body (supports statements + top-level await).
      // Parse-time failures can't have side effects, so a retry is safe.
      return await page.evaluate(`(async () => { ${src} })()`);
    }
  })();
  const result = await evalTimeout(run, timeout, 'eval').catch((e) => {
    if (/timed out/.test(e.message)) throw { code: 'TIMEOUT', message: e.message };
    throw e;
  });
  return { result };
}

async function upload(page, { selector, file, timeout = 30000 } = {}) {
  const p = path.resolve(String(file));
  if (!fs.existsSync(p)) {
    throw { code: 'NOT_FOUND', message: `upload file not found: ${file}`, hint: 'pass an existing local file path to --file' };
  }
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'attached', timeout });
  await loc.setInputFiles(p, { timeout });
  return { selector, file: p, bytes: fs.statSync(p).size };
}

async function pdf(page, { out } = {}) {
  const file = out || `page-${stamp()}.pdf`;
  ensureDir(path.dirname(path.resolve(file)));
  await page.pdf({ path: file, format: 'A4' });
  const bytes = fs.statSync(file).size;
  return { path: path.resolve(file), bytes };
}

// fields: JSON like {"#name":"Ali","#email":"a@b.c"}. Handles text inputs,
// selects, checkboxes/radios. --submit presses Enter in the last field.
async function fill(page, { fields, submit = false, timeout = 10000 } = {}) {
  let obj;
  try { obj = JSON.parse(fields); }
  catch { throw { code: 'BAD_FLAG', message: '--fields must be valid JSON, e.g. \'{"#name":"Ali"}\'' }; }
  const entries = Object.entries(obj);
  if (!entries.length) throw { code: 'BAD_FLAG', message: '--fields JSON object is empty' };
  const filled = [];
  let lastLoc = null;
  for (const [sel, val] of entries) {
    const loc = page.locator(sel).first();
    await loc.waitFor({ state: 'visible', timeout });
    const kind = await loc.evaluate((el) => {
      const t = el.tagName.toLowerCase();
      if (t === 'select') return 'select';
      if (t === 'input' && (el.type === 'checkbox' || el.type === 'radio')) return 'check';
      return 'text';
    }).catch(() => 'text');
    if (kind === 'select') await loc.selectOption(String(val), { timeout });
    else if (kind === 'check') {
      const want = val === true || val === 1 || String(val).toLowerCase() === 'true' || String(val) === '1';
      if ((await loc.isChecked().catch(() => false)) !== want) {
        if (humanize.enabled()) { await humanize.maybeAmbient(page); await humanize.humanClick(page, sel, { timeout }); }
        else await loc.click({ timeout });
      }
    }
    else if (humanize.enabled()) { await humanize.maybeAmbient(page); await humanize.humanType(page, sel, String(val), { timeout }); }
    else await loc.fill(String(val), { timeout });
    filled.push(sel);
    lastLoc = loc;
  }
  let submitted = false;
  if (submit && lastLoc) { await lastLoc.press('Enter').catch(() => {}); submitted = true; }
  return { filled, submitted };
}

// ---- assertions (for QA audits; caller sets non-zero exit on fail) ----

async function assertText(page, { selector, text, timeout = 10000 } = {}) {
  const loc = page.locator(selector).first();
  const actual = await loc.innerText({ timeout }).catch(() => null);
  if (actual === null) {
    return { pass: false, check: 'text-contains', selector, expected: text, actual: null, reason: 'element not found' };
  }
  return {
    pass: actual.includes(text), check: 'text-contains', selector, expected: text,
    actual: actual.length > 300 ? actual.slice(0, 300) + '…' : actual,
  };
}

async function assertJs(page, { js, timeout = 30000 } = {}) {
  const { result } = await evalJs(page, { js, timeout });
  return { pass: !!result, check: 'js-truthy', js, result };
}

// ---- network log: records every request/response while loading a URL ----

async function netlog(page, { url, out, waitMs = 3000, timeout = 30000 } = {}) {
  const events = [];
  const onReq = (r) => events.push({ kind: 'request', method: r.method(), url: r.url(), ts: Date.now() });
  const onResp = async (r) => {
    let bytes = null;
    try { const b = await r.body(); bytes = b.length; } catch {}
    events.push({ kind: 'response', url: r.url(), status: r.status(), bytes, ts: Date.now() });
  };
  const onFail = (r) => events.push({ kind: 'requestfailed', url: r.url(), error: ((r.failure() || {}).errorText) || 'unknown', ts: Date.now() });
  page.on('request', onReq);
  page.on('response', onResp);
  page.on('requestfailed', onFail);
  let finalUrl = url;
  try {
    const nav = await goto(page, url, { timeout });
    finalUrl = nav.url;
  } finally {
    await page.waitForTimeout(waitMs);
    page.off('request', onReq);
    page.off('response', onResp);
    page.off('requestfailed', onFail);
  }
  const file = out || `netlog-${stamp()}.jsonl`;
  ensureDir(path.dirname(path.resolve(file)));
  fs.writeFileSync(file, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const requests = events.filter((e) => e.kind === 'request').length;
  const failed = events.filter((e) => e.kind === 'requestfailed').length;
  return {
    url: finalUrl, events: events.length, requests, failed,
    out: path.resolve(file),
    summary: `captured ${events.length} network events (${requests} requests, ${failed} failed) → ${path.resolve(file)}`,
  };
}

// ---- screenshot diff (visual regression) ----

function shotDiff({ a, b, out, threshold = 0.1 } = {}) {
  const { PNG } = require('pngjs');
  const _pm = require('pixelmatch');
  const pixelmatch = _pm.default || _pm; // pixelmatch >=6 is ESM-only
  for (const [label, p] of [['--a', a], ['--b', b]]) {
    if (!p || !fs.existsSync(p)) throw { code: 'NOT_FOUND', message: `${label} file not found: ${p}` };
  }
  const imgA = PNG.sync.read(fs.readFileSync(a));
  const imgB = PNG.sync.read(fs.readFileSync(b));
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) {
    throw {
      code: 'SIZE_MISMATCH',
      message: `image sizes differ: ${imgA.width}x${imgA.height} vs ${imgB.width}x${imgB.height}`,
      hint: 'take both screenshots the same way (both --full-page, or both viewport)',
    };
  }
  const { width, height } = imgA;
  const diff = new PNG({ width, height });
  const numDiff = pixelmatch(imgA.data, imgB.data, diff.data, width, height, { threshold });
  const outPath = out || `diff-${stamp()}.png`;
  ensureDir(path.dirname(path.resolve(outPath)));
  fs.writeFileSync(outPath, PNG.sync.write(diff));
  return {
    a: path.resolve(a), b: path.resolve(b), out: path.resolve(outPath),
    width, height, threshold,
    diffPixels: numDiff,
    diffPercent: Math.round((numDiff / (width * height)) * 10000) / 100,
  };
}

module.exports = {
  goto, shot, dump, extract, click, type, scroll, move, wait, evalJs, upload, pdf,
  fill, assertText, assertJs, netlog, shotDiff,
};
