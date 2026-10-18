// MCP SERVER (stdio): exposes agent-browser ops as MCP tools so ANY agent
// (Claude, Cursor, custom harnesses) can drive the browser — the ArtCraft
// pattern: UI + CLI + agent interface for the same engine.
// Usage: agent-browser mcp
// Wire into a client as: { "command": "node", "args": ["/path/to/bin/agent-browser.js", "mcp"] }
const readline = require('readline');
const session = require('./session');
const ops = require('./ops');
const { crawl } = require('./crawl');

const VERSION = '1.1.0';

const TOOLS = [
  { name: 'browser_open', description: 'Navigate the active tab to a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' }, wait: { type: 'string', description: 'load|networkidle|domcontentloaded|<ms>' } }, required: ['url'] } },
  { name: 'browser_dump', description: 'Page content as Markdown (or text/html via format) with token estimate', inputSchema: { type: 'object', properties: { maxTokens: { type: 'number' }, format: { type: 'string', enum: ['markdown', 'text', 'html'] } } } },
  { name: 'browser_extract', description: 'CSS selector → full-text JSON items (never truncated)', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, attr: { type: 'string', description: 'comma-separated attributes' }, limit: { type: 'number' }, table: { type: 'boolean' }, csv: { type: 'boolean' } }, required: ['selector'] } },
  { name: 'browser_click', description: 'Click an element', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, waitNav: { type: 'boolean' } }, required: ['selector'] } },
  { name: 'browser_type', description: 'Type into an input', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' } }, required: ['selector', 'text'] } },
  { name: 'browser_fill', description: 'Fill a form from a JSON object of selector→value', inputSchema: { type: 'object', properties: { fields: { type: 'object', description: 'e.g. {"#name":"Ali"}' }, submit: { type: 'boolean' } }, required: ['fields'] } },
  { name: 'browser_upload', description: 'Upload a local file into a file input', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, file: { type: 'string' } }, required: ['selector', 'file'] } },
  { name: 'browser_scroll', description: 'Scroll the page', inputSchema: { type: 'object', properties: { to: { type: 'string', description: 'bottom|top|<px>' }, selector: { type: 'string' } } } },
  { name: 'browser_move', description: 'Move the mouse cursor the human way (bezier path). Never clicks.', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' } } } },
  { name: 'browser_wait', description: 'Wait for ms / selector / load state', inputSchema: { type: 'object', properties: { ms: { type: 'number' }, selector: { type: 'string' }, state: { type: 'string' }, load: { type: 'string' } } } },
  { name: 'browser_eval', description: 'Run JS in page context; bare expression or statements with return', inputSchema: { type: 'object', properties: { js: { type: 'string' } }, required: ['js'] } },
  { name: 'browser_shot', description: 'Screenshot to PNG', inputSchema: { type: 'object', properties: { out: { type: 'string' }, fullPage: { type: 'boolean' }, selector: { type: 'string' } } } },
  { name: 'browser_pdf', description: 'Save page as PDF', inputSchema: { type: 'object', properties: { out: { type: 'string' } } } },
  { name: 'browser_tab_new', description: 'Open a new tab (optionally navigate)', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'browser_tab_list', description: 'List open tabs', inputSchema: { type: 'object', properties: {} } },
  { name: 'browser_tab_switch', description: 'Switch the active tab', inputSchema: { type: 'object', properties: { tab: { type: 'number' } }, required: ['tab'] } },
  { name: 'browser_tab_close', description: 'Close a tab', inputSchema: { type: 'object', properties: { tab: { type: 'number' } }, required: ['tab'] } },
  { name: 'browser_crawl', description: 'BFS link discovery from a URL → JSONL url list', inputSchema: { type: 'object', properties: { url: { type: 'string' }, maxPages: { type: 'number' }, maxDepth: { type: 'number' }, allDomains: { type: 'boolean' }, out: { type: 'string' } }, required: ['url'] } },
  { name: 'browser_netlog', description: 'Capture network requests/responses while loading a URL', inputSchema: { type: 'object', properties: { url: { type: 'string' }, out: { type: 'string' }, waitMs: { type: 'number' } }, required: ['url'] } },
  { name: 'browser_assert_text', description: 'Assert an element contains text (for QA audits)', inputSchema: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' } }, required: ['selector', 'text'] } },
  { name: 'browser_assert_js', description: 'Assert a JS expression is truthy (for QA audits)', inputSchema: { type: 'object', properties: { js: { type: 'string' } }, required: ['js'] } },
];

const PROFILE = process.env.AGENT_BROWSER_MCP_PROFILE || 'default';
const TIMEOUT = parseInt(process.env.AGENT_BROWSER_MCP_TIMEOUT || '30000', 10);

async function callTool(name, args) {
  switch (name) {
    case 'browser_open':
      return session.withPage(PROFILE, (p) => ops.goto(p, args.url, { timeout: TIMEOUT, wait: args.wait || 'load' }));
    case 'browser_dump':
      return session.withPage(PROFILE, (p) => ops.dump(p, { maxTokens: args.maxTokens, format: args.format }));
    case 'browser_extract':
      return session.withPage(PROFILE, (p) => ops.extract(p, { selector: args.selector, attr: args.attr, limit: args.limit || 100, table: !!args.table, csv: !!args.csv, timeout: TIMEOUT }));
    case 'browser_click':
      return session.withPage(PROFILE, (p) => ops.click(p, { selector: args.selector, waitNav: !!args.waitNav, timeout: TIMEOUT }));
    case 'browser_type':
      return session.withPage(PROFILE, (p) => ops.type(p, { selector: args.selector, text: args.text, clear: !!args.clear, submit: !!args.submit, timeout: TIMEOUT }));
    case 'browser_fill':
      return session.withPage(PROFILE, (p) => ops.fill(p, { fields: JSON.stringify(args.fields), submit: !!args.submit, timeout: TIMEOUT }));
    case 'browser_upload':
      return session.withPage(PROFILE, (p) => ops.upload(p, { selector: args.selector, file: args.file, timeout: TIMEOUT }));
    case 'browser_scroll':
      return session.withPage(PROFILE, (p) => ops.scroll(p, { to: args.to || 'bottom', selector: args.selector }));
    case 'browser_move':
      return session.withPage(PROFILE, (p) => ops.move(p, { selector: args.selector, x: args.x, y: args.y, timeout: TIMEOUT }));
    case 'browser_wait':
      return session.withPage(PROFILE, (p) => ops.wait(p, { ms: args.ms, selector: args.selector, state: args.state || 'visible', load: args.load, timeout: TIMEOUT }));
    case 'browser_eval':
      return session.withPage(PROFILE, (p) => ops.evalJs(p, { js: args.js, timeout: TIMEOUT }));
    case 'browser_shot':
      return session.withPage(PROFILE, (p) => ops.shot(p, { out: args.out, fullPage: !!args.fullPage, selector: args.selector }));
    case 'browser_pdf':
      return session.withPage(PROFILE, (p) => ops.pdf(p, { out: args.out }));
    case 'browser_tab_new':
      return session.withContext(PROFILE, async (c) => {
        const page = await c.newPage();
        if (args.url) await ops.goto(page, String(args.url), { timeout: TIMEOUT });
        const num = await session.registerNewTab(PROFILE, page);
        session.setActiveTab(PROFILE, num);
        return { tab: num, url: page.url() };
      });
    case 'browser_tab_list':
      return session.withContext(PROFILE, async (c) => {
        const tabs = await session.resolveTabNumbers(PROFILE, c);
        return { tabs: tabs.map((t) => ({ tab: t.num, url: t.url, title: t.title })), count: tabs.length };
      });
    case 'browser_tab_switch': {
      const r = await session.withContext(PROFILE, async (c) => {
        const page = await session.pageForTab(PROFILE, c, args.tab);
        try { await page.bringToFront(); } catch {}
        session.setActiveTab(PROFILE, args.tab);
        return { tab: args.tab, url: page.url() };
      });
      return r;
    }
    case 'browser_tab_close':
      return session.withContext(PROFILE, async (c) => {
        const page = await session.pageForTab(PROFILE, c, args.tab);
        const url = page.url();
        await page.close();
        return { closed: args.tab, url };
      });
    case 'browser_crawl':
      return crawl({ url: args.url, maxPages: args.maxPages || 50, maxDepth: args.maxDepth === undefined ? 2 : args.maxDepth, allDomains: !!args.allDomains, out: args.out, timeoutMs: TIMEOUT });
    case 'browser_netlog':
      return session.withPage(PROFILE, (p) => ops.netlog(p, { url: args.url, out: args.out, waitMs: args.waitMs || 3000, timeout: TIMEOUT }));
    case 'browser_assert_text':
      return session.withPage(PROFILE, (p) => ops.assertText(p, { selector: args.selector, text: args.text, timeout: TIMEOUT }));
    case 'browser_assert_js':
      return session.withPage(PROFILE, (p) => ops.assertJs(p, { js: args.js, timeout: TIMEOUT }));
    default:
      throw { code: 'UNKNOWN_TOOL', message: `unknown tool '${name}'` };
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message: String(message).slice(0, 2000) } }) + '\n');
}

async function main() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    try {
      if (method === 'initialize') {
        respond(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'agent-browser', version: VERSION },
        });
      } else if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
        // no-op
      } else if (method === 'ping') {
        respond(id, {});
      } else if (method === 'tools/list') {
        respond(id, { tools: TOOLS });
      } else if (method === 'tools/call') {
        const { name, arguments: args } = params || {};
        try {
          const result = await callTool(name, args || {});
          respond(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1).slice(0, 200000) }] });
        } catch (e) {
          respond(id, { content: [{ type: 'text', text: `ERROR: ${(e && e.code) || 'ERROR'}: ${String((e && e.message) || e).slice(0, 2000)}` }], isError: true });
        }
      } else {
        respondError(id, -32601, `method not found: ${method}`);
      }
    } catch (e) {
      respondError(id, -32603, (e && e.message) || String(e));
    }
  }
}

main().catch((e) => { process.stderr.write(`mcp fatal: ${(e && e.stack) || e}\n`); process.exit(1); });
