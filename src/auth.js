/**
 * Loopback-only authentication for the monitor server.
 *
 * Threat model: the server binds 127.0.0.1 only, so the network is not the
 * attacker. What IS reachable is any web page the user has open in the same
 * browser - it can issue cross-site requests to http://127.0.0.1:<port>/ and,
 * without checks, read the dashboard (which exposes cwd paths, prompts-adjacent
 * metadata and cost). So every request must prove BOTH:
 *
 *   1. knowledge of a per-process secret (a 32-byte token, handed out once via
 *      the startup URL and then stored in an HttpOnly cookie), and
 *   2. that the request was actually initiated by our own origin
 *      (Host / Origin / Sec-Fetch-Site checks - the classic DNS-rebinding and
 *      cross-site-request defences).
 *
 * The cookie is HttpOnly + SameSite=Strict so page scripts on other origins can
 * neither read it nor make the browser attach it. Token comparison goes through
 * crypto.timingSafeEqual on SHA-256 digests: digests are always the same length,
 * so a length mismatch cannot throw and cannot leak length through timing.
 *
 * Everything here is a pure function of (request headers, url) so it can be
 * tested without a socket.
 */

import crypto from 'node:crypto';

export const COOKIE_NAME = 'cm_token';
/** 32 bytes of entropy, hex-encoded -> 64 chars, url-safe by construction. */
export const TOKEN_BYTES = 32;
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** @returns {string} a fresh 64-char lowercase hex token */
export function generateToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Constant-time string comparison.
 * Hashing first normalises the length, so timingSafeEqual never throws on
 * mismatched inputs and the comparison time does not depend on the input.
 * @param {unknown} a
 * @param {unknown} b
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  // Called through the module object on purpose: tests replace it to prove the
  // constant-time path is the one actually taken.
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Parse a Cookie header into a plain object. Never throws.
 * @param {string|undefined|null} header
 * @returns {Record<string,string>}
 */
export function parseCookies(header) {
  /** @type {Record<string,string>} */
  const out = {};
  if (typeof header !== 'string' || !header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    let v = part.slice(eq + 1).trim();
    if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Response headers applied to every response we produce.
 * The CSP is deliberately closed: no inline script, no inline style, no remote
 * anything. It is the backstop for the "no innerHTML / no external URLs" rule
 * the front-end already follows by hand.
 */
export function securityHeaders() {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // Framing is the one cross-site read we cannot stop with SameSite alone:
    // a framed dashboard can be measured and clickjacked. frame-ancestors is
    // the modern control; X-Frame-Options is the belt for anything older.
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; " +
      "img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  };
}

export class Auth {
  /** @param {{port?: number, token?: string}} [opts] */
  constructor(opts = {}) {
    this.token = typeof opts.token === 'string' && opts.token ? opts.token : generateToken();
    this.port = Number.isInteger(opts.port) ? opts.port : 0;
  }

  /** The real port is only known after listen() when port 0 was requested. */
  setPort(port) {
    this.port = Number(port) || 0;
    return this;
  }

  /**
   * Adopt a token chosen after construction.
   *
   * Same reason setPort exists. `serve` must not create - let alone rotate -
   * the stored token until the port is actually ours: a second instance
   * started by hand on a busy port would otherwise invalidate the bookmark of
   * the server that is really running. So the bind comes first and the token
   * arrives here afterwards. A falsy value is ignored: dropping to no token at
   * all would open the dashboard to every page in the browser.
   * @param {string} token
   */
  setToken(token) {
    if (typeof token === 'string' && token) this.token = token;
    return this;
  }

  /** Host header values we accept. */
  allowedHosts() {
    return [`127.0.0.1:${this.port}`, `localhost:${this.port}`];
  }

  /** The one URL that bootstraps a browser session. */
  entryUrl() {
    return `http://127.0.0.1:${this.port}/?t=${this.token}`;
  }

  /** @returns {string} Set-Cookie value */
  setCookieHeader() {
    return `${COOKIE_NAME}=${this.token}; HttpOnly; SameSite=Strict; Path=/`;
  }

  /** Clear the cookie (used on shutdown paths / logout, not routed today). */
  clearCookieHeader() {
    return `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
  }

  /**
   * Token supplied in the query string of the bootstrap URL.
   * @param {string} rawUrl request url, e.g. '/?t=abc'
   * @returns {string|null}
   */
  static queryToken(rawUrl) {
    const q = String(rawUrl || '').indexOf('?');
    if (q < 0) return null;
    let params;
    try {
      params = new URLSearchParams(String(rawUrl).slice(q + 1));
    } catch {
      return null;
    }
    const t = params.get('t');
    return typeof t === 'string' && t ? t : null;
  }

  /** @param {string} candidate */
  isToken(candidate) {
    // Shape check first (cheap, non-secret): a malformed value can never match.
    if (typeof candidate !== 'string' || !TOKEN_RE.test(candidate)) {
      // Still run the constant-time compare so a wrong-shaped guess and a
      // right-shaped guess cost the same.
      safeEqual(this.token, String(candidate ?? ''));
      return false;
    }
    return safeEqual(this.token, candidate);
  }

  /**
   * Does the request carry a valid session cookie?
   * @param {{headers: Record<string, any>}} req
   */
  hasValidCookie(req) {
    const cookies = parseCookies(req?.headers?.cookie);
    return this.isToken(cookies[COOKIE_NAME]);
  }

  /**
   * Origin-ish checks. Applied to /api/* AND to the static files, because the
   * static files are what leak the token-bearing UI.
   * @param {{headers: Record<string, any>}} req
   * @returns {{ok: boolean, reason: string|null}}
   */
  checkOrigin(req) {
    const headers = req?.headers ?? {};
    const host = typeof headers.host === 'string' ? headers.host : '';
    if (!this.allowedHosts().includes(host)) {
      return { ok: false, reason: 'bad-host' };
    }
    const origin = headers.origin;
    if (typeof origin === 'string' && origin && origin !== 'null') {
      if (origin !== `http://${host}`) return { ok: false, reason: 'bad-origin' };
    }
    const site = headers['sec-fetch-site'];
    if (typeof site === 'string' && site) {
      if (site !== 'same-origin' && site !== 'none') return { ok: false, reason: 'bad-sec-fetch-site' };
    }
    return { ok: true, reason: null };
  }

  /**
   * Full check for an authenticated route.
   * @param {{headers: Record<string, any>}} req
   * @returns {{ok: boolean, reason: string|null}}
   */
  authorize(req) {
    const origin = this.checkOrigin(req);
    if (!origin.ok) return origin;
    if (!this.hasValidCookie(req)) return { ok: false, reason: 'no-cookie' };
    return { ok: true, reason: null };
  }
}
