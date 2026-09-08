/**
 * The live state model.
 *
 * Pure functions over a plain, JSON-serialisable object so the whole thing can
 * be exercised without touching disk, a clock or a socket. Nothing here does
 * I/O; src/collector.js feeds it.
 *
 * Four independent sources write into one session record, in this priority:
 *
 *   hooks      -> `phase` (the state machine below), tools, subagents,
 *                 notifications, cwd, transcript path
 *   sessions/  -> pid, liveness, and a coarse `status` used ONLY as a fallback
 *                 phase for sessions that started before our hooks existed
 *   statusline -> model, context %, cost, rate_limits (nowhere else to get them)
 *   transcript -> ai-title and token totals
 *
 * Phase state machine (hook driven):
 *
 *   SessionStart                                   -> idle
 *   UserPromptSubmit                               -> busy
 *   PreToolUse (main thread)                       -> busy + currentTool
 *   PostToolUse / PostToolUseFailure               -> currentTool cleared
 *   Notification permission_prompt                 -> waiting_permission
 *   Notification idle_prompt / agent_needs_input   -> waiting_input
 *   Stop                                           -> idle
 *   PreCompact                                     -> compacting (prev saved)
 *   PostCompact                                    -> the phase before compact
 *   SessionEnd                                     -> ended (+ reason)
 *
 * `startedAt` / `endedAt` sit beside that machine and follow two rules of their
 * own: the FIRST source to name a start owns it (SessionStart fires again on a
 * resume, and sessions/<pid>.json may have got there first), and an end time is
 * WITHDRAWN by any later sign of life. Both carry a `*Source` sibling, and
 * both leave here as ISO strings whichever shape they arrived in.
 *
 * A dead PID outranks everything: `alive === false` forces phase `dead`.
 * `alive === null` means "we have no sessions/<pid>.json for this session",
 * which is NOT evidence of death and never forces `dead`.
 *
 * LIVENESS IS POSITIVE EVIDENCE, never the absence of an ending (see isLive).
 * The statusline sidecar directory keeps one file per session FOREVER, so
 * applyStatusline creates a record for sessions that ended days ago. Those have
 * no hook phase, no sessions/<pid>.json and phase `unknown`; counting them as
 * live is how the header came to read "3 稼働" with one session running.
 *
 * `stale` is the session-level twin of the agent sweep: hooks said busy (or
 * idle, after a Stop), no SessionEnd ever came, and neither a PID nor the
 * transcript says otherwise.
 * It is INFERENCE (`phaseSource: 'inferred'`) and any later hook event undoes
 * it - see touchSession.
 *
 * Subagent-scoped tool events (those carrying agent_id) update the AGENT's
 * currentTool and tool counter. They also fill the session's currentTool, but
 * only while the main thread has none - otherwise a background agent would hide
 * what the user's own turn is doing.
 */

export const PHASES = [
  'unknown',
  'idle',
  'busy',
  'waiting_permission',
  'waiting_input',
  'compacting',
  'stale',
  'ended',
  'dead',
];

/** Notification types that move the session into a "needs you" phase. */
export const WAITING_NOTIFICATIONS = {
  permission_prompt: 'waiting_permission',
  idle_prompt: 'waiting_input',
  agent_needs_input: 'waiting_input',
};

/** Notification types the UI raises a desktop notification for. */
export const NOTIFY_TYPES = ['permission_prompt', 'idle_prompt', 'agent_needs_input', 'agent_completed'];

const MAX_NOTIFICATIONS = 20;
/**
 * Finished subagents kept per session. Measured on real data: a single session
 * produced 13 SubagentStop events in one afternoon and there is no upper bound,
 * so an always-on server would grow its snapshot without one.
 */
export const MAX_COMPLETED_AGENTS = 30;
/** Ended/dead sessions kept in memory (the Live view collapses them anyway). */
export const MAX_ARCHIVED_SESSIONS = 50;

/**
 * How long a PreToolUse may sit without its PostToolUse before we stop
 * claiming the tool is still running.
 *
 * MEASURED COUNTEREXAMPLE: agent a458ad0670a1f500e ran one tool from
 * 14:39:42Z to 14:56:54Z - 17m12s - and its PostToolUse did arrive. So this
 * threshold WILL misfire on genuinely long tools. That is acceptable only
 * because clearing `currentTool` is cosmetic and fully reversible: a late
 * PostToolUse (or any other event for that agent) revives the record.
 */
export const TOOL_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * How long an agent may be silent before we stop calling it "running".
 * SubagentStop is not reliable (measured: 29 stops for 1 start, and agents
 * with no lifecycle events at all), so silence is the only other evidence.
 */
export const AGENT_STALE_MS = 10 * 60 * 1000;

/**
 * How long a session may claim to be working with no hook event, no live PID
 * and no transcript growth before we stop believing it.
 *
 * Deliberately three times AGENT_STALE_MS: a session is quiet for as long as
 * its longest tool runs (measured: 17m12s for one Bash call), and unlike an
 * agent it has no SubagentStop to fall back on - only SessionEnd, which is
 * exactly the event that never arrives when Claude Code is killed.
 * Measured case: ea1b82f5's last event is a PostToolUse at 2026-09-02T23:59:50
 * and it sat "busy" for days.
 */
export const SESSION_STALE_MS = 30 * 60 * 1000;

/** hookPhases that claim the session is working right now. */
const HOOK_LIVE_PHASES = new Set(['busy', 'waiting_permission', 'waiting_input', 'compacting']);

/**
 * hookPhases the stale sweep may take down. 'idle' is included even though it
 * claims no work: isLive() counts a hooks-sourced idle as 稼働, and a session
 * whose last event was a Stop and whose process then died without a
 * SessionEnd (window closed, machine rebooted, monitor restarted after the
 * sessions/<pid>.json was gone) would otherwise sit in the live list forever.
 * Measured: 77b69db3's last event was a Stop at 2026-09-06T15:34 and it was
 * still "live" two days later.
 */
const HOOK_SWEEP_PHASES = new Set([...HOOK_LIVE_PHASES, 'idle']);

/** Longest prompt excerpt kept in state; the UI trims further. */
const MAX_PROMPT_CHARS = 200;

/**
 * Claude Code writes its own `ai-title` records, and it regenerates them from
 * the newest prompt. When that prompt is an attachment the title becomes the
 * attachment placeholder - measured: sending an image rewrote the title to
 * "Image #1". Those carry no information about the session, so they are
 * refused and the previous good title (or the cwd) stays.
 *
 * Written to stay LINEAR. The first version ended `\s*#?\d*\s*\]?$`, which put
 * two nullable `\s*` runs next to each other: on a long non-matching string
 * ("image" + many spaces + "x") the engine tried every way of splitting the
 * spaces between them, which is quadratic - measured 265ms at 16k characters,
 * and the input is a title that arrives from a transcript file. The numeric
 * part is now one alternation that must end on `\d+` or on `#`, so no two
 * adjacent groups can both match the same space.
 */
const PLACEHOLDER_TITLE_RE = /^\[?\s*(?:image|screenshot|pasted(?:\s+\w+)?|attachment|file)(?:\s*#?\d+|\s*#)?\s*\]?$/i;

/**
 * Longest title we bother pattern-matching. A placeholder is a handful of
 * characters; anything past this is real text and is useful by definition.
 * The cap is also the backstop for the regex above: no input reaches it long
 * enough for even a linear scan to cost anything.
 */
const MAX_TITLE_MATCH_CHARS = 200;

/** @param {unknown} t @returns {boolean} */
export function isUsefulTitle(t) {
  if (typeof t !== 'string') return false;
  const trimmed = t.trim();
  if (!trimmed) return false;
  if (trimmed.length > MAX_TITLE_MATCH_CHARS) return true;
  return !PLACEHOLDER_TITLE_RE.test(trimmed);
}

/** Collapse whitespace and cap the length of a prompt excerpt. */
export function excerpt(text, max = MAX_PROMPT_CHARS) {
  if (typeof text !== 'string') return null;
  const flat = text.replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** @returns {{sessions: Record<string, any>, revision: number}} */
export function createState() {
  return { sessions: {}, revision: 0 };
}

/** @param {string} sessionId */
export function emptySession(sessionId) {
  return {
    sessionId,
    cwd: null,
    projectDirName: null,
    title: null,
    aiTitle: null,
    name: null,
    pid: null,
    alive: null,
    aliveSource: null,
    pidReused: null,
    sessionsStatus: null,
    startedAt: null,
    startedAtSource: null,
    endedAt: null,
    endedAtSource: null,
    version: null,
    model: null,
    contextPct: null,
    costUsd: null,
    rateLimits: {},
    statuslineAt: null,
    hookPhase: null,
    phaseBeforeCompact: null,
    phaseBeforeStale: null,
    staleAt: null,
    staleReason: null,
    endedReason: null,
    currentTool: null,
    agents: {},
    notifications: [],
    notificationSeq: 0,
    lastEventAt: null,
    lastEventName: null,
    firstEventAt: null,
    toolCount: 0,
    transcriptPath: null,
    jsonlPath: null,
    tokens: null,
    tokensAt: null,
    lastPrompt: null,
    lastPromptAt: null,
  };
}

function emptyAgent(agentId, agentType) {
  return {
    agentId,
    agentType: agentType ?? null,
    description: null,
    model: null,
    modelSource: null,
    startedAt: null,
    endedAt: null,
    lastEventAt: null,
    status: 'running',
    statusSource: 'hooks',
    staleAt: null,
    staleReason: null,
    tools: 0,
    errors: 0,
    currentTool: null,
    agentTranscriptPath: null,
  };
}

/**
 * Any hook event for an agent is proof of life: it revives a record we had
 * given up on. Without this, the stale sweep would be a one-way door and a
 * long-running agent (see TOOL_TIMEOUT_MS) could never come back.
 */
function touchAgent(a, at) {
  if (at) a.lastEventAt = at;
  if (a.status === 'stale') {
    a.status = 'running';
    a.statusSource = 'hooks';
    a.staleAt = null;
    a.staleReason = null;
  }
  return a;
}

/**
 * Any hook event for a session is proof of life, exactly as touchAgent is for a
 * subagent: it undoes the stale sweep and restores the phase the session held
 * when we gave up on it. Without this the sweep would be a one-way door and a
 * session that merely ran a very long tool could never come back.
 */
function touchSession(s) {
  if (s.hookPhase !== 'stale') return s;
  s.hookPhase = s.phaseBeforeStale ?? 'busy';
  s.phaseBeforeStale = null;
  s.staleAt = null;
  s.staleReason = null;
  return s;
}

/** sessions/<pid>.json `status` -> a phase, when no hook has ever been seen. */
export function phaseFromSessionsStatus(status) {
  if (typeof status !== 'string' || !status) return 'unknown';
  const s = status.toLowerCase();
  if (s === 'busy' || s === 'working' || s === 'running') return 'busy';
  if (s === 'idle' || s === 'ready' || s === 'waiting') return 'idle';
  return 'unknown';
}

/**
 * Resolve the phase actually shown, and say where it came from.
 * @param {any} s a session record
 * @returns {{phase: string, phaseSource: string}}
 */
export function derivePhase(s) {
  if (!s) return { phase: 'unknown', phaseSource: 'none' };
  if (s.alive === false) return { phase: 'dead', phaseSource: 'pid' };
  // 'stale' came from the sweep, not from a hook, and the UI has to be able to
  // say so - the same contract subagents get via statusSource: 'inferred'.
  if (s.hookPhase === 'stale') return { phase: 'stale', phaseSource: 'inferred' };
  if (s.hookPhase) return { phase: s.hookPhase, phaseSource: 'hooks' };
  if (s.sessionsStatus) return { phase: phaseFromSessionsStatus(s.sessionsStatus), phaseSource: 'sessions' };
  return { phase: 'unknown', phaseSource: 'none' };
}

/** Phases that are an ending, whatever else we know. */
const NOT_LIVE_PHASES = new Set(['dead', 'ended', 'stale']);

/**
 * Is this session live? THE one answer - counts, ordering, the tree list and
 * the transcript poller all ask here.
 *
 * Liveness needs POSITIVE evidence, because "not obviously finished" is the
 * default state of every record we ever create and most of them are junk:
 * applyStatusline mints a session for every file in the sidecar directory, and
 * that directory is never pruned. Such a record has phase 'unknown' with
 * phaseSource 'none' - literally "we have never heard anything about this" -
 * and it must not be counted.
 *
 * The evidence, any one of which is enough:
 *   - alive === true          a PID we checked is running
 *   - phaseSource 'hooks'     a hook phase that is not ended/stale
 *   - phaseSource 'sessions'  sessions/<pid>.json named a status
 *
 * Accepts BOTH shapes - a raw state record and the toPublicSession wire shape -
 * because tree-view and tree-merge only ever see the latter.
 *
 * @param {any} s
 */
export function isLive(s) {
  if (!s) return false;
  const d = typeof s.phase === 'string' && s.phase && typeof s.phaseSource === 'string' && s.phaseSource
    ? { phase: s.phase, phaseSource: s.phaseSource }
    : derivePhase(s);
  if (NOT_LIVE_PHASES.has(d.phase)) return false;
  if (s.alive === true) return true;
  return d.phaseSource === 'hooks' || d.phaseSource === 'sessions';
}

function str(v) {
  return typeof v === 'string' && v.length ? v : null;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * One shape on the wire. `startedAt` arrives as an ISO string from hooks and
 * as epoch ms from sessions/<pid>.json; a consumer that has to guess which one
 * it got is a consumer that will eventually guess wrong.
 * @param {string|number|null|undefined} v
 * @returns {string|null} ISO 8601, or null
 */
export function isoTime(v) {
  if (typeof v === 'string' && v) return Number.isFinite(Date.parse(v)) ? v : null;
  if (typeof v === 'number' && Number.isFinite(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

function putSession(state, session) {
  return {
    ...state,
    revision: (state.revision || 0) + 1,
    sessions: { ...state.sessions, [session.sessionId]: session },
  };
}

/**
 * Forget the end time. `endedAt` is a claim that the session is over, so it
 * must be dropped the moment the session speaks again - otherwise a resumed
 * session would keep showing the moment it was last closed.
 */
function clearEnd(s) {
  s.endedAt = null;
  s.endedAtSource = null;
}

/* ------------------------------ hook events ------------------------------ */

/**
 * Fold one normalized hook event (see hooks-ingest.normalizeEvent) into state.
 * Never throws on unknown event names or missing fields.
 *
 * @param {{sessions: Record<string, any>}} state
 * @param {any} event
 * @returns {{state: any, changed: boolean}}
 */
export function reduce(state, event) {
  if (!state || typeof state !== 'object') return { state: createState(), changed: false };
  if (!event || typeof event !== 'object') return { state, changed: false };
  const sessionId = str(event.sessionId);
  if (!sessionId) return { state, changed: false };

  const prev = state.sessions[sessionId] ?? emptySession(sessionId);
  const s = { ...prev };
  const name = str(event.event) ?? '(unknown)';
  const at = str(event.receivedAt);
  const agentId = str(event.agentId);

  touchSession(s);
  s.lastEventName = name;
  if (at) s.lastEventAt = at;
  if (at && !s.firstEventAt) s.firstEventAt = at;
  if (str(event.cwd)) s.cwd = str(event.cwd);
  if (str(event.transcriptPath)) s.transcriptPath = str(event.transcriptPath);

  switch (name) {
    case 'SessionStart':
      s.hookPhase = 'idle';
      s.endedReason = null;
      s.currentTool = null;
      // The FIRST source to name a start time wins: sessions/<pid>.json is
      // written by Claude Code itself and predates our hook, and a resumed
      // session fires SessionStart again - overwriting here would move the
      // start of a session that began hours ago to just now.
      if (at && !s.startedAt) {
        s.startedAt = at;
        s.startedAtSource = 'hooks';
      }
      clearEnd(s);
      break;

    case 'UserPromptSubmit':
      s.hookPhase = 'busy';
      // A prompt in a session we had recorded as finished means it was resumed:
      // it is alive again and its old end time is no longer an end.
      clearEnd(s);
      // The prompt is shown on its own line and is NEVER the title: it changes
      // every turn, and an attachment-only message would rename the card to
      // something like "Image #1".
      s.lastPrompt = excerpt(str(event.prompt) ?? str(event.raw && event.raw.prompt));
      s.lastPromptAt = at;
      break;

    case 'PreToolUse': {
      const tool = {
        name: str(event.toolName) ?? '(tool)',
        toolUseId: str(event.toolUseId),
        since: at,
        agentId,
      };
      if (agentId) {
        const agents = { ...s.agents };
        const a = touchAgent({ ...(agents[agentId] ?? emptyAgent(agentId, str(event.agentType))) }, at);
        if (str(event.agentType)) a.agentType = str(event.agentType);
        if (!a.startedAt) a.startedAt = at;
        if (a.status !== 'completed') a.status = 'running';
        a.tools += 1;
        a.currentTool = tool;
        agents[agentId] = a;
        s.agents = agents;
        // A subagent running a tool means the SESSION is working, even if we
        // never saw its SessionStart or UserPromptSubmit. Only fills a gap -
        // it must not overwrite idle/waiting/ended with busy.
        if (!s.hookPhase) s.hookPhase = 'busy';
        // Only surface an agent's tool at session level when the main thread
        // has nothing running of its own.
        if (!s.currentTool || s.currentTool.agentId) s.currentTool = tool;
      } else {
        s.hookPhase = 'busy';
        s.currentTool = tool;
        s.toolCount += 1;
      }
      break;
    }

    case 'PostToolUse':
    case 'PostToolUseFailure': {
      const failed = name === 'PostToolUseFailure';
      if (agentId) {
        const agents = { ...s.agents };
        const a = touchAgent({ ...(agents[agentId] ?? emptyAgent(agentId, str(event.agentType))) }, at);
        if (str(event.agentType)) a.agentType = str(event.agentType);
        if (failed) a.errors += 1;
        a.currentTool = null;
        agents[agentId] = a;
        s.agents = agents;
        if (!s.hookPhase) s.hookPhase = 'busy';
      } else if (!s.hookPhase) {
        // A tool finished, so the session is clearly working even though we
        // missed its SessionStart / UserPromptSubmit.
        s.hookPhase = 'busy';
      }
      if (matchesCurrentTool(s.currentTool, event, agentId)) s.currentTool = null;
      break;
    }

    case 'Notification': {
      const type = str(event.notificationType) ?? '(notification)';
      s.notificationSeq += 1;
      const entry = {
        id: `${sessionId}#${s.notificationSeq}`,
        type,
        message: str(event.message) ?? str(event.raw && event.raw.message),
        at,
        agentId,
      };
      s.notifications = [...s.notifications, entry].slice(-MAX_NOTIFICATIONS);
      const phase = WAITING_NOTIFICATIONS[type];
      if (phase) s.hookPhase = phase;
      break;
    }

    case 'Stop':
      s.hookPhase = 'idle';
      s.currentTool = null;
      break;

    case 'SubagentStart': {
      if (agentId) {
        const agents = { ...s.agents };
        const a = touchAgent({ ...(agents[agentId] ?? emptyAgent(agentId, str(event.agentType))) }, at);
        a.agentType = str(event.agentType) ?? a.agentType;
        a.startedAt = at ?? a.startedAt;
        a.status = 'running';
        a.statusSource = 'hooks';
        a.endedAt = null;
        agents[agentId] = a;
        s.agents = agents;
        // Spawning an agent is the session working. Gap-fill only, as above.
        if (!s.hookPhase) s.hookPhase = 'busy';
      }
      break;
    }

    case 'SubagentStop': {
      if (agentId) {
        const agents = { ...s.agents };
        const a = { ...(agents[agentId] ?? emptyAgent(agentId, str(event.agentType))) };
        if (at) a.lastEventAt = at;
        a.agentType = str(event.agentType) ?? a.agentType;
        // A real stop always wins over an inferred one: stale -> completed.
        a.status = 'completed';
        a.statusSource = 'hooks';
        a.staleAt = null;
        a.staleReason = null;
        a.endedAt = at;
        a.currentTool = null;
        // agent_transcript_path exists on SubagentStop only (never on Start).
        a.agentTranscriptPath = str(event.agentTranscriptPath) ?? a.agentTranscriptPath;
        agents[agentId] = a;
        s.agents = pruneAgents(agents);
        if (s.currentTool && s.currentTool.agentId === agentId) s.currentTool = null;
      }
      break;
    }

    case 'PreCompact':
      if (s.hookPhase !== 'compacting') s.phaseBeforeCompact = s.hookPhase;
      s.hookPhase = 'compacting';
      break;

    case 'PostCompact':
      s.hookPhase = s.phaseBeforeCompact ?? 'busy';
      s.phaseBeforeCompact = null;
      break;

    case 'SessionEnd':
      s.hookPhase = 'ended';
      s.endedReason = str(event.reason);
      s.currentTool = null;
      if (at) {
        s.endedAt = at;
        s.endedAtSource = 'hooks';
      }
      break;

    default:
      // Unknown or untracked event: we still recorded lastEvent*.
      break;
  }

  return { state: putSession(state, s), changed: true };
}

/**
 * Drop the oldest finished subagents once there are too many. Running agents
 * are never dropped, however old they are.
 * @param {Record<string, any>} agents
 */
function pruneAgents(agents) {
  const entries = Object.entries(agents);
  const done = entries.filter(([, a]) => a.status !== 'running');
  if (done.length <= MAX_COMPLETED_AGENTS) return agents;
  done.sort((a, b) => (Date.parse(a[1].endedAt || 0) || 0) - (Date.parse(b[1].endedAt || 0) || 0));
  const drop = new Set(done.slice(0, done.length - MAX_COMPLETED_AGENTS).map(([id]) => id));
  /** @type {Record<string, any>} */
  const out = {};
  for (const [id, a] of entries) {
    if (!drop.has(id)) out[id] = a;
  }
  return out;
}

/**
 * Forget the oldest ended/dead sessions. Live sessions are never dropped.
 * @param {any} state
 * @param {{max?: number}} [opts]
 */
export function pruneSessions(state, opts = {}) {
  const max = Number.isFinite(opts.max) ? opts.max : MAX_ARCHIVED_SESSIONS;
  const entries = Object.entries((state && state.sessions) || {});
  const archived = entries.filter(([, s]) => !isLive(s));
  if (archived.length <= max) return { state, changed: false };
  archived.sort(
    (a, b) => (Date.parse(a[1].lastEventAt || 0) || 0) - (Date.parse(b[1].lastEventAt || 0) || 0),
  );
  const drop = new Set(archived.slice(0, archived.length - max).map(([id]) => id));
  /** @type {Record<string, any>} */
  const sessions = {};
  for (const [id, s] of entries) {
    if (!drop.has(id)) sessions[id] = s;
  }
  return { state: { ...state, revision: (state.revision || 0) + 1, sessions }, changed: true };
}

function matchesCurrentTool(currentTool, event, agentId) {
  if (!currentTool) return false;
  const id = str(event.toolUseId);
  if (id && currentTool.toolUseId) return currentTool.toolUseId === id;
  return (currentTool.agentId ?? null) === (agentId ?? null);
}

/** Fold a whole batch, reporting whether anything changed. */
export function reduceAll(state, events) {
  let next = state;
  let changed = false;
  for (const ev of events || []) {
    const r = reduce(next, ev);
    next = r.state;
    changed = changed || r.changed;
  }
  return { state: next, changed };
}

/* ----------------------------- other sources ----------------------------- */

function mergeSession(state, sessionId, patch) {
  const prev = state.sessions[sessionId] ?? emptySession(sessionId);
  let dirty = !(sessionId in state.sessions);
  const next = { ...prev };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (!sameValue(prev[k], v)) {
      next[k] = v;
      dirty = true;
    }
  }
  return dirty ? { state: putSession(state, next), changed: true } : { state, changed: false };
}

function sameValue(a, b) {
  if (a === b) return true;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Apply a sessions.js listing. Sessions that were alive and have vanished from
 * the listing are marked dead - the file disappears when the process exits.
 * @param {any} state
 * @param {any[]} list
 */
export function applySessions(state, list) {
  let next = state;
  let changed = false;
  const seen = new Set();
  for (const ls of list || []) {
    const sessionId = str(ls && ls.sessionId);
    if (!sessionId) continue;
    seen.add(sessionId);
    const prev = next.sessions[sessionId];
    // Whichever source named a start time FIRST owns it (see SessionStart in
    // reduce). `undefined` is how mergeSession is told to leave a field alone.
    const startedAt = prev && prev.startedAt != null ? undefined : num(ls.startedAt);
    const r = mergeSession(next, sessionId, {
      pid: num(ls.pid),
      alive: ls.alive === true,
      aliveSource: str(ls.aliveSource),
      pidReused: ls.pidReused === true ? true : ls.pidReused === false ? false : null,
      sessionsStatus: str(ls.status),
      startedAt,
      startedAtSource: startedAt != null ? 'sessions' : undefined,
      version: str(ls.version),
      name: str(ls.name),
      cwd: (prev && prev.cwd) ?? str(ls.cwd),
    });
    next = r.state;
    changed = changed || r.changed;
  }
  for (const [id, s] of Object.entries(next.sessions)) {
    if (seen.has(id) || s.alive !== true) continue;
    const r = mergeSession(next, id, { alive: false, aliveSource: 'sessions-file-gone' });
    next = r.state;
    changed = changed || r.changed;
  }
  return { state: next, changed };
}

/**
 * Apply statusline sidecar entries (see statusline-sidecar.readSidecars).
 * @param {any} state
 * @param {any[]} entries
 */
export function applyStatusline(state, entries) {
  let next = state;
  let changed = false;
  for (const e of entries || []) {
    const sessionId = str(e && e.sessionId);
    if (!sessionId) continue;
    const prev = next.sessions[sessionId];
    const r = mergeSession(next, sessionId, {
      model: str(e.model),
      contextPct: num(e.contextUsedPct),
      costUsd: num(e.costUsd),
      rateLimits: e.rateLimits && typeof e.rateLimits === 'object' ? e.rateLimits : {},
      statuslineAt: str(e.capturedAt),
      cwd: (prev && prev.cwd) ?? str(e.cwd),
    });
    next = r.state;
    changed = changed || r.changed;
  }
  return { state: next, changed };
}

/**
 * Apply what we learned from a transcript: ai-title and token totals.
 * @param {any} state
 * @param {string} sessionId
 * @param {{aiTitle?: string|null, tokens?: any, tokensAt?: string|null,
 *          jsonlPath?: string|null, projectDirName?: string|null}} patch
 */
export function applyTranscript(state, sessionId, patch = {}) {
  if (!str(sessionId)) return { state, changed: false };
  // A placeholder ai-title must not replace a good one, so an unusable value
  // is dropped entirely rather than written as null.
  const aiTitle = patch.aiTitle === undefined || !isUsefulTitle(patch.aiTitle)
    ? undefined
    : str(patch.aiTitle);
  return mergeSession(state, sessionId, {
    aiTitle,
    tokens: patch.tokens,
    tokensAt: patch.tokensAt === undefined ? undefined : str(patch.tokensAt),
    jsonlPath: patch.jsonlPath === undefined ? undefined : str(patch.jsonlPath),
    projectDirName: patch.projectDirName === undefined ? undefined : str(patch.projectDirName),
  });
}

/**
 * Attach what `subagents/agent-<id>.meta.json` knows to agents we already
 * track. Deliberately does NOT create records: the directory holds every agent
 * the session ever spawned, and inventing cards for all of them would bury the
 * ones actually running.
 *
 * @param {any} state
 * @param {string} sessionId
 * @param {Array<{agentId: string, agentType?: string|null, description?: string|null, model?: string|null}>} metas
 */
export function applyAgentMeta(state, sessionId, metas) {
  const prev = state.sessions[str(sessionId)];
  if (!prev || !Array.isArray(metas) || !metas.length) return { state, changed: false };
  const agents = { ...prev.agents };
  let changed = false;
  for (const meta of metas) {
    const agentId = str(meta && meta.agentId);
    if (!agentId) continue;
    const a0 = agents[agentId];
    if (!a0) continue;
    const patch = {
      agentType: str(meta.agentType) ?? a0.agentType,
      description: str(meta.description) ?? a0.description,
      model: a0.model,
      modelSource: a0.modelSource ?? null,
    };
    // meta.json wins: it names the model the agent was SPAWNED with, and it is
    // the short form a human recognises. A transcript-derived model only fills
    // the gap (measured: 1 of 7 metas here had no `model`).
    const model = str(meta.model);
    const source = meta.modelSource === 'transcript' ? 'transcript' : 'meta';
    if (model && (source === 'meta' || patch.modelSource !== 'meta')) {
      patch.model = model;
      patch.modelSource = source;
    }
    if (patch.agentType === a0.agentType && patch.description === a0.description
        && patch.model === a0.model && patch.modelSource === (a0.modelSource ?? null)) {
      continue;
    }
    agents[agentId] = { ...a0, ...patch };
    changed = true;
  }
  if (!changed) return { state, changed: false };
  return { state: putSession(state, { ...prev, agents }), changed: true };
}

function tsOf(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

function toMtimeLookup(src) {
  if (typeof src === 'function') return src;
  if (src instanceof Map) return (sessionId, agentId) => src.get(`${sessionId}:${agentId}`) ?? null;
  return () => null;
}

/** Same idea as toMtimeLookup, keyed by sessionId alone. */
function toSessionMtimeLookup(src) {
  if (typeof src === 'function') return src;
  if (src instanceof Map) return (sessionId) => src.get(sessionId) ?? null;
  return () => null;
}

/**
 * Time-based cleanup for things whose closing event never arrived.
 *
 * Two independent failures are covered, both measured on real data:
 *
 *   - a PreToolUse whose PostToolUse never comes, which would otherwise show a
 *     tool "running" forever;
 *   - an agent with no SubagentStop, which would sit in the AGENTS list as a
 *     ghost and be counted in the header. Measured: agent a458ad0670a1f500e had
 *     one PreToolUse and one PostToolUse, no SubagentStart, no SubagentStop and
 *     no meta.json, and stayed "running" for over an hour;
 *   - a SESSION with no SessionEnd - Claude Code killed, the machine rebooted,
 *     the terminal closed. Measured: ea1b82f5's last event is a PostToolUse at
 *     2026-09-02T23:59:50 and it read "busy" for four days.
 *
 * The session rule needs THREE things to be true at once, because marking a
 * working session dead is the expensive mistake: hooks silent for
 * sessionStaleMs, `alive !== true` (a running PID always wins - the process is
 * right there), and the session's own transcript not growing either.
 *
 * Everything here is INFERENCE, never a fact, so it is marked as such
 * (`status: 'stale'`, `statusSource: 'inferred'`) and is fully reversible: any
 * later hook event for that agent puts it back to running, and a SubagentStop
 * promotes it to completed.
 *
 * @param {any} state
 * @param {{now?: number, toolTimeoutMs?: number, agentStaleMs?: number,
 *          sessionStaleMs?: number,
 *          agentFileMtimes?: Function|Map<string, number>,
 *          sessionFileMtimes?: Function|Map<string, number>}} [opts]
 * @returns {{state: any, changed: boolean, toolTimeouts: number,
 *            agentsStale: number, sessionsStale: number}}
 */
export function sweepStale(state, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const toolTimeoutMs = Number.isFinite(opts.toolTimeoutMs) ? opts.toolTimeoutMs : TOOL_TIMEOUT_MS;
  const agentStaleMs = Number.isFinite(opts.agentStaleMs) ? opts.agentStaleMs : AGENT_STALE_MS;
  const sessionStaleMs = Number.isFinite(opts.sessionStaleMs) ? opts.sessionStaleMs : SESSION_STALE_MS;
  const mtimeOf = toMtimeLookup(opts.agentFileMtimes);
  const sessionMtimeOf = toSessionMtimeLookup(opts.sessionFileMtimes);

  let next = state;
  let changed = false;
  let toolTimeouts = 0;
  let agentsStale = 0;
  let sessionsStale = 0;

  for (const [sessionId, prev] of Object.entries((state && state.sessions) || {})) {
    const { phase } = derivePhase(prev);
    // A session that is over takes its subagents with it - no waiting needed.
    const sessionOver = phase === 'dead' || phase === 'ended';
    const s = { ...prev };
    let dirty = false;

    const expired = (tool) => {
      const since = tsOf(tool && tool.since);
      return since === null ? false : now - since > toolTimeoutMs;
    };

    if (s.currentTool && (sessionOver || expired(s.currentTool))) {
      if (!sessionOver) toolTimeouts += 1;
      s.currentTool = null;
      dirty = true;
    }

    const agents = { ...s.agents };
    let agentsDirty = false;
    for (const [agentId, a0] of Object.entries(agents)) {
      if (a0.status !== 'running') continue;
      const a = { ...a0 };
      let aDirty = false;

      if (a.currentTool && (sessionOver || expired(a.currentTool))) {
        if (!sessionOver) toolTimeouts += 1;
        a.currentTool = null;
        aDirty = true;
      }

      if (!a.currentTool) {
        // The agent's own transcript is positive evidence of life, and it is
        // the only signal we have when hooks went missing entirely.
        const fileMs = mtimeOf(sessionId, agentId);
        const fileFresh = fileMs != null && now - fileMs < agentStaleMs;
        const lastSeen = tsOf(a.lastEventAt) ?? tsOf(a.startedAt);
        const quiet = lastSeen !== null && now - lastSeen > agentStaleMs;
        if (sessionOver || (quiet && !fileFresh)) {
          a.status = 'stale';
          a.statusSource = 'inferred';
          a.staleAt = new Date(now).toISOString();
          a.staleReason = sessionOver
            ? 'session-over'
            : fileMs != null
              ? 'silent+transcript-idle'
              : 'silent';
          agentsStale += 1;
          aDirty = true;
        }
      }

      if (aDirty) {
        agents[agentId] = a;
        agentsDirty = true;
      }
    }
    if (agentsDirty) {
      s.agents = agents;
      dirty = true;
    }

    // A session whose hooks stopped mid-turn, or that went idle and was then
    // never heard from again. `alive === true` is checked first and is
    // absolute: a PID we watched answer outranks any amount of silence, and
    // sweeping it would put a session the user is typing into behind "停止推定".
    if (s.alive !== true && HOOK_SWEEP_PHASES.has(s.hookPhase)) {
      const lastSeen = tsOf(s.lastEventAt) ?? tsOf(s.startedAt);
      const quiet = lastSeen !== null && now - lastSeen > sessionStaleMs;
      // The transcript is the same positive evidence the agent rule uses: a
      // file still growing means work is happening whatever hooks did.
      const fileMs = sessionMtimeOf(sessionId);
      const fileFresh = fileMs != null && now - fileMs < sessionStaleMs;
      if (quiet && !fileFresh) {
        s.phaseBeforeStale = s.hookPhase;
        s.hookPhase = 'stale';
        s.staleAt = new Date(now).toISOString();
        s.staleReason = s.phaseBeforeStale === 'idle'
          ? `idle with no hook event for ${Math.round(sessionStaleMs / 60000)} min, PID unknown`
          : `no hook event for ${Math.round(sessionStaleMs / 60000)} min, PID unknown`;
        sessionsStale += 1;
        dirty = true;
      }
    }

    if (dirty) {
      next = putSession(next, s);
      changed = true;
    }
  }

  return { state: next, changed, toolTimeouts, agentsStale, sessionsStale };
}

/* --------------------------------- output -------------------------------- */

/** Last path segment of a Windows or POSIX path. */
export function baseName(p) {
  if (typeof p !== 'string' || !p) return null;
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/** Display title: the transcript's ai-title, else the cwd's last segment. */
export function sessionTitle(s) {
  return s.aiTitle || s.title || baseName(s.cwd) || s.name || (s.sessionId ? s.sessionId.slice(0, 8) : 'session');
}

/** Wire shape for one session. */
export function toPublicSession(s) {
  const { phase, phaseSource } = derivePhase(s);
  const agents = Object.values(s.agents || {})
    .map(toPublicAgent)
    .sort((a, b) => (Date.parse(a.startedAt || 0) || 0) - (Date.parse(b.startedAt || 0) || 0));
  return {
    sessionId: s.sessionId,
    title: sessionTitle(s),
    aiTitle: s.aiTitle ?? null,
    cwd: s.cwd ?? null,
    projectDirName: s.projectDirName ?? null,
    pid: s.pid ?? null,
    alive: s.alive,
    aliveSource: s.aliveSource ?? null,
    pidReused: s.pidReused ?? null,
    phase,
    phaseSource,
    hookPhase: s.hookPhase ?? null,
    staleAt: s.staleAt ?? null,
    staleReason: s.staleReason ?? null,
    sessionsStatus: s.sessionsStatus ?? null,
    endedReason: s.endedReason ?? null,
    model: s.model ?? null,
    contextPct: s.contextPct ?? null,
    costUsd: s.costUsd ?? null,
    rateLimits: s.rateLimits ?? {},
    statuslineAt: s.statuslineAt ?? null,
    currentTool: s.currentTool ?? null,
    toolCount: s.toolCount ?? 0,
    agents,
    activeAgents: agents.filter((a) => a.status === 'running').length,
    notifications: s.notifications ?? [],
    lastEventAt: s.lastEventAt ?? null,
    lastEventName: s.lastEventName ?? null,
    startedAt: isoTime(s.startedAt),
    startedAtSource: s.startedAtSource ?? null,
    endedAt: isoTime(s.endedAt),
    endedAtSource: s.endedAtSource ?? null,
    version: s.version ?? null,
    tokens: s.tokens ?? null,
    tokensAt: s.tokensAt ?? null,
    lastPrompt: s.lastPrompt ?? null,
    lastPromptAt: s.lastPromptAt ?? null,
  };
}

/** Wire shape for one subagent, with a display label the UI can use as-is. */
export function toPublicAgent(a) {
  return {
    agentId: a.agentId,
    agentType: a.agentType ?? null,
    description: a.description ?? null,
    model: a.model ?? null,
    modelSource: a.modelSource ?? null,
    label: agentLabel(a),
    startedAt: a.startedAt ?? null,
    endedAt: a.endedAt ?? null,
    lastEventAt: a.lastEventAt ?? null,
    status: a.status,
    statusSource: a.statusSource ?? 'hooks',
    staleAt: a.staleAt ?? null,
    staleReason: a.staleReason ?? null,
    tools: a.tools ?? 0,
    errors: a.errors ?? 0,
    currentTool: a.currentTool ?? null,
    agentTranscriptPath: a.agentTranscriptPath ?? null,
  };
}

/**
 * What to call an agent. meta.json is the only place a human-written
 * description exists; hooks give at best an agentType, and on SubagentStop
 * even that arrives as an empty string.
 */
export function agentLabel(a) {
  const type = str(a && a.agentType);
  const desc = str(a && a.description);
  if (desc && type) return `${desc}（${type}）`;
  return desc || type || (a && a.agentId ? a.agentId.slice(0, 8) : 'agent');
}

const PHASE_ORDER = {
  waiting_permission: 0,
  waiting_input: 1,
  busy: 2,
  compacting: 3,
  idle: 4,
  unknown: 5,
  stale: 6,
  ended: 7,
  dead: 8,
};

/**
 * Build the object handed to /api/state and pushed over SSE.
 * @param {any} state
 * @param {{stats?: any, sources?: any, serverStartedAt?: number}} [extra]
 */
export function buildSnapshot(state, extra = {}) {
  const sessions = Object.values((state && state.sessions) || {}).map(toPublicSession);
  sessions.sort((a, b) => {
    const pa = PHASE_ORDER[a.phase] ?? 9;
    const pb = PHASE_ORDER[b.phase] ?? 9;
    if (pa !== pb) return pa - pb;
    return (Date.parse(b.lastEventAt || 0) || 0) - (Date.parse(a.lastEventAt || 0) || 0);
  });
  // isLive, not "not ended": see its doc. A sidecar-only session is 'unknown'
  // forever and must not reach the header.
  const live = sessions.filter(isLive);
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    serverNow: Date.now(),
    serverStartedAt: extra.serverStartedAt ?? null,
    revision: (state && state.revision) || 0,
    counts: {
      total: sessions.length,
      live: live.length,
      busy: live.filter((s) => s.phase === 'busy' || s.phase === 'compacting').length,
      waiting: live.filter((s) => s.phase === 'waiting_permission' || s.phase === 'waiting_input').length,
      agentsRunning: sessions.reduce((n, s) => n + s.activeAgents, 0),
    },
    stats: extra.stats ?? null,
    sources: extra.sources ?? null,
    sessions,
  };
}
