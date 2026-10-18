// BULK mode: run an action template across many URLs in parallel.
// Deterministic, no LLM calls: N worker browsers, per-item timeout + retries,
// structured JSONL output, progress log, failure report, polite flags.
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { SHELL } = require('./session');
const ops = require('./ops');
const { ensureDir, readLines, readJsonFile, slugifyUrl, expandTemplate, robotsAllowed, proxyConfig } = require('./util');
const { startLocalProxy } = require('./proxy-agent');

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
  const valid = new Set(['goto', 'wait', 'click', 'type', 'scroll', 'shot', 'dump', 'extract', 'eval', 'pdf']);
  actions.forEach((a, i) => {
    if (!a || !valid.has(a.op)) throw { code: 'BAD_FILE', message: `actions[${i}].op must be one of: ${[...valid].join(', ')}` };
  });
  return actions;
}

// Only these string fields get {{var}} template expansion (safe by design).
const TEMPLATED_FIELDS = new Set(['out', 'url']);

function expandAction(action, vars) {
  const copy = { ...action };
  for (const k of TEMPLATED_FIELDS) {
    if (typeof copy[k] === 'string') copy[k] = expandTemplate(copy[k], vars);
  }
  return copy;
}

async function runActions(page, actions, vars, ctx) {
  const data = {};
  const used = {};
  for (let i = 0; i < actions.length; i++) {
    const a = expandAction(actions[i], vars);
    const base = a.as || a.op;
    used[base] = (used[base] || 0) + 1;
    const key = used[base] > 1 ? `${base}_${used[base]}` : base;
    const t = ctx.timeoutMs;
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
      case 'shot': {
        const out = a.out || path.join(ctx.shotsDir, `${vars.slug}-${vars.index}.png`);
        data[key] = await ops.shot(page, { out, fullPage: !!a.fullPage, selector: a.selector });
        break;
      }
      case 'dump':
        data[key] = await ops.dump(page, { maxTokens: a.maxTokens, out: a.out });
        break;
      case 'extract':
        data[key] = await ops.extract(page, { selector: a.selector, attr: a.attr, limit: a.limit || 100, timeout: t });
        break;
      case 'eval':
        data[key] = await ops.evalJs(page, { js: a.js || 'return document.title;', timeout: t });
        break;
      case 'pdf':
        data[key] = await ops.pdf(page, { out: a.out || path.join(ctx.shotsDir, `${vars.slug}-${vars.index}.pdf`) });
        break;
    }
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

async function runBulk(opts) {
  const started = Date.now();
  const items = loadItems(opts.input);
  const actions = loadActions(opts.actionsFile);
  const total = items.length;
  if (!total) throw { code: 'BAD_FILE', message: `${opts.input} contains no URLs` };

  ensureDir(path.dirname(path.resolve(opts.out)));
  ensureDir(opts.shotsDir);
  if (opts.failures) ensureDir(path.dirname(path.resolve(opts.failures)));
  fs.writeFileSync(opts.out, ''); // fresh results file
  const appendResult = (obj) => fs.appendFileSync(opts.out, JSON.stringify(obj) + '\n');

  const concurrency = Math.max(1, Math.min(opts.concurrency || 5, total));
  const failures = [];
  let done = 0, okCount = 0, failCount = 0, skipCount = 0;
  let next = 0;

  const log = (msg) => console.error(msg);

  // One persistent browser per worker; a fresh isolated context per URL.
  // Traffic goes through the local proxy shim (preemptive proxy auth).
  const shim = await startLocalProxy();
  const proxy = shim ? { server: `http://127.0.0.1:${shim.port}` } : proxyConfig();
  const browsers = [];
  for (let w = 0; w < concurrency; w++) {
    if (!fs.existsSync(SHELL)) throw { code: 'BROWSER_LAUNCH_FAILED', message: `headless Chromium shell not found at ${SHELL}` };
    browsers.push(await chromium.launch({
      executablePath: SHELL,
      proxy,
      args: ['--no-sandbox', '--disable-dev-shm-usage'],
    }));
  }

  async function processItem(browser, item, index) {
    const vars = {
      url: item.url, id: item.id, index,
      host: (() => { try { return new URL(item.url).hostname; } catch { return 'unknown'; } })(),
      slug: slugifyUrl(item.url),
    };
    const t0 = Date.now();
    const record = { id: item.id, url: item.url, index };

    if (opts.respectRobots && !(await robotsAllowed(item.url))) {
      record.status = 'skipped';
      record.reason = 'robots-txt disallows this path';
      record.ms = Date.now() - t0;
      skipCount++;
      appendResult(record);
      log(`[${done + 1}/${total}] SKIP ${item.id} (robots.txt)`);
      done++;
      return;
    }

    let lastErr = null;
    for (let attempt = 1; attempt <= opts.retries + 1; attempt++) {
      const context = await browser.newContext({
        viewport: { width: 1280, height: 800 },
        ignoreHTTPSErrors: true, // egress proxy MITMs TLS; documented in README
      });
      context.setDefaultTimeout(opts.timeoutMs);
      context.setDefaultNavigationTimeout(opts.timeoutMs);
      try {
        const page = await context.newPage();
        const data = await withTimeout(
          runActions(page, actions, vars, { shotsDir: opts.shotsDir, timeoutMs: opts.timeoutMs }),
          opts.itemTimeoutMs,
          `item ${item.id}`
        );
        record.status = 'ok';
        record.attempts = attempt;
        record.ms = Date.now() - t0;
        record.data = data;
        okCount++;
        appendResult(record);
        log(`[${done + 1}/${total}] OK   ${item.id} (${record.ms}ms${attempt > 1 ? `, attempt ${attempt}` : ''})`);
        done++;
        await context.close().catch(() => {});
        return;
      } catch (e) {
        lastErr = e;
        await context.close().catch(() => {});
        if (attempt <= opts.retries) await sleep(1000 * attempt);
      }
    }
    record.status = 'failed';
    record.attempts = opts.retries + 1;
    record.ms = Date.now() - t0;
    record.error = { code: (lastErr && lastErr.code) || 'ACTION_FAILED', message: String((lastErr && lastErr.message) || lastErr).split('\n')[0] };
    failCount++;
    failures.push(record);
    appendResult(record);
    log(`[${done + 1}/${total}] FAIL ${item.id}: ${record.error.message}`);
    done++;
  }

  async function worker(browser) {
    while (true) {
      const i = next++;
      if (i >= total) break;
      if (opts.rateLimitMs) await sleep(opts.rateLimitMs);
      await processItem(browser, items[i], i);
    }
  }

  await Promise.all(browsers.map(worker));
  for (const b of browsers) await b.close().catch(() => {});
  if (shim) shim.close();

  let failuresFile = null;
  if (opts.failures) {
    failuresFile = path.resolve(opts.failures);
    fs.writeFileSync(failuresFile, failures.map((f) => JSON.stringify(f)).join('\n') + (failures.length ? '\n' : ''));
  }

  return {
    total, succeeded: okCount, failed: failCount, skipped: skipCount,
    ms: Date.now() - started,
    resultsFile: path.resolve(opts.out),
    failuresFile,
  };
}

module.exports = { runBulk, loadItems, loadActions };
