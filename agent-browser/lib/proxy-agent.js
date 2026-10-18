// Local egress-proxy shim.
//
// Why this exists: the sandbox routes outbound traffic through an HTTP proxy
// that REQUIRES the Proxy-Authorization header preemptively on CONNECT.
// Without it the proxy answers `403 Forbidden` to the tunnel request and
// Chromium surfaces net::ERR_TUNNEL_CONNECTION_FAILED. Chromium cannot send
// preemptive proxy auth itself, so this tiny forwarder runs on 127.0.0.1,
// injects the header from the environment's proxy URL, and relays.
//
// Credentials are never logged. If no upstream proxy is configured in the
// environment, startLocalProxy() resolves to null (direct connection).
const net = require('net');

function upstreamFromEnv() {
  const raw = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return {
      host: u.hostname,
      port: parseInt(u.port, 10) || 3128,
      auth: 'Basic ' + Buffer.from(
        decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)
      ).toString('base64'),
    };
  } catch { return null; }
}

function noProxyList() {
  const raw = process.env.NO_PROXY || process.env.no_proxy || '';
  return raw.split(',').map((s) => s.trim().toLowerCase().replace(/^\./, '')).filter(Boolean);
}

function shouldBypass(hostname) {
  const h = String(hostname).toLowerCase().split(':')[0].replace(/^\[|\]$/g, '');
  return noProxyList().some((n) => h === n || h.endsWith('.' + n));
}

function splitTarget(target, defaultPort) {
  // "host:port" or "[ipv6]:port"
  const m = target.match(/^\[([^\]]+)\](?::(\d+))?$/);
  if (m) return { host: m[1], port: parseInt(m[2], 10) || defaultPort };
  const i = target.lastIndexOf(':');
  if (i > 0 && /^\d+$/.test(target.slice(i + 1))) {
    return { host: target.slice(0, i), port: parseInt(target.slice(i + 1), 10) };
  }
  return { host: target, port: defaultPort };
}

function pipeSockets(a, b) {
  a.pipe(b);
  b.pipe(a);
  const kill = () => { try { a.destroy(); } catch {} try { b.destroy(); } catch {} };
  a.on('error', kill);
  b.on('error', kill);
  a.on('close', () => { try { b.end(); } catch {} });
  b.on('close', () => { try { a.end(); } catch {} });
}

function startLocalProxy() {
  return new Promise((resolve) => {
    const upstream = upstreamFromEnv();
    if (!upstream) { resolve(null); return; }

    const server = net.createServer((client) => {
      client.setTimeout(60000, () => client.destroy());
      let buf = Buffer.alloc(0);
      const onHead = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx === -1) return;
        client.removeListener('data', onHead);
        const head = buf.slice(0, idx).toString('latin1');
        const rest = buf.slice(idx + 4);
        handleRequest(head, rest, client, upstream).catch(() => client.destroy());
      };
      client.on('data', onHead);
      client.on('error', () => {});
    });

    server.on('error', () => resolve(null));
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: server.address().port, close: () => server.close() });
    });
  });
}

async function handleRequest(head, rest, client, upstream) {
  const lines = head.split('\r\n');
  const [method, target] = lines[0].split(' ');
  const headers = lines.slice(1);

  if (method === 'CONNECT') {
    const { host, port } = splitTarget(target, 443);
    if (shouldBypass(host)) {
      const direct = net.connect(port, host);
      direct.on('connect', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) direct.write(rest);
        pipeSockets(client, direct);
      });
      direct.on('error', () => client.destroy());
      return;
    }
    const up = net.connect(upstream.port, upstream.host);
    up.on('connect', () => {
      const fwd = headers.filter((h) => !/^proxy-authorization:/i.test(h));
      fwd.push('Proxy-Authorization: ' + upstream.auth);
      up.write(`CONNECT ${target} HTTP/1.1\r\n` + fwd.join('\r\n') + '\r\n\r\n');
      let ubuf = Buffer.alloc(0);
      const onResp = (chunk) => {
        ubuf = Buffer.concat([ubuf, chunk]);
        const i = ubuf.indexOf('\r\n\r\n');
        if (i === -1) return;
        up.removeListener('data', onResp);
        const status = ubuf.slice(0, i).toString('latin1').split('\r\n')[0];
        if (!/^HTTP\/1\.[01] 200/i.test(status)) {
          client.write(ubuf);
          client.end();
          up.end();
          return;
        }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (rest.length) up.write(rest);
        pipeSockets(client, up);
      };
      up.on('data', onResp);
    });
    up.on('error', () => client.destroy());
    up.setTimeout(30000, () => up.destroy());
    return;
  }

  // Plain-HTTP via proxy: absolute-URI request line. Force one request per
  // connection so every request carries Proxy-Authorization.
  let url;
  try { url = new URL(target); } catch { client.destroy(); return; }
  const fwd = headers.filter((h) => !/^proxy-authorization:/i.test(h) && !/^proxy-connection:/i.test(h));
  fwd.push('Proxy-Authorization: ' + upstream.auth);
  fwd.push('Connection: close');
  const originForm = `${method} ${url.pathname}${url.search} HTTP/1.1`;
  const payload = Buffer.concat([
    Buffer.from(originForm + '\r\n' + fwd.join('\r\n') + '\r\n\r\n', 'latin1'),
    rest,
  ]);

  if (shouldBypass(url.hostname)) {
    const direct = net.connect(parseInt(url.port, 10) || 80, url.hostname);
    direct.on('connect', () => { direct.write(payload); pipeSockets(client, direct); });
    direct.on('error', () => client.destroy());
    return;
  }
  const up = net.connect(upstream.port, upstream.host);
  up.on('connect', () => { up.write(payload); pipeSockets(client, up); });
  up.on('error', () => client.destroy());
  up.setTimeout(30000, () => up.destroy());
}

module.exports = { startLocalProxy, upstreamFromEnv };
