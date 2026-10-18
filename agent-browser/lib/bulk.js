// BULK mode: run an action template across many URLs in parallel.
// Deterministic, no LLM calls. v1.1 upgrades:
//  - --out-dir: per-URL COMPLETE output files (COMPLETE OUTPUT RULE — never
//    summarize/merge/shrink deliverables); results.jsonl is INDEX ONLY.
//  - conditional steps: {"op": ..., "if": {"selector"|"text"|"js": ...}}
//  - chaining: {{var}} templates in any string field (url/id/index/host/slug
//    plus earlier steps' outputs by their `as` name or op name).
//  - --since <statefile>: sha256 content-hash compare, skip unchanged URLs.
//  - --resume: skip items already done in the results file.
//  - --max-per-domain N + --delay-ms: polite throttling.
//  - --proxy <url> / --proxy-list <file>: per-item proxy rotation.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require('playwright-core');
const { SHELL } = require('./session');
const ops = require('./ops');
const { ensureDir, readLines, readJsonFile, slugifyUrl, expandTemplate, robotsAllowed, proxyConfig } = require('./util');
const { startLocalProxy } = require('./proxy-agent');
const { findFullChromium, headedUserAgent, STEALTH_ARGS, applyStealth, ensureXvfb } = require('./stealth');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadItems(inputFile) {
  return readLines(inputFile).map((line, i) => {
    if (line.startsWith('{')) {
      try {
        const o = JSON.parse(line);
        if (!o.url) throw new Error('missing "url"');
        return { id: o.id || `item-${i}`, url: o.url };
      } catch (e) {
        throw { code: 'BAD_FILE', message: `bad JSON on line ${i + 1} of ${inputFile}: ${e.message}` };
      }
    }
    return { id: `item-${i}`, url: line };
  });
}

function loadActions(actionsFile) {
  const raw = readJsonFile(actionsFile);
  const actions = Array.isArray(raw) ? raw : raw.actions;
  if (!Array.isArray(actions) || !actions.length) {
    throw { code: 'BAD_FILE', message: `${actionsFile} must contain a non-empty "actions" array` };
  }
  const valid = new Set(['goto', 'wait', 'click', 'type', 'scroll', 'move', 'shot', 'dump', 'extract', 'eval', 'pdf', 'upload']);
  actions.forEach((a, i) => {
    if (!a || !valid.has(a.op)) throw { code: 'BAD_FILE', message: `actions[${i}].op must be one of: ${[...valid].join(', ')}` };
  });
  return actions;
}

function safeId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'item';
}

// Best-effort: pull saved-file paths out of action results for the index.
function collectFiles(data) {
  const files = [];
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (typeof v.path === 'string') files.push(v.path);
    if (typeof v.savedTo === 'string') files.push(v.savedTo);
    if (typeof v.out === 'string' && /\.(png|pdf|jsonl?|html|md|txt|csv|har)$/i.test(v.out)) files.push(v.out);
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(data);
  return [...new Set(files)];
}

// Chaining: turn a step's result into a template string for later steps.
function stepValue(v) {
  if (v && typeof v === 'object' && 'result' in v && (typeof v.result !== 'object' || v.result === null)) {
    return v.result === null || v.result === undefined ? '' : String(v.result);
  }
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try { return JSON.stringify(v); } catch { return String(v); }
}

// Expand {{var}} in every string field except op/as (unknown vars stay as-is).
function expandDeep(val, vars) {
  if (typeof val === 'string') return expandTemplate(val, vars);
  if (Array.isArray(val)) return val.map((x) => expandDeep(x, vars));
  if (val && typeof val === 'object') {
    const o = {};
    for (const [k, v] of Object.entries(val)) o[k] = (k === 'op' || k === 'as') ? v : expandDeep(v, vars);
    return o;
  }
  return val;
}

async function condMet(page, cond, timeoutMs) {
  if (!cond || typeof cond !== 'object') return true;
  if (cond.selector) {
    try { return (await page.locator(cond.selector).count()) > 0; }
    catch { return false; }
  }
  if (cond.text !== undefined) {
    const body = await page.evaluate(() => (document.body ? document.body.innerText || '' : '')).catch(() => '');
    return body.includes(String(cond.text));
  }
  if (cond.js) {
    try {
      const { result } = await ops.evalJs(page, { js: cond.js, timeout: timeoutMs });
      return !!result;
    } catch { return false; }
  }
  return true;
}

async function runActions(page, actions, vars, ctx) {
  const data = {};
  const used = {};
  for (let i = 0; i < actions.length; i++) {
    const a = expandDeep(actions[i], vars);
    const base = a.as || a.op;
    used[base] = (used[base] || 0) + 1;
    const key = used[base] > 1 ? `${base}_${used[base]}` : base;
    const t = ctx.timeoutMs;
    if (a.if && !(await condMet(page, a.if, t))) {
      data[key] = { skipped: true, reason: 'if-condition not met' };
      vars[key] = '';
      continue;
    }
    switch (a.op) {
      case 'goto':
        data[key] = await ops.goto(page, a.url || vars.url, { timeout: t, wait: a.wait || 'load' });
        break;
      case 'wait':
        data[key] = await ops.wait(page, { ms: a.ms, selector: a.selector, state: a.state, load: a.load, timeout: t });
        break;
      case 'click':
        data[key] = await ops.click(page, { selector: a.selector, waitNav: !!a.waitNav, timeout: t });
        break;
      case 'type':
        data[key] = await ops.type(page, { selector: a.selector, text: a.text || '', clear: !!a.clear, submit: !!a.submit, timeout: t });
        break;
      case 'scroll':
        data[key] = await ops.scroll(page, { to: a.to || 'bottom', selector: a.selector });
        break;
      case 'move':
        data[key] = await ops.move(page, { selector: a.selector, x: a.x, y: a.y, timeout: t });
        break;
      case 'shot': {
        const out = a.out || path.join(ctx.shotsDir, `${vars.slug}-${vars.index}.png`);
        data[key] = await ops.shot(page, { out, fullPage: !!a.fullPage, selector: a.selector });
        break;
      }
      case 'dump':
        data[key] = await ops.dump(page, { maxTokens: a.maxTokens, out: a.out, format: a.format });
        break;
      case 'extract':
        data[key] = await ops.extract(page, { selector: a.selector, attr: a.attr, limit: a.limit || 100, timeout: t, table: !!a.table, csv: !!a.csv });
        break;
      case 'eval':
        data[key] = await ops.evalJs(page, { js: a.js || 'return document.title;', timeout: t });
        break;
      case 'upload':
        data[key] = await ops.upload(page, { selector: a.selector, file: a.file, timeout: t });
        break;
      case 'pdf':
        data[key] = await ops.pdf(page, { out: a.out || path.join(ctx.shotsDir, `${vars.slug}-${vars.index}.pdf`) });
        break;
    }
    vars[key] = stepValue(data[key]); // chaining
  }
  return data;
}

async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject({ code: 'TIMEOUT', message: `${label} exceeded ${ms}ms` }), ms);
  });
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(timer); }
}

// Per-domain concurrency limiter (polite throttling).
function makeDomainLimiter() {
  const sems = new Map();
  return async function withSlot(host, limit, fn) {
    if (!limit || limit <= 0) return fn();
    let s = sems.get(host);
    if (!s) { s = { active: 0, waiters: [] }; sems.set(host, s); }
    while (s.active >= limit) await new Promise((r) => s.waiters.push(r));
    s.active++;
    try { return await fn(); }
    finally { s.active--; const w = s.waiters.shift(); if (w) w(); }
  };
}

async function runBulk(opts) {
  const started = Date.now();
  const items = loadItems(opts.input);
  const actions = loadActions(opts.actionsFile);
  const total = items.length;
  if (!total) throw { code: 'BAD_FILE', message: `${opts.input} contains no URLs` };

  // --out-dir: per-URL COMPLETE output files; results.jsonl becomes INDEX ONLY.
  const outDir = opts.outDir ? path.resolve(opts.outDir) : null;
  if (outDir) ensureDir(outDir);
  const indexPath = outDir && !opts.outExplicit ? path.join(outDir, 'results.jsonl') : path.resolve(opts.out);
  ensureDir(path.dirname(indexPath));
  ensureDir(opts.shotsDir);
  if (opts.failures) ensureDir(path.dirname(path.resolve(opts.failures)));

  // --resume: skip items already done in the results file (do NOT truncate it).
  const doneIds = new Set();
  if (opts.resume && fs.existsSync(indexPath)) {
    for (const line of fs.readFileSync(indexPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r && r.id && ['ok', 'skipped', 'unchanged'].includes(r.status)) doneIds.add(r.id);
      } catch {}
    }
  } else {
    fs.writeFileSync(indexPath, ''); // fresh results file
  }
  const appendResult = (obj) => fs.appendFileSync(indexPath, JSON.stringify(obj) + '\n');

  // --since: content-hash state for incremental runs.
  let sinceState = null, sincePath = null;
  if (opts.since) {
    sincePath = path.resolve(opts.since);
    try { sinceState = JSON.parse(fs.readFileSync(sincePath, 'utf8')); } catch { sinceState = {}; }
    if (!sinceState || typeof sinceState !== 'object' || Array.isArray(sinceState)) sinceState = {};
  }

  // --proxy / --proxy-list: per-item proxy rotation (set per context).
  let proxyList = [];
  if (opts.proxyList) {
    proxyList = readLines(opts.proxyList).filter((l) => /^https?:\/\//i.test(l));
    if (!proxyList.length) throw { code: 'BAD_FILE', message: `--proxy-list '${opts.proxyList}' has no usable proxy URLs` };
  }
  const itemProxy = proxyList.length
    ? ((item, index) => proxyList[index % proxyList.length])
    : (opts.proxy ? (() => opts.proxy) : null);

  const concurrency = Math.max(1, Math.min(opts.concurrency || 5, total));
  const maxPerDomain = Math.max(0, opts.maxPerDomain || 0);
  const delayMs = Math.max(0, opts.delayMs || opts.rateLimitMs || 0);
  const withDomainSlot = makeDomainLimiter();
  const failures = [];
  let done = 0, okCount = 0, failCount = 0, skipCount = 0, unchangedCount = 0;
  let next = 0;

  const log = (msg) => console.error(msg);
  const headed = !!opts.headed || process.env.AGENT_BROWSER_HEADED === '1';
  require('./humanize').setEnabled(headed); // headed bulk → humanized actions

  // Browser fleet. Proxy shim only when NOT using explicit proxies.
  const shim = itemProxy ? null : await startLocalProxy();
  const browserProxy = itemProxy ? undefined : (shim ? { server: `http://127.0.0.1:${shim.port}` } : proxyConfig());
  let exe = SHELL;
  let xvfb = null;
  if (headed) {
    exe = findFullChromium();
    if (!exe) throw { code: 'NO_HEADED_CHROMIUM', message: 'no full Chromium found for --headed (headless_shell cannot open a window)', hint: 'npx playwright-core install chromium, or set AGENT_BROWSER_CHROMIUM_HEADED=/path/to/chrome' };
    xvfb = await ensureXvfb();
    if (xvfb.display && !process.env.DISPLAY) process.env.DISPLAY = xvfb.display;
  }
  if (!fs.existsSync(exe)) throw { code: 'BROWSER_LAUNCH_FAILED', message: `Chromium not found at ${exe}` };
  const browsers = [];
  for (let w = 0; w < concurrency; w++) {
    browsers.push(await chromium.launch({
      executablePath: exe,
      headless: !headed,
      ...(browserProxy ? { proxy: browserProxy } : {}),
      args: headed ? [...STEALTH_ARGS] : ['--no-sandbox', '--disable-dev-shm-usage'],
    }));
  }

  const ctxBase = { shotsDir: opts.shotsDir, timeoutMs: opts.timeoutMs, headed };

  async function newItemContext(browser, item, index) {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 768 },
      ignoreHTTPSErrors: true, // egress proxy MITMs TLS; documented in README
      ...(headed ? { userAgent: headedUserAgent(), locale: 'en-US' } : {}),
      ...(itemProxy ? { proxy: { server: itemProxy(item, index) } } : {}),
    });
    if (headed) await applyStealth(context);
    context.setDefaultTimeout(opts.timeoutMs);
    context.setDefaultNavigationTimeout(opts.timeoutMs);
    return context;
  }

  // --since probe: goto + full dump → sha256. Internal only (not a deliverable).
  async function probeContent(browser, item, index) {
    const context = await newItemContext(browser, item, index);
    try {
      const page = await context.newPage();
      try {
        await ops.goto(page, item.url, { timeout: opts.timeoutMs, wait: 'domcontentloaded' });
        const d = await ops.dump(page, {});
        return { hash: crypto.createHash('sha256').update(d.markdown || '').digest('hex') };
      } finally { await page.close().catch(() => {}); }
    } catch (e) {
      return { error: String((e && e.message) || e).split('\n')[0] };
    } finally { await context.close().catch(() => {}); }
  }

  async function processItem(browser, item, index) {
    const vars = {
      url: item.url, id: item.id, index,
      host: (() => { try { return new URL(item.url).hostname; } catch { return 'unknown'; } })(),
      slug: slugifyUrl(item.url),
    };
    const t0 = Date.now();
    const record = { id: item.id, url: item.url, index };
    const finish = (status, extra) => {
      record.status = status;
      record.ms = Date.now() - t0;
      if (extra) Object.assign(record, extra);
      appendResult(record);
      done++;
      return record;
    };

    if (doneIds.has(item.id)) {
      skipCount++;
      log(`[${done + 1}/${total}] SKIP ${item.id} (already done, --resume)`);
      return finish('skipped', { reason: 'already done (--resume)' });
    }

    await withDomainSlot(vars.host, maxPerDomain, async () => {
      if (opts.respectRobots && !(await robotsAllowed(item.url))) {
        skipCount++;
        log(`[${done + 1}/${total}] SKIP ${item.id} (robots.txt)`);
        finish('skipped', { reason: 'robots-txt disallows this path' });
        return;
      }

      // --since: skip unchanged content before running the full template.
      let newHash = null;
      if (sinceState) {
        const probe = await probeContent(browser, item, index);
        if (!probe.error) {
          if (sinceState[item.url] === probe.hash) {
            unchangedCount++;
            log(`[${done + 1}/${total}] UNCHANGED ${item.id}`);
            finish('unchanged', { reason: 'content hash matches --since state' });
            return;
          }
          newHash = probe.hash;
        }
      }

      let lastErr = null;
      for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
        const context = await newItemContext(browser, item, index);
        try {
          const page = await context.newPage();
          // Implicit navigation: every item starts on its URL, unless the
          // template's first step is an explicit goto (the v1.0 pattern —
          // goto with no url already targets the item URL).
          if (!actions.length || actions[0].op !== 'goto') {
            await ops.goto(page, item.url, { timeout: opts.timeoutMs, wait: 'domcontentloaded' });
          }
          const data = await withTimeout(
            runActions(page, actions, vars, ctxBase),
            opts.itemTimeoutMs,
            `item ${item.id}`
          );
          const extra = { attempts: attempt };
          if (outDir) {
            // COMPLETE OUTPUT RULE: full per-URL output as its own file.
            const itemFile = path.join(outDir, `${safeId(item.id)}.json`);
            fs.writeFileSync(itemFile, JSON.stringify({ id: item.id, url: item.url, index, data }, null, 1));
            extra.files = [itemFile, ...collectFiles(data)];
          }
          if (sinceState && newHash) sinceState[item.url] = newHash;
          okCount++;
          log(`[${done + 1}/${total}] OK   ${item.id} (${Date.now() - t0}ms${attempt > 1 ? `, attempt ${attempt}` : ''}${outDir ? ' → per-URL file' : ''})`);
          finish('ok', extra);
          await context.close().catch(() => {});
          return;
        } catch (e) {
          lastErr = e;
          await context.close().catch(() => {});
          if (attempt <= opts.retries) await sleep(1000 * attempt);
        }
      }
      failCount++;
      const rec = {
        error: { code: (lastErr && lastErr.code) || 'ACTION_FAILED', message: String((lastErr && lastErr.message) || lastErr).split('\n')[0] },
        attempts: opts.retries + 1,
      };
      failures.push({ ...record, ...rec });
      log(`[${done + 1}/${total}] FAIL ${item.id}: ${rec.error.message}`);
      finish('failed', rec);
    });
  }

  async function worker(browser) {
    while (true) {
      const i = next++;
      if (i >= total) break;
      if (delayMs) await sleep(delayMs);
      await processItem(browser, items[i], i);
    }
  }

  await Promise.all(browsers.map(worker));
  for (const b of browsers) await b.close().catch(() => {});
  if (shim) shim.close();
  if (xvfb && xvfb.owned && xvfb.pid) { try { process.kill(xvfb.pid); } catch {} }

  if (sincePath) {
    ensureDir(path.dirname(sincePath));
    fs.writeFileSync(sincePath, JSON.stringify(sinceState, null, 1));
  }

  let failuresFile = null;
  if (opts.failures) {
    failuresFile = path.resolve(opts.failures);
    fs.writeFileSync(failuresFile, failures.map((f) => JSON.stringify(f)).join('\n') + (failures.length ? '\n' : ''));
  }

  return {
    total, succeeded: okCount, failed: failCount, skipped: skipCount, unchanged: unchangedCount,
    ms: Date.now() - started,
    resultsFile: indexPath,
    outDir: outDir || null,
    failuresFile,
  };
}

module.exports = { runBulk, loadItems, loadActions };
