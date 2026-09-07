/**
 * Auth unit tests. No sockets: every check is a pure function of headers.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { Auth, COOKIE_NAME, generateToken, parseCookies, safeEqual, securityHeaders } from '../src/auth.js';

/** Minimal request stand-in. */
function req(headers = {}) {
  return { headers };
}

function withCookie(auth, extra = {}) {
  return req({
    host: `127.0.0.1:${auth.port}`,
    cookie: `${COOKIE_NAME}=${auth.token}`,
    ...extra,
  });
}

describe('token generation', () => {
  test('is 32 bytes of hex and differs every time', () => {
    const a = generateToken();
    const b = generateToken();
    assert.match(a, /^[0-9a-f]{64}$/);
    assert.notEqual(a, b);
  });

  test('the entry url carries the token and only the token', () => {
    const auth = new Auth({ port: 47321 });
    assert.equal(auth.entryUrl(), `http://127.0.0.1:47321/?t=${auth.token}`);
  });

  test('a token can be adopted after construction, like the port', () => {
    // serve binds BEFORE it reads or rotates the stored token, so that a second
    // instance on a busy port cannot invalidate the running one's bookmark. The
    // token therefore arrives after the Auth was built.
    const auth = new Auth({ port: 47321 });
    const first = auth.token;
    const stored = generateToken();
    auth.setToken(stored);
    assert.equal(auth.token, stored);
    assert.equal(auth.entryUrl(), `http://127.0.0.1:47321/?t=${stored}`);
    assert.equal(auth.isToken(stored), true);
    assert.equal(auth.isToken(first), false, 'the throwaway one stops working');
  });

  test('setToken refuses to leave the server with no token at all', () => {
    const auth = new Auth({ port: 1 });
    const original = auth.token;
    for (const bad of ['', null, undefined, 42, {}]) auth.setToken(bad);
    assert.equal(auth.token, original);
  });
});

describe('constant-time comparison', () => {
  test('safeEqual matches equal strings and rejects different ones', () => {
    assert.equal(safeEqual('abc', 'abc'), true);
    assert.equal(safeEqual('abc', 'abd'), false);
  });

  test('different lengths do not throw (timingSafeEqual needs equal buffers)', () => {
    assert.equal(safeEqual('a', 'aaaaaaaaaaaaaaaaaaaa'), false);
    assert.equal(safeEqual('', 'x'), false);
  });

  test('non-strings are rejected without throwing', () => {
    assert.equal(safeEqual(undefined, 'x'), false);
    assert.equal(safeEqual(null, null), false);
    assert.equal(safeEqual(1, 1), false);
  });

  test('crypto.timingSafeEqual is the comparison actually used', () => {
    const original = crypto.timingSafeEqual;
    let calls = 0;
    crypto.timingSafeEqual = (a, b) => {
      calls++;
      // Both operands must be equal-length digests, never raw tokens.
      assert.equal(a.length, 32);
      assert.equal(b.length, 32);
      return original(a, b);
    };
    try {
      const auth = new Auth({ port: 1 });
      assert.equal(auth.isToken(auth.token), true);
      assert.equal(auth.isToken('0'.repeat(64)), false);
      assert.ok(calls >= 2, `timingSafeEqual should have been called, got ${calls}`);
    } finally {
      crypto.timingSafeEqual = original;
    }
  });

  test('a malformed candidate still pays for a comparison', () => {
    const original = crypto.timingSafeEqual;
    let calls = 0;
    crypto.timingSafeEqual = (a, b) => { calls++; return original(a, b); };
    try {
      const auth = new Auth({ port: 1 });
      assert.equal(auth.isToken('nope'), false);
      assert.equal(calls, 1);
    } finally {
      crypto.timingSafeEqual = original;
    }
  });
});

describe('query token', () => {
  test('reads ?t=', () => {
    assert.equal(Auth.queryToken('/?t=abc'), 'abc');
    assert.equal(Auth.queryToken('/index.html?x=1&t=zzz'), 'zzz');
  });

  test('absent or empty is null', () => {
    assert.equal(Auth.queryToken('/'), null);
    assert.equal(Auth.queryToken('/?t='), null);
    assert.equal(Auth.queryToken('/?u=1'), null);
    assert.equal(Auth.queryToken(undefined), null);
  });
});

describe('cookie parsing', () => {
  test('splits pairs and trims', () => {
    assert.deepEqual(parseCookies('a=1; b=2'), { a: '1', b: '2' });
  });

  test('handles quotes, url-encoding and junk without throwing', () => {
    assert.deepEqual(parseCookies('a="1"'), { a: '1' });
    assert.deepEqual(parseCookies('a=%41'), { a: 'A' });
    assert.deepEqual(parseCookies('a=%'), { a: '%' });
    assert.deepEqual(parseCookies('novalue; b=2'), { b: '2' });
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies(''), {});
  });
});

describe('cookie authentication', () => {
  test('the right cookie authenticates', () => {
    const auth = new Auth({ port: 47321 });
    assert.equal(auth.hasValidCookie(withCookie(auth)), true);
  });

  test('a wrong or missing cookie does not', () => {
    const auth = new Auth({ port: 47321 });
    assert.equal(auth.hasValidCookie(req({ cookie: `${COOKIE_NAME}=deadbeef` })), false);
    assert.equal(auth.hasValidCookie(req({ cookie: 'other=1' })), false);
    assert.equal(auth.hasValidCookie(req({})), false);
  });

  test('the Set-Cookie is HttpOnly, SameSite=Strict and Path=/', () => {
    const auth = new Auth({ port: 47321 });
    const c = auth.setCookieHeader();
    assert.ok(c.startsWith(`${COOKIE_NAME}=${auth.token};`));
    assert.match(c, /HttpOnly/);
    assert.match(c, /SameSite=Strict/);
    assert.match(c, /Path=\//);
  });
});

describe('origin checks', () => {
  const auth = new Auth({ port: 47321 });

  test('accepts 127.0.0.1 and localhost on our port', () => {
    assert.equal(auth.checkOrigin(req({ host: '127.0.0.1:47321' })).ok, true);
    assert.equal(auth.checkOrigin(req({ host: 'localhost:47321' })).ok, true);
  });

  test('rejects any other Host (DNS rebinding)', () => {
    assert.equal(auth.checkOrigin(req({ host: 'evil.example:47321' })).reason, 'bad-host');
    assert.equal(auth.checkOrigin(req({ host: '127.0.0.1:9999' })).reason, 'bad-host');
    assert.equal(auth.checkOrigin(req({ host: '127.0.0.1' })).reason, 'bad-host');
    assert.equal(auth.checkOrigin(req({})).reason, 'bad-host');
  });

  test('an Origin header must equal our own origin', () => {
    assert.equal(auth.checkOrigin(req({ host: '127.0.0.1:47321', origin: 'http://127.0.0.1:47321' })).ok, true);
    assert.equal(auth.checkOrigin(req({ host: '127.0.0.1:47321', origin: 'http://evil.example' })).reason, 'bad-origin');
    assert.equal(auth.checkOrigin(req({ host: '127.0.0.1:47321', origin: 'https://127.0.0.1:47321' })).reason, 'bad-origin');
    // localhost and 127.0.0.1 are different origins to a browser.
    assert.equal(auth.checkOrigin(req({ host: '127.0.0.1:47321', origin: 'http://localhost:47321' })).reason, 'bad-origin');
  });

  test('no Origin header is allowed (plain navigation sends none)', () => {
    assert.equal(auth.checkOrigin(req({ host: '127.0.0.1:47321' })).ok, true);
  });

  test('Sec-Fetch-Site must be same-origin or none when present', () => {
    const base = { host: '127.0.0.1:47321' };
    assert.equal(auth.checkOrigin(req({ ...base, 'sec-fetch-site': 'same-origin' })).ok, true);
    assert.equal(auth.checkOrigin(req({ ...base, 'sec-fetch-site': 'none' })).ok, true);
    assert.equal(auth.checkOrigin(req({ ...base, 'sec-fetch-site': 'cross-site' })).reason, 'bad-sec-fetch-site');
    assert.equal(auth.checkOrigin(req({ ...base, 'sec-fetch-site': 'same-site' })).reason, 'bad-sec-fetch-site');
  });
});

describe('authorize', () => {
  test('needs both a good origin and a good cookie', () => {
    const auth = new Auth({ port: 47321 });
    assert.equal(auth.authorize(withCookie(auth)).ok, true);
    assert.equal(auth.authorize(req({ host: '127.0.0.1:47321' })).reason, 'no-cookie');
    assert.equal(auth.authorize(req({ host: 'evil:47321', cookie: `${COOKIE_NAME}=${auth.token}` })).reason, 'bad-host');
    assert.equal(
      auth.authorize(withCookie(auth, { 'sec-fetch-site': 'cross-site' })).reason,
      'bad-sec-fetch-site',
    );
  });

  test('setPort moves the accepted host set', () => {
    const auth = new Auth({ port: 1 });
    auth.setPort(5000);
    assert.equal(auth.checkOrigin(req({ host: '127.0.0.1:5000' })).ok, true);
    assert.equal(auth.checkOrigin(req({ host: '127.0.0.1:1' })).ok, false);
  });
});

describe('security headers', () => {
  test('carry no-store, nosniff, no-referrer and a closed CSP', () => {
    const h = securityHeaders();
    assert.equal(h['Cache-Control'], 'no-store');
    assert.equal(h['X-Content-Type-Options'], 'nosniff');
    assert.equal(h['Referrer-Policy'], 'no-referrer');
    const csp = h['Content-Security-Policy'];
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'self'/);
    assert.match(csp, /style-src 'self'/);
    assert.match(csp, /connect-src 'self'/);
    assert.match(csp, /img-src 'self' data:/);
    assert.match(csp, /base-uri 'none'/);
    assert.match(csp, /form-action 'none'/);
    assert.ok(!csp.includes('unsafe-inline'), 'CSP must not allow inline script or style');
  });

  test('forbid framing two ways, for old and new browsers', () => {
    const h = securityHeaders();
    // SameSite=Strict stops the cookie riding along on a cross-site request,
    // but a frame of a page the user is already authenticated to can still be
    // measured and clickjacked. Both controls are required.
    assert.equal(h['X-Frame-Options'], 'DENY');
    assert.match(h['Content-Security-Policy'], /frame-ancestors 'none'/);
  });
});
