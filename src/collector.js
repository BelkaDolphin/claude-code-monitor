/**
 * Collector - the single place that turns four noisy on-disk sources into one
 * state object, and says "change" when something actually moved.
 *
 * Sources and cadence:
 *
 *   hooks      <monitorDir>/events/<YYYY-MM-DD>.jsonl
 *              fs.watch on the DIRECTORY plus a 1s poll. Both are needed:
 *              fs.watch on Windows drops events under load and reports nothing
 *              for appends to an already-open file in some configurations, so
 *              the poll is the guarantee and the watch is the latency win.
 *              Byte offsets come from JsonlTail, so a poll that finds nothing
 *              new costs one statSync.
 *   sessions   ~/.claude/sessions/*.json every 2s (PID liveness).
 *              The PID-reuse check shells out to PowerShell (Linux: reads
 *              /proc), so it runs on a much slower cadence (60s) - see
 *              PROC_START_EVERY. sessions.js remembers the verdict for the
 *              ticks in between.
 *   statusline <monitorDir>/statusline/*.json, fs.watch + 2s poll.
 *   transcript the jsonl of every live session (main + its subagents), tailed
 *              incrementally for ai-title and token usage; the full session
 *              index is rebuilt every 30s to discover new files.
 *
 * Failure policy: every read is wrapped. A failure increments a counter in
 * stats() and the loop continues. Files that vanish between enumeration and
 * read are expected (Claude Code prunes transcripts on its own schedule) and
 * are counted as `skippedFiles`, exactly as the usage aggregators do.
 */

import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { eventsDir as defaultEventsDir, statuslineDir as defaultStatuslineDir, localDateKey } from './paths.js';
import { HooksIngest, listEventDates, pruneEventFiles, EVENTS_KEEP_DAYS } from './hooks-ingest.js';
import { readSidecars } from './statusline-sidecar.js';
import { readLiveSessions } from './sessions.js';
import { buildSessionIndex } from './session-index.js';
import { JsonlTail } from './jsonl-tail.js';
import { parseLine } from './parser.js';
import { UsageCollector } from './usage.js';
import {
  createState,
  reduce,
  applySessions,
  applyStatusline,
  applyTranscript,
  applyAgentMeta,
  sweepStale,
  buildSnapshot,
  pruneSessions,
  isLive,
} from './state.js';

const HOOK_POLL_MS = 1000;
const SESSIONS_POLL_MS = 2000;
const STATUSLINE_POLL_MS = 2000;
const TRANSCRIPT_POLL_MS = 2000;
const INDEX_POLL_MS = 30000;
/** How often the "its closing event never arrived" sweep runs. */
const SWEEP_POLL_MS = 30000;
const DEBOUNCE_MS = 250;
/** Every Nth sessions tick also verifies process start times (PowerShell). */
const PROC_START_EVERY = 30; // 30 * 2s = 60s

export class Collector extends EventEmitter {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.eventsDir]
   * @param {string} [opts.statuslineDir]
   * @param {string} [opts.projectsRoot]  override ~/.claude/projects (tests)
   * @param {string} [opts.sessionsDir]   override ~/.claude/sessions (tests)
   * @param {boolean} [opts.watch=true]   use fs.watch in addition to polling
   * @param {boolean} [opts.readTranscripts=true]
   * @param {number} [opts.debounceMs]
   * @param {number} [opts.eventsKeepDays] retention for events/<date>.jsonl,
   *   default EVENTS_KEEP_DAYS; 0 or less keeps everything forever
   */
  constructor(opts = {}) {
    super();
    this.opts = opts;
    this.eventsDir = opts.eventsDir ?? defaultEventsDir();
    this.statuslineDir = opts.statuslineDir ?? defaultStatuslineDir();
    this.projectsRoot = opts.projectsRoot ?? null;
    this.sessionsDir = opts.sessionsDir ?? null;
    this.useWatch = opts.watch !== false;
    this.readTranscripts = opts.readTranscripts !== false;
    this.debounceMs = Number.isFinite(opts.debounceMs) ? opts.debounceMs : DEBOUNCE_MS;
    /** Injectable clock so the midnight rollover is testable. */
    this.nowFn = typeof opts.now === 'function' ? opts.now : () => new Date();
    this.toolTimeoutMs = Number.isFinite(opts.toolTimeoutMs) ? opts.toolTimeoutMs : undefined;
    this.agentStaleMs = Number.isFinite(opts.agentStaleMs) ? opts.agentStaleMs : undefined;
    this.sessionStaleMs = Number.isFinite(opts.sessionStaleMs) ? opts.sessionStaleMs : undefined;
    /** Retention for our own events/ day files. 0 (or less) disables it. */
    this.eventsKeepDays = Number.isFinite(opts.eventsKeepDays) ? opts.eventsKeepDays : EVENTS_KEEP_DAYS;

    this.state = createState();
    this.startedAt = Date.now();
    this.running = false;

    this.ingest = new HooksIngest({ dir: this.eventsDir });
    /** Day files we still read from. Grows at midnight, trimmed a day later. */
    this.activeDates = new Set();
    this.transcriptTail = new JsonlTail();
    /** sessionId -> UsageCollector (dedupe survives across incremental reads) */
    this.usage = new Map();
    /** sessionId -> index entry from session-index */
    this.indexBySession = new Map();
    /** Resolved paths of every transcript the last index listed. */
    this.indexedFiles = new Set();
    /** absolute jsonl path -> sessionId, so a tail result knows its owner */
    this.fileOwner = new Map();

    this.counters = {
      hookEvents: 0,
      hookParseFailures: 0,
      hookReadErrors: 0,
      eventFilesDeleted: 0,
      eventPruneErrors: 0,
      sessionsReads: 0,
      sessionsErrors: 0,
      statuslineReads: 0,
      statuslineErrors: 0,
      transcriptReads: 0,
      transcriptErrors: 0,
      transcriptSkippedFiles: 0,
      indexReads: 0,
      indexErrors: 0,
      watchErrors: 0,
      tickErrors: 0,
      toolTimeouts: 0,
      agentsStale: 0,
      sessionsStale: 0,
      changes: 0,
    };
    /** @type {{at: string, where: string, message: string}[]} */
    this.recentErrors = [];

    this.timers = [];
    this.watchers = [];
    this.debounceTimer = null;
    this.pendingChange = false;
  }

  /* ------------------------------ lifecycle ------------------------------ */

  /** Prime every source once (synchronously where possible) and start timers. */
  async start() {
    if (this.running) return this;
    this.running = true;

    this.safeTick('prime-dates', () => this.primeDates());
    // Before the first read, so a restart is the moment the backlog goes away
    // even on a machine that never crosses midnight with the server running.
    this.safeTick('events-prune', () => this.pruneEvents());
    this.safeTick('hooks', () => this.pollHooks());
    await this.safeTick('sessions', () => this.pollSessions(true));
    this.safeTick('statusline', () => this.pollStatusline());
    if (this.readTranscripts) {
      this.safeTick('index', () => this.pollIndex());
      this.safeTick('transcripts', () => this.pollTranscripts());
    }
    // Run once at startup so a ghost left over from a previous run is not
    // presented as live for the first half minute.
    this.safeTick('sweep', () => this.sweep());

    this.addTimer(setInterval(() => this.safeTick('hooks', () => this.pollHooks()), HOOK_POLL_MS));
    let sessionTick = 0;
    this.addTimer(setInterval(() => {
      sessionTick += 1;
      this.safeTick('sessions', () => this.pollSessions(sessionTick % PROC_START_EVERY === 0));
    }, SESSIONS_POLL_MS));
    this.addTimer(setInterval(() => this.safeTick('statusline', () => this.pollStatusline()), STATUSLINE_POLL_MS));
    if (this.readTranscripts) {
      this.addTimer(setInterval(() => this.safeTick('index', () => this.pollIndex()), INDEX_POLL_MS));
      this.addTimer(setInterval(() => this.safeTick('transcripts', () => this.pollTranscripts()), TRANSCRIPT_POLL_MS));
    }
    this.addTimer(setInterval(() => this.safeTick('sweep', () => this.sweep()), SWEEP_POLL_MS));

    if (this.useWatch) {
      this.watchDir(this.eventsDir, () => this.pollHooks());
      this.watchDir(this.statuslineDir, () => this.pollStatusline());
    }
    // Emit the primed snapshot so a client connecting immediately sees data.
    this.markChanged();
    return this;
  }

  stop() {
    this.running = false;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const w of this.watchers) {
      try {
        w.close();
      } catch { /* already closed */ }
    }
    this.watchers = [];
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  addTimer(t) {
    if (typeof t.unref === 'function') t.unref();
    this.timers.push(t);
    return t;
  }

  /**
   * Run a poller so that nothing it throws can reach the event loop.
   *
   * A throw inside a setInterval callback has NO catch site: it becomes an
   * uncaughtException and kills the process. The individual I/O calls are
   * already guarded, but the code between them (state folding, path joins, a
   * future edit) is not, and one bad line would take the whole monitor down.
   * Rejections from the async pollers are caught here too.
   *
   * @param {string} where label used in the error log
   * @param {() => any} fn
   */
  safeTick(where, fn) {
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        return result.then(
          (v) => v,
          (err) => {
            this.counters.tickErrors += 1;
            this.recordError(`tick:${where}`, err);
            return false;
          },
        );
      }
      return result;
    } catch (err) {
      this.counters.tickErrors += 1;
      this.recordError(`tick:${where}`, err);
      return false;
    }
  }

  /**
   * fs.watch is best-effort: the directory may not exist yet (hooks installed
   * but never fired) and Windows can hand us EPERM when it is replaced.
   */
  watchDir(dir, onEvent) {
    let w;
    try {
      w = fs.watch(dir, { persistent: false }, () => {
        this.safeTick(`watch:${path.basename(dir)}`, onEvent);
      });
    } catch (err) {
      // Not fatal - polling still covers this directory.
      this.counters.watchErrors += 1;
      this.recordError(`watch:${dir}`, err);
      return null;
    }
    w.on('error', (err) => {
      this.counters.watchErrors += 1;
      this.recordError(`watch:${dir}`, err);
      try {
        w.close();
      } catch { /* ignore */ }
    });
    this.watchers.push(w);
    return w;
  }

  /* -------------------------------- hooks -------------------------------- */

  /**
   * Which day files to read on startup. The current day always; the previous
   * day too when we start just after midnight, because a session that was
   * running at 23:59 wrote its events there.
   */
  primeDates(now = this.nowFn()) {
    this.activeDates.add(localDateKey(now));
    if (now.getHours() < 1) {
      const y = new Date(now.getTime() - 24 * 3600 * 1000);
      this.activeDates.add(localDateKey(y));
    }
    // Pick up any day file that exists but is newer than what we know about
    // (e.g. the clock jumped, or the process was resumed).
    try {
      for (const d of listEventDates(this.eventsDir).slice(-2)) this.activeDates.add(d);
    } catch (err) {
      this.recordError('events-listdir', err);
    }
    return this.activeDates;
  }

  /**
   * Keep only the two newest day files, OLDEST FIRST.
   *
   * `activeDates` is a Set, so iterating it walks insertion order, and at
   * midnight the day that just ended is the second-newest insertion while the
   * day before it was inserted first only when the process started before
   * midnight. The previous code deleted in insertion order and so, after a
   * start at 00:30 (which primes today then yesterday), the next rollover
   * dropped the day that had JUST ended and kept the one before it.
   * @param {string} today
   */
  trimActiveDates(today) {
    const sorted = [...this.activeDates].sort();
    while (sorted.length > 2) {
      const oldest = sorted.shift();
      if (oldest === today) break; // paranoia: never drop the current day
      this.activeDates.delete(oldest);
    }
    return this.activeDates;
  }

  /**
   * Delete day files past the retention window. Runs at startup and on the
   * midnight rollover - never on the 1s tick, which would be a readdir per
   * second for a directory that changes once a day.
   */
  pruneEvents() {
    if (!(this.eventsKeepDays > 0)) return 0;
    const r = pruneEventFiles({
      dir: this.eventsDir,
      keepDays: this.eventsKeepDays,
      now: this.nowFn(),
      onError: (where, err) => this.recordError(where, err),
    });
    this.counters.eventFilesDeleted += r.deleted.length;
    this.counters.eventPruneErrors += r.errors;
    for (const dateKey of r.deleted) {
      // The byte offset of a file that no longer exists would sit in the tail
      // map for the life of the process.
      this.ingest.tail.reset(this.ingest.fileFor(dateKey));
      this.activeDates.delete(dateKey);
    }
    return r.deleted.length;
  }

  pollHooks() {
    const today = localDateKey(this.nowFn());
    // Day rolled over. The new file joins the set BEFORE this tick reads, and
    // the old ones are trimmed only AFTER it: the day that just ended still
    // had events appended to it in its last fraction of a second (a SessionEnd
    // at 23:59:59.8 is the measured case) and dropping it first loses them for
    // good, because nothing ever reads that file again.
    const rolled = !this.activeDates.has(today);
    if (rolled) this.activeDates.add(today);
    let changed = false;
    for (const dateKey of [...this.activeDates].sort()) {
      let events;
      try {
        events = this.ingest.readDay(dateKey);
      } catch (err) {
        this.counters.hookReadErrors += 1;
        this.recordError(`events:${dateKey}`, err);
        continue;
      }
      for (const ev of events) {
        this.counters.hookEvents += 1;
        try {
          const r = reduce(this.state, ev);
          this.state = r.state;
          changed = changed || r.changed;
        } catch (err) {
          // One malformed event must never stop the rest of the day file.
          this.counters.hookReadErrors += 1;
          this.recordError(`reduce:${ev && ev.event}`, err);
        }
      }
    }
    if (rolled) {
      this.trimActiveDates(today);
      this.safeTick('events-prune', () => this.pruneEvents());
    }
    this.counters.hookParseFailures = this.ingest.parseFailures;
    if (changed) this.markChanged();
    return changed;
  }

  /* ------------------------------- sessions ------------------------------- */

  async pollSessions(checkProcStart = false) {
    let list;
    try {
      const res = await readLiveSessions({
        dir: this.sessionsDir ?? undefined,
        checkProcStart,
      });
      list = res.sessions;
      this.counters.sessionsReads += 1;
    } catch (err) {
      this.counters.sessionsErrors += 1;
      this.recordError('sessions', err);
      return false;
    }
    // Folding is pure, but "pure" is an assumption about code that will keep
    // changing; a throw here would come from a timer with no catch site.
    let r;
    try {
      r = applySessions(this.state, list);
    } catch (err) {
      this.counters.sessionsErrors += 1;
      this.recordError('sessions-apply', err);
      return false;
    }
    this.state = r.state;
    if (r.changed) this.markChanged();
    return r.changed;
  }

  /* ------------------------------ statusline ------------------------------ */

  pollStatusline() {
    let entries;
    try {
      entries = readSidecars({ dir: this.statuslineDir }).entries;
      this.counters.statuslineReads += 1;
    } catch (err) {
      this.counters.statuslineErrors += 1;
      this.recordError('statusline', err);
      return false;
    }
    let r;
    try {
      r = applyStatusline(this.state, entries);
    } catch (err) {
      this.counters.statuslineErrors += 1;
      this.recordError('statusline-apply', err);
      return false;
    }
    this.state = r.state;
    if (r.changed) this.markChanged();
    return r.changed;
  }

  /* ------------------------------ transcripts ------------------------------ */

  pollIndex() {
    let index;
    try {
      index = buildSessionIndex({ days: 30, root: this.projectsRoot ?? undefined, withCwd: false });
      this.counters.indexReads += 1;
    } catch (err) {
      this.counters.indexErrors += 1;
      this.recordError('session-index', err);
      return false;
    }
    this.indexBySession = new Map(index.sessions.map((s) => [s.sessionId, s]));

    // Claude Code deletes transcripts older than ~30 days on its own schedule
    // (measured: 171 files -> 146 mid-session). Their byte offsets would
    // otherwise sit in JsonlTail.states for the life of the process.
    const present = new Set();
    for (const entry of index.sessions) {
      present.add(path.resolve(entry.jsonlPath));
      for (const sub of entry.subagents || []) {
        if (sub && sub.jsonlPath) present.add(path.resolve(sub.jsonlPath));
      }
    }
    for (const file of this.indexedFiles) {
      if (!present.has(file)) this.transcriptTail.reset(file);
    }
    this.indexedFiles = present;

    let changed = false;
    for (const entry of index.sessions) {
      if (!this.state.sessions[entry.sessionId]) continue;
      const r = applyTranscript(this.state, entry.sessionId, {
        jsonlPath: entry.jsonlPath,
        projectDirName: entry.projectDirName,
      });
      this.state = r.state;
      changed = changed || r.changed;

      // meta.json is the only source of a human-written description, and the
      // only place the short model name ("opus"/"sonnet") appears.
      if (entry.subagents && entry.subagents.length) {
        const m = applyAgentMeta(this.state, entry.sessionId, entry.subagents.map((sub) => ({
          agentId: sub.agentId,
          agentType: sub.agentType,
          description: sub.description,
          model: sub.model,
          modelSource: 'meta',
        })));
        this.state = m.state;
        changed = changed || m.changed;
      }
    }
    if (changed) this.markChanged();
    return changed;
  }

  /**
   * Every transcript belonging to one session, tagged with the agent it
   * belongs to (null for the main thread) so a record parsed out of it can be
   * attributed without a second lookup.
   * @returns {{file: string, agentId: string|null}[]}
   */
  transcriptTargets(sessionId) {
    const s = this.state.sessions[sessionId];
    const entry = this.indexBySession.get(sessionId);
    const out = [];
    const main = (s && (s.jsonlPath || s.transcriptPath)) || (entry && entry.jsonlPath) || null;
    if (main) out.push({ file: main, agentId: null });
    if (entry) {
      for (const sub of entry.subagents || []) {
        if (sub && sub.jsonlPath) out.push({ file: sub.jsonlPath, agentId: sub.agentId });
      }
    }
    return out;
  }

  /** Every transcript file belonging to one session: main plus subagents. */
  filesForSession(sessionId) {
    return this.transcriptTargets(sessionId).map((t) => t.file);
  }

  /**
   * mtime of `subagents/agent-<id>.jsonl`, used by the stale sweep as positive
   * evidence that an agent is still working even when no hook arrived.
   * @returns {number|null}
   */
  agentFileMtime(sessionId, agentId) {
    const entry = this.indexBySession.get(sessionId);
    if (!entry) return null;
    for (const sub of entry.subagents || []) {
      if (sub && sub.agentId === agentId) return Number.isFinite(sub.mtimeMs) ? sub.mtimeMs : null;
    }
    return null;
  }

  /**
   * The collector's clock in epoch ms. Everything time-based must go through
   * the injected `now` (the sweep decides whether a session is stale by
   * comparing against it), not the wall clock.
   */
  nowMs() {
    const t = this.nowFn();
    if (t instanceof Date) return t.getTime();
    return Number.isFinite(t) ? t : Date.now();
  }

  /**
   * mtime of the session's OWN transcript, the session-level twin of
   * agentFileMtime: a growing file is positive evidence that the session is
   * still working even when its hooks went silent.
   * @returns {number|null}
   */
  sessionFileMtime(sessionId) {
    const entry = this.indexBySession.get(sessionId);
    if (!entry) return null;
    return Number.isFinite(entry.mtimeMs) ? entry.mtimeMs : null;
  }

  /**
   * Mark tools, agents and sessions whose closing event never arrived. See
   * state.sweepStale - everything it does is inference and is reversible.
   */
  sweep(now = this.nowMs()) {
    const r = sweepStale(this.state, {
      now,
      toolTimeoutMs: this.toolTimeoutMs,
      agentStaleMs: this.agentStaleMs,
      sessionStaleMs: this.sessionStaleMs,
      agentFileMtimes: (sessionId, agentId) => this.agentFileMtime(sessionId, agentId),
      sessionFileMtimes: (sessionId) => this.sessionFileMtime(sessionId),
    });
    this.counters.toolTimeouts += r.toolTimeouts;
    this.counters.agentsStale += r.agentsStale;
    this.counters.sessionsStale += r.sessionsStale;
    this.state = r.state;
    if (r.changed) this.markChanged();
    return r.changed;
  }

  pollTranscripts() {
    let changed = false;
    for (const [sessionId, s] of Object.entries(this.state.sessions)) {
      if (!isLive(s)) continue;
      const targets = this.transcriptTargets(sessionId);
      if (!targets.length) continue;
      let collector = this.usage.get(sessionId);
      if (!collector) {
        collector = new UsageCollector();
        this.usage.set(sessionId, collector);
      }
      let sawLines = false;
      let aiTitle;
      /** agentId -> the model its newest assistant record was answered by */
      const agentModels = new Map();
      for (const { file, agentId } of targets) {
        let res;
        try {
          res = this.transcriptTail.read(file);
          this.counters.transcriptReads += 1;
        } catch (err) {
          this.counters.transcriptErrors += 1;
          this.recordError(`transcript:${path.basename(file)}`, err);
          continue;
        }
        if (res.missing) {
          // Enumerated a moment ago, gone now. Claude Code prunes transcripts
          // mid-session; that is normal, not an error worth stopping for.
          this.counters.transcriptSkippedFiles += 1;
          continue;
        }
        if (!res.lines.length) continue;
        sawLines = true;
        let lineNo = res.firstLineNo;
        for (const line of res.lines) {
          const rec = parseLine(line, lineNo++, { file });
          if (!rec) continue;
          if (rec.aiTitle) aiTitle = rec.aiTitle;
          // The newest assistant record wins: an agent can switch models
          // mid-run, and meta.json is not rewritten when it does.
          if (agentId && rec.type === 'assistant' && rec.model) agentModels.set(agentId, rec.model);
          collector.add(rec);
        }
      }
      if (!sawLines) continue;
      const summary = collector.summarize();
      const r = applyTranscript(this.state, sessionId, {
        aiTitle,
        tokens: {
          input: summary.totals.input_tokens,
          output: summary.totals.output_tokens,
          cacheCreate: summary.totals.cache_creation_input_tokens,
          cacheRead: summary.totals.cache_read_input_tokens,
          total: summary.totals.totalTokens,
          messages: summary.uniqueMessages,
        },
        tokensAt: new Date().toISOString(),
      });
      this.state = r.state;
      changed = changed || r.changed;

      if (agentModels.size) {
        const m = applyAgentMeta(this.state, sessionId, [...agentModels].map(([agentId, model]) => ({
          agentId,
          model,
          modelSource: 'transcript',
        })));
        this.state = m.state;
        changed = changed || m.changed;
      }
    }
    if (changed) this.markChanged();
    return changed;
  }

  /* -------------------------------- output -------------------------------- */

  recordError(where, err) {
    const entry = {
      at: new Date().toISOString(),
      where: String(where),
      message: String((err && err.message) || err),
    };
    this.recentErrors.push(entry);
    if (this.recentErrors.length > 20) this.recentErrors.shift();
  }

  /** Total number of ingest problems, for the header counter in the UI. */
  errorCount() {
    const c = this.counters;
    return (
      c.hookParseFailures +
      c.hookReadErrors +
      c.sessionsErrors +
      c.statuslineErrors +
      c.transcriptErrors +
      c.indexErrors +
      c.watchErrors +
      c.tickErrors
    );
  }

  stats() {
    return {
      ...this.counters,
      errorCount: this.errorCount(),
      unknownEvents: Object.fromEntries(this.ingest.unknownEvents),
      recentErrors: this.recentErrors.slice(-5),
      activeDates: [...this.activeDates].sort(),
      eventsKeepDays: this.eventsKeepDays,
      watchers: this.watchers.length,
      sessionsTracked: Object.keys(this.state.sessions).length,
      indexedSessions: this.indexBySession.size,
      tailedFiles: this.transcriptTail.states.size,
      usageCollectors: this.usage.size,
      uptimeMs: Date.now() - this.startedAt,
    };
  }

  sources() {
    return {
      eventsDir: this.eventsDir,
      statuslineDir: this.statuslineDir,
      projectsRoot: this.projectsRoot,
      sessionsDir: this.sessionsDir,
      watch: this.useWatch,
    };
  }

  snapshot() {
    return buildSnapshot(this.state, {
      stats: this.stats(),
      sources: this.sources(),
      serverStartedAt: this.startedAt,
    });
  }

  /**
   * Forget the oldest archived sessions and the usage collectors that went with
   * them. Runs once per debounced emit rather than inside one poller: a session
   * can become archived through ANY source - most importantly `pollSessions`,
   * which is the path for a process that died without a clean SessionEnd hook,
   * and which may be the only thing still moving if no hooks fire at all.
   */
  prune() {
    const pruned = pruneSessions(this.state);
    if (!pruned.changed) return false;
    const dropped = Object.keys(this.state.sessions).filter((id) => !pruned.state.sessions[id]);
    // Resolve the file list BEFORE the records leave state - filesForSession()
    // reads this.state.sessions[id] and this.indexBySession.
    /** @type {string[]} */
    const files = [];
    for (const id of dropped) files.push(...this.filesForSession(id));

    this.state = pruned.state;
    for (const id of dropped) {
      this.usage.delete(id);
      this.indexBySession.delete(id);
    }
    // Byte offsets are keyed by file path and would otherwise outlive every
    // session that ever ran.
    for (const f of files) this.forgetFile(f);
    return true;
  }

  /** Release the tail offset (and the indexedFiles entry) for one file. */
  forgetFile(file) {
    this.transcriptTail.reset(file);
    this.indexedFiles.delete(path.resolve(file));
  }

  /** Coalesce bursts of file activity into one 'change' emit. */
  markChanged() {
    this.pendingChange = true;
    if (this.debounceTimer) return;
    const fire = () => {
      this.debounceTimer = null;
      if (!this.pendingChange) return;
      this.pendingChange = false;
      this.prune();
      this.counters.changes += 1;
      this.emit('change');
    };
    // The whole emit runs inside safeTick, because this is the third place
    // with no catch site above it: a setTimeout callback. `emit('change')`
    // calls straight into the server's SSE broadcast, and a listener that
    // throws (a snapshot that will not serialize, a socket in a state we did
    // not expect) would otherwise become an uncaughtException and take the
    // monitor down - the one failure mode 4.7 exists to prevent.
    const guarded = () => this.safeTick('emit-change', fire);
    if (this.debounceMs <= 0) {
      guarded();
      return;
    }
    this.debounceTimer = setTimeout(guarded, this.debounceMs);
    if (typeof this.debounceTimer.unref === 'function') this.debounceTimer.unref();
  }
}

export default Collector;
