/**
 * Server tests: a real listener on 127.0.0.1 with an ephemeral port.
 *
 * The collector is pointed at a temp directory, so nothing in ~/.claude or
 * ~/.claude-monitor is read.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { makeTmpDir, appendJsonl, writeJsonl, assistantRec } from './helpers.js';
import { startServer, routeKey, resolvePort, installCrashHandlers, DEFAULT_PORT } from '../src/server.js';
import { Collector } from '../src/collector.js';
import { COOKIE_NAME } from '../src/auth.js';
import { localDateKey } from '../src/paths.js';
import { CcusageCache } from '../src/usage-view.js';
import { CCUSAGE_SPEC, CCUSAGE_VERSION } from '../src/ccusage.js';

const SID = 'bbbbbbbb-1111-2222-3333-555555555555';
/** A transcript the collector never adopts (no hook events name it). */
const USAGE_SID = 'dddddddd-1111-2222-3333-555555555555';

let tmp;
let handle;
let cookie;
let monitorDir;
/** Swapped per test; ttlMs 0 keeps one test's answer out of the next one. */
let ccRunner = async () => ({ ok: true, data: { daily: [] }, error: null });

/** Raw GET with full control over headers. */
function get(pathname, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, path: pathname, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function authed(extra = {}) {
  return { cookie, ...extra };
}

before(async () => {
  tmp = makeTmpDir('cm-server');
  const eventsDir = path.join(tmp.dir, 'events');
  const statuslineDir = path.join(tmp.dir, 'statusline');
  const sessionsDir = path.join(tmp.dir, 'sessions');
  const projectsRoot = path.join(tmp.dir, 'projects');
  for (const d of [eventsDir, statuslineDir, sessionsDir, projectsRoot]) fs.mkdirSync(d, { recursive: true });

  appendJsonl(path.join(eventsDir, `${localDateKey(new Date())}.jsonl`), [
    {
      receivedAt: new Date().toISOString(),
      hookEventName: 'SessionStart',
      hook_event_name: 'SessionStart',
      session_id: SID,
      cwd: 'D:\\tmp\\server-test',
    },
    {
      receivedAt: new Date().toISOString(),
      hookEventName: 'UserPromptSubmit',
      hook_event_name: 'UserPromptSubmit',
      session_id: SID,
      cwd: 'D:\\tmp\\server-test',
    },
  ]);

  const collector = new Collector({
    eventsDir,
    statuslineDir,
    sessionsDir,
    projectsRoot,
    watch: false,
    readTranscripts: false,
    debounceMs: 5,
  });
  await collector.start();

  // M4 fixture: two days of usage in a session the collector does not track,
  // so /api/usage has something to report without changing any snapshot.
  writeJsonl(path.join(projectsRoot, 'D--tmp-usage', `${USAGE_SID}.jsonl`), [
    assistantRec({
      messageId: 'srv-a',
      timestamp: new Date().toISOString(),
      usage: { input_tokens: 11, output_tokens: 22, cache_creation_input_tokens: 33, cache_read_input_tokens: 44 },
      sessionId: USAGE_SID,
    }),
  ]);

  // The usage store is the only thing a GET writes; keep it in the temp tree.
  monitorDir = path.join(tmp.dir, 'monitor');
  handle = await startServer({
    port: 0,
    collector,
    monitorDir,
    statuslineDir,
    ccusageCache: new CcusageCache({ runner: (o) => ccRunner(o), ttlMs: 0 }),
  });
  cookie = `${COOKIE_NAME}=${handle.token}`;
});

after(async () => {
  if (handle) {
    await handle.close();
    handle.collector.stop();
  }
  if (tmp) tmp.cleanup();
});

describe('bind and startup', () => {
  test('listens on loopback with an ephemeral port', () => {
    const addr = handle.server.address();
    assert.equal(addr.address, '127.0.0.1');
    assert.ok(addr.port > 0);
  });

  test('the startup url carries the token', () => {
    assert.equal(handle.url, `http://127.0.0.1:${handle.port}/?t=${handle.token}`);
    assert.match(handle.token, /^[0-9a-f]{64}$/);
  });
});

describe('GET / bootstrap', () => {
  test('no token and no cookie -> 403 that leaks nothing', async () => {
    const res = await get('/');
    assert.equal(res.status, 403);
    assert.equal(res.body.trim(), 'forbidden');
    assert.ok(!res.body.includes(handle.token));
    assert.equal(res.headers['set-cookie'], undefined);
  });

  test('a wrong token -> 403', async () => {
    const res = await get(`/?t=${'0'.repeat(64)}`);
    assert.equal(res.status, 403);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  test('the right token -> 302 to / with the session cookie', async () => {
    const res = await get(`/?t=${handle.token}`);
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, '/');
    const sc = res.headers['set-cookie'];
    assert.ok(Array.isArray(sc) && sc.length === 1);
    assert.match(sc[0], new RegExp(`^${COOKIE_NAME}=${handle.token};`));
    assert.match(sc[0], /HttpOnly/);
    assert.match(sc[0], /SameSite=Strict/);
    assert.match(sc[0], /Path=\//);
  });

  test('with the cookie -> 200 and the dashboard html', async () => {
    const res = await get('/', { headers: authed() });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/html/);
    assert.match(res.body, /<title>claude\/monitor<\/title>/);
    assert.match(res.body, /<script src="\/app\.js"><\/script>/);
  });

  test('every response carries the security headers', async () => {
    const res = await get('/', { headers: authed() });
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['referrer-policy'], 'no-referrer');
    assert.match(res.headers['content-security-policy'], /default-src 'none'/);
  });
});

describe('static files', () => {
  test('app.js and style.css need the cookie', async () => {
    assert.equal((await get('/app.js')).status, 403);
    assert.equal((await get('/style.css')).status, 403);
  });

  test('and are served with it', async () => {
    const js = await get('/app.js', { headers: authed() });
    assert.equal(js.status, 200);
    assert.match(js.headers['content-type'], /javascript/);
    const css = await get('/style.css', { headers: authed() });
    assert.equal(css.status, 200);
    assert.match(css.headers['content-type'], /text\/css/);
  });

  test('the shipped app.js uses no forbidden DOM sink', async () => {
    const js = (await get('/app.js', { headers: authed() })).body;
    // Patterns match a CALL or an ASSIGNMENT, so the banner comment that merely
    // names these APIs does not trip the check.
    const banned = [
      /\.innerHTML/,
      /\.outerHTML/,
      /\.insertAdjacentHTML\s*\(/,
      /document\.write\s*\(/,
      /\beval\s*\(/,
      /new\s+Function\s*\(/,
      /\bon(?:click|load|error)\s*=\s*["']/,
    ];
    for (const re of banned) {
      assert.equal(re.test(js), false, `app.js uses ${re}`);
    }
  });

  test('the shipped html has no inline script, style or handler', async () => {
    const html = (await get('/', { headers: authed() })).body;
    assert.equal(/<script(?![^>]*\ssrc=)/i.test(html), false, 'inline <script> found');
    assert.equal(/<style[\s>]/i.test(html), false, 'inline <style> found');
    assert.equal(/\son[a-z]+\s*=/i.test(html), false, 'inline event handler attribute found');
    // No external resource is ever fetched. (The SVG favicon's xmlns is a
    // namespace identifier, not a request, so only src/href are checked.)
    assert.equal(/(?:src|href)\s*=\s*["']https?:/i.test(html), false, 'external resource found');
  });

  test('the stylesheet references nothing external', async () => {
    const css = (await get('/style.css', { headers: authed() })).body;
    assert.equal(/@import/i.test(css), false);
    assert.equal(/url\s*\(\s*["']?https?:/i.test(css), false);
  });

  test('directory traversal is 404, not a file', async () => {
    for (const p of [
      '/../package.json',
      '/%2e%2e/package.json',
      '/..%2fpackage.json',
      '/%2e%2e%2f%2e%2e%2fpackage.json',
      '/public/../package.json',
      '/..\\package.json',
      '/%5c..%5cpackage.json',
    ]) {
      const res = await get(p, { headers: authed() });
      assert.equal(res.status, 404, `${p} -> ${res.status}`);
      assert.ok(!res.body.includes('claude-monitor'), `${p} leaked package.json`);
    }
  });

  test('unknown paths are 404', async () => {
    assert.equal((await get('/nope', { headers: authed() })).status, 404);
    assert.equal((await get('/api/nope', { headers: authed() })).status, 404);
  });

  test('non-GET is refused', async () => {
    const res = await get('/', { headers: authed(), method: 'POST' });
    assert.equal(res.status, 405);
  });
});

describe('GET /api/state', () => {
  test('needs the cookie', async () => {
    assert.equal((await get('/api/state')).status, 403);
  });

  test('returns the snapshot', async () => {
    const res = await get('/api/state', { headers: authed() });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.sessions.length, 1);
    assert.equal(body.sessions[0].sessionId, SID);
    assert.equal(body.sessions[0].phase, 'busy');
    assert.equal(body.sessions[0].cwd, 'D:\\tmp\\server-test');
    assert.equal(body.counts.live, 1);
    assert.ok(body.stats);
  });

  test('a cross-site Origin is refused even with the cookie', async () => {
    const res = await get('/api/state', { headers: authed({ origin: 'http://evil.example' }) });
    assert.equal(res.status, 403);
  });

  test('a cross-site Sec-Fetch-Site is refused', async () => {
    const res = await get('/api/state', { headers: authed({ 'sec-fetch-site': 'cross-site' }) });
    assert.equal(res.status, 403);
  });

  test('a rebound Host is refused', async () => {
    const res = await get('/api/state', { headers: authed({ host: 'attacker.test' }) });
    assert.equal(res.status, 403);
  });

  test('our own Origin and Sec-Fetch-Site are accepted', async () => {
    const res = await get('/api/state', {
      headers: authed({ origin: `http://127.0.0.1:${handle.port}`, 'sec-fetch-site': 'same-origin' }),
    });
    assert.equal(res.status, 200);
  });
});

describe('GET /api/health', () => {
  test('reports uptime and collector stats', async () => {
    const res = await get('/api/health', { headers: authed() });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.uptime, 'number');
    assert.ok(body.collectorStats);
    assert.equal(typeof body.collectorStats.errorCount, 'number');
  });
});

describe('M4: GET /api/usage', () => {
  test('needs the cookie', async () => {
    assert.equal((await get('/api/usage')).status, 403);
    assert.equal((await get('/api/usage?days=7')).status, 403);
  });

  test('returns the whole view, and it adds up', async () => {
    const res = await get('/api/usage', { headers: authed() });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.windowDays, 30);
    assert.match(body.since, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(body.until, /^\d{4}-\d{2}-\d{2}$/);
    assert.equal(body.today, body.until);
    assert.deepEqual(body.series, ['Opus', 'Sonnet', 'Haiku', 'Fable', 'other']);
    assert.ok(Array.isArray(body.days));
    assert.ok(Array.isArray(body.sessions));

    const today = body.days.find((d) => d.date === body.today);
    assert.ok(today, 'the fixture writes a record dated today');
    assert.equal(today.totals.totalTokens, 11 + 22 + 33 + 44);
    assert.equal(today.totals.input_tokens, 11);
    assert.equal(today.msgs, 1);
    assert.equal(today.source, 'live');
    assert.equal(today.today, true);
    assert.equal(today.byModel.Opus.totalTokens, 110, 'models are series, not raw ids');

    const s = body.sessions.find((x) => x.sessionId === USAGE_SID);
    assert.ok(s, 'the session shows up in the top list');
    assert.equal(s.model, 'Opus');
    assert.equal(s.totalTokens, 110);
    assert.equal(s.costUsd, null, 'no sidecar for it, so no estimate is invented');
    assert.equal(typeof body.stats.scannedFiles, 'number');
    assert.equal(typeof body.stats.cache.hits, 'number');
  });

  test('days is clamped to 1..90 and falls back to 30', async () => {
    const cases = [['?days=7', 7], ['?days=999', 90], ['?days=0', 1], ['?days=-4', 1],
      ['?days=abc', 30], ['?days=', 30], ['', 30]];
    for (const [q, want] of cases) {
      const body = JSON.parse((await get(`/api/usage${q}`, { headers: authed() })).body);
      assert.equal(body.windowDays, want, `days${q}`);
      const spanDays = (Date.parse(`${body.until}T00:00:00`) - Date.parse(`${body.since}T00:00:00`)) / 86400000;
      assert.equal(Math.round(spanDays) + 1, want, `the window itself for days${q}`);
    }
  });

  test('the second request is served from the file cache', async () => {
    await get('/api/usage', { headers: authed() });
    const body = JSON.parse((await get('/api/usage', { headers: authed() })).body);
    assert.equal(body.stats.cache.misses, 0);
    assert.ok(body.stats.cache.hits >= 1);
  });

  test('the store is written under the INJECTED monitor dir, never the real one', async () => {
    await get('/api/usage', { headers: authed() });
    const file = path.join(monitorDir, 'usage', 'daily.json');
    assert.ok(fs.existsSync(file), 'expected the store in the temp tree');
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(raw.version, 1);
    assert.ok(Object.keys(raw.days).length >= 1);
    // Atomic write: no half-written temp file left next to it.
    assert.deepEqual(fs.readdirSync(path.join(monitorDir, 'usage')), ['daily.json']);
  });

  test('cross-site Origin, rebound Host and POST are refused here too', async () => {
    assert.equal((await get('/api/usage', { headers: authed({ origin: 'http://evil.example' }) })).status, 403);
    assert.equal((await get('/api/usage', { headers: authed({ host: 'attacker.test' }) })).status, 403);
    assert.equal((await get('/api/usage', { headers: authed(), method: 'POST' })).status, 405);
  });

  test('HEAD answers with the headers and no body', async () => {
    const res = await get('/api/usage', { headers: authed(), method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.body, '');
    assert.ok(Number(res.headers['content-length']) > 0);
  });

  test('anything else under /api/usage/ is a 404 JSON, not a 400', async () => {
    for (const p of ['/api/usage/other', '/api/usage/', '/api/usage/ccusage/x', '/api/usage/CCUSAGE']) {
      const res = await get(p, { headers: authed() });
      assert.equal(res.status, 404, p);
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'not found' }, p);
    }
  });
});

describe('M4: GET /api/usage/ccusage', () => {
  test('needs the cookie', async () => {
    assert.equal((await get('/api/usage/ccusage')).status, 403);
  });

  test('compares the window against the injected runner', async () => {
    const today = localDateKey(new Date());
    ccRunner = async () => ({
      ok: true,
      error: null,
      data: { daily: [{ period: today, agent: 'all', inputTokens: 11, outputTokens: 20, totalCost: 0.75 }] },
    });
    const res = await get('/api/usage/ccusage?days=7', { headers: authed() });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    // The window LENGTH is `windowDays` here too; `days` never means two things.
    assert.equal(body.windowDays, 7);
    assert.equal(body.days, undefined);
    const row = body.rows.find((r) => r.date === today);
    assert.equal(row.ours.output_tokens, 22);
    assert.equal(row.ccusage.output_tokens, 20);
    assert.equal(row.delta.output_tokens, 2);
    assert.equal(row.delta.input_tokens, 0);
    assert.equal(row.totalCost, 0.75);
    assert.ok(body.fetchedAt);
    assert.equal(body.cached, false);
  });

  test('a failed run is one fixed string and a 200, not a 500 and not a stack', async () => {
    const seen = [];
    const original = handle.collector.recordError;
    handle.collector.recordError = (where, err) => { seen.push([where, String(err)]); return original.call(handle.collector, where, err); };
    ccRunner = async () => ({ ok: false, data: null, error: 'exit code 1: npm ERR! 404 Not Found - ccusage@latest' });
    const res = await get('/api/usage/ccusage?days=7', { headers: authed() });
    handle.collector.recordError = original;
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(res.body).ok, false);
    assert.equal(JSON.parse(res.body).error, 'ccusage unavailable');
    assert.equal(/npm ERR/.test(res.body), false, 'the detail must not reach the browser');
    assert.ok(seen.some(([w]) => w === 'http:usage:ccusage'), `expected the detail on onError, got ${JSON.stringify(seen)}`);
  });

  test('a missing ccusage answers notInstalled plus the version to install', async () => {
    ccRunner = async () => ({
      ok: false,
      data: null,
      notInstalled: true,
      error: `${CCUSAGE_SPEC} is not installed (npx refused to download it)`,
    });
    const res = await get('/api/usage/ccusage?days=7', { headers: authed() });
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'ccusage unavailable');
    assert.equal(body.notInstalled, true);
    // The page prints `npm i -g ccusage@<this>`; the number is the server's.
    assert.equal(body.ccusageVersion, CCUSAGE_VERSION);
    assert.equal(/npx canceled|npm error/.test(res.body), false, 'no npm text reaches the browser');
    ccRunner = async () => ({ ok: true, data: { daily: [] }, error: null });
  });

  test('an ordinary failure is not notInstalled', async () => {
    ccRunner = async () => ({ ok: false, data: null, error: 'exit code 3' });
    const body = JSON.parse((await get('/api/usage/ccusage?days=7', { headers: authed() })).body);
    assert.equal(body.notInstalled, false);
    ccRunner = async () => ({ ok: true, data: { daily: [] }, error: null });
  });

  test('a runner that rejects does not take the listener down', async () => {
    ccRunner = async () => { throw new Error('spawn EINVAL'); };
    const res = await get('/api/usage/ccusage?days=7', { headers: authed() });
    assert.equal(res.status, 200);
    assert.equal(JSON.parse(res.body).error, 'ccusage unavailable');
    // still alive
    assert.equal((await get('/api/health', { headers: authed() })).status, 200);
    ccRunner = async () => ({ ok: true, data: { daily: [] }, error: null });
  });
});

/**
 * The tests above never reach guardAsync's catch: CcusageCache.daily has its
 * own try/catch, so a broken runner comes back as a resolved {ok:false} and
 * buildCcusageComparison turns it into a 200. guardAsync exists for the case
 * NOTHING absorbs - the cache object itself failing - and that is the case that
 * used to reach `unhandledRejection` and make installCrashHandlers exit 1.
 */
describe('M4: guardAsync is what keeps a broken /api/usage/ccusage from killing the server', () => {
  let h2;
  const seen = [];
  /** daily() is swapped per test; stats() must survive for /api/health. */
  let daily = async () => ({ ok: true, data: { daily: [] }, error: null });

  const get2 = (pathname) => new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: h2.port, path: pathname, method: 'GET', headers: { cookie: `${COOKIE_NAME}=${h2.token}` } },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    req.end();
  });

  before(async () => {
    h2 = await startServer({
      port: 0,
      collector: handle.collector,
      monitorDir: path.join(tmp.dir, 'monitor-guard'),
      statuslineDir: path.join(tmp.dir, 'statusline'),
      ccusageCache: {
        daily: (...a) => daily(...a),
        stats: () => ({ runs: 0, hits: 0, entries: 0 }),
      },
      onError: (where, err) => seen.push([where, String(err)]),
    });
  });

  after(async () => {
    if (h2) await h2.close();
  });

  test('a cache that throws synchronously is a 500 with the fixed body, not a crash', async () => {
    seen.length = 0;
    daily = () => { throw new Error('ccusage cache exploded'); };
    const res = await get2('/api/usage/ccusage?days=7');
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'internal error' });
    assert.equal(/exploded/.test(res.body), false, 'the detail must not reach the browser');
    assert.ok(seen.some(([w, e]) => w === 'api:usage-ccusage' && /exploded/.test(e)), JSON.stringify(seen));
    // The process is still here and still answering.
    assert.equal((await get2('/api/health')).status, 200);
  });

  test('a cache that returns a rejected promise is the same 500', async () => {
    seen.length = 0;
    daily = () => Promise.reject(new Error('ccusage cache rejected'));
    const res = await get2('/api/usage/ccusage?days=7');
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'internal error' });
    assert.ok(seen.some(([w, e]) => w === 'api:usage-ccusage' && /rejected/.test(e)), JSON.stringify(seen));
    const health = await get2('/api/health');
    assert.equal(health.status, 200);
    assert.equal(JSON.parse(health.body).ok, true);
    daily = async () => ({ ok: true, data: { daily: [] }, error: null });
  });
});

describe('GET /api/stream', () => {
  test('needs the cookie', async () => {
    assert.equal((await get('/api/stream')).status, 403);
  });

  test('delivers a snapshot event on connect and a ping-capable stream', async () => {
    const payload = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: handle.port,
          path: '/api/stream',
          headers: { cookie, accept: 'text/event-stream' },
        },
        (res) => {
          assert.equal(res.statusCode, 200);
          assert.match(res.headers['content-type'], /text\/event-stream/);
          let buf = '';
          res.on('data', (c) => {
            buf += c.toString('utf8');
            const m = /event: snapshot\ndata: (.*)\n\n/.exec(buf);
            if (m) {
              req.destroy();
              resolve(m[1]);
            }
          });
          res.on('error', () => { /* destroyed on purpose */ });
        },
      );
      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
      req.setTimeout(4000, () => { req.destroy(); reject(new Error('stream timeout')); });
      req.end();
    });

    const snap = JSON.parse(payload);
    assert.equal(snap.ok, true);
    assert.equal(snap.sessions[0].sessionId, SID);
  });

  test('a change on disk is pushed to a connected client', async () => {
    const eventsDir = path.join(tmp.dir, 'events');
    const day = path.join(eventsDir, `${localDateKey(new Date())}.jsonl`);

    const seen = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: handle.port, path: '/api/stream', headers: { cookie } },
        (res) => {
          let buf = '';
          let snapshots = 0;
          res.on('data', (c) => {
            buf += c.toString('utf8');
            const frames = buf.split('\n\n');
            snapshots = frames.filter((f) => f.startsWith('event: snapshot')).length;
            if (snapshots === 1) {
              // Now make something happen.
              appendJsonl(day, [{
                receivedAt: new Date().toISOString(),
                hookEventName: 'Notification',
                hook_event_name: 'Notification',
                session_id: SID,
                notification_type: 'permission_prompt',
                message: 'Claude needs your permission',
              }]);
              handle.collector.pollHooks();
              snapshots = -1; // only trigger once
            } else if (buf.includes('permission_prompt')) {
              req.destroy();
              resolve(true);
            }
          });
          res.on('error', () => { /* destroyed on purpose */ });
        },
      );
      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
      req.setTimeout(5000, () => { req.destroy(); reject(new Error('no push received')); });
      req.end();
    });
    assert.equal(seen, true);
    assert.equal(handle.collector.snapshot().sessions[0].phase, 'waiting_permission');
  });
});

describe('route parsing', () => {
  test('keeps ordinary paths', () => {
    assert.equal(routeKey('/'), '/');
    assert.equal(routeKey('/app.js'), '/app.js');
    assert.equal(routeKey('/api/state?x=1'), '/api/state');
    assert.equal(routeKey('/api/state#frag'), '/api/state');
  });

  test('refuses traversal, backslashes, NUL and malformed escapes', () => {
    assert.equal(routeKey('/../x'), null);
    assert.equal(routeKey('/a/../../x'), null);
    assert.equal(routeKey('/%2e%2e/x'), null);
    assert.equal(routeKey('/a\\b'), null);
    assert.equal(routeKey('/%00'), null);
    assert.equal(routeKey('/%zz'), null);
    assert.equal(routeKey('http://evil/'), null);
  });
});

describe('port resolution', () => {
  test('explicit beats env beats default', () => {
    assert.equal(resolvePort(1234, {}), 1234);
    assert.equal(resolvePort(undefined, { CLAUDE_MONITOR_PORT: '5555' }), 5555);
    assert.equal(resolvePort(undefined, {}), DEFAULT_PORT);
    assert.equal(resolvePort(true, {}), DEFAULT_PORT);
    assert.equal(resolvePort('abc', {}), DEFAULT_PORT);
    assert.equal(resolvePort(0, {}), 0);
    assert.equal(resolvePort(70000, {}), DEFAULT_PORT);
  });
});

describe('review 2026-09-03: hardening', () => {
  test('the token exchange is refused on a rebound Host (F3)', async () => {
    // A page on another origin cannot read our loopback response, but a DNS
    // rebind can make the browser send our own token back to a host we do not
    // control. The bootstrap must not mint a cookie for it.
    const res = await get(`/?t=${handle.token}`, { headers: { host: 'attacker.test' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers['set-cookie'], undefined);
    assert.equal(res.body.trim(), 'forbidden');
  });

  test('the token exchange is refused on a cross-site Origin (F3)', async () => {
    const res = await get(`/?t=${handle.token}`, { headers: { origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  test('the token exchange is refused on a cross-site Sec-Fetch-Site (F3)', async () => {
    const res = await get(`/?t=${handle.token}`, { headers: { 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.status, 403);
    assert.equal(res.headers['set-cookie'], undefined);
  });

  test('the token exchange still works from our own origin', async () => {
    const res = await get(`/?t=${handle.token}`, {
      headers: { origin: `http://127.0.0.1:${handle.port}`, 'sec-fetch-site': 'same-origin' },
    });
    assert.equal(res.status, 302);
    assert.ok(res.headers['set-cookie']);
  });

  test('framing is forbidden by both headers (F5)', async () => {
    for (const p of ['/', '/api/state', '/nope']) {
      const res = await get(p, { headers: authed() });
      assert.equal(res.headers['x-frame-options'], 'DENY', p);
      assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/, p);
    }
  });

  test('HEAD returns the headers a GET would, with no body (F6)', async () => {
    for (const p of ['/', '/app.js', '/style.css', '/api/state', '/api/health']) {
      const head = await get(p, { headers: authed(), method: 'HEAD' });
      const body = await get(p, { headers: authed() });
      assert.equal(head.status, 200, p);
      assert.equal(head.body, '', `${p} returned a body to HEAD`);
      assert.equal(head.headers['content-type'], body.headers['content-type'], p);
      assert.ok(Number(head.headers['content-length']) > 0, `${p} lost its Content-Length`);
    }
  });

  test('HEAD on an error response also has no body (F6)', async () => {
    const notFound = await get('/nope', { headers: authed(), method: 'HEAD' });
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body, '');
    const forbidden = await get('/api/state', { method: 'HEAD' });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body, '');
  });

  test('HEAD on /api/stream is 405, not a silent subscription (F6)', async () => {
    const before = handle.sse.size;
    const res = await get('/api/stream', { headers: authed(), method: 'HEAD' });
    assert.equal(res.status, 405);
    assert.equal(res.headers.allow, 'GET');
    assert.equal(handle.sse.size, before, 'HEAD must not consume a stream slot');
  });

  test('the listener keeps a permanent error handler after listen (F1c)', () => {
    // Without one, an 'error' emitted later (EMFILE, ECONNABORTED) is rethrown
    // by EventEmitter and kills the process.
    assert.ok(handle.server.listenerCount('error') >= 1);
    assert.doesNotThrow(() => {
      const err = new Error('synthetic EMFILE');
      err.code = 'EMFILE';
      handle.server.emit('error', err);
    });
    const noted = handle.collector.stats().recentErrors.some((e) => e.where === 'http:server');
    assert.equal(noted, true, 'the error was recorded rather than swallowed');
  });

  test('a client that vanishes mid-response does not kill the server (F1d)', async () => {
    let uncaught = 0;
    const onUncaught = () => { uncaught++; };
    process.on('uncaughtException', onUncaught);
    try {
      // Send a request and destroy the socket the instant the headers land.
      await new Promise((resolve) => {
        const req = http.request(
          { host: '127.0.0.1', port: handle.port, path: '/api/state', headers: { cookie } },
          (res) => {
            res.socket.destroy();
            resolve();
          },
        );
        req.on('error', () => resolve());
        req.end();
      });
      await new Promise((r) => setTimeout(r, 60));
      assert.equal(uncaught, 0);
      // Still serving.
      assert.equal((await get('/api/health', { headers: authed() })).status, 200);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });
});

describe('crash handlers', () => {
  test('installCrashHandlers records, closes and reports without exiting the test run', async () => {
    const closed = [];
    const logged = [];
    const errors = [];
    const fakeHandle = {
      close: async () => { closed.push(true); },
      collector: { recordError: (where, err) => errors.push({ where, err }) },
    };
    const h = installCrashHandlers(fakeHandle, { log: (m) => logged.push(m), exit: false });
    try {
      h.crash('uncaughtException', new Error('boom'));
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(closed.length, 1, 'the server was closed so the port is freed');
      assert.equal(errors[0].where, 'uncaughtException');
      assert.ok(logged.join('\n').includes('boom'), 'the reason was printed, not swallowed');
      // A second crash while shutting down is ignored.
      h.crash('unhandledRejection', new Error('again'));
      assert.equal(closed.length, 1);
    } finally {
      h.dispose();
    }
  });

  test('it registers for both process events and can unregister', () => {
    const before = process.listenerCount('uncaughtException');
    const h = installCrashHandlers({ close: async () => {} }, { exit: false });
    assert.equal(process.listenerCount('uncaughtException'), before + 1);
    h.dispose();
    assert.equal(process.listenerCount('uncaughtException'), before);
  });
});

describe('browser review 2026-09-03: what the shipped UI does', () => {
  let js;
  let html;
  let css;

  before(async () => {
    js = (await get('/app.js', { headers: authed() })).body;
    html = (await get('/', { headers: authed() })).body;
    css = (await get('/style.css', { headers: authed() })).body;
  });

  test('the reset clock carries a date when it is not today (item 3)', () => {
    // A 7d window resets days away; "06:00" alone reads as this morning.
    assert.match(js, /function clockFromEpochSec/);
    assert.match(js, /sameDay/);
    assert.match(js, /getMonth\(\) \+ 1\) \+ '\/' \+ d\.getDate\(\)/);
  });

  test('the TOKENS row shows cache creation as well as cache reads (item 4)', () => {
    assert.match(js, /pair\('cache作', compact\(t\.cacheCreate\)\)/);
    assert.match(js, /pair\('cache読', compact\(t\.cacheRead\)\)/);
  });

  test('the header "requires attention" count is highlighted only when non-zero (item 5)', () => {
    assert.match(js, /stat-waiting-wrap'\)\.classList\.toggle\('stat--alert', waitingCount > 0\)/);
    assert.match(html, /id="stat-waiting-wrap"/);
    // It borrows the badge's amber, so the header and the card agree.
    assert.match(css, /\.stat--alert \.stat__n \{ color: var\(--wait\); \}/);
  });

  test('the latest prompt has its own row and is never the title (item 6)', () => {
    // The row is built by the client, so the assertion belongs on app.js.
    assert.match(js, /buildRow\('最新プロンプト'\)/);
    assert.match(js, /trim80\(s\.lastPrompt\)/);
    // 80 characters, newlines flattened, textContent only.
    assert.match(js, /flat\.length > 80 \? flat\.slice\(0, 80\)/);
    assert.equal(/setText\(card\.title, s\.lastPrompt/.test(js), false);
  });

  test('every status mark carries its Japanese name as a title (review 3)', () => {
    const labels = bodyOf(js, 'var AGENT_STATUS_LABEL = {');
    for (const pair of ["running: '実行中'", "completed: '完了'", "stale: '終了と推定'",
      "error: 'エラー'", "'async-unknown': '完了不明'"]) {
      assert.ok(labels.includes(pair), `AGENT_STATUS_LABEL is missing ${pair}`);
    }
    // Both views set it, so hovering explains the glyph wherever it appears.
    assert.match(js, /node\.mark\.setAttribute\('title', AGENT_STATUS_LABEL\[a\.status\]/);
    assert.match(js, /parts\.mark\.setAttribute\('title', isSession/);
    assert.match(css, /\.tnode__mark \{[^}]*cursor: help;/);
  });

  test('an alias and a full model id for one family render identically (review 2)', () => {
    // meta.json says "opus"; the transcript says "claude-opus-5". Showing them
    // as "Opus" and "Opus 5" in one tree read as two different models.
    const table = bodyOf(js, 'var MODEL_LABEL = {');
    for (const alias of [['opus', 'Opus'], ['sonnet', 'Sonnet'], ['haiku', 'Haiku'], ['fable', 'Fable']]) {
      assert.ok(table.includes(`${alias[0]}: '${alias[1]}'`), `alias ${alias[0]} should read ${alias[1]}`);
    }
    for (const full of ['claude-opus-5', 'claude-opus-4-5']) {
      assert.ok(table.includes(`'${full}': 'Opus'`), `${full} should read Opus, not a version`);
    }
    for (const full of ['claude-sonnet-5', 'claude-sonnet-4-5']) {
      assert.ok(table.includes(`'${full}': 'Sonnet'`), `${full} should read Sonnet`);
    }
    assert.ok(table.includes("'claude-haiku-4-5': 'Haiku'"));
    assert.ok(table.includes("'claude-fable-5': 'Fable'"));
    // No entry may carry a version any more, or the mismatch comes straight back.
    assert.equal(/: '(Opus|Sonnet|Haiku|Fable) [0-9.]/.test(table), false,
      'a MODEL_LABEL value still carries a version number');
  });

  test('agent rows show label, model and a distinct mark for inferred ends (items 1, 2, 7)', () => {
    // One status table, shared by the Live cards and the Tree (M3 review 3).
    const marks = bodyOf(js, 'var AGENT_MARK = {');
    for (const pair of ["running: '▶'", "completed: '✓'", "stale: '?'",
      "error: '✗'", "'async-unknown': '~'"]) {
      assert.ok(marks.includes(pair), `AGENT_MARK is missing ${pair}`);
    }
    // The two "we are guessing" marks must not collide with each other or with
    // the expand toggle's dot.
    assert.equal(marks.includes("'async-unknown': '·'"), false);
    assert.match(js, /setText\(node\.type, a\.label/);
    assert.match(js, /setText\(node\.model, a\.model \? modelLabel\(a\.model\) : ''\)/);
    assert.match(js, /終了と推定/);
    assert.match(css, /\.agent--stale/);
  });

  test('model names are table driven and unknown ids pass through (item 7)', () => {
    assert.match(js, /var MODEL_LABEL = \{/);
    assert.match(js, /'claude-haiku-4-5': /);
    // Only a trailing release date is stripped before the lookup.
    assert.match(js, /replace\(\/-\\d\{8\}\$\/, ''\)/);
    assert.match(js, /return id;/);
  });

  test('the new markup still has no inline script, style or handler', () => {
    assert.equal(/<script(?![^>]*\ssrc=)/i.test(html), false);
    assert.equal(/<style[\s>]/i.test(html), false);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  });

  test('the new client code still uses no forbidden DOM sink', () => {
    for (const re of [/\.innerHTML/, /\.outerHTML/, /\.insertAdjacentHTML\s*\(/, /document\.write\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/]) {
      assert.equal(re.test(js), false, `app.js uses ${re}`);
    }
  });
});

/**
 * The source of one top-level function inside public/app.js, from its
 * signature to the first line that closes at two-space indent. Built with
 * fromCharCode so the newline needs no escape that a shell could eat.
 */
function bodyOf(js, signature) {
  const start = js.indexOf(signature);
  assert.ok(start > 0, `not found in app.js: ${signature}`);
  const end = js.indexOf(String.fromCharCode(10) + '  }', start);
  assert.ok(end > start, `no close found for: ${signature}`);
  return js.slice(start, end);
}

describe('M3: the tree view the server actually hands out', () => {
  let js;
  let html;
  let css;

  before(async () => {
    js = (await get('/app.js', { headers: authed() })).body;
    html = (await get('/', { headers: authed() })).body;
    css = (await get('/style.css', { headers: authed() })).body;
  });

  test('the placeholder is gone and the three panes exist', () => {
    assert.equal(/M3 で実装する/.test(html), false, 'the Tree todo card is still there');
    for (const id of [
      'tree-days', 'tree-reload', 'tree-sessions', 'tree-side-empty',
      'tree-title', 'tree-cwd', 'tree-sum', 'tree-nodes', 'tree-empty',
      'tree-orphans', 'tree-orphan-nodes', 'tree-orphan-count',
      'tree-detail', 'detail-title', 'detail-rows', 'detail-prompt', 'detail-tools',
    ]) {
      assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    // The tab no longer advertises itself as unbuilt.
    assert.match(html, /id="tab-tree" data-view="tree">Tree<\/button>/);
    // Neither does Usage, now that M4 shipped: the milestone badge is gone and
    // so is the class that drew it.
    assert.match(html, /id="tab-usage" data-view="usage">Usage<\/button>/);
    assert.equal(/tab__m/.test(html), false, 'the milestone badge is still in the markup');
    assert.equal(/\.tab__m/.test(css), false, 'the milestone badge style is still in style.css');
  });

  test('it talks to the three M3 endpoints and nothing else', () => {
    assert.match(js, /'\/api\/sessions\?days='/);
    assert.match(js, /'\/api\/tree\/' \+ encodeURIComponent/);
    assert.match(js, /'\/api\/tools\/' \+ encodeURIComponent/);
    // Same-origin credentials, like the rest of the client.
    assert.match(js, /fetch\(url, \{ credentials: 'same-origin' \}\)/);
  });

  test('a live tree is refreshed on SSE snapshots, debounced, and only when visible', () => {
    assert.match(js, /var TREE_DEBOUNCE_MS = 2000;/);
    assert.match(js, /function onSnapshotForTree\(\)/);
    assert.match(js, /if \(currentView !== 'tree'\) return;/);
    assert.match(js, /if \(!tree\.selected \|\| !isSelectedLive\(\)\) return;/);
    // A finished session has a manual button instead.
    assert.match(js, /\$\('tree-reload'\)\.addEventListener/);
  });

  test('nodes are a nested list with real toggle buttons, open to depth 2', () => {
    assert.match(js, /var DEFAULT_OPEN_DEPTH = 2;/);
    assert.match(js, /el\('ul', 'tnodes'\)/);
    assert.match(js, /el\('li', 'tnode'\)/);
    assert.match(js, /tog\.setAttribute\('aria-expanded'/);
    assert.match(js, /parts\.tog\.setAttribute\('aria-expanded', folded \? 'false' : 'true'\)/);
  });

  test('an inferred status is never dressed up as a fact', () => {
    assert.match(js, /stale: '\?'/);
    assert.match(js, /stale: '終了と推定'/);
    assert.match(js, /inferred: '無音からの推定'/);
    // The source of every resolved field is shown next to it.
    assert.match(js, /var FIELD_SOURCE_LABEL = \{/);
    assert.match(js, /meta: 'meta\.json'/);
  });

  test('the DOM is only restructured when the tree structure changed', () => {
    assert.match(js, /if \(sig !== tree\.signature\)/);
    assert.match(js, /tree\.signature = sig;/);
  });

  test('the selected tab, session and window survive a reload', () => {
    assert.match(js, /var K_TAB = 'cm\.tab';/);
    assert.match(js, /var K_TREE_SESSION = 'cm\.tree\.session';/);
    assert.match(js, /var K_TREE_DAYS = 'cm\.tree\.days';/);
    // Both accessors are wrapped: a private window throws on localStorage.
    assert.match(js, /function getStore\(key\) \{\s*try \{ return window\.localStorage\.getItem\(key\); \} catch/);
    assert.match(js, /function setStore\(key, value\) \{\s*try \{ window\.localStorage\.setItem/);
    assert.match(js, /selectView\(getStore\(K_TAB\) \|\| 'live'\)/);
  });

  test('a Live card can jump straight to its tree', () => {
    assert.match(js, /function showTreeFor\(sessionId\)/);
    assert.match(js, /el\('button', 'btn btn--sm card__tree', 'Tree'\)/);
  });

  test('the Tree button loads the session list once, not twice (review 4)', () => {
    // selectView('tree') already runs enterTree(), which loads the list.
    const body = bodyOf(js, 'function showTreeFor(sessionId) {');
    assert.equal(/loadSessions\(/.test(body), false, 'showTreeFor loads the list a second time');
    assert.match(body, /selectView\('tree'\);/);
    assert.match(body, /selectSession\(sessionId\);/);
  });

  test('a debounced refresh armed on the Tree tab does not fire after leaving it (review 3)', () => {
    const body = bodyOf(js, 'function onSnapshotForTree() {');
    // Once when arming, and once inside EACH of the two timer callbacks.
    const guards = body.match(/currentView !== 'tree'/g) || [];
    assert.equal(guards.length, 3, `expected 3 visibility guards, found ${guards.length}`);
  });

  test('an empty cell rather than a bare zero (review 1)', () => {
    const body = bodyOf(js, 'function patchNode(w) {');
    // A hooks-only agent has no transcript, so its totals are 0. Printing "0"
    // in the token column reads as a stray number next to the id.
    assert.ok(body.includes("setText(parts.tok, n.tokens && n.tokens.total ? compact(n.tokens.total) : '');"),
      'the token cell still prints a zero');
    assert.ok(body.includes("setText(parts.tools, n.toolCount ? n.toolCount + ' tools' : '');"),
      'the tool-count cell still prints a zero');
    // The unnamed rows are ids, so they get the same mono face as the numbers.
    assert.match(body, /parts\.label\.classList\.toggle\('tnode__label--id'/);
    // Two classes deep so it beats the hooks-only italic rule.
    assert.match(css, /\.tnode__btn \.tnode__label--id \{[^}]*font-family: var\(--font-mono\);/);
    assert.match(css, /\.tnode__btn \.tnode__label--id \{[^}]*font-style: normal;/);
  });

  test('the M3 markup still has no inline script, style or handler', () => {
    assert.equal(/<script(?![^>]*\ssrc=)/i.test(html), false);
    assert.equal(/<style[\s>]/i.test(html), false);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false);
    // No external anything, still.
    assert.equal(/https?:\/\//i.test(html.replace(/<link rel="icon"[^>]*>/, '')), false);
  });

  test('the M3 client code uses no forbidden DOM sink either', () => {
    for (const re of [/\.innerHTML/, /\.outerHTML/, /\.insertAdjacentHTML\s*\(/, /document\.write\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /setAttribute\(\s*'style'/]) {
      assert.equal(re.test(js), false, `app.js uses ${re}`);
    }
  });

  test('the M3 stylesheet pulls in nothing from outside', () => {
    assert.equal(/@import/.test(css), false);
    assert.equal(/url\(\s*['"]?https?:/i.test(css), false);
    // The tree classes are actually styled.
    for (const cls of ['.tnode__btn', '.tnodes', '.srow', '.detail', '.trow', '.orphans']) {
      assert.ok(css.includes(cls), `missing style for ${cls}`);
    }
  });

  test('the tree keeps the colour discipline: amber only for attention', () => {
    // Waiting states get --wait; a running agent gets the muted busy blue.
    assert.match(css, /\.srow__dot\[data-phase="waiting_permission"\], \.srow__dot\[data-phase="waiting_input"\] \{ background: var\(--wait\); \}/);
    assert.match(css, /\.tnode__btn\[data-status="running"\] \.tnode__mark \{ color: var\(--busy\); \}/);
  });
});

describe('M4: the Usage view the server actually hands out', () => {
  let js;
  let html;
  let css;

  before(async () => {
    js = (await get('/app.js', { headers: authed() })).body;
    html = (await get('/', { headers: authed() })).body;
    css = (await get('/style.css', { headers: authed() })).body;
  });

  test('the placeholder is gone and every pane exists', () => {
    assert.equal(/M4 で実装する/.test(html), false, 'the Usage todo card is still there');
    for (const id of [
      'usage-days', 'usage-reload', 'usage-cc', 'usage-state',
      'usage-tiles', 'usage-legend',
      'usage-daily', 'usage-daily-head', 'usage-daily-body', 'usage-daily-empty',
      'usage-models-head', 'usage-models-body',
      'usage-sessions-head', 'usage-sessions-body',
      'usage-foot', 'usage-ccfoot',
    ]) {
      assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    // 7 / 14 / 30 and nothing else.
    for (const v of ['7', '14', '30']) assert.match(html, new RegExp(`<option value="${v}"`));
  });

  test('it talks to the two M4 endpoints and nothing else', () => {
    assert.match(js, /'\/api\/usage\?days=' \+ want/);
    assert.match(js, /'\/api\/usage\/ccusage\?days=' \+ usage\.days/);
    assert.equal(/\/api\/usage\/(?!ccusage)[a-z]/.test(js), false, 'no other /api/usage/ path');
  });

  test('the period is remembered in localStorage beside the tab', () => {
    assert.match(js, /var K_USAGE_DAYS = 'cm\.usageDays';/);
    assert.match(js, /setStore\(K_USAGE_DAYS/);
    assert.match(js, /getStore\(K_USAGE_DAYS\)/);
    // Both accessors are the try/catch pair, not raw localStorage.
    assert.match(js, /function getStore\(key\) \{\s*try \{/);
  });

  test('SSE snapshots reload it on a 10s debounce, and only while it is visible', () => {
    assert.match(js, /var USAGE_DEBOUNCE_MS = 10000;/);
    const body = bodyOf(js, 'function onSnapshotForUsage() {');
    assert.match(body, /if \(currentView !== 'usage'\) return;/);
    // The re-check INSIDE the timer is the M3 review fix (8.3), repeated here.
    assert.equal((body.match(/currentView !== 'usage'/g) || []).length, 2,
      'the visibility check must run again when the timer fires');
    assert.match(js, /if \(name === 'usage'\) enterUsage\(\);/);
  });

  test('entering the tab does not refetch what is still fresh', () => {
    const body = bodyOf(js, 'function enterUsage() {');
    assert.match(body, /USAGE_STALE_MS/);
    assert.match(body, /usage\.dataDays !== usage\.days/);
  });

  test('loading and error states are text, never a blank pane', () => {
    assert.match(js, /setText\(\$\('usage-state'\), '読み込んでいる'\)/);
    assert.match(js, /setText\(\$\('usage-state'\), '使用量を取得できなかった'\)/);
    assert.match(js, /ccusage と突合できなかった/);
  });

  test('the daily row marks today and labels stored / partial days', () => {
    const body = bodyOf(js, 'function renderUsageDaily(d) {');
    assert.match(body, /row\.date \+ \(row\.today \? ' \*' : ''\)/);
    assert.match(body, /'保存値'/);
    assert.match(body, /'一部欠損'/);
    assert.match(body, /row\.source === 'store'/);
  });

  test('the bar is scaled to the biggest day and stacked by model series', () => {
    const body = bodyOf(js, 'function usageBar(row, max) {');
    assert.match(body, /gauge__track usage__bar/, 'the quota gauge track is reused');
    assert.match(body, /max > 0 \? \(total \/ max\) \* 100 : 0/);
    assert.match(body, /style\.setProperty\('width'/);
    assert.match(js, /var USAGE_SERIES = \['Opus', 'Sonnet', 'Haiku', 'Fable', 'other'\];/);
  });

  test('the session table jumps to the Tree the same way a Live card does', () => {
    assert.match(js, /function bindTreeJump\(btn, sessionId\) \{/);
    assert.match(js, /btn\.addEventListener\('click', function \(\) \{ showTreeFor\(sessionId\); \}\);/);
  });

  test('the Claude Code cost is labelled as an estimate, not as billing', () => {
    assert.match(js, /'推定 \(Claude Code\)'/);
    assert.match(js, /label: '推定 \(Claude Code\)'/);
  });

  test('the 5h/7d gauges exist once, in the header, and are not copied into the Usage tab', () => {
    // The header ribbon is on every view, so a second pair inside #view-usage
    // was two DOM trees and two update paths for one number.
    assert.match(html, /id="quota-rows"/);
    assert.equal(/id="usage-gauges/.test(html), false, 'the Usage tab still has its own gauges');
    assert.equal(/renderUsageQuota/.test(js), false, 'the duplicate gauge renderer is still in app.js');
    assert.equal(/usage__gauges|usage__none/.test(css), false, 'the duplicate gauge styles are still in style.css');
    // The one that stayed is still the shared implementation.
    assert.match(bodyOf(js, 'function renderQuota(sessions) {'), /freshestRateLimits\(sessions\)/);
    assert.match(js, /function buildGauge\(/);
  });

  test('the stacked-bar segment colours are not overridden by their own base rule', () => {
    // Equal specificity: the LAST rule wins, so `.useg { background }` has to
    // come before `.useg--opus`, or every segment paints grey.
    const base = css.indexOf('.useg { height');
    const mod = css.indexOf('.useg--opus { background');
    assert.ok(base > 0 && mod > 0, 'both rules must exist');
    assert.ok(base < mod, `.useg base (${base}) must precede .useg--opus (${mod})`);
    for (const s of ['opus', 'sonnet', 'haiku', 'fable', 'other']) {
      assert.match(css, new RegExp(`\\.useg--${s} \\{ background: var\\(--m-${s}\\); \\}`));
    }
  });

  test('compact() never prints a unit that does not exist', () => {
    // compact lives in the browser IIFE with no exports, so the served source
    // is evaluated here rather than trusted.
    const src = `${bodyOf(js, 'function compact(n) {')}\n}\n;compact`;
    const compact = vm.runInNewContext(src, {});
    const table = [
      [0, '0'], [999, '999'], [1000, '1.0k'], [1100, '1.1k'], [12000, '12k'],
      [999499, '999k'],
      // The bug: toFixed rounds 999.8k up to "1000k", a unit that is not a unit.
      [999800, '1.0M'], [999999, '1.0M'],
      [1400000, '1.4M'], [264000000, '264M'], [973000000, '973M'],
      [999900000, '1.0G'], [1000000000, '1.0G'], [1500000000, '1.5G'],
      [2500000000000, '2500G'],
    ];
    for (const [n, want] of table) assert.equal(compact(n), want, `compact(${n})`);
    assert.equal(compact(NaN), '-');
    assert.equal(compact(Infinity), '-');
    assert.equal(compact('12'), '-');
  });

  test('the M4 markup still has no inline script, style or handler', () => {
    assert.equal(/<script(?![^>]*\ssrc=)/i.test(html), false);
    assert.equal(/<style[\s>]/i.test(html), false);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false);
    assert.equal(/https?:\/\//i.test(html.replace(/<link rel="icon"[^>]*>/, '')), false);
  });

  test('the ccusage footnote promises no download and tells the user how to install', () => {
    const src = bodyOf(js, 'function loadCcusage() {');
    // The button never downloads anything any more, so the old warning is a lie.
    assert.equal(/ダウンロード/.test(src), false, 'the footnote still mentions an npx download');
    assert.match(src, /'ccusage を実行している'/);
    assert.match(src, /ccusage が見つからない。npm i -g/);
    assert.match(src, /d\.notInstalled/);
    // The version is the server's answer, never a copy in the page.
    assert.match(src, /d\.ccusageVersion/);
    assert.equal(new RegExp(CCUSAGE_VERSION.replace(/\./g, '\\.')).test(js), false,
      'the ccusage version is hard-coded in app.js');
    assert.match(src, /setText\(/);
  });

  test('the M4 client code uses no forbidden DOM sink either', () => {
    for (const re of [/\.innerHTML/, /\.outerHTML/, /\.insertAdjacentHTML\s*\(/, /document\.write\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/, /setAttribute\(\s*'style'/]) {
      assert.equal(re.test(js), false, `app.js uses ${re}`);
    }
  });

  test('the M4 stylesheet styles the new classes and pulls in nothing external', () => {
    assert.equal(/@import/.test(css), false);
    assert.equal(/url\(\s*['"]?https?:/i.test(css), false);
    for (const cls of ['.usage__head', '.usage__tiles', '.utile', '.utab', '.useg', '.uleg', '.usage__bar']) {
      assert.ok(css.includes(cls), `missing style for ${cls}`);
    }
  });

  test('the model palette keeps the colour discipline: no amber for a breakdown', () => {
    for (const v of ['--m-opus', '--m-sonnet', '--m-haiku', '--m-fable', '--m-other']) {
      assert.ok(css.includes(v), `missing ${v}`);
    }
    assert.equal(/--m-[a-z]+: var\(--wait\)/.test(css), false, 'amber means "a human is needed"');
  });
});

describe('notification settings: the panel the server actually hands out', () => {
  let js;
  let html;
  let css;
  let rules;

  before(async () => {
    js = (await get('/app.js', { headers: authed() })).body;
    html = (await get('/', { headers: authed() })).body;
    css = (await get('/style.css', { headers: authed() })).body;
    rules = (await get('/notify-rules.js', { headers: authed() })).body;
  });

  test('/notify-rules.js needs the cookie, like every other static file', async () => {
    assert.equal((await get('/notify-rules.js')).status, 403);
  });

  test('and is served as javascript with it', async () => {
    const res = await get('/notify-rules.js', { headers: authed() });
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.match(res.body, /CMNotifyRules/);
  });

  test('the page loads it BEFORE app.js', () => {
    const rulesAt = html.indexOf('<script src="/notify-rules.js"></script>');
    const appAt = html.indexOf('<script src="/app.js"></script>');
    assert.ok(rulesAt > 0, 'the page does not load /notify-rules.js');
    assert.ok(appAt > rulesAt, 'app.js is loaded before the rules it depends on');
  });

  test('every control the client wires up exists in the markup', () => {
    for (const id of [
      'notify-settings', 'notify-panel', 'notify-panel-state', 'notify-test', 'notify-close',
      'notify-quiet',
      'notify-kind-permission_prompt', 'notify-kind-idle_prompt', 'notify-kind-agent_needs_input',
      'notify-kind-agent_completed', 'notify-kind-turn_complete',
      'notify-quota-five_hour', 'notify-quota-five_hour-th',
      'notify-quota-seven_day', 'notify-quota-seven_day-th',
    ]) {
      assert.match(html, new RegExp(`id="${id}"`), `missing #${id}`);
    }
    // The master switch and the permission button are still there.
    assert.match(html, /id="notify-toggle"/);
    assert.match(html, /id="notify-permission"/);
  });

  test('the threshold inputs are bounded in the markup, not only in the code', () => {
    for (const w of ['five_hour', 'seven_day']) {
      const re = new RegExp(`id="notify-quota-${w}-th"[^>]*min="1"[^>]*max="100"`);
      assert.match(html, re, `#notify-quota-${w}-th is unbounded`);
    }
  });

  test('the panel is labelled and wired to its button for a screen reader', () => {
    assert.match(html, /id="notify-settings" aria-expanded="false" aria-controls="notify-panel"/);
    assert.match(html, /id="notify-panel" aria-label="通知設定" hidden/);
    // Every checkbox and number input is reachable by its own label.
    for (const id of [
      'notify-quiet', 'notify-kind-turn_complete', 'notify-quota-five_hour', 'notify-quota-five_hour-th',
    ]) {
      assert.match(html, new RegExp(`for="${id}"`), `#${id} has no label`);
    }
  });

  test('the client persists ONE versioned key and migrates the old one', () => {
    assert.match(js, /'cm\.notify\.settings'/);
    assert.match(js, /'cm\.notify\.enabled'/);
    // The old key is read for the migration and then removed - never written.
    assert.match(js, /function dropLegacyStore/);
    assert.equal(/writeStore\(\s*(?:notifyEnabled|notifySettings\.enabled)\s*\?\s*'1'/.test(js), false,
      'the client still writes the pre-settings on/off value');
  });

  test('the client asks notify-rules.js instead of re-deriving the rules', () => {
    assert.match(js, /window\.CMNotifyRules/);
    assert.match(js, /RULES\.evaluateQuota\(/);
    assert.match(js, /RULES\.parse\(/);
    assert.match(js, /RULES\.parseThreshold\(/);
    // The quota alert reuses the ribbon's "freshest capture" decision.
    assert.match(js, /var limits = renderQuota\(/);
    assert.equal(/function freshestRateLimits/.test(rules), false,
      'the freshest-capture rule is duplicated in notify-rules.js');
  });

  test('every notification path consults the settings', () => {
    // Kind switches.
    assert.match(js, /if \(!kindEnabled\(n\.type\)\) continue;/);
    assert.match(js, /kindEnabled\('turn_complete'\)/);
    // The focus rule is a setting now, not a hard-coded silence.
    assert.match(js, /notifySettings\.quietWhenFocused[\s\S]{0,120}document\.hasFocus\(\)/);
    // The master switch still gates everything.
    assert.match(js, /if \(!notifySettings\.enabled\) return false;/);
  });

  test('the first snapshot primes the quota alerts instead of firing them', () => {
    assert.match(js, /fireQuotaNotifications\(limits, !firstSnapshotSeen\);/);
  });

  test('the test notification deliberately ignores quietWhenFocused', () => {
    const body = bodyOf(js, 'function showTestNotification(');
    assert.equal(/canNotify\(\)/.test(body), false, 'the test button goes through canNotify()');
    assert.match(body, /new window\.Notification\(/);
  });

  test('the panel closes on Escape and on a click outside it', () => {
    assert.match(js, /e\.key !== 'Escape'/);
    assert.match(js, /\$\('notify-panel'\)\.contains\(e\.target\)/);
  });

  test('the shipped rules file uses no forbidden DOM sink', () => {
    for (const re of [
      /\.innerHTML/, /\.outerHTML/, /\.insertAdjacentHTML\s*\(/,
      /document\.write\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/,
      /https?:\/\//,
    ]) {
      assert.equal(re.test(rules), false, `notify-rules.js uses ${re}`);
    }
  });

  test('the panel markup adds no inline script, style or handler', () => {
    assert.equal(/<script(?![^>]*\ssrc=)/i.test(html), false);
    assert.equal(/<style[\s>]/i.test(html), false);
    assert.equal(/\son[a-z]+\s*=/i.test(html), false);
  });

  test('the stylesheet styles the panel and pulls in nothing external', () => {
    for (const cls of ['.npanel', '.npanel__fs', '.nrow', '.num', '.npanel__foot']) {
      assert.ok(css.includes(cls), `missing style for ${cls}`);
    }
    assert.equal(/@import/.test(css), false);
    assert.equal(/url\(\s*['"]?https?:/i.test(css), false);
  });

  test('nothing about the settings ever leaves the browser', () => {
    // No endpoint, no request: the settings are localStorage only.
    assert.equal(/\/api\/notify/.test(js), false);
    assert.equal(/notify/i.test(readSrc('src/server.js').replace(/notify-rules\.js/g, '')), false,
      'the server grew a notification concept beyond serving the rules file');
  });
});

/** Read a repo file relative to the package root. */
function readSrc(rel) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return fs.readFileSync(path.resolve(here, '..', rel), 'utf8');
}
