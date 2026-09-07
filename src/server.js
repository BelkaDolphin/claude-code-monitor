/**
 * The local monitor server.
 *
 * Binds 127.0.0.1 ONLY. Never 0.0.0.0, never a LAN address: the dashboard shows
 * working directories, session names, cost and quota, and there is no user
 * model to scope any of it.
 *
 * Routes:
 *   GET /?t=<token>   one-shot bootstrap: sets the cookie, redirects to /
 *   GET /             the dashboard (cookie required)
 *   GET /app.js       (cookie required)
 *   GET /notify-rules.js  (cookie required)
 *   GET /style.css    (cookie required)
 *   GET /api/state    snapshot JSON
 *   GET /api/stream   SSE: `snapshot` on connect and on every change
 *   GET /api/health   {ok, uptime, collectorStats}
 *   GET /api/sessions?days=N          session list for the tree view (M3)
 *   GET /api/tree/<sessionId>         one merged subagent tree (M3)
 *   GET /api/tools/<sessionId>?agent=&limit=  tool log tail (M3)
 *   GET /api/usage?days=N             daily / model / session token usage (M4)
 *   GET /api/usage/ccusage?days=N     the same window compared against ccusage (M4)
 *   everything else   404
 *
 * A malformed or unknown id on the M3 routes answers 404, never 400: a 400
 * would confirm "that shape is a real id, this one just does not exist" to
 * anything that got past the cookie. One shape of answer, no oracle.
 *
 * Static files are served from an explicit three-entry allow-list, and the
 * resolved path is checked to sit inside public/ anyway. Two independent
 * defences, because a traversal here reads the user's home directory.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { Auth, securityHeaders } from './auth.js';
import { SseHub } from './sse.js';
import { Collector } from './collector.js';
import {
  TreeCache,
  SessionIndexCache,
  HookHistory,
  buildTreeView,
  toolLogView,
  listSessionsView,
  clampInt,
  isSessionId,
  isAgentId,
  DEFAULT_DAYS,
  MIN_DAYS,
  MAX_DAYS,
  DEFAULT_TOOL_LIMIT,
  MAX_TOOL_LIMIT,
} from './tree-view.js';
import {
  UsageFileCache,
  UsageStore,
  CcusageCache,
  buildUsageView,
  buildCcusageComparison,
} from './usage-view.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PUBLIC_DIR = path.resolve(HERE, '..', 'public');
export const DEFAULT_PORT = 47321;
export const HOST = '127.0.0.1';

/** The only files we will ever hand out, and their content types. */
const STATIC_FILES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  // Loaded before app.js: the pure notification rules (see architecture 9).
  ['/notify-rules.js', { file: 'notify-rules.js', type: 'text/javascript; charset=utf-8' }],
  ['/style.css', { file: 'style.css', type: 'text/css; charset=utf-8' }],
]);

/** Resolve the configured port: explicit > env > default. */
export function resolvePort(explicit, env = process.env) {
  const candidates = [explicit, env.CLAUDE_MONITOR_PORT];
  for (const c of candidates) {
    if (c === undefined || c === null || c === '' || c === true) continue;
    const n = Number(c);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  return DEFAULT_PORT;
}

/**
 * Normalize a request target to a route key.
 * Returns null when the path escapes, is not a plain path, or is not one of
 * the files we publish.
 * @param {string} rawUrl
 * @returns {string|null}
 */
export function routeKey(rawUrl) {
  let pathname = String(rawUrl || '');
  const q = pathname.indexOf('?');
  if (q >= 0) pathname = pathname.slice(0, q);
  const h = pathname.indexOf('#');
  if (h >= 0) pathname = pathname.slice(0, h);
  if (!pathname.startsWith('/')) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  // Backslashes are path separators on Windows; refuse them outright.
  if (decoded.includes('\\') || decoded.includes('\0')) return null;
  // Any '..' segment is a traversal attempt, before OR after normalisation.
  // We do not "helpfully" resolve it - a legitimate request never has one.
  if (decoded.split('/').includes('..')) return null;
  const normalized = path.posix.normalize(decoded);
  if (normalized.split('/').includes('..')) return null;
  return normalized;
}

/** Read one allow-listed static file, verifying it stays inside publicDir. */
function readStatic(publicDir, entry) {
  const target = path.resolve(publicDir, entry.file);
  const root = path.resolve(publicDir);
  if (target !== root && !target.startsWith(root + path.sep)) return null;
  try {
    return fs.readFileSync(target);
  } catch {
    return null;
  }
}

/**
 * Send a body, or - for HEAD - only the headers that body would have had.
 * RFC 9110: a HEAD response carries the same header fields as GET (including
 * Content-Length) but no content.
 */
function send(req, res, status, buf, contentType, extraHeaders = {}) {
  res.writeHead(status, {
    ...securityHeaders(),
    ...extraHeaders,
    'Content-Type': contentType,
    'Content-Length': buf.length,
  });
  if (req && req.method === 'HEAD') res.end();
  else res.end(buf);
}

function sendText(req, res, status, body, extraHeaders = {}) {
  send(req, res, status, Buffer.from(body, 'utf8'), 'text/plain; charset=utf-8', extraHeaders);
}

function sendJson(req, res, status, obj, extraHeaders = {}) {
  send(req, res, status, Buffer.from(JSON.stringify(obj), 'utf8'), 'application/json; charset=utf-8', extraHeaders);
}

/**
 * Socket-level errors (ECONNRESET when a tab closes, EPIPE when curl is
 * ^C'd) are routine, not faults of ours. They are recorded for visibility but
 * deliberately kept out of the collector's ingest error counter, which the UI
 * shows as "something is wrong with the data".
 * @param {{recordError?: Function}} collector
 */
/**
 * When a session ran, from its index entry, so the hook history only opens the
 * day files that could hold its events.
 *
 * `firstTs`/`lastTs` are the transcript's own timestamps and are the honest
 * answer; `mtimeMs` is the fallback for an entry built without them
 * (`withCwd:false`) and for a transcript whose records carry no timestamp.
 * Returning null means "no idea", and the fallback window applies.
 * @param {any} entry
 * @returns {{from: number, to: number}|null}
 */
function spanOfEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const mtime = Number.isFinite(entry.mtimeMs) && entry.mtimeMs > 0 ? entry.mtimeMs : null;
  const parse = (v) => {
    const t = typeof v === 'string' && v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : null;
  };
  const from = parse(entry.firstTs) ?? mtime;
  const to = parse(entry.lastTs) ?? mtime;
  if (from === null && to === null) return null;
  return { from: from ?? to, to: to ?? from };
}

function defaultOnError(collector) {
  return (where, err) => {
    if (collector && typeof collector.recordError === 'function') {
      collector.recordError(`http:${where}`, err);
    }
  };
}

/**
 * Create the server (not yet listening).
 * @param {{collector: Collector, auth: Auth, publicDir?: string, sse?: SseHub,
 *          startedAt?: number, onError?: (where: string, err: any) => void}} deps
 */
export function createRequestHandler(deps) {
  const { collector, auth } = deps;
  const publicDir = deps.publicDir ?? PUBLIC_DIR;
  const sse = deps.sse ?? new SseHub();
  const startedAt = deps.startedAt ?? Date.now();
  const onError = typeof deps.onError === 'function' ? deps.onError : defaultOnError(collector);
  // The tree view reads ~/.claude/projects directly rather than through the
  // collector: the collector's index is built with withCwd:false and only
  // covers 30 days, and the tree needs both.
  const projectsRoot = deps.projectsRoot ?? (collector && collector.projectsRoot) ?? undefined;
  const treeCache = deps.treeCache ?? new TreeCache();
  const indexCache = deps.indexCache ?? new SessionIndexCache({ root: projectsRoot });
  // Hook evidence for sessions the collector is not following (it only follows
  // live ones). Without it, every agent of an old session would read
  // `async-unknown` while `cli.js tree` reported `completed` for the same id.
  const hookHistory = deps.hookHistory
    ?? new HookHistory({ dir: collector && collector.eventsDir });
  // M4. The store is the ONLY thing the dashboard writes on a GET: it is our
  // own copy of the daily figures, kept because Claude Code deletes its
  // transcripts after ~30 days (known constraint 7).
  const statuslineDir = deps.statuslineDir ?? (collector && collector.statuslineDir) ?? undefined;
  const usageCache = deps.usageCache ?? new UsageFileCache();
  const usageStore = deps.usageStore
    ?? new UsageStore({ dir: deps.monitorDir, onError: (where, err) => onError(where, err) });
  const ccusageCache = deps.ccusageCache
    ?? new CcusageCache(deps.ccusageRunner ? { runner: deps.ccusageRunner } : {});

  const handler = (req, res) => {
    // A client that walks away mid-response makes the socket emit 'error'.
    // With no listener that is an uncaught exception and the process dies -
    // a monitoring tool must not be killable by closing a browser tab.
    req.on('error', (err) => onError('request', err));
    res.on('error', (err) => onError('response', err));

    // The dashboard is read-only; nothing here should ever accept a body.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendText(req, res, 405, 'method not allowed\n', { Allow: 'GET, HEAD' });
      return;
    }
    const route = routeKey(req.url);
    if (route === null) {
      sendText(req, res, 404, 'not found\n');
      return;
    }

    // Bootstrap: /?t=<token> exchanges the URL token for a cookie so the token
    // stops travelling in URLs (and out of Referer, history and shoulder view).
    if (route === '/' || route === '/index.html') {
      const qt = Auth.queryToken(req.url);
      if (qt !== null) {
        // The token exchange is the one request that needs no cookie, so it is
        // the one place a rebound host could mint itself a valid one. Origin
        // rules apply here first, exactly as they do everywhere else.
        const origin = auth.checkOrigin(req);
        if (!origin.ok || !auth.isToken(qt)) {
          sendText(req, res, 403, 'forbidden\n');
          return;
        }
        res.writeHead(302, {
          ...securityHeaders(),
          'Set-Cookie': auth.setCookieHeader(),
          Location: '/',
          'Content-Length': 0,
        });
        res.end();
        return;
      }
    }

    if (route.startsWith('/api/')) {
      const ok = auth.authorize(req);
      if (!ok.ok) {
        sendText(req, res, 403, 'forbidden\n');
        return;
      }
      return handleApi(route, req, res);
    }

    const entry = STATIC_FILES.get(route);
    if (!entry) {
      sendText(req, res, 404, 'not found\n');
      return;
    }
    // Static files carry the UI, so they need the same proof as the API: a
    // valid cookie and a request that came from our own origin.
    const allowed = auth.authorize(req);
    if (!allowed.ok) {
      sendText(req, res, 403, 'forbidden\n');
      return;
    }
    const body = readStatic(publicDir, entry);
    if (!body) {
      sendText(req, res, 404, 'not found\n');
      return;
    }
    send(req, res, 200, body, entry.type);
  };

  /** Query string of a request, with the fragment (if any) removed. */
  function queryOf(rawUrl) {
    const raw = String(rawUrl || '');
    const q = raw.indexOf('?');
    if (q < 0) return new URLSearchParams();
    let tail = raw.slice(q + 1);
    const h = tail.indexOf('#');
    if (h >= 0) tail = tail.slice(0, h);
    try {
      return new URLSearchParams(tail);
    } catch {
      return new URLSearchParams();
    }
  }

  /**
   * The hook-derived view of one session: the collector's own record when it is
   * following that session (it also carries statusline and PID facts), else the
   * event history folded on demand.
   */
  function hookSessionOf(sessionId, entry) {
    const snap = collector.snapshot();
    for (const s of snap.sessions || []) {
      if (s.sessionId === sessionId) return s;
    }
    try {
      // The index entry is what tells HookHistory which day files to open.
      // Without it the fallback window is a few days, which is right for a
      // live session and wrong for one from last month.
      return hookHistory.session(sessionId, spanOfEntry(entry));
    } catch (err) {
      onError('hook-history', err);
      return null;
    }
  }

  /**
   * Parsing a 35MB transcript can fail in ways we have not met yet. A monitor
   * must answer, not die (architecture 4.7), so every M3 route runs inside
   * this: one JSON 500, one recorded error, the listener still up.
   */
  function guard(where, req, res, fn) {
    try {
      fn();
    } catch (err) {
      onError(where, err);
      try {
        sendJson(req, res, 500, { ok: false, error: 'internal error' });
      } catch { /* the socket is already gone */ }
    }
  }

  /**
   * `guard` for a handler that returns a promise. `guard` alone would let a
   * rejection escape into `unhandledRejection`, which installCrashHandlers
   * treats as fatal - a failed `npx ccusage` must never take the server down.
   */
  function guardAsync(where, req, res, fn) {
    Promise.resolve()
      .then(fn)
      .catch((err) => {
        onError(where, err);
        try {
          sendJson(req, res, 500, { ok: false, error: 'internal error' });
        } catch { /* the socket is already gone */ }
      });
  }

  function notFoundJson(req, res) {
    sendJson(req, res, 404, { ok: false, error: 'not found' });
  }

  /** GET /api/sessions?days=N - the tree view's left-hand list. */
  function handleSessions(req, res) {
    const days = clampInt(queryOf(req.url).get('days'), DEFAULT_DAYS, MIN_DAYS, MAX_DAYS);
    const index = indexCache.get();
    const sessions = listSessionsView({ index, snapshot: collector.snapshot(), days });
    sendJson(req, res, 200, {
      ok: true,
      days,
      generatedAt: new Date().toISOString(),
      serverNow: Date.now(),
      count: sessions.length,
      scannedProjects: index.scannedProjects,
      sessions,
    });
  }

  /** GET /api/tree/<sessionId> */
  function handleTree(req, res, sessionId) {
    if (!isSessionId(sessionId)) return notFoundJson(req, res);
    const entry = indexCache.entry(sessionId);
    if (!entry) return notFoundJson(req, res);
    sendJson(req, res, 200, buildTreeView({
      entry,
      cache: treeCache,
      hookSession: hookSessionOf(sessionId, entry),
    }));
  }

  /** GET /api/tools/<sessionId>?agent=<agentId>&limit=N */
  function handleTools(req, res, sessionId) {
    if (!isSessionId(sessionId)) return notFoundJson(req, res);
    const entry = indexCache.entry(sessionId);
    if (!entry) return notFoundJson(req, res);
    const q = queryOf(req.url);
    const rawAgent = q.get('agent');
    let agentId = null;
    if (rawAgent !== null && rawAgent !== '') {
      if (rawAgent !== 'main' && !isAgentId(rawAgent)) return notFoundJson(req, res);
      agentId = rawAgent;
    }
    const limit = clampInt(q.get('limit'), DEFAULT_TOOL_LIMIT, 1, MAX_TOOL_LIMIT);
    sendJson(req, res, 200, toolLogView({ entry, cache: treeCache, agentId, limit }));
  }

  /** The Usage view's window, shared by both M4 routes. */
  function usageDaysOf(req) {
    return clampInt(queryOf(req.url).get('days'), DEFAULT_DAYS, MIN_DAYS, MAX_DAYS);
  }

  function usageViewFor(days) {
    return buildUsageView({
      days,
      projectsRoot,
      statuslineDir,
      cache: usageCache,
      store: usageStore,
      onError,
    });
  }

  /** GET /api/usage?days=N */
  function handleUsage(req, res) {
    sendJson(req, res, 200, usageViewFor(usageDaysOf(req)));
  }

  /**
   * GET /api/usage/ccusage?days=N - runs `npx --no ccusage@<pinned>` and diffs
   * it against us. Never on the dashboard's own path: only when the user asks
   * (constraint 8), and never a download - if ccusage is not installed the body
   * carries `notInstalled: true` plus the `ccusageVersion` the footnote tells
   * the user to install.
   */
  async function handleUsageCcusage(req, res) {
    const days = usageDaysOf(req);
    const view = usageViewFor(days);
    const cmp = await buildCcusageComparison({ view, cache: ccusageCache, onError });
    // `windowDays`, not `days`: /api/usage spends `days` on the ARRAY of day
    // rows, and one name may not mean two things across two routes.
    sendJson(req, res, 200, { ...cmp, windowDays: days, since: view.since, until: view.until });
  }

  function handleApi(route, req, res) {
    if (route.startsWith('/api/usage/')) {
      if (route === '/api/usage/ccusage') {
        return guardAsync('api:usage-ccusage', req, res, () => handleUsageCcusage(req, res));
      }
      // Same one-shape answer as the M3 routes: no oracle for what exists.
      return notFoundJson(req, res);
    }
    if (route.startsWith('/api/tree/')) {
      return guard('api:tree', req, res, () => handleTree(req, res, route.slice('/api/tree/'.length)));
    }
    if (route.startsWith('/api/tools/')) {
      return guard('api:tools', req, res, () => handleTools(req, res, route.slice('/api/tools/'.length)));
    }
    switch (route) {
      case '/api/sessions':
        return guard('api:sessions', req, res, () => handleSessions(req, res));

      case '/api/usage':
        return guard('api:usage', req, res, () => handleUsage(req, res));

      // The three original M2 routes ran outside `guard`, on the assumption
      // that building a snapshot cannot fail. It can: `JSON.stringify` throws
      // on a circular value or a BigInt that a future field brings in, and the
      // snapshot is assembled from four on-disk sources. Unguarded that is an
      // uncaught exception in an http callback - the whole monitor gone
      // because somebody refreshed the dashboard (architecture 4.7).
      case '/api/state':
        return guard('api:state', req, res, () => sendJson(req, res, 200, collector.snapshot()));

      case '/api/health':
        return guard('api:health', req, res, () => sendJson(req, res, 200, {
          ok: true,
          uptime: Math.round((Date.now() - startedAt) / 1000),
          uptimeMs: Date.now() - startedAt,
          clients: sse.size,
          collectorStats: collector.stats(),
          treeCache: treeCache.stats(),
          hookHistory: hookHistory.stats(),
          usageCache: usageCache.stats(),
          ccusage: ccusageCache.stats(),
        }));

      case '/api/stream':
        return guard('api:stream', req, res, () => {
          // A stream has no meaningful "headers only" form: HEAD would open a
          // subscription nobody reads and hold one of the 8 slots.
          if (req.method === 'HEAD') {
            sendText(req, res, 405, 'method not allowed\n', { Allow: 'GET' });
            return;
          }
          const added = sse.add(req, res, securityHeaders());
          if (!added.ok) {
            sendText(req, res, 503, `stream unavailable: ${added.reason}\n`);
            return;
          }
          sse.send(added.client, 'snapshot', collector.snapshot());
        });

      default:
        sendText(req, res, 404, 'not found\n');
    }
  }

  return { handler, sse };
}

/**
 * Start everything: collector, SSE hub, HTTP server.
 * @param {Object} [opts]
 * @param {number} [opts.port]
 * @param {string} [opts.token]
 * @param {Collector} [opts.collector]
 * @param {Object} [opts.collectorOptions]
 * @param {string} [opts.publicDir]
 * @param {boolean} [opts.open]
 * @param {string} [opts.projectsRoot]   override ~/.claude/projects (tests)
 * @param {any} [opts.treeCache]         inject a TreeCache (tests)
 * @param {any} [opts.indexCache]        inject a SessionIndexCache (tests)
 * @param {any} [opts.hookHistory]       inject a HookHistory (tests)
 * @param {string} [opts.monitorDir]     override ~/.claude-monitor (usage store)
 * @param {string} [opts.statuslineDir]  override <monitorDir>/statusline
 * @param {any} [opts.usageCache]        inject a UsageFileCache (tests)
 * @param {any} [opts.usageStore]        inject a UsageStore (tests)
 * @param {any} [opts.ccusageCache]      inject a CcusageCache (tests)
 * @param {(o: any) => Promise<any>} [opts.ccusageRunner] inject the ccusage runner (tests)
 * @param {(where: string, err: any) => void} [opts.onError]
 */
export async function startServer(opts = {}) {
  const port = resolvePort(opts.port);
  const collector = opts.collector ?? new Collector(opts.collectorOptions ?? {});
  const auth = new Auth({ port, token: opts.token });
  const startedAt = Date.now();
  const sse = new SseHub({ maxClients: opts.maxClients });
  const { handler } = createRequestHandler({
    collector,
    auth,
    publicDir: opts.publicDir,
    sse,
    startedAt,
    projectsRoot: opts.projectsRoot,
    treeCache: opts.treeCache,
    indexCache: opts.indexCache,
    hookHistory: opts.hookHistory,
    monitorDir: opts.monitorDir,
    statuslineDir: opts.statuslineDir,
    usageCache: opts.usageCache,
    usageStore: opts.usageStore,
    ccusageCache: opts.ccusageCache,
    ccusageRunner: opts.ccusageRunner,
    onError: opts.onError,
  });

  const noteError = defaultOnError(collector);
  const server = http.createServer(handler);
  server.on('clientError', (err, socket) => {
    noteError('client', err);
    if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });
  // PERMANENT listener, attached before listen() and never removed. An 'error'
  // with no listener is rethrown by EventEmitter and takes the process down;
  // the listener can fire long after startup (EMFILE when the fd table fills,
  // ECONNABORTED on accept). The listen() promise below adds its own one-shot
  // listener to reject on a bind failure - this one only records.
  server.on('error', (err) => noteError('server', err));

  if (!opts.collector) await collector.start();
  const onChange = () => sse.broadcast('snapshot', collector.snapshot());
  collector.on('change', onChange);

  try {
    await new Promise((resolve, reject) => {
      const onError = (err) => reject(err);
      server.once('error', onError);
      server.listen(port, HOST, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
  } catch (err) {
    // Do not leave the collector's timers and watchers behind on a failed bind.
    collector.off('change', onChange);
    if (!opts.collector) collector.stop();
    if (err && err.code === 'EADDRINUSE') {
      const e = new Error(
        `port ${port} is already in use - another claude-monitor may be running. ` +
        'Use --port N or CLAUDE_MONITOR_PORT.',
      );
      e.code = 'EADDRINUSE';
      throw e;
    }
    throw err;
  }

  const actualPort = server.address().port;
  auth.setPort(actualPort);

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    collector.off('change', onChange);
    sse.closeAll();
    if (!opts.collector) collector.stop();
    await new Promise((resolve) => server.close(resolve));
  };

  const url = auth.entryUrl();
  if (opts.open) openBrowser(url);

  return {
    server,
    sse,
    collector,
    auth,
    port: actualPort,
    // Read through to auth rather than copied: a caller may hand the token over
    // only after the bind succeeded (see cli.js cmdServe, which must not touch
    // the token file until the port is really ours), and a stale copy here
    // would be a URL that opens nothing.
    get url() { return auth.entryUrl(); },
    get token() { return auth.token; },
    startedAt,
    close,
  };
}

/**
 * Open the default browser on Windows.
 * `start` is a cmd builtin, so cmd.exe must be launched explicitly; Node 20.12+
 * refuses to spawn a .cmd/.bat directly (EINVAL) and `shell: true` triggers
 * DEP0190. The empty "" is start's title argument - without it a quoted URL is
 * taken as the window title and nothing opens.
 */
export function openBrowser(url) {
  // Allow-list the characters that can reach a shell. Our URL is generated,
  // but this is the one string that crosses into cmd.exe, so verify it.
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/\?t=[0-9a-f]{64}$/.test(url)) return false;
  try {
    if (process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '""', `"${url}"`], {
        detached: true,
        stdio: 'ignore',
        windowsVerbatimArguments: true,
      });
      child.unref();
    } else {
      const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
      const child = spawn(cmd, [url], { detached: true, stdio: 'ignore' });
      child.unref();
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Wire SIGINT/SIGTERM to a graceful shutdown: drop every SSE client, stop the
 * collector's timers, close the listener, then exit.
 * @param {{close: () => Promise<void>}} handle
 */
export function installSignalHandlers(handle, { log = () => {} } = {}) {
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`\n${signal} received - shutting down`);
    handle
      .close()
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    // Never hang on a stuck socket.
    const t = setTimeout(() => process.exit(0), 3000);
    if (typeof t.unref === 'function') t.unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return shutdown;
}

/**
 * Last line of defence for the long-running `serve` process.
 *
 * A monitoring tool that dies silently is worse than one that never started:
 * the user keeps glancing at a stale tab believing everything is fine. So an
 * escaped exception must (1) say what happened on stderr, (2) be recorded in
 * the collector's error log like every other failure, (3) close the listener so
 * the port is freed, and (4) exit non-zero so a supervisor can restart us.
 *
 * We deliberately do NOT swallow and continue: past an uncaught throw the
 * process state is unknown, and a monitor reporting from unknown state is the
 * failure mode this is meant to prevent.
 *
 * @param {{close: () => Promise<void>, collector?: any}} handle
 */
export function installCrashHandlers(handle, { log = () => {}, exit = true } = {}) {
  let crashing = false;
  const crash = (kind, err) => {
    if (crashing) return;
    crashing = true;
    const detail = (err && err.stack) || String(err);
    if (handle && handle.collector && typeof handle.collector.recordError === 'function') {
      handle.collector.recordError(kind, err);
    }
    log(`\n${kind}: ${detail}`);
    log('claude-monitor is shutting down. Nothing was written outside its own data dir.');
    const done = () => {
      if (exit) process.exit(1);
    };
    Promise.resolve()
      .then(() => (handle && typeof handle.close === 'function' ? handle.close() : undefined))
      .then(done, done);
    // Never hang on a socket that will not close.
    const t = setTimeout(done, 3000);
    if (typeof t.unref === 'function') t.unref();
  };
  const onUncaught = (err) => crash('uncaughtException', err);
  const onUnhandled = (reason) => crash('unhandledRejection', reason);
  process.on('uncaughtException', onUncaught);
  process.on('unhandledRejection', onUnhandled);
  return {
    crash,
    dispose() {
      process.off('uncaughtException', onUncaught);
      process.off('unhandledRejection', onUnhandled);
    },
  };
}
