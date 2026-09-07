/**
 * The I/O and caching layer behind the M4 Usage view.
 *
 * Mirrors src/tree-view.js: everything that touches disk lives here, the
 * aggregation rules stay in src/usage.js.
 *
 * WHY THE CACHE HOLDS PER-FILE MESSAGE MAPS AND NOT PER-FILE TOTALS
 *
 * The dedupe rule (usage.js, architecture 3.1) is CROSS-FILE: the same
 * `message.id` is written into the parent transcript AND into the sidechain
 * copy, and the record with the latest timestamp wins. Caching a per-file
 * TOTAL and summing the totals would count such a message once per file - the
 * exact 4.5x overcount the dedupe exists to prevent - and no later correction
 * is possible because the totals no longer say which messages they contain.
 *
 * So the cached value per file is the small Map `message.id -> best record`
 * that the file alone produces. Merging those maps with the same
 * "latest timestamp wins, tie -> larger total" rule gives bit-for-bit the same
 * answer as parsing every file in one pass, no matter how many of the files
 * came from the cache.
 *
 * Cost, measured on this machine (Node v24.13.0, Windows 11) - see
 * docs/m4-verification.md for the full table:
 *
 *   cold, days=30 (100 transcripts, 112.6 MB, 27,532 lines)   670 ms
 *   cold, days=7  (31 of those 100 opened - see MTIME_MARGIN_MS)  204 ms
 *   warm (same files, every fingerprint unchanged)               16-19 ms
 *   the same over HTTP: 791 ms cold, 23-26 ms warm
 *
 * The fingerprint is `size:mtimeMs` per file, like TreeCache's: a transcript
 * that gained a byte re-parses, one that did not never does.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ccusageDaily, normalizeDailyRow } from './ccusage.js';
import { parseFile, ParseStats } from './parser.js';
import {
  localDateKey,
  monitorDir as defaultMonitorDir,
  projectsDir,
  readJsonUtf8,
  statuslineDir as defaultStatuslineDir,
  writeFileAtomic,
} from './paths.js';
import { readSidecars } from './statusline-sidecar.js';
import { DEFAULT_DAYS } from './tree-view.js';
import { METRICS, emptyTotals, usageTotal } from './usage.js';

/** Sessions returned by the view, biggest first. */
export const DEFAULT_SESSION_LIMIT = 20;
/** Persistence store schema. */
export const STORE_VERSION = 1;
/** The only text a failed ccusage run ever shows the browser. */
export const CCUSAGE_ERROR = 'ccusage unavailable';
export const CCUSAGE_TTL_MS = 10 * 60 * 1000;
export const CCUSAGE_TIMEOUT_MS = 60_000;
/** ccusage takes dates on its own argv; nothing but this shape is passed on. */
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A file whose last write predates the window cannot hold a record inside it:
 * records are appended, so every timestamp in a file is <= its mtime. The
 * margin absorbs clock skew and a transcript written just before midnight.
 */
const MTIME_MARGIN_MS = 2 * 24 * 60 * 60 * 1000;

/**
 * Model id -> display series, for the stacked daily bar and the model table.
 *
 * The browser-side twin of this table is `MODEL_LABEL` in public/app.js, and
 * the two must agree on the family names. It cannot be imported from there:
 * app.js is a browser IIFE with no exports, served as a static file. This copy
 * exists so the FRONTEND needs no second table - the API already hands out
 * series names.
 *
 * Table driven on purpose (same reasoning as app.js): an id we do not
 * recognise is bucketed as 'other' rather than guessed at by a clever rule.
 */
const MODEL_SERIES = {
  opus: 'Opus',
  sonnet: 'Sonnet',
  haiku: 'Haiku',
  fable: 'Fable',
  'claude-opus-5': 'Opus',
  'claude-sonnet-5': 'Sonnet',
  'claude-fable-5': 'Fable',
  'claude-haiku-4-5': 'Haiku',
  'claude-opus-4-5': 'Opus',
  'claude-sonnet-4-5': 'Sonnet',
  // Measured on this machine 2026-09-06, in the real transcripts, and absent
  // from the M3 table: 25.7M tokens of claude-fable-5-1 and 2.1M of
  // claude-opus-4-7 were landing in 'other'. `<synthetic>` (7 messages,
  // 0 tokens) legitimately stays there - it is not a model.
  'claude-fable-5-1': 'Fable',
  'claude-opus-4-7': 'Opus',
};

/** Every series the UI has a colour for; 'other' is the catch-all. */
export const SERIES = ['Opus', 'Sonnet', 'Haiku', 'Fable', 'other'];

/** @param {string|null} id @returns {string} one of SERIES */
export function modelSeries(id) {
  if (typeof id !== 'string' || !id) return 'other';
  const key = id.toLowerCase();
  if (MODEL_SERIES[key]) return MODEL_SERIES[key];
  // Strip a trailing release date (claude-haiku-4-5-20251001) and retry.
  const undated = key.replace(/-\d{8}$/, '');
  if (MODEL_SERIES[undated]) return MODEL_SERIES[undated];
  return 'other';
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function addUsage(target, usage) {
  for (const m of METRICS) target[m] += num(usage[m]);
  target.count += 1;
  return target;
}

function addTotals(target, totals) {
  for (const m of METRICS) target[m] += num(totals[m]);
  target.count += num(totals.count);
  return target;
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

function sealed(t) {
  t.totalTokens = usageTotal(t);
  return t;
}

function baseName(p) {
  if (typeof p !== 'string' || !p) return null;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

function isoOrNull(ms) {
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The series that moved the most tokens in `m`, or null if `m` is empty. */
function topSeries(m) {
  let top = null;
  let topN = -1;
  for (const [series, n] of m) {
    if (n > topN) { topN = n; top = series; }
  }
  return top;
}

/** The dedupe rule, in one place: is `b` a better record for this id than `a`? */
function better(a, b) {
  if (!a) return true;
  if (b.tsMs > a.tsMs) return true;
  return b.tsMs === a.tsMs && b.total > a.total;
}

/** The dedupe key, identical to UsageCollector's. */
function keyOf(rec) {
  if (rec.messageId) return rec.messageId;
  if (rec.requestId) return `REQ:${rec.requestId}`;
  return `NOID:${rec.uuid ?? `${rec.file}#${rec.lineNo}`}`;
}

/**
 * Everything the view needs about one deduped message, and nothing more. The
 * parsed `usage` object carries fields we never sum (thinking tokens, server
 * tool use); keeping only the four metrics bounds what the cache holds.
 */
function compact(rec) {
  const usage = {};
  for (const m of METRICS) usage[m] = num(rec.usage[m]);
  const tsMs = Number.isFinite(rec.tsMs) ? rec.tsMs : -Infinity;
  return {
    tsMs,
    total: usageTotal(usage),
    usage,
    date: rec.timestamp ? localDateKey(rec.timestamp) : null,
    model: rec.model ?? null,
    sessionId: rec.sessionId ?? null,
    agentId: rec.agentId ?? null,
    cwd: rec.cwd ?? null,
  };
}

/** Walk every `*.jsonl` under projects/ (main transcripts AND subagents). */
export function listTranscripts(root = projectsDir()) {
  /** @type {{path: string, size: number, mtimeMs: number}[]} */
  const out = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(full);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue; // deleted between readdir and stat: it is simply not there
        }
        out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
      }
    }
  };
  walk(root);
  return out;
}

/** `size:mtimeMs` - any append changes it, nothing else does. */
export function fileFingerprint(file) {
  return `${file.size}:${Math.round(file.mtimeMs)}`;
}

/**
 * Per-file `message.id -> best record` maps, keyed by path and fingerprinted
 * by the bytes on disk. See the file header for why totals are NOT cached.
 */
export class UsageFileCache {
  constructor() {
    /** @type {Map<string, {fingerprint: string, records: Map<string, any>, lines: number, failures: number, parseMs: number}>} */
    this.entries = new Map();
    this.hits = 0;
    this.misses = 0;
  }

  get size() {
    return this.entries.size;
  }

  /**
   * @param {{path: string, size: number, mtimeMs: number}} file
   * @returns {{records: Map<string, any>, lines: number, failures: number, parseMs: number, cached: boolean}}
   */
  records(file) {
    const fp = fileFingerprint(file);
    const hit = this.entries.get(file.path);
    if (hit && hit.fingerprint === fp) {
      this.hits += 1;
      return { ...hit, cached: true };
    }
    this.misses += 1;
    const t0 = Date.now();
    const stats = new ParseStats();
    /** @type {Map<string, any>} */
    const records = new Map();
    // parseFile turns a per-file I/O failure into stats.skippedFiles; guard
    // anyway so one bad path can never abort a scan of the whole corpus.
    try {
      parseFile(file.path, (rec) => {
        if (rec.type !== 'assistant') return;
        if (!rec.usage || typeof rec.usage !== 'object') return;
        const key = keyOf(rec);
        const next = compact(rec);
        if (better(records.get(key), next)) records.set(key, next);
      }, stats);
    } catch {
      // counted below as a parse-less file; the view still answers
    }
    const value = {
      fingerprint: fp,
      records,
      lines: stats.totalLines,
      failures: stats.parseFailures,
      parseMs: Date.now() - t0,
    };
    this.entries.set(file.path, value);
    return { ...value, cached: false };
  }

  /**
   * Drop cached maps for files that are no longer on disk. Claude Code prunes
   * transcripts on its own schedule (known constraint 7), so without this the
   * cache would grow for the life of the process and hold the bytes of files
   * that stopped existing weeks ago.
   * @param {Set<string>} livePaths
   */
  evictMissing(livePaths) {
    let dropped = 0;
    for (const p of [...this.entries.keys()]) {
      if (!livePaths.has(p)) {
        this.entries.delete(p);
        dropped += 1;
      }
    }
    return dropped;
  }

  stats() {
    return { size: this.entries.size, hits: this.hits, misses: this.misses };
  }
}

/* ------------------------------ persistence ------------------------------ */

/**
 * `<monitorDir>/usage/daily.json` - our own copy of the daily figures.
 *
 * Claude Code deletes transcripts older than ~30 days (known constraint 7), so
 * a scan alone cannot answer "what did last month cost". Every build writes
 * back whatever it just measured; a date whose live numbers are SMALLER than
 * the stored ones means files were pruned, and the stored numbers win.
 *
 * A corrupt or unreadable store is never fatal: it is reported once through
 * onError and the view starts a fresh one.
 */
export class UsageStore {
  /** @param {{dir?: string, file?: string, onError?: (where: string, err: any) => void}} [opts] */
  constructor(opts = {}) {
    const dir = opts.dir ?? defaultMonitorDir();
    this.file = opts.file ?? path.join(dir, 'usage', 'daily.json');
    this.onError = typeof opts.onError === 'function' ? opts.onError : () => {};
    this.reads = 0;
    this.writes = 0;
    this.corrupt = 0;
  }

  /** @returns {{days: Record<string, any>, present: boolean, corrupt: boolean}} */
  load() {
    this.reads += 1;
    let raw;
    try {
      if (!fs.existsSync(this.file)) return { days: {}, present: false, corrupt: false };
      raw = readJsonUtf8(this.file);
    } catch (err) {
      this.onError('usage:store-read', err);
      return { days: {}, present: false, corrupt: true };
    }
    if (!raw || typeof raw !== 'object' || raw.version !== STORE_VERSION || !raw.days || typeof raw.days !== 'object') {
      this.corrupt += 1;
      this.onError('usage:store-read', new Error(`unusable usage store at ${this.file}`));
      return { days: {}, present: true, corrupt: true };
    }
    /** @type {Record<string, any>} */
    const days = {};
    for (const [date, v] of Object.entries(raw.days)) {
      if (!DATE_RE.test(date) || !v || typeof v !== 'object' || !v.totals || typeof v.totals !== 'object') continue;
      const totals = emptyTotals();
      addTotals(totals, v.totals);
      /** @type {Record<string, any>} */
      const byModel = {};
      if (v.byModel && typeof v.byModel === 'object') {
        for (const [series, t] of Object.entries(v.byModel)) {
          if (!t || typeof t !== 'object') continue;
          byModel[series] = sealed(addTotals(emptyTotals(), t));
        }
      }
      days[date] = {
        msgs: num(v.msgs),
        totals: sealed(totals),
        byModel,
        updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
      };
    }
    return { days, present: true, corrupt: false };
  }

  /**
   * Write the store back, re-merging whatever is on disk RIGHT NOW.
   *
   * The caller read the store at the start of the build and has been busy for
   * hundreds of milliseconds since; a second server sharing this monitorDir
   * (two `serve` processes, or a tray plus a shell) can have written in the
   * meantime, and a plain read-modify-write would silently drop its dates.
   *
   * There is no lock. There does not need to be one, because the merge rule is
   * MONOTONIC: per date the larger totalTokens wins, and dates the other writer
   * added are kept. Re-reading immediately before the rename shrinks the race
   * window to the write itself, and anything still lost is restored by the next
   * build - the loser's numbers are never larger than what it will measure
   * again. This is self-healing, not exclusion (known constraint 28).
   *
   * @param {Record<string, any>} days
   */
  save(days) {
    const merged = { ...days };
    const disk = this.load().days;
    for (const [date, v] of Object.entries(disk)) {
      const mine = merged[date];
      if (!mine || num(v.totals.totalTokens) > num(mine.totals.totalTokens)) merged[date] = v;
    }
    const body = JSON.stringify({ version: STORE_VERSION, days: merged }, null, 0);
    try {
      writeFileAtomic(this.file, body);
      this.writes += 1;
      return true;
    } catch (err) {
      // A store we cannot write is a lost long-term record, not a broken view.
      this.onError('usage:store-write', err);
      return false;
    }
  }

  stats() {
    return { file: this.file, reads: this.reads, writes: this.writes, corrupt: this.corrupt };
  }
}

/* -------------------------------- the view -------------------------------- */

/**
 * The window as LOCAL calendar days: `days` days ending today, inclusive.
 * @param {number} days
 * @param {number} nowMs
 */
export function windowOf(days, nowMs) {
  const until = new Date(nowMs);
  const since = new Date(nowMs);
  since.setHours(0, 0, 0, 0);
  since.setDate(since.getDate() - (days - 1));
  return {
    since: localDateKey(since),
    until: localDateKey(until),
    sinceMs: since.getTime(),
    today: localDateKey(until),
  };
}

/**
 * Build the whole Usage view.
 *
 * @param {Object} [opts]
 * @param {number} [opts.days]              window in LOCAL calendar days (default 30)
 * @param {number} [opts.now]               epoch ms (tests)
 * @param {string} [opts.projectsRoot]      override ~/.claude/projects
 * @param {string} [opts.monitorDir]        override ~/.claude-monitor (store)
 * @param {string} [opts.statuslineDir]     override <monitorDir>/statusline
 * @param {UsageFileCache} [opts.cache]
 * @param {UsageStore} [opts.store]
 * @param {number} [opts.sessionLimit]
 * @param {(where: string, err: any) => void} [opts.onError]
 */
export function buildUsageView(opts = {}) {
  const t0 = Date.now();
  const days = Number.isFinite(opts.days) ? Math.trunc(opts.days) : DEFAULT_DAYS;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const onError = typeof opts.onError === 'function' ? opts.onError : () => {};
  const cache = opts.cache ?? new UsageFileCache();
  const store = opts.store ?? new UsageStore({ dir: opts.monitorDir, onError });
  const sessionLimit = Number.isFinite(opts.sessionLimit) ? opts.sessionLimit : DEFAULT_SESSION_LIMIT;
  const win = windowOf(days, now);

  const all = listTranscripts(opts.projectsRoot ?? projectsDir());
  cache.evictMissing(new Set(all.map((f) => f.path)));
  const wanted = all.filter((f) => f.mtimeMs >= win.sinceMs - MTIME_MARGIN_MS);

  /** @type {Map<string, any>} the cross-file dedupe */
  const merged = new Map();
  let lines = 0;
  let failures = 0;
  let cacheHits = 0;
  for (const file of wanted) {
    const got = cache.records(file);
    lines += got.lines;
    failures += got.failures;
    if (got.cached) cacheHits += 1;
    for (const [key, rec] of got.records) {
      const cur = merged.get(key);
      if (better(cur, rec)) merged.set(key, rec);
    }
  }

  /* ------------------------------ aggregate ------------------------------ */

  const totals = emptyTotals();
  /** @type {Record<string, any>} */
  const byDate = {};
  /** @type {Record<string, Record<string, any>>} */
  const byDateModel = {};
  /** @type {Record<string, any>} */
  const byModel = {};
  /** @type {Map<string, string[]>} series -> the raw ids folded into it */
  const seriesIds = new Map();
  /** @type {Map<string, any>} */
  const bySession = new Map();

  for (const rec of merged.values()) {
    const date = rec.date;
    if (date === null || date < win.since || date > win.until) continue;
    const series = modelSeries(rec.model);
    addUsage(totals, rec.usage);
    addUsage((byDate[date] ??= emptyTotals()), rec.usage);
    addUsage(((byDateModel[date] ??= {})[series] ??= emptyTotals()), rec.usage);
    addUsage((byModel[series] ??= emptyTotals()), rec.usage);
    if (rec.model) {
      const ids = seriesIds.get(series) ?? [];
      if (!ids.includes(rec.model)) ids.push(rec.model);
      seriesIds.set(series, ids);
    }
    const sid = rec.sessionId ?? 'unknown-session';
    let s = bySession.get(sid);
    if (!s) {
      s = { sessionId: sid, totals: emptyTotals(), cwd: null, firstMs: Infinity, series: new Map(), rootSeries: new Map() };
      bySession.set(sid, s);
    }
    addUsage(s.totals, rec.usage);
    if (!s.cwd && rec.cwd) s.cwd = rec.cwd;
    if (Number.isFinite(rec.tsMs) && rec.tsMs < s.firstMs) s.firstMs = rec.tsMs;
    s.series.set(series, (s.series.get(series) ?? 0) + rec.total);
    // The session's OWN model is the one the human is talking to, i.e. the one
    // in the root transcript (agentId === null). Subagents routinely run on a
    // different, heavier model and outweigh the root by an order of magnitude,
    // so counting them made a Fable session read as "Opus".
    if (!rec.agentId && rec.model) {
      s.rootSeries.set(series, (s.rootSeries.get(series) ?? 0) + rec.total);
    }
  }

  sealed(totals);
  for (const d of Object.keys(byDate)) sealed(byDate[d]);
  for (const d of Object.keys(byDateModel)) {
    for (const k of Object.keys(byDateModel[d])) sealed(byDateModel[d][k]);
    byDateModel[d] = sortKeys(byDateModel[d]);
  }
  for (const k of Object.keys(byModel)) {
    sealed(byModel[k]);
    byModel[k].ids = (seriesIds.get(k) ?? []).sort();
  }

  /* -------------------------------- store -------------------------------- */

  const loaded = store.load();
  const stored = loaded.days;
  /** @type {Record<string, any>} */
  const nextStore = { ...stored };
  let storeChanged = false;
  const updatedAt = new Date(now).toISOString();
  for (const date of Object.keys(byDate)) {
    const live = { msgs: byDate[date].count, totals: byDate[date], byModel: byDateModel[date] ?? {} };
    const prev = stored[date];
    if (prev && num(prev.totals.totalTokens) >= live.totals.totalTokens) continue;
    nextStore[date] = {
      msgs: live.msgs,
      totals: live.totals,
      byModel: live.byModel,
      updatedAt,
    };
    storeChanged = true;
  }
  if (storeChanged) store.save(nextStore);

  /* ------------------------------- day rows ------------------------------ */

  const dateSet = new Set(Object.keys(byDate));
  for (const date of Object.keys(stored)) {
    if (date >= win.since && date <= win.until) dateSet.add(date);
  }
  // Newest first: a 30-day table is read from today backwards.
  const dates = [...dateSet].sort().reverse();

  const dayRows = dates.map((date) => {
    const live = byDate[date] ?? null;
    const prev = stored[date] ?? null;
    const liveTotal = live ? live.totalTokens : -1;
    const prevTotal = prev ? num(prev.totals.totalTokens) : -1;
    if (!live && prev) {
      return {
        date,
        msgs: num(prev.msgs),
        totals: prev.totals,
        byModel: prev.byModel,
        source: 'store',
        partial: false,
        today: date === win.today,
      };
    }
    if (live && prev && prevTotal > liveTotal) {
      // The transcripts shrank under us (Claude Code's ~30-day cleanup, or a
      // session directory removed by hand). Show what we recorded, and say so.
      return {
        date,
        msgs: num(prev.msgs),
        totals: prev.totals,
        byModel: prev.byModel,
        source: 'store',
        partial: true,
        today: date === win.today,
      };
    }
    return {
      date,
      msgs: live.count,
      totals: live,
      byModel: byDateModel[date] ?? {},
      source: 'live',
      partial: false,
      today: date === win.today,
    };
  });

  /* ------------------------------- sessions ------------------------------ */

  /** @type {Map<string, number|null>} sessionId -> Claude Code's own cost estimate */
  const costs = new Map();
  try {
    for (const e of readSidecars({ dir: opts.statuslineDir ?? defaultStatuslineDir() }).entries) {
      if (e.sessionId && !costs.has(e.sessionId)) costs.set(e.sessionId, e.costUsd);
    }
  } catch (err) {
    onError('usage:statusline', err);
  }

  const sessions = [...bySession.values()]
    .map((s) => {
      sealed(s.totals);
      // Root transcript first; only a session whose root says nothing about a
      // model falls back to "whichever series moved the most tokens".
      const top = topSeries(s.rootSeries) ?? topSeries(s.series);
      return {
        sessionId: s.sessionId,
        cwd: s.cwd,
        projectDirName: baseName(s.cwd),
        totals: s.totals,
        totalTokens: s.totals.totalTokens,
        msgs: s.totals.count,
        model: top,
        // Claude Code's own number for the WHOLE session, not just the window.
        costUsd: costs.has(s.sessionId) ? costs.get(s.sessionId) : null,
        startedAt: isoOrNull(s.firstMs),
      };
    })
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, sessionLimit);

  return {
    ok: true,
    generatedAt: new Date(now).toISOString(),
    serverNow: now,
    // `days` is the ARRAY of day rows (newest first); the window SIZE that
    // produced it is `windowDays`.
    windowDays: days,
    since: win.since,
    until: win.until,
    today: win.today,
    series: SERIES,
    days: dayRows,
    byModel,
    totals,
    sessions,
    sessionCount: bySession.size,
    stats: {
      scannedFiles: wanted.length,
      foundFiles: all.length,
      scannedLines: lines,
      parseFailures: failures,
      uniqueMessages: merged.size,
      buildMs: Date.now() - t0,
      // Per REQUEST, then the cache's lifetime counters - never spread the
      // lifetime ones over the per-request ones, they share key names.
      cache: { hits: cacheHits, misses: wanted.length - cacheHits, size: cache.stats().size, lifetimeHits: cache.stats().hits, lifetimeMisses: cache.stats().misses },
      store: { present: loaded.present, corrupt: loaded.corrupt, wrote: storeChanged, days: Object.keys(nextStore).length },
    },
  };
}

/* -------------------------------- ccusage -------------------------------- */

/**
 * ccusage, on demand only.
 *
 * `npx -y ccusage@latest` downloads and runs a third-party CLI, so it is never
 * on the request path of the dashboard itself (known constraint 8). This runs
 * it when the user presses the button, caches the answer for ten minutes per
 * (since, until), and lets concurrent callers share a single run - two tabs
 * pressing the button together must not start two npx downloads.
 */
export class CcusageCache {
  /**
   * @param {{runner?: (o: any) => Promise<any>, ttlMs?: number, timeoutMs?: number,
   *          now?: () => number}} [opts]
   */
  constructor(opts = {}) {
    this.runner = opts.runner ?? ccusageDaily;
    this.ttlMs = Number.isFinite(opts.ttlMs) ? opts.ttlMs : CCUSAGE_TTL_MS;
    this.timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : CCUSAGE_TIMEOUT_MS;
    this.now = typeof opts.now === 'function' ? opts.now : () => Date.now();
    /** @type {Map<string, {fetchedAt: number, res: any}>} */
    this.done = new Map();
    /** @type {Map<string, Promise<any>>} */
    this.inflight = new Map();
    this.runs = 0;
  }

  /**
   * @param {string} since YYYY-MM-DD, already validated by the caller
   * @param {string} until YYYY-MM-DD
   * @returns {Promise<{ok: boolean, data: any, error: string|null, fetchedAt: number, cached: boolean}>}
   */
  async daily(since, until) {
    const key = `${since}|${until}`;
    const hit = this.done.get(key);
    if (hit && this.now() - hit.fetchedAt < this.ttlMs) {
      return { ...hit.res, fetchedAt: hit.fetchedAt, cached: true };
    }
    const flight = this.inflight.get(key);
    // A second caller during a run waits for that run rather than starting one.
    if (flight) return flight;

    const p = (async () => {
      this.runs += 1;
      let res;
      try {
        res = await this.runner({ since, until, timeoutMs: this.timeoutMs });
      } catch (err) {
        res = { ok: false, data: null, error: String(err && err.message ? err.message : err) };
      }
      const fetchedAt = this.now();
      // Failures are NOT cached: the button must be able to retry.
      if (res && res.ok) this.done.set(key, { fetchedAt, res });
      return { ...res, fetchedAt, cached: false };
    })();
    this.inflight.set(key, p);
    try {
      return await p;
    } finally {
      this.inflight.delete(key);
    }
  }

  stats() {
    return { runs: this.runs, cached: this.done.size, inflight: this.inflight.size };
  }
}

/** ccusage 20.0.20 emits one row per (period, agent); `all` is the roll-up. */
function ccusageRows(data) {
  const daily = Array.isArray(data?.daily) ? data.daily : [];
  return daily
    .filter((r) => r?.agent === undefined || r.agent === 'all')
    .map((r) => normalizeDailyRow(r))
    .filter((r) => typeof r.date === 'string' && DATE_RE.test(r.date));
}

function metricsOf(t) {
  const o = {};
  for (const m of METRICS) o[m] = num(t?.[m]);
  o.totalTokens = usageTotal(o);
  return o;
}

/**
 * Our figures against ccusage's, day by day.
 *
 * @param {Object} args
 * @param {any} args.view      a buildUsageView() result (supplies since/until and `ours`)
 * @param {CcusageCache} [args.cache]
 * @param {(o: any) => Promise<any>} [args.runner] convenience: build a cache around this
 * @param {(where: string, err: any) => void} [args.onError]
 */
export async function buildCcusageComparison(args = {}) {
  const onError = typeof args.onError === 'function' ? args.onError : () => {};
  const view = args.view;
  const cache = args.cache ?? new CcusageCache(args.runner ? { runner: args.runner } : {});
  const since = view ? view.since : null;
  const until = view ? view.until : null;
  // Both strings go straight onto ccusage's argv. Nothing but this shape does.
  if (!DATE_RE.test(String(since)) || !DATE_RE.test(String(until))) {
    onError('usage:ccusage', new Error(`refusing to pass dates to ccusage: ${since}..${until}`));
    return { ok: false, error: CCUSAGE_ERROR };
  }

  const res = await cache.daily(since, until);
  if (!res || !res.ok) {
    onError('usage:ccusage', new Error(String(res && res.error ? res.error : 'ccusage failed')));
    return { ok: false, error: CCUSAGE_ERROR };
  }

  const theirs = new Map(ccusageRows(res.data).map((r) => [r.date, r]));
  const ours = new Map((view.days || []).map((r) => [r.date, r.totals]));
  const dates = [...new Set([...ours.keys(), ...theirs.keys()])]
    .filter((d) => d >= since && d <= until)
    .sort()
    .reverse();

  const sumOurs = metricsOf({});
  const sumTheirs = metricsOf({});
  let totalCost = 0;
  const rows = dates.map((date) => {
    const a = metricsOf(ours.get(date));
    const t = theirs.get(date) ?? null;
    const b = metricsOf(t);
    const delta = {};
    for (const m of METRICS) {
      delta[m] = a[m] - b[m];
      sumOurs[m] += a[m];
      sumTheirs[m] += b[m];
    }
    delta.totalTokens = a.totalTokens - b.totalTokens;
    totalCost += num(t?.totalCost);
    return {
      date,
      today: date === view.today,
      match: t !== null && METRICS.every((m) => delta[m] === 0),
      ours: a,
      ccusage: b,
      delta,
      totalCost: t ? num(t.totalCost) : null,
      modelsUsed: t ? t.modelsUsed : [],
    };
  });
  sumOurs.totalTokens = usageTotal(sumOurs);
  sumTheirs.totalTokens = usageTotal(sumTheirs);
  const sumDelta = {};
  for (const m of METRICS) sumDelta[m] = sumOurs[m] - sumTheirs[m];
  sumDelta.totalTokens = sumOurs.totalTokens - sumTheirs.totalTokens;

  return {
    ok: true,
    since,
    until,
    fetchedAt: new Date(res.fetchedAt).toISOString(),
    cached: !!res.cached,
    rows,
    totals: { ours: sumOurs, ccusage: sumTheirs, delta: sumDelta, totalCost },
  };
}
