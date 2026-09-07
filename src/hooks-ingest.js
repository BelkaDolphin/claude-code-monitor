/**
 * Read and normalize the events written by hooks/monitor-hook.js.
 *
 * Hooks are the FIRST-CLASS source of live state (running / idle / tool running
 * / subagent lifecycle / notifications). The transcript jsonl only tells us what
 * was written to disk after the fact; sessions/<pid>.json only has a coarse
 * status. Priority: hooks > sessions > jsonl.
 *
 * Common hook input fields (docs, verbatim list): session_id, prompt_id,
 * transcript_path, cwd, permission_mode, effort, hook_event_name. Inside a
 * subagent (or with --agent) the input additionally carries agent_id and
 * agent_type. Event-specific extras used here:
 *   Stop / SubagentStop : last_assistant_message, stop_hook_active
 *   SubagentStop        : agent_transcript_path  (NOT present on SubagentStart)
 *   SessionEnd          : reason  (clear|resume|logout|prompt_input_exit|other)
 *   Notification        : notification_type
 *   PreToolUse/PostToolUse : tool_name, tool_input, tool_use_id
 *   PostToolUse         : tool_response
 */

import fs from 'node:fs';
import path from 'node:path';
import { eventsDir, localDateKey } from './paths.js';
import { JsonlTail } from './jsonl-tail.js';

/** Events we install hooks for and understand. */
export const TRACKED_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'UserPromptSubmit',
  'Stop',
  'SubagentStart',
  'SubagentStop',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'PreCompact',
  'PostCompact',
];

const TRACKED = new Set(TRACKED_EVENTS);

/**
 * @typedef {Object} MonitorEvent
 * @property {string} receivedAt   ISO time the hook script ran
 * @property {number} receivedMs
 * @property {string} event        hook_event_name (or '(unknown)')
 * @property {boolean} known       whether it is in TRACKED_EVENTS
 * @property {string|null} sessionId
 * @property {string|null} agentId
 * @property {string|null} agentType
 * @property {string|null} cwd
 * @property {string|null} toolName
 * @property {string|null} toolUseId
 * @property {string|null} notificationType
 * @property {string|null} reason
 * @property {string|null} permissionMode
 * @property {string|null} transcriptPath
 * @property {string|null} agentTranscriptPath
 * @property {any} raw
 */

/** @param {any} o */
export function normalizeEvent(o) {
  if (!o || typeof o !== 'object') return null;
  const event = str(o.hookEventName) ?? str(o.hook_event_name) ?? '(unknown)';
  const receivedAt = str(o.receivedAt) ?? null;
  return {
    receivedAt,
    receivedMs: receivedAt ? Date.parse(receivedAt) : NaN,
    event,
    known: TRACKED.has(event),
    sessionId: str(o.session_id) ?? str(o.sessionId),
    promptId: str(o.prompt_id),
    agentId: str(o.agent_id),
    agentType: str(o.agent_type),
    cwd: str(o.cwd),
    permissionMode: str(o.permission_mode),
    transcriptPath: str(o.transcript_path),
    agentTranscriptPath: str(o.agent_transcript_path),
    toolName: str(o.tool_name),
    toolUseId: str(o.tool_use_id),
    notificationType: str(o.notification_type),
    // Notification payloads carry a human-readable `message`
    // (measured: "Claude is waiting for your input" for idle_prompt).
    message: str(o.message),
    reason: str(o.reason),
    stopHookActive: o.stop_hook_active === true,
    lastAssistantMessage: typeof o.last_assistant_message === 'string' ? o.last_assistant_message : null,
    raw: o,
  };
}

function str(v) {
  return typeof v === 'string' && v.length ? v : null;
}

/** The only file name we ever create in - or delete from - the events dir. */
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

/** List available event date keys, newest last. */
export function listEventDates(dir = eventsDir()) {
  let ents;
  try {
    ents = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return ents
    .filter((f) => DAY_FILE_RE.test(f))
    .map((f) => f.slice(0, -'.jsonl'.length))
    .sort();
}

/**
 * How many days of `<monitorDir>/events/<date>.jsonl` we keep.
 *
 * Measured at ~7MB/day on one busy machine, and nothing was ever deleting
 * them. 30 days matches the window Claude Code itself keeps transcripts for
 * (known constraint 7), so beyond it the Tree view has no transcript to pair
 * the hook history with anyway.
 */
export const EVENTS_KEEP_DAYS = 30;

/**
 * Delete day files older than the retention window.
 *
 * Deletion is deliberately narrow: only inside our OWN events directory, only
 * names that are exactly `YYYY-MM-DD.jsonl`, and only dates strictly older
 * than the cutoff. Anything else in that directory is left alone.
 *
 * @param {Object} [opts]
 * @param {string} [opts.dir]
 * @param {number} [opts.keepDays]  0 or less disables pruning entirely
 * @param {Date|number} [opts.now]
 * @param {(where: string, err: any) => void} [opts.onError]
 * @returns {{deleted: string[], cutoff: string|null, errors: number}}
 */
export function pruneEventFiles(opts = {}) {
  const keepDays = Number.isFinite(opts.keepDays) ? opts.keepDays : EVENTS_KEEP_DAYS;
  if (!(keepDays > 0)) return { deleted: [], cutoff: null, errors: 0 };
  const dir = opts.dir ?? eventsDir();
  const now = opts.now instanceof Date ? opts.now : new Date(opts.now ?? Date.now());
  // keepDays counts calendar days INCLUDING today, so keepDays=1 keeps only
  // today's file and keepDays=30 keeps today plus the previous 29.
  const cutoff = localDateKey(new Date(now.getTime() - (keepDays - 1) * 24 * 3600 * 1000));
  if (!cutoff) return { deleted: [], cutoff: null, errors: 0 };
  const deleted = [];
  let errors = 0;
  for (const dateKey of listEventDates(dir)) {
    if (dateKey >= cutoff) continue;
    try {
      fs.rmSync(path.join(dir, `${dateKey}.jsonl`), { force: true });
      deleted.push(dateKey);
    } catch (err) {
      errors += 1;
      if (typeof opts.onError === 'function') opts.onError(`events-prune:${dateKey}`, err);
    }
  }
  return { deleted, cutoff, errors };
}

/**
 * Incremental event reader. Keeps byte offsets per day-file so repeated calls
 * only surface new events.
 */
export class HooksIngest {
  /** @param {{dir?: string, tail?: JsonlTail}} [opts] */
  constructor(opts = {}) {
    this.dir = opts.dir ?? eventsDir();
    this.tail = opts.tail ?? new JsonlTail();
    this.parseFailures = 0;
    /** @type {Map<string, number>} */
    this.unknownEvents = new Map();
  }

  /** @param {string} dateKey e.g. '2026-09-02' */
  fileFor(dateKey) {
    return path.join(this.dir, `${dateKey}.jsonl`);
  }

  /**
   * Read new events for one day.
   * @param {string} dateKey
   * @returns {MonitorEvent[]}
   */
  readDay(dateKey) {
    const file = this.fileFor(dateKey);
    const { lines } = this.tail.read(file);
    /** @type {MonitorEvent[]} */
    const out = [];
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      let obj;
      try {
        obj = JSON.parse(t);
      } catch {
        this.parseFailures++;
        continue;
      }
      const ev = normalizeEvent(obj);
      if (!ev) continue;
      if (!ev.known) this.unknownEvents.set(ev.event, (this.unknownEvents.get(ev.event) || 0) + 1);
      out.push(ev);
    }
    return out;
  }

  /**
   * Read new events across every day file (or the given days).
   * @param {{dates?: string[]}} [opts]
   */
  readAll(opts = {}) {
    const dates = opts.dates ?? listEventDates(this.dir);
    /** @type {MonitorEvent[]} */
    const out = [];
    for (const d of dates) out.push(...this.readDay(d));
    out.sort((a, b) => (a.receivedMs || 0) - (b.receivedMs || 0));
    return out;
  }

  /** Re-read a day from the beginning (used by one-shot CLI queries). */
  rereadDay(dateKey) {
    this.tail.reset(this.fileFor(dateKey));
    return this.readDay(dateKey);
  }
}

/**
 * Fold an event stream into per-session and per-agent live state.
 * @param {MonitorEvent[]} events
 */
export function foldState(events) {
  /** @type {Map<string, any>} */
  const sessions = new Map();
  /** @type {Map<string, any>} */
  const agents = new Map();
  const startedAgentIds = new Set();
  const stoppedAgentIds = new Set();

  for (const ev of events) {
    if (ev.sessionId) {
      const s = sessions.get(ev.sessionId) ?? {
        sessionId: ev.sessionId,
        cwd: null,
        state: 'unknown',
        lastEvent: null,
        lastEventAt: null,
        startedAt: null,
        endedAt: null,
        activeTool: null,
        pendingNotification: null,
        endedReason: null,
      };
      s.cwd = ev.cwd ?? s.cwd;
      s.lastEvent = ev.event;
      s.lastEventAt = ev.receivedAt;
      switch (ev.event) {
        // Same rule as state.js: the EARLIEST SessionStart owns the start time
        // (a resume fires another one), and any sign of life clears the end.
        case 'SessionStart':
          s.state = 'idle';
          s.endedReason = null;
          if (!s.startedAt) s.startedAt = ev.receivedAt ?? null;
          s.endedAt = null;
          break;
        case 'UserPromptSubmit': s.state = 'working'; s.endedAt = null; break;
        case 'PreToolUse': if (!ev.agentId) { s.state = 'tool-running'; s.activeTool = ev.toolName; } break;
        case 'PostToolUse':
        case 'PostToolUseFailure': if (!ev.agentId) { s.state = 'working'; s.activeTool = null; } break;
        case 'Stop': s.state = 'idle'; s.activeTool = null; break;
        case 'Notification': s.pendingNotification = ev.notificationType; break;
        case 'SessionEnd':
          s.state = 'ended';
          s.endedReason = ev.reason;
          s.endedAt = ev.receivedAt ?? null;
          s.activeTool = null;
          break;
        case 'PreCompact': s.state = 'compacting'; break;
        case 'PostCompact': s.state = 'working'; break;
        default: break;
      }
      sessions.set(ev.sessionId, s);
    }
    if (ev.agentId) {
      const a = agents.get(ev.agentId) ?? {
        agentId: ev.agentId,
        agentType: ev.agentType,
        sessionId: ev.sessionId,
        state: 'unknown',
        startedAt: null,
        stoppedAt: null,
        activeTool: null,
        transcriptPath: null,
      };
      a.agentType = ev.agentType ?? a.agentType;
      if (ev.event === 'SubagentStart') { a.state = 'running'; a.startedAt = ev.receivedAt; startedAgentIds.add(ev.agentId); }
      else if (ev.event === 'SubagentStop') {
        a.state = 'stopped';
        a.stoppedAt = ev.receivedAt;
        a.transcriptPath = ev.agentTranscriptPath ?? a.transcriptPath;
        stoppedAgentIds.add(ev.agentId);
      } else if (ev.event === 'PreToolUse') { a.activeTool = ev.toolName; if (a.state === 'unknown') a.state = 'running'; }
      else if (ev.event === 'PostToolUse' || ev.event === 'PostToolUseFailure') { a.activeTool = null; }
      agents.set(ev.agentId, a);
    }
  }
  return { sessions, agents, startedAgentIds, stoppedAgentIds };
}

/** Today's date key, matching the file naming used by monitor-hook.js. */
export function todayKey(now = new Date()) {
  return localDateKey(now);
}
