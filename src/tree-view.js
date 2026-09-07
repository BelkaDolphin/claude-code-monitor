/**
 * The I/O and caching layer behind the M3 tree view.
 *
 * Everything that touches disk lives here; src/tree-merge.js stays pure.
 *
 * Cost, measured on this machine (Node v24.13.0, Windows 11, warm cache):
 *
 *   34.2 MB session (main + 17 subagent transcripts)  buildTree  248 ms
 *                                                     buildToolLog 208 ms
 *   21.9 MB / 12 subagents                            buildTree  131 ms
 *    9.2 MB /  7 subagents                            buildTree   49 ms
 *   buildSessionIndex(days:0, withCwd:true), 70 sessions           91 ms
 *
 * Parsing is synchronous and blocks the event loop for as long as it runs. A
 * quarter of a second on the largest real session is well inside what an SSE
 * ping (15 s) and a browser fetch tolerate, so this stays simple: parse
 * synchronously, then cache hard.
 *
 * Two caches, both keyed on what the filesystem reports rather than on time:
 *
 *   the session index   TTL, because it is a directory walk and a live session
 *                       changes its mtime every few seconds anyway
 *   the parsed tree     fingerprint of (main jsonl size+mtime, every subagent
 *                       jsonl size+mtime, number of meta.json files). A live
 *                       session invalidates itself the moment a byte lands;
 *                       an old one never re-parses. LRU-8 because a parsed
 *                       tree of a 34 MB session is not small.
 *
 * The MERGE is re-run on every request even on a cache hit: the hook-derived
 * half of the answer (running/completed, currentTool) changes many times a
 * second and must never be served from a cache keyed on file mtimes.
 */

import { HooksIngest } from './hooks-ingest.js';
import { localDateKey } from './paths.js';
import { buildSessionIndex, listSubagents } from './session-index.js';
import { createState, isLive, isoTime, pruneSessions, reduceAll, sweepStale, toPublicSession } from './state.js';
import { buildTree } from './tree.js';
import { buildToolLog } from './tools-log.js';
import { mergeTree } from './tree-merge.js';

/** Session transcripts are named by UUID; verified over all 70 local sessions. */
export const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Every one of the 82 local `agent-<id>.jsonl` ids is exactly 17 lowercase hex. */
export const AGENT_ID_RE = /^[0-9a-f]{17}$/i;

export const DEFAULT_DAYS = 30;
export const MIN_DAYS = 1;
export const MAX_DAYS = 90;
export const DEFAULT_TOOL_LIMIT = 100;
export const MAX_TOOL_LIMIT = 500;
const INDEX_TTL_MS = 2000;
const HOOK_HISTORY_TTL_MS = 2000;
const MAX_CACHED_TREES = 8;

/**
 * Clamp a query parameter to a range, falling back for anything unparseable.
 * An absent or empty parameter is NOT zero: `Number(null)` and `Number('')`
 * are both 0, which would silently become `min`.
 */
export function clampInt(value, fallback, min, max) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.trunc(n);
  if (i < min) return min;
  if (i > max) return max;
  return i;
}

export function isSessionId(v) {
  return typeof v === 'string' && SESSION_ID_RE.test(v);
}

export function isAgentId(v) {
  return typeof v === 'string' && AGENT_ID_RE.test(v);
}

/**
 * Identity of a session's bytes on disk. Any append to any transcript, and any
 * new (or removed) meta.json, changes it.
 * @param {import('./session-index.js').SessionEntry} entry
 */
export function fingerprint(entry) {
  const parts = [`${entry.size}:${Math.round(entry.mtimeMs)}`];
  const subs = [...(entry.subagents || [])].sort((a, b) => a.agentId.localeCompare(b.agentId));
  let metas = 0;
  for (const s of subs) {
    parts.push(`${s.agentId}:${s.size}:${Math.round(s.mtimeMs)}`);
    if (s.metaPath) metas += 1;
  }
  parts.push(`m${metas}`);
  return parts.join('|');
}

/**
 * Everything the merge needs out of a parsed transcript, and nothing more.
 *
 * buildTree's `toolUseIndex` holds the full `input` of every tool_use - several
 * megabytes on a big session. It is squeezed down to the two facts the view
 * actually wants (when an agent was spawned, and with what prompt) before
 * anything is put in the cache.
 */
function extract(built, entry) {
  /** spawning tool_use id -> {at, prompt} */
  const spawns = new Map();
  /** agentId -> last tool_use timestamp seen in that agent's transcript */
  const lastToolAt = new Map();
  const wanted = new Set();
  for (const sub of entry.subagents || []) {
    if (sub && sub.toolUseId) wanted.add(sub.toolUseId);
  }
  for (const [id, use] of built.toolUseIndex || []) {
    const owner = use.ownerAgentId;
    if (owner && use.ts) {
      const prev = lastToolAt.get(owner);
      if (!prev || use.ts > prev) lastToolAt.set(owner, use.ts);
    }
    if (!wanted.has(id)) continue;
    const input = use.input && typeof use.input === 'object' ? use.input : null;
    spawns.set(id, {
      at: use.ts ?? null,
      prompt: input && typeof input.prompt === 'string' ? input.prompt : null,
    });
  }
  return { spawns, lastToolAt };
}

/**
 * Parsed-transcript cache. `get()` returns the jsonl half of the answer; the
 * hook half is merged in by the caller, fresh, every time.
 */
export class TreeCache {
  constructor({ max = MAX_CACHED_TREES } = {}) {
    this.max = max;
    /** sessionId -> {fingerprint, tree, spawns, lastToolAt, toolLog, parseMs} */
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get size() {
    return this.entries.size;
  }

  /** Move a key to the end (most recently used) and evict from the front. */
  touch(sessionId, value) {
    this.entries.delete(sessionId);
    this.entries.set(sessionId, value);
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      this.entries.delete(oldest);
    }
    return value;
  }

  /**
   * @param {import('./session-index.js').SessionEntry} entry
   * @returns {{tree: any, spawns: Map, lastToolAt: Map, parseMs: number, cached: boolean}}
   */
  parsed(entry) {
    const fp = fingerprint(entry);
    const hit = this.entries.get(entry.sessionId);
    if (hit && hit.fingerprint === fp) {
      this.hits += 1;
      this.touch(entry.sessionId, hit);
      return { ...hit, cached: true };
    }
    this.misses += 1;
    const t0 = Date.now();
    const tree = buildTree(entry);
    const parseMs = Date.now() - t0;
    const { spawns, lastToolAt } = extract(tree, entry);
    // The full tool_use inputs are the biggest thing in memory here and are of
    // no use once `spawns` has what it needs.
    tree.toolUseIndex = null;
    tree.toolResultIndex = null;
    const value = { fingerprint: fp, tree, spawns, lastToolAt, parseMs, toolLog: null };
    this.touch(entry.sessionId, value);
    return { ...value, cached: false };
  }

  /** The tool log for a session, built (and cached) only when asked for. */
  toolLog(entry) {
    this.parsed(entry); // make sure the slot exists and matches the bytes
    const slot = this.entries.get(entry.sessionId);
    if (slot && slot.toolLog) return { log: slot.toolLog, cached: true, buildMs: 0 };
    const t0 = Date.now();
    const log = buildToolLog(entry);
    const buildMs = Date.now() - t0;
    if (slot) slot.toolLog = log;
    return { log, cached: false, buildMs };
  }

  drop(sessionId) {
    return this.entries.delete(sessionId);
  }

  stats() {
    return { size: this.entries.size, max: this.max, hits: this.hits, misses: this.misses };
  }
}

/**
 * The session index, rebuilt at most once every INDEX_TTL_MS.
 * Always scans ALL history (days:0) so an old session stays reachable by id;
 * the day window is applied when the list is rendered.
 */
export class SessionIndexCache {
  constructor({ root, ttlMs = INDEX_TTL_MS, now = () => Date.now() } = {}) {
    this.root = root;
    this.ttlMs = ttlMs;
    this.now = now;
    this.value = null;
    this.builtAt = -Infinity;
    this.builds = 0;
  }

  get(force = false) {
    const t = this.now();
    if (!force && this.value && t - this.builtAt < this.ttlMs) return this.value;
    const index = buildSessionIndex({ days: 0, root: this.root, withCwd: true });
    this.value = {
      ...index,
      bySession: new Map(index.sessions.map((s) => [s.sessionId, s])),
      builtAt: t,
    };
    this.builtAt = t;
    this.builds += 1;
    return this.value;
  }

  entry(sessionId) {
    return this.get().bySession.get(sessionId) ?? null;
  }
}

/**
 * Hook state for sessions the collector does NOT track.
 *
 * The collector only follows sessions that are alive right now, so a tree
 * opened for last week's session would otherwise have no hook evidence at all
 * and every agent would read `async-unknown` - even the ones whose
 * `SubagentStop` is sitting in an event file (`cli.js tree` already folds the
 * whole history, and the two must not disagree).
 *
 * `HooksIngest.readAll()` is incremental (byte offsets per day file), so the
 * cost is one full pass at first use and a stat per file afterwards. Measured:
 * 5.3 MB across two day files, 999 events, 41 ms for the first pass.
 *
 * That first pass is only cheap while `events/` is small, and nothing used to
 * bound it: at the measured 7MB/day the first `/api/tree` request opened every
 * day file ever written (446 ms, +106 MB heap). So the caller says WHICH DAYS
 * it needs - the span of the session being opened, plus a day either side for
 * the local/UTC disagreement across midnight - and days it never asks for are
 * never opened. `datesRead` remembers what has been opened, so a day that is
 * new to this request is read even inside the TTL while a repeat request
 * inside the TTL still costs nothing. With no span the fallback window is
 * HOOK_HISTORY_FALLBACK_DAYS.
 *
 * Memory is bounded the same way the collector bounds it: `pruneSessions`
 * keeps at most MAX_ARCHIVED_SESSIONS finished sessions. A session that falls
 * off simply loses its hook layer and is served from the transcript alone.
 */
export class HookHistory {
  constructor({ dir, ttlMs = HOOK_HISTORY_TTL_MS, now = () => Date.now() } = {}) {
    this.ingest = new HooksIngest(dir ? { dir } : {});
    this.state = createState();
    this.ttlMs = ttlMs;
    this.now = now;
    this.builtAt = -Infinity;
    this.refreshes = 0;
    this.eventsRead = 0;
    this.readErrors = 0;
    /** Day keys this instance has opened at least once. */
    this.datesRead = new Set();
  }

  /**
   * @param {{dates?: string[]|null, force?: boolean}|boolean} [opts]
   *   a bare boolean is still accepted for the old `refresh(force)` shape.
   */
  refresh(opts = {}) {
    const o = typeof opts === 'boolean' ? { force: opts } : (opts || {});
    const force = o.force === true;
    const asked = Array.isArray(o.dates) ? o.dates : datesForSpan(null, this.now());
    const t = this.now();
    // Inside the TTL the bytes we already have count as fresh - but a day file
    // we have never opened has no bytes at all, so that one is read anyway.
    const targets = new Set();
    const fresh = !force && t - this.builtAt < this.ttlMs;
    for (const d of asked) if (!fresh || !this.datesRead.has(d)) targets.add(d);
    if (!fresh) for (const d of this.datesRead) targets.add(d);
    if (!targets.size) return this.state;

    if (!fresh) this.builtAt = t;
    this.refreshes += 1;
    let events = [];
    const dates = [...targets].sort();
    try {
      events = this.ingest.readAll({ dates });
    } catch {
      this.readErrors += 1;
      return this.state;
    }
    for (const d of dates) this.datesRead.add(d);
    this.eventsRead += events.length;
    if (events.length) this.state = reduceAll(this.state, events).state;
    // Without the sweep a ghost agent (no SubagentStop, ever) would read
    // `running` for the rest of the process's life.
    this.state = sweepStale(this.state, { now: t }).state;
    this.state = pruneSessions(this.state).state;
    return this.state;
  }

  /**
   * @param {string} sessionId
   * @param {{from?: number|string|null, to?: number|string|null}|null} [span]
   *   when the session ran, so only the day files that could hold its events
   *   are opened. Omitted or unusable falls back to the last few days.
   * @returns {any|null} the wire shape of one session, hooks only.
   */
  session(sessionId, span = null) {
    const s = this.refresh({ dates: datesForSpan(span, this.now()) }).sessions[sessionId];
    return s ? toPublicSession(s) : null;
  }

  stats() {
    return {
      refreshes: this.refreshes,
      eventsRead: this.eventsRead,
      readErrors: this.readErrors,
      datesRead: this.datesRead.size,
      sessions: Object.keys(this.state.sessions).length,
    };
  }
}

/** Days read when the caller cannot say when the session ran. */
export const HOOK_HISTORY_FALLBACK_DAYS = 7;

/**
 * Ceiling on how many day files one request may open, so a session with a
 * nonsense span (a bad clock, a transcript resumed from months ago) cannot
 * turn back into the unbounded read this replaced. The NEWEST days are kept.
 */
export const HOOK_HISTORY_MAX_DAYS = 45;

/**
 * The day keys that could hold a session's events: its span widened by a day
 * at each end. The widening is not cosmetic - the hook writes `receivedAt` and
 * files by LOCAL date while transcript timestamps are UTC, so the two disagree
 * about which file an event near midnight lives in.
 *
 * @param {{from?: number|string|null, to?: number|string|null}|null} span
 * @param {number|Date} [now]
 * @returns {string[]} ascending date keys
 */
export function datesForSpan(span, now = Date.now()) {
  const DAY = 24 * 3600 * 1000;
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  const end = Number.isFinite(nowMs) ? nowMs : Date.now();
  const from = msOf(span && span.from);
  const to = msOf(span && span.to);
  let lo;
  let hi;
  if (from === null && to === null) {
    hi = end;
    lo = end - (HOOK_HISTORY_FALLBACK_DAYS - 1) * DAY;
  } else {
    lo = (from ?? to) - DAY;
    hi = (to ?? from) + DAY;
  }
  // Nothing can have been written after now, and a `to` in the future (clock
  // skew) must not make us walk forward.
  if (hi > end) hi = end;
  if (lo > hi) lo = hi;
  /** @type {string[]} */
  const out = [];
  for (let t = lo; t <= hi; t += DAY) {
    const k = localDateKey(new Date(t));
    if (k && out[out.length - 1] !== k) out.push(k);
    if (out.length >= HOOK_HISTORY_MAX_DAYS * 2) break;
  }
  const endKey = localDateKey(new Date(hi));
  if (endKey && out[out.length - 1] !== endKey) out.push(endKey);
  return out.length > HOOK_HISTORY_MAX_DAYS ? out.slice(-HOOK_HISTORY_MAX_DAYS) : out;
}

/** ISO string or epoch ms -> epoch ms, else null. */
function msOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  return tsOf(v);
}

function tsOf(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/**
 * When a session began, and how we know.
 *
 *   hooks       a `SessionStart` event we saw ourselves
 *   sessions    the `startedAt` in ~/.claude/sessions/<pid>.json, written by
 *               Claude Code before our hooks exist
 *   transcript  the first record in the jsonl - the earliest thing on disk, but
 *               the transcript is only opened once the session has something to
 *               write, so it runs late
 *
 * state.js already applies "first source wins" between the two live sources, so
 * `startedAtSource` on the snapshot is the honest label for whichever it kept.
 *
 * @param {any} entry a SessionEntry, or null for a session with no transcript
 * @param {any} s     the hook snapshot for the session, or null
 */
export function resolveSessionStart(entry, s) {
  if (s && s.startedAtSource === 'hooks') {
    const h = isoTime(s.startedAt);
    if (h) return { startedAt: h, startedAtSource: 'hooks' };
  }
  const live = s ? isoTime(s.startedAt) : null;
  if (live) return { startedAt: live, startedAtSource: s.startedAtSource ?? 'sessions' };
  const first = entry && typeof entry.firstTs === 'string' && entry.firstTs ? entry.firstTs : null;
  if (first) return { startedAt: first, startedAtSource: 'transcript' };
  return { startedAt: null, startedAtSource: null };
}

/**
 * When a session ended, and how we know.
 *
 * A LIVE session has no end time at all. The last record it wrote is not an
 * ending and neither is its mtime - showing either as 終了 would put a finish
 * time on a session that is still typing.
 *
 *   hooks       a `SessionEnd` event: the only source that actually says "over"
 *   transcript  the last record in the jsonl (session-index.readLastTimestamp)
 *   mtime       the file's own timestamp - the time of the last WRITE, not of
 *               the last record, so it is the fallback of last resort
 *
 * @param {any} entry
 * @param {any} s
 * @param {boolean} live
 */
export function resolveSessionEnd(entry, s, live) {
  if (live) return { endedAt: null, endedAtSource: null };
  if (s && s.endedAtSource === 'hooks') {
    const h = isoTime(s.endedAt);
    if (h) return { endedAt: h, endedAtSource: 'hooks' };
  }
  const last = entry && typeof entry.lastTs === 'string' && entry.lastTs ? entry.lastTs : null;
  if (last) return { endedAt: last, endedAtSource: 'transcript' };
  const m = entry && Number.isFinite(entry.mtimeMs) ? isoTime(entry.mtimeMs) : null;
  if (m) return { endedAt: m, endedAtSource: 'mtime' };
  return { endedAt: null, endedAtSource: null };
}

/**
 * Reconcile a resolved start/end pair, last, after both have been chosen.
 *
 * An end BEFORE its start is not hypothetical - it was measured on
 * e2a7ec22-c605-478e-ba4f-3fce7dc2e9d0, whose start and end differed by -1ms.
 * The min/max scans in session-index remove the ordinary cause, but two more
 * remain and neither can be fixed there:
 *
 *   - the start comes from the HEAD window and the end from the TAIL window.
 *     They are different windows over the same file, so a timestamp outside one
 *     of them can still invert the pair.
 *   - the two can come from different sources entirely. A hooks SessionStart
 *     fired by a RESUME is legitimately later than anything in the transcript.
 *
 * So the end is clamped up to the start rather than dropped: both times are
 * real, their sources are still the honest answer to "where did this come from",
 * and the duration is 0 - which reads as "no measurable span", where a null
 * would read as "we could not work it out" and a negative as a bug on display.
 *
 * @returns {{endedAt: string|null, durationMs: number|null}}
 */
export function clampSpan(startedAt, endedAt) {
  if (!endedAt) return { endedAt: null, durationMs: null };
  const a = tsOf(startedAt);
  const b = tsOf(endedAt);
  if (a === null || b === null) return { endedAt, durationMs: null };
  if (b < a) return { endedAt: startedAt, durationMs: 0 };
  return { endedAt, durationMs: b - a };
}

/**
 * The left-hand session list: everything on disk inside the window, with the
 * live sessions the collector knows about hoisted to the top.
 *
 * A live session that has no transcript on disk yet (a brand new one) still
 * appears - it is the one the user is most likely looking for.
 *
 * @param {{index: any, snapshot: any, days: number}} args
 */
export function listSessionsView({ index, snapshot, days = DEFAULT_DAYS }) {
  const cutoff = days > 0 ? Date.now() - days * 24 * 60 * 60 * 1000 : -Infinity;
  const live = new Map();
  for (const s of (snapshot && snapshot.sessions) || []) {
    if (s && s.sessionId) live.set(s.sessionId, s);
  }

  const rows = [];
  const seen = new Set();
  for (const entry of (index && index.sessions) || []) {
    const s = live.get(entry.sessionId) ?? null;
    // state.isLive, so this list, the header count and the card ordering can
    // never disagree. A record we only know from its statusline sidecar is NOT
    // live, and therefore gets a real endedAt from the transcript below rather
    // than the 稼働中 placeholder.
    const rowLive = isLive(s);
    // A tracked session is never hidden by the day window: the user is looking
    // at it right now.
    if (entry.mtimeMs < cutoff && !rowLive) continue;
    seen.add(entry.sessionId);
    const start = resolveSessionStart(entry, s);
    const end = resolveSessionEnd(entry, s, rowLive);
    const span = clampSpan(start.startedAt, end.endedAt);
    rows.push({
      sessionId: entry.sessionId,
      projectPath: entry.projectPath,
      projectDirName: entry.projectDirName,
      cwd: entry.cwd ?? (s ? s.cwd : null),
      title: (s && s.title) || basename(entry.cwd) || entry.projectDirName || entry.sessionId.slice(0, 8),
      // `new Date(NaN).toISOString()` THROWS, and this runs inside the request
      // handler for every session on disk: one unstattable file must not take
      // the whole list down.
      modified: isoTime(entry.mtimeMs),
      modifiedMs: entry.mtimeMs,
      startedAt: start.startedAt,
      startedAtSource: start.startedAtSource,
      // The source survives the clamp: where the value came from is still true
      // even when the value had to be nudged.
      endedAt: span.endedAt,
      endedAtSource: end.endedAtSource,
      durationMs: span.durationMs,
      subagentCount: (entry.subagents || []).length,
      live: rowLive,
      phase: s ? s.phase : null,
      phaseSource: s ? s.phaseSource : null,
      sizeBytes: entry.size,
      hasTranscript: true,
    });
  }

  for (const [sessionId, s] of live) {
    if (seen.has(sessionId)) continue;
    if (!isLive(s)) continue;
    // Live by construction, so `endedAt` is null here whatever hooks recorded.
    const start = resolveSessionStart(null, s);
    const end = resolveSessionEnd(null, s, true);
    rows.push({
      sessionId,
      projectPath: null,
      projectDirName: s.projectDirName ?? null,
      cwd: s.cwd ?? null,
      title: s.title || sessionId.slice(0, 8),
      modified: s.lastEventAt ?? null,
      modifiedMs: tsOf(s.lastEventAt) ?? 0,
      startedAt: start.startedAt,
      startedAtSource: start.startedAtSource,
      endedAt: end.endedAt,
      endedAtSource: end.endedAtSource,
      durationMs: null,
      subagentCount: (s.agents || []).length,
      live: true,
      phase: s.phase,
      phaseSource: s.phaseSource,
      sizeBytes: 0,
      hasTranscript: false,
    });
  }

  rows.sort((a, b) => {
    if (a.live !== b.live) return a.live ? -1 : 1;
    return b.modifiedMs - a.modifiedMs;
  });
  return rows;
}

function basename(p) {
  if (typeof p !== 'string' || !p) return null;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Build one session's merged tree.
 * @param {Object} args
 * @param {import('./session-index.js').SessionEntry} args.entry
 * @param {TreeCache} args.cache
 * @param {any} [args.hookSession]  state.toPublicSession() record or null
 */
export function buildTreeView({ entry, cache, hookSession = null }) {
  const parsed = cache.parsed(entry);
  // ALWAYS re-read the metas instead of using the index's copy. The index is
  // cached for INDEX_TTL_MS and a meta.json is written a moment AFTER the
  // agent's jsonl appears, so the cached copy is exactly the one that is most
  // likely to be missing a name we could have shown. Reading it back is a
  // readdir plus one small JSON per agent - cheap next to the parse we just
  // did, and it also drops agents whose files vanished under us (5-13).
  const metas = entry.projectPath
    ? listSubagents(entry.projectPath, entry.sessionId)
    : (entry.subagents || []);

  const merged = mergeTree({
    tree: parsed.tree,
    metas,
    hookAgents: hookSession ? hookSession.agents || [] : [],
    hookSession,
    spawns: parsed.spawns,
    lastToolAt: parsed.lastToolAt,
    aiTitle: parsed.tree.root ? parsed.tree.root.aiTitle : null,
    cwd: entry.cwd,
    projectPath: entry.projectPath,
    transcriptPath: entry.jsonlPath,
    sizeBytes: entry.size,
  });

  return {
    ok: true,
    sessionId: entry.sessionId,
    generatedAt: new Date().toISOString(),
    serverNow: Date.now(),
    root: merged.root,
    orphans: merged.orphans,
    agentCount: merged.agentCount,
    hooksOnly: merged.hooksOnly,
    parse: {
      cached: parsed.cached,
      parseMs: parsed.parseMs,
      files: 1 + (entry.subagents || []).length,
      bytes: entry.size + (entry.subagents || []).reduce((n, s) => n + (s.size || 0), 0),
      failures: parsed.tree.stats ? parsed.tree.stats.parseFailures : 0,
    },
  };
}

/**
 * Tail of the tool log for a session, optionally narrowed to one agent.
 * @param {{entry: any, cache: TreeCache, agentId?: string|null, limit?: number}} args
 */
export function toolLogView({ entry, cache, agentId = null, limit = DEFAULT_TOOL_LIMIT }) {
  const { log, cached, buildMs } = cache.toolLog(entry);
  const all = log.calls;
  const scoped = agentId === null
    ? all
    : agentId === 'main'
      ? all.filter((c) => c.agentId === null)
      : all.filter((c) => c.agentId === agentId);
  const tail = scoped.slice(-limit);
  return {
    ok: true,
    sessionId: entry.sessionId,
    agentId,
    total: scoped.length,
    totalAllAgents: all.length,
    limit,
    cached,
    buildMs,
    calls: tail,
  };
}
