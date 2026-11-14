'use strict';

/**
 * The one way this extension talks HTTP: Salesforce REST (with the CLI's
 * session) and the Git hosts. Node does not use a proxy by itself, so this
 * does - an https address goes through a CONNECT tunnel, a plain http one as
 * an absolute-form request - from cmr.http.proxy, VS Code's http.proxy, or
 * HTTPS_PROXY / HTTP_PROXY, with NO_PROXY honoured and loopback never proxied.
 *
 *   request(url, { method, headers, body, timeout, follow, followCrossHost })
 *     -> { status, headers, body: Buffer, redirectedTo? }
 *
 * Redirects: to the same host they are followed with the same headers; to
 * another host they are followed only with followCrossHost, and then without
 * any Authorization header, so a token never leaves the host it was meant for.
 * Plain Node.js, no VS Code dependency.
 */
const http = require('http');
const https = require('https');
const tls = require('tls');

const settings = { proxy: '', noProxy: '', ca: null, strictSSL: true };

/** Sets the proxy and certificates; anything left out keeps its current value. */
function configure(o) {
  const x = o || {};
  if ('proxy' in x) settings.proxy = String(x.proxy || '').trim();
  if ('noProxy' in x) settings.noProxy = String(x.noProxy || '');
  if ('ca' in x) settings.ca = x.ca ? [].concat(x.ca) : null;
  if ('strictSSL' in x) settings.strictSSL = x.strictSSL !== false;
}

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|\[?::1\]?)$/i;

/** True when NO_PROXY (or the setting) says this host goes direct. */
function bypass(host, port) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (LOOPBACK.test(h)) return true;
  const list = (settings.noProxy || process.env.NO_PROXY || process.env.no_proxy || '').split(/[\s,]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
  for (const raw of list) {
    if (raw === '*') return true;
    const [name, p] = raw.split(/:(?=\d+$)/);
    if (p && String(port) !== p) continue;
    const bare = name.replace(/^\*?\./, '');
    if (h === bare || h.endsWith('.' + bare)) return true;
  }
  return false;
}

/** The proxy for an address, or null: the setting first, then the environment. */
function proxyFor(url) {
  const u = new URL(url);
  const port = u.port || (u.protocol === 'https:' ? 443 : 80);
  if (bypass(u.hostname, port)) return null;
  const env = u.protocol === 'https:'
    ? process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    : process.env.HTTP_PROXY || process.env.http_proxy;
  const p = settings.proxy || env || '';
  if (!p) return null;
  try { return new URL(/^[a-z]+:\/\//i.test(p) ? p : 'http://' + p); } catch (e) { return null; }
}

function proxyAuth(p) {
  if (!p.username) return {};
  return { 'Proxy-Authorization': 'Basic ' + Buffer.from(decodeURIComponent(p.username) + ':' + decodeURIComponent(p.password || '')).toString('base64') };
}

function tlsOptions(proxied) {
  const o = {};
  if (settings.ca) o.ca = tls.rootCertificates.concat(settings.ca.map(String));
  if (proxied && !settings.strictSSL) o.rejectUnauthorized = false;
  return o;
}

/** Plain words for a network failure, naming the proxy when there is one. */
function networkMessage(e, url, proxy) {
  const code = e.code || '';
  const host = new URL(url).host;
  if (proxy && /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/.test(code)) {
    return 'cannot reach ' + host + ' through the proxy ' + proxy.host + ' (' + code + ') - check Copado \u203a HTTP proxy';
  }
  if (/CERT|SELF_SIGNED|UNABLE_TO_(GET|VERIFY)/.test(code)) {
    return 'the certificate of ' + host + ' is not trusted (' + code + ')' + (proxy ? ' - a proxy that inspects TLS needs its certificate in Copado \u203a HTTP CA file' : '');
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN/.test(code)) {
    return 'cannot reach ' + host + ' (' + code + ') - behind a corporate proxy? Set it in Copado \u203a HTTP proxy, or HTTPS_PROXY';
  }
  return e.message;
}

/** Opens a tunnel through the proxy and hands back the TLS socket on it. */
function tunnel(proxy, target, timeout) {
  return new Promise((resolve, reject) => {
    const lib = proxy.protocol === 'https:' ? https : http;
    const port = target.port || 443;
    const req = lib.request({ host: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80), method: 'CONNECT', path: target.hostname + ':' + port,
      headers: Object.assign({ Host: target.hostname + ':' + port }, proxyAuth(proxy)) });
    req.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        const e = new Error(res.statusCode === 407
          ? 'the proxy ' + proxy.host + ' needs a login (407) - put it in the proxy address: http://user:password@' + proxy.host
          : 'the proxy ' + proxy.host + ' refused the tunnel to ' + target.host + ' (' + res.statusCode + ')');
        e.code = 'EPROXY';
        reject(e);
        return;
      }
      resolve(socket);
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('the proxy ' + proxy.host + ' did not answer'), { code: 'ETIMEDOUT' })));
    req.end();
  });
}

async function once(url, o) {
  const target = new URL(url);
  const proxy = o.direct ? null : proxyFor(url);
  const headers = Object.assign({}, o.headers || {});
  const body = o.body == null ? null : Buffer.isBuffer(o.body) ? o.body : Buffer.from(String(o.body), 'utf8');
  if (body) headers['Content-Length'] = body.length;
  const timeout = o.timeout || 60000;
  let opts;
  let lib = target.protocol === 'https:' ? https : http;
  if (proxy && target.protocol === 'https:') {
    const socket = await tunnel(proxy, target, timeout);
    opts = Object.assign({ method: o.method || 'GET', headers: Object.assign({ Host: target.host }, headers), servername: target.hostname,
      createConnection: () => tls.connect(Object.assign({ socket, servername: target.hostname }, tlsOptions(true))) }, tlsOptions(true));
    opts.hostname = target.hostname; opts.port = target.port || 443; opts.path = target.pathname + target.search;
  } else if (proxy) {
    lib = proxy.protocol === 'https:' ? https : http;
    opts = { hostname: proxy.hostname, port: proxy.port || 80, path: target.href, method: o.method || 'GET',
      headers: Object.assign({ Host: target.host }, headers, proxyAuth(proxy)) };
  } else {
    opts = Object.assign({ hostname: target.hostname, port: target.port || undefined, path: target.pathname + target.search, method: o.method || 'GET', headers }, target.protocol === 'https:' ? tlsOptions(false) : {});
  }
  return new Promise((resolve, reject) => {
    const req = lib.request(opts, res => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', e => reject(Object.assign(new Error(networkMessage(e, url, proxy)), { code: e.code })));
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error('the request to ' + target.host + ' timed out'), { code: 'ETIMEDOUT' })));
    req.end(body || undefined);
  }).catch(e => { throw Object.assign(new Error(e.code === 'EPROXY' ? e.message : networkMessage(e, url, proxy)), { code: e.code }); });
}

async function request(url, options) {
  const o = Object.assign({ follow: 3 }, options || {});
  let current = url, headers = Object.assign({}, o.headers || {});
  for (let hop = 0; ; hop++) {
    const r = await once(current, Object.assign({}, o, { headers }));
    const loc = r.headers.location;
    if (!(r.status >= 300 && r.status < 400 && loc) || hop >= o.follow) return r;
    const next = new URL(loc, current);
    if (next.host !== new URL(current).host) {
      if (!o.followCrossHost) return Object.assign(r, { redirectedTo: next.host });
      headers = Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(authorization|private-token|cookie)$/i.test(k)));
    }
    current = next.toString();
  }
}

module.exports = { configure, request, proxyFor, bypass, settings };
