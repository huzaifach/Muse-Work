// Human-behavior mimicry layer for headed stealth mode (--headed).
//
// Purpose: defeat BEHAVIORAL bot detection (mouse dynamics, typing cadence,
// scroll patterns) — not just fingerprint checks.
//
// SAFETY RULE (hard): this layer only humanizes actions the task already
// performs (the click/type/scroll the user asked for, done the human way).
// It NEVER synthesizes clicks on random elements — a random click could hit
// logout/delete/buy. Ambient behavior = mouse movement + scroll ONLY, never
// clicks. There is no code path here that clicks anything unasked.
//
// Enabled automatically in headed mode (session.js / bulk.js call
// setEnabled(true)); headless mode keeps the fast deterministic path.
const { chromium } = require('playwright-core');

let ENABLED = false;
function setEnabled(v) { ENABLED = !!v; }
function enabled() { return ENABLED; }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Last known cursor position per page (Playwright doesn't expose it).
const lastPos = new WeakMap();
function getPos(page) {
  const p = lastPos.get(page);
  if (p) return p;
  const vp = page.viewportSize() || { width: 1366, height: 768 };
  return { x: vp.width / 2, y: vp.height / 2 };
}
function setPos(page, x, y) { lastPos.set(page, { x, y }); }

// Quadratic bezier point.
function qbez(p0, p1, p2, t) {
  const u = 1 - t;
  return { x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
           y: u * u * p0.y + 2 * u * t * p1.y + t * t * p2.y };
}

/**
 * Move the cursor along a bezier curve with human dynamics:
 * variable speed (ease in/out + jitter), micro-pauses, and occasional
 * slight overshoot + correction. Returns the sampled trajectory for
 * measurement/verification (pass {record: true}).
 */
async function humanMove(page, toX, toY, { record = false } = {}) {
  const from = getPos(page);
  const vp = page.viewportSize() || { width: 1366, height: 768 };
  toX = Math.max(0, Math.min(vp.width - 1, toX));
  toY = Math.max(0, Math.min(vp.height - 1, toY));
  const dx = toX - from.x, dy = toY - from.y;
  const dist = Math.hypot(dx, dy);
  const traj = [{ x: from.x, y: from.y }];
  let stepCount = 0;

  if (dist >= 3) {
    // Control point: midpoint pushed sideways → curved (never straight) path.
    const mx = (from.x + toX) / 2, my = (from.y + toY) / 2;
    const bend = dist * (0.08 + Math.random() * 0.30) * (Math.random() < 0.5 ? -1 : 1);
    const cx = mx + (-dy / dist) * bend, cy = my + (dx / dist) * bend;
    const steps = Math.max(10, Math.min(70, Math.round(dist / 10)));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      // easeInOutQuad + per-step jitter → non-uniform speed
      const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const jx = (Math.random() - 0.5) * 1.6, jy = (Math.random() - 0.5) * 1.6;
      const p = qbez(from, { x: cx, y: cy }, { x: toX, y: toY }, e);
      p.x = Math.max(0, Math.min(vp.width - 1, p.x + jx));
      p.y = Math.max(0, Math.min(vp.height - 1, p.y + jy));
      await page.mouse.move(p.x, p.y);
      stepCount++;
      if (record) traj.push({ x: p.x, y: p.y, t: Date.now() });
      // variable speed: 4–18ms per step, ~4% micro-pauses (30–90ms)
      if (Math.random() < 0.04) await sleep(30 + Math.random() * 60);
      else await sleep(4 + Math.random() * 14);
    }
    // Slight overshoot + correction on longer moves (~35% of the time).
    let overshot = false;
    if (dist > 60 && Math.random() < 0.35) {
      overshot = true;
      const ox = Math.max(0, Math.min(vp.width - 1, toX + (Math.random() * 12 - 6)));
      const oy = Math.max(0, Math.min(vp.height - 1, toY + (Math.random() * 12 - 6)));
      await page.mouse.move(ox, oy);
      if (record) traj.push({ x: ox, y: oy, t: Date.now(), overshoot: true });
      await sleep(25 + Math.random() * 45);
      await page.mouse.move(toX, toY);
      if (record) traj.push({ x: toX, y: toY, t: Date.now(), correction: true });
      await sleep(20 + Math.random() * 30);
    }
    void overshot;
  } else {
    await page.mouse.move(toX, toY);
    if (record) traj.push({ x: toX, y: toY, t: Date.now() });
  }
  setPos(page, toX, toY);
  return { points: traj, steps: stepCount, from, to: { x: toX, y: toY } };
}

/** Human click: move along a curve, dwell, press with human timing. */
async function humanClick(page, selector, { timeout = 10000, waitNav = false } = {}) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout });
  const box = await loc.boundingBox({ timeout });
  if (!box) throw { code: 'NOT_FOUND', message: `no visible bounding box for '${selector}'` };
  // Aim point: somewhere inside the element, not always dead center.
  const x = box.x + box.width * (0.30 + Math.random() * 0.40);
  const y = box.y + box.height * (0.30 + Math.random() * 0.40);
  await humanMove(page, x, y);
  await sleep(60 + Math.random() * 140); // dwell: aim → commit
  const down = async () => {
    await page.mouse.down();
    await sleep(35 + Math.random() * 75); // human press duration
    await page.mouse.up();
  };
  if (waitNav) {
    await Promise.all([page.waitForNavigation({ timeout }).catch(() => {}), down()]);
  } else {
    await down();
  }
  await sleep(80 + Math.random() * 160); // post-click settle
  return { x, y };
}

/** Human typing: variable 40–140ms keystroke delays, occasional typo → backspace → retype. */
async function humanType(page, selector, text, { timeout = 10000, submit = false } = {}) {
  const loc = page.locator(selector).first();
  await loc.waitFor({ state: 'visible', timeout });
  // Focus the human way: move to the field, click it.
  const box = await loc.boundingBox({ timeout }).catch(() => null);
  if (box) {
    await humanMove(page, box.x + box.width * (0.3 + Math.random() * 0.4), box.y + box.height / 2);
    await sleep(60 + Math.random() * 120);
  }
  await loc.click({ timeout });
  await sleep(120 + Math.random() * 200); // pre-typing pause
  let typos = 0;
  const pressChar = async (ch) => {
    if (ch === '\n') return page.keyboard.press('Enter');
    if (ch === '\t') return page.keyboard.press('Tab');
    if (ch === ' ') return page.keyboard.press('Space');
    return page.keyboard.press(ch);
  };
  for (const ch of String(text)) {
    // ~3% typo on letters: wrong key, notice, backspace, retype.
    if (/[a-zA-Z]/.test(ch) && Math.random() < 0.03) {
      typos++;
      const off = Math.random() < 0.5 ? 1 : -1;
      const wrong = String.fromCharCode(ch.charCodeAt(0) + off);
      await pressChar(wrong);
      await sleep(90 + Math.random() * 130); // notice the mistake
      await page.keyboard.press('Backspace');
      await sleep(70 + Math.random() * 110);
    }
    await pressChar(ch);
    await sleep(40 + Math.random() * 100); // 40–140ms cadence
  }
  if (submit) {
    await sleep(150 + Math.random() * 250);
    await page.keyboard.press('Enter');
  }
  return { typed: String(text).length, typos };
}

/**
 * Human scroll: real wheel events with momentum-like easing (fast start,
 * gentle landing), not instant jumps.
 */
async function humanScroll(page, { to = 'bottom', selector = null, pixels = null } = {}) {
  let targetY;
  if (pixels !== null && pixels !== undefined) {
    const cur = await page.evaluate(() => window.scrollY);
    targetY = cur + Number(pixels);
  } else if (selector) {
    const y = await page.locator(selector).first().evaluate((el) => {
      const r = el.getBoundingClientRect();
      return window.scrollY + r.top - window.innerHeight * 0.3;
    }).catch(() => null);
    if (y === null) throw { code: 'NOT_FOUND', message: `scroll target not found: '${selector}'` };
    targetY = y;
  } else {
    const h = await page.evaluate(() => document.body.scrollHeight - window.innerHeight);
    const low = String(to).toLowerCase();
    if (low === 'top') targetY = 0;
    else if (/^\d+$/.test(low)) targetY = parseInt(low, 10); // --to 1500
    else targetY = Math.max(0, h); // bottom (default)
  }
  const startY = await page.evaluate(() => window.scrollY);
  const distance = targetY - startY;
  if (Math.abs(distance) < 4) return { scrolled: 0 };
  // Wheel-event bursts with easeOutCubic envelope → momentum feel.
  const steps = Math.max(8, Math.min(40, Math.round(Math.abs(distance) / 90)));
  let done = 0;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const e = 1 - Math.pow(1 - t, 3);
    const want = startY + distance * e;
    const cur = await page.evaluate(() => window.scrollY);
    const delta = want - cur;
    if (Math.abs(delta) >= 1) {
      await page.mouse.wheel(0, delta * (0.85 + Math.random() * 0.3));
      done += delta;
    }
    await sleep(16 + Math.random() * 34);
  }
  await sleep(120 + Math.random() * 180); // settle
  const finalY = await page.evaluate(() => window.scrollY);
  return { scrolled: Math.round(finalY - startY) };
}

/**
 * Ambient behavior: SAFE drift only — small mouse move and/or a scroll that
 * returns to its origin (net no-op). NEVER clicks. Called occasionally
 * before a humanized action so the session shows idle "alive" signals.
 */
async function ambient(page) {
  const vp = page.viewportSize() || { width: 1366, height: 768 };
  const cur = getPos(page);
  const nx = Math.max(20, Math.min(vp.width - 20, cur.x + (Math.random() * 220 - 110)));
  const ny = Math.max(20, Math.min(vp.height - 20, cur.y + (Math.random() * 160 - 80)));
  await humanMove(page, nx, ny);
  if (Math.random() < 0.45) {
    const d = Math.round(Math.random() * 140 - 70);
    if (d !== 0) {
      await page.mouse.wheel(0, d);
      await sleep(180 + Math.random() * 220);
      await page.mouse.wheel(0, -d); // drift back: net-zero scroll
    }
  }
  await sleep(100 + Math.random() * 300);
}

// Occasionally (default 18%) precede a humanized action with ambient drift.
async function maybeAmbient(page, p = 0.18) {
  if (Math.random() < p) {
    try { await ambient(page); } catch {}
  }
}

module.exports = {
  setEnabled, enabled,
  humanMove, humanClick, humanType, humanScroll, ambient, maybeAmbient,
  // exported for tests
  _qbez: qbez, _getPos: getPos,
};
