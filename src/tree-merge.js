/**
 * Merge the three views of a session's subagent tree into one.
 *
 * PURE. No I/O, no clock, no globals - everything arrives as an argument so
 * every precedence rule below can be exercised without touching disk. The
 * caller (src/tree-view.js) does the parsing and the caching.
 *
 * Three sources describe the same agents and none of them is complete:
 *
 *   meta.json  subagents/agent-<id>.meta.json. The ONLY place a human-written
 *              `description` and the short model name ("opus") exist. Carries
 *              NO timestamps at all (verified: 82/82 metas on this machine have
 *              exactly agentType/description/toolUseId/spawnDepth and
 *              optionally model/worktreePath/worktreeBranch/parentAgentId/
 *              spawnedWithWorktree - no time field of any kind).
 *   hooks      state.js agent records. The only source that can prove an agent
 *              FINISHED (SubagentStop) and the only one with a live
 *              `currentTool`. Exists only for sessions the collector tracks.
 *              `SubagentStop` delivers `agent_type: ""` - an empty string must
 *              never overwrite a real value (architecture 5, item 9).
 *   transcript buildTree() over the jsonl. The only source that reaches agents
 *              of sessions that ended before the monitor existed, and the only
 *              one with token totals and nesting.
 *
 * Precedence, by field:
 *
 *   status        hooks evidence > stale inference > jsonl inference
 *   agentType     meta > hooks (non-empty) > -
 *   description   meta > hooks > -
 *   model         meta > hooks > child jsonl (`message.model`)
 *   startedAt     hooks SubagentStart > first child jsonl record > the
 *                 spawning tool_use in the parent
 *   endedAt       hooks SubagentStop > last child jsonl record, but only when
 *                 the agent is considered finished
 *
 * The ROOT session node answers the same two questions from different sources -
 * hooks SessionStart/SessionEnd over the transcript's first and last records,
 * and no end time at all while the session is live. See resolveSessionSpan.
 *
 * Every resolved field carries a `*Source` sibling saying which source won, in
 * the same style as the collector's `statusInferred`/`statusSource`: an inference is
 * always labelled as one.
 *
 * Agents known ONLY to hooks (no meta.json, no transcript - the measured
 * `a458ad0670a1f500e` ghost) still get a node. They cannot be placed in the
 * tree because nothing says who spawned them, so they are returned in
 * `orphans` with `origin: 'hooks'`.
 */

import { excerpt, isLive, isUsefulTitle, sessionTitle } from './state.js';

/** Fields of usage.emptyTotals mapped to the names the UI already uses. */
export function toTokens(usage) {
  const u = usage && typeof usage === 'object' ? usage : {};
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const input = n(u.input_tokens);
  const output = n(u.output_tokens);
  const cacheCreate = n(u.cache_creation_input_tokens);
  const cacheRead = n(u.cache_read_input_tokens);
  return {
    input,
    output,
    cacheCreate,
    cacheRead,
    total: Number.isFinite(u.totalTokens) ? u.totalTokens : input + output + cacheCreate + cacheRead,
    messages: n(u.count),
  };
}

function str(v) {
  return typeof v === 'string' && v.length ? v : null;
}

function tsOf(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Statuses that mean "this agent is not working any more". */
const FINISHED = new Set(['completed', 'error', 'stale']);

/**
 * A transcript verdict backed by an actual `tool_result` - not a guess.
 * `jsonl:async_launched` and `jsonl:no-tool-result` are guesses; these are not.
 */
function isTranscriptFact(node) {
  const src = str(node && node.statusSource);
  return !!src && src.startsWith('jsonl:tool-result');
}

/**
 * hooks evidence > stale inference > jsonl inference.
 *
 * A hook record whose `statusSource` is 'hooks' was written by an actual
 * event (SubagentStop, or a tool event proving life). `stale` is our own
 * time-based guess (state.sweepStale) and outranks the transcript only because
 * the transcript's `async-unknown` says nothing at all.
 */
export function resolveStatus(node, hookAgent) {
  if (hookAgent && hookAgent.statusSource === 'hooks') {
    if (hookAgent.status === 'completed') {
      return { status: 'completed', statusSource: 'hooks:SubagentStop', statusDetail: null };
    }
    if (hookAgent.status === 'running') {
      return { status: 'running', statusSource: 'hooks', statusDetail: null };
    }
  }
  if (hookAgent && hookAgent.status === 'stale') {
    // `stale` is OUR guess from silence. It outranks the transcript's own
    // guesses (`async_launched`, `no-tool-result`) but never a `tool_result`
    // that actually says the spawn finished or failed.
    if (!isTranscriptFact(node)) {
      return {
        status: 'stale',
        statusSource: 'inferred',
        statusDetail: str(hookAgent.staleReason),
      };
    }
  }
  if (node && str(node.statusInferred)) {
    return {
      status: node.statusInferred,
      statusSource: str(node.statusSource) ?? 'jsonl',
      statusDetail: null,
    };
  }
  // Nothing at all said anything: do not claim it finished.
  return { status: 'async-unknown', statusSource: 'none', statusDetail: null };
}

/** meta > hooks (empty strings ignored by `str`) > null. */
function resolveText(metaValue, hookValue) {
  const m = str(metaValue);
  if (m) return { value: m, source: 'meta' };
  const h = str(hookValue);
  if (h) return { value: h, source: 'hooks' };
  return { value: null, source: null };
}

/** meta > hooks > the model recorded on the child transcript's messages. */
export function resolveModel(meta, hookAgent, node) {
  const m = str(meta && meta.model);
  if (m) return { model: m, modelSource: 'meta' };
  const h = str(hookAgent && hookAgent.model);
  if (h) return { model: h, modelSource: str(hookAgent.modelSource) ?? 'hooks' };
  const j = str(node && node.model);
  if (j) return { model: j, modelSource: 'transcript' };
  return { model: null, modelSource: null };
}

/**
 * What to call a node, reusing state.agentLabel's shape so the Tree and the
 * Live view never disagree about a name.
 */
export function nodeLabel(description, agentType, agentId) {
  if (description && agentType) return `${description}（${agentType}）`;
  return description || agentType || (agentId ? agentId.slice(0, 8) : 'agent');
}

/** startedAt: hooks > child transcript > the tool_use that spawned it. */
function resolveStart(node, hookAgent, spawn) {
  const h = str(hookAgent && hookAgent.startedAt);
  if (h) return { startedAt: h, startedAtSource: 'hooks' };
  const j = str(node && node.startedAt);
  if (j) return { startedAt: j, startedAtSource: 'transcript' };
  const s = str(spawn && spawn.at);
  if (s) return { startedAt: s, startedAtSource: 'spawn' };
  return { startedAt: null, startedAtSource: null };
}

/** endedAt: hooks SubagentStop > last child record, and only once finished. */
function resolveEnd(node, hookAgent, status) {
  const h = str(hookAgent && hookAgent.endedAt);
  if (h) return { endedAt: h, endedAtSource: 'hooks' };
  if (FINISHED.has(status)) {
    const j = str(node && node.endedAt);
    if (j) return { endedAt: j, endedAtSource: 'transcript' };
  }
  return { endedAt: null, endedAtSource: null };
}

function durationOf(startedAt, endedAt) {
  const a = tsOf(startedAt);
  const b = tsOf(endedAt);
  if (a === null || b === null) return null;
  const d = b - a;
  return d >= 0 ? d : null;
}

/**
 * The ROOT's own start and end, which follow different rules from an agent's.
 *
 * `hooks` here means a `SessionStart` / `SessionEnd` event, and the snapshot
 * says so itself via `startedAtSource` / `endedAtSource` - a start time that
 * came from ~/.claude/sessions/<pid>.json is labelled `sessions` there and is
 * NOT a hook fact, so it must not be relabelled as one. Anything else falls
 * back to the transcript's first and last records.
 *
 * A live session has NO end time: its last record is the latest thing it has
 * said, not a finish. Same rule resolveEnd applies to a running agent.
 *
 * @param {any} rootNode  the jsonl root from buildTree, or null
 * @param {any} hookSession state.toPublicSession() record, or null
 * @param {boolean} live
 */
export function resolveSessionSpan(rootNode, hookSession, live) {
  const hookStart = hookSession && hookSession.startedAtSource === 'hooks'
    ? str(hookSession.startedAt) : null;
  const startedAt = hookStart ?? str(rootNode && rootNode.startedAt);
  const startedAtSource = startedAt ? (hookStart ? 'hooks' : 'transcript') : null;

  let endedAt = null;
  let endedAtSource = null;
  if (!live) {
    const hookEnd = hookSession && hookSession.endedAtSource === 'hooks'
      ? str(hookSession.endedAt) : null;
    endedAt = hookEnd ?? str(rootNode && rootNode.endedAt);
    endedAtSource = endedAt ? (hookEnd ? 'hooks' : 'transcript') : null;
  }
  // The two halves can come from different sources, and then the pair can
  // invert: a `SessionStart` fired by a RESUME is later than everything already
  // in the transcript, so a hooks start over a transcript end reads as negative.
  // Clamp the end up to the start, keeping both sources - same rule and same
  // reasoning as tree-view.clampSpan.
  const a = tsOf(startedAt);
  const b = tsOf(endedAt);
  if (a !== null && b !== null && b < a) endedAt = startedAt;
  return { startedAt, startedAtSource, endedAt, endedAtSource };
}

/** startedAt ascending; anything without one sorts last, order preserved. */
export function byStart(a, b) {
  const ta = tsOf(a && a.startedAt);
  const tb = tsOf(b && b.startedAt);
  if (ta === null && tb === null) return 0;
  if (ta === null) return 1;
  if (tb === null) return -1;
  return ta - tb;
}

/**
 * @typedef {Object} MergeInput
 * @property {any} tree            {root, nodes: Map, orphans} from buildTree
 * @property {Array} [metas]       session-index.listSubagents() refs
 * @property {Array} [hookAgents]  state.toPublicAgent() records for the session
 * @property {any} [hookSession]   state.toPublicSession() record, or null
 * @property {Map<string, {at: string|null, prompt: string|null}>} [spawns]
 *           spawning tool_use id -> when it was issued and its `prompt` input
 * @property {Map<string, string>} [lastToolAt]  agentId -> last tool_use ts
 * @property {string|null} [aiTitle]  latest ai-title seen in the transcript
 * @property {string|null} [cwd]
 * @property {string|null} [transcriptPath]
 * @property {number} [sizeBytes]
 */

/**
 * @param {MergeInput} input
 * @returns {{root: any, orphans: any[], agentCount: number, hooksOnly: number}}
 */
export function mergeTree(input = {}) {
  const tree = input.tree || {};
  const jsonlNodes = tree.nodes instanceof Map ? tree.nodes : new Map();
  const rootNode = tree.root || null;
  const rootId = rootNode ? rootNode.id : null;

  const metaById = new Map();
  for (const m of input.metas || []) {
    if (m && str(m.agentId)) metaById.set(m.agentId, m);
  }
  const hookById = new Map();
  for (const a of input.hookAgents || []) {
    if (a && str(a.agentId)) hookById.set(a.agentId, a);
  }
  const spawns = input.spawns instanceof Map ? input.spawns : new Map();
  const lastTool = input.lastToolAt instanceof Map ? input.lastToolAt : new Map();

  /** @type {Map<string, any>} */
  const merged = new Map();

  const buildAgent = (agentId, node, meta, hookAgent, origin) => {
    const { status, statusSource, statusDetail } = resolveStatus(node, hookAgent);
    const type = resolveText(meta && meta.agentType, hookAgent && hookAgent.agentType);
    const desc = resolveText(meta && meta.description, hookAgent && hookAgent.description);
    const { model, modelSource } = resolveModel(meta, hookAgent, node);
    const spawnId = str(node && node.spawnedByToolUseId) ?? str(meta && meta.toolUseId);
    const spawn = spawnId ? spawns.get(spawnId) : null;
    const { startedAt, startedAtSource } = resolveStart(node, hookAgent, spawn);
    const { endedAt, endedAtSource } = resolveEnd(node, hookAgent, status);
    const running = status === 'running';
    return {
      kind: 'agent',
      id: agentId,
      parentId: null,
      spawnDepth: Number.isFinite(node && node.spawnDepth)
        ? node.spawnDepth
        : (Number.isFinite(meta && meta.spawnDepth) ? meta.spawnDepth : 1),
      origin,
      agentType: type.value,
      agentTypeSource: type.source,
      description: desc.value,
      descriptionSource: desc.source,
      label: nodeLabel(desc.value, type.value, agentId),
      model,
      modelSource,
      status,
      statusSource,
      statusDetail,
      startedAt,
      startedAtSource,
      endedAt,
      endedAtSource,
      durationMs: durationOf(startedAt, endedAt),
      running,
      tokens: toTokens(node && node.usage),
      toolCount: node ? (node.toolUseCount ?? 0) : (hookAgent ? (hookAgent.tools ?? 0) : 0),
      toolCountSource: node ? 'transcript' : (hookAgent ? 'hooks' : null),
      hookToolCount: hookAgent ? (hookAgent.tools ?? 0) : 0,
      errorCount: hookAgent ? (hookAgent.errors ?? 0) : 0,
      messageCount: node ? (node.messageCount ?? 0) : 0,
      currentTool: running && hookAgent ? (hookAgent.currentTool ?? null) : null,
      lastToolAt: lastTool.get(agentId) ?? null,
      spawnedByToolUseId: spawnId,
      // The Agent tool_use that spawned this agent carries the full prompt.
      // The transcript parser deliberately keeps no message text, so this is
      // the only prompt we can show without a second, text-retaining pass.
      promptExcerpt: excerpt(spawn && spawn.prompt, 400) ?? desc.value,
      transcriptPath: str(meta && meta.jsonlPath)
        ?? str(hookAgent && hookAgent.agentTranscriptPath),
      worktreePath: str(node && node.worktreePath) ?? str(meta && meta.worktreePath),
      children: [],
    };
  };

  for (const [id, node] of jsonlNodes) {
    if (id === rootId) continue;
    merged.set(id, buildAgent(id, node, metaById.get(id) ?? null, hookById.get(id) ?? null, 'transcript'));
  }

  // Agents hooks saw but that left no transcript and no meta.json. Real:
  // a458ad0670a1f500e had one PreToolUse and one PostToolUse and nothing else.
  let hooksOnly = 0;
  for (const [id, hookAgent] of hookById) {
    if (merged.has(id)) continue;
    hooksOnly += 1;
    merged.set(id, buildAgent(id, null, metaById.get(id) ?? null, hookAgent, 'hooks'));
  }

  /** @type {any[]} */
  const orphans = [];
  for (const [id, m] of merged) {
    const node = jsonlNodes.get(id);
    const parentId = node ? str(node.parentId) : null;
    m.parentId = parentId;
    if (!parentId) {
      orphans.push(m);
      continue;
    }
    if (parentId === rootId) continue; // attached to the root below
    const parent = merged.get(parentId);
    if (parent) parent.children.push(m);
    else orphans.push(m);
  }

  const rootChildren = [];
  for (const [id, m] of merged) {
    if (m.parentId === rootId && rootId !== null) rootChildren.push(merged.get(id));
  }

  for (const m of merged.values()) m.children.sort(byStart);
  rootChildren.sort(byStart);
  orphans.sort(byStart);

  const rootTokens = toTokens(rootNode && rootNode.usage);
  const hookSession = input.hookSession || null;
  const cwd = str(input.cwd) ?? str(hookSession && hookSession.cwd);
  // The transcript's own ai-title is regenerated from the latest prompt, so an
  // attachment-only turn renames the session to "Image #1". Same guard the Live
  // view uses (state.isUsefulTitle): reject it and fall through to the cwd.
  const aiTitle = [str(hookSession && hookSession.aiTitle), str(input.aiTitle)]
    .find((t) => isUsefulTitle(t)) ?? null;
  const title = sessionTitle({ sessionId: rootId, aiTitle, cwd });

  // state.isLive: one rule for the header, the session list and this tree.
  const live = isLive(hookSession);
  const span = resolveSessionSpan(rootNode, hookSession, live);

  const root = {
    kind: 'session',
    id: rootId,
    title,
    cwd,
    projectPath: str(input.projectPath),
    live,
    phase: hookSession ? hookSession.phase : null,
    phaseSource: hookSession ? hookSession.phaseSource : null,
    model: str(hookSession && hookSession.model),
    startedAt: span.startedAt,
    startedAtSource: span.startedAtSource,
    endedAt: span.endedAt,
    endedAtSource: span.endedAtSource,
    // The resolved pair when we have both; otherwise the transcript's own span,
    // which is all a live session can offer.
    durationMs: durationOf(span.startedAt, span.endedAt)
      ?? (rootNode ? (rootNode.durationMs ?? null) : null),
    tokens: rootTokens,
    toolCount: rootNode ? (rootNode.toolUseCount ?? 0) : 0,
    messageCount: rootNode ? (rootNode.messageCount ?? 0) : 0,
    currentTool: hookSession ? (hookSession.currentTool ?? null) : null,
    transcriptPath: str(input.transcriptPath),
    sizeBytes: Number.isFinite(input.sizeBytes) ? input.sizeBytes : null,
    agentCount: merged.size,
    children: rootChildren,
  };

  return { root, orphans, agentCount: merged.size, hooksOnly };
}

export default mergeTree;
