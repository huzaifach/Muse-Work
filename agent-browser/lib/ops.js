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

async function dump(page, { maxTokens, out } = {}) {
  const { title, description, lines } = await page.evaluate(extractorFn());
  const parts = [];
  if (title) parts.push('# ' + title);
  if (description) parts.push('> ' + description);
  parts.push(...lines);
  let markdown = parts.join('\n\n');
  let tokens = estimateTokens(markdown);
  let truncated = false;
  if (maxTokens && tokens > maxTokens) {
    markdown = markdown.slice(0, maxTokens * 4) + '\n\n…[truncated to token budget]';
    tokens = estimateTokens(markdown);
    truncated = true;
  }
  const url = page.url();
  let savedTo;
  if (out) {
    ensureDir(path.dirname(path.resolve(out)));
    fs.writeFileSync(out, `# ${title}\n\nSource: ${url}\n\n` + markdown);
    savedTo = path.resolve(out);
  }
  return {
    url, title, tokens, truncated, markdown,
    savedTo,
    summary: `dumped ${url}: ${tokens} est. tokens${truncated ? ' (truncated)' : ''}${savedTo ? ` → ${savedTo}` : ''}`,
  };
}

async function extract(page, { selector, attr, limit = 100, timeout = 10000 } = {}) {
  const attrs = attr ? String(attr).split(',').map((s) => s.trim()).filter(Boolean) : [];
  const items = await page.$$eval(selector, (els, { attrs, limit }) => {
    return els.slice(0, limit).map((el, i) => {
      const item = { index: i, text: (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500) };
      for (const a of attrs) item[a] = el.getAttribute(a);
      return item;
    });
  }, { attrs, limit });
  return { items };
}

async function click(page, { selector, waitNav = false, timeout = 10000 } = {}) {
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

// JS runs in page context (DOM APIs available). Must return a JSON-serializable value.
async function evalJs(page, { js, timeout = 30000 } = {}) {
  const result = await page.evaluate(`(async () => { ${js} })()`, { timeout });
  return { result };
}

async function pdf(page, { out } = {}) {
  const file = out || `page-${stamp()}.pdf`;
  ensureDir(path.dirname(path.resolve(file)));
  await page.pdf({ path: file, format: 'A4' });
  const bytes = fs.statSync(file).size;
  return { path: path.resolve(file), bytes };
}

module.exports = { goto, shot, dump, extract, click, type, scroll, wait, evalJs, pdf };
