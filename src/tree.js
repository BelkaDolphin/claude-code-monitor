/**
 * Reconstruct the session -> subagent tree.
 *
 * How parentage is determined (all verified against real data, 2.1.258):
 *  1. Every subagent has a meta.json with `toolUseId` - the id of the `Agent`
 *     tool_use block that spawned it.
 *  2. We index every `tool_use` block across the main transcript AND every
 *     subagent transcript by its id, remembering which transcript it came from
 *     (main = null agentId, subagent = its agentId). Matching meta.toolUseId
 *     against that index yields the parent. This handles nesting naturally.
 *  3. spawnDepth >= 2 metas ALSO carry an explicit `parentAgentId` field
 *     (measured: 12/12 of the depth-2 metas have it, 0/87 of depth-1). When
 *     present it is authoritative and used directly.
 *  4. Nested subagent transcripts live in the SAME flat `subagents/` directory
 *     as depth-1 ones - there is no nested directory structure.
 *
 * Status inference (IMPORTANT - differs from the original design assumption):
 *  A tool_result for the spawning tool_use appears in the parent IMMEDIATELY for
 *  background/async agents, carrying
 *     toolUseResult = {isAsync:true, status:"async_launched", agentId:"..."}.
 *  So "tool_result present => completed" is WRONG. Measured across all history:
 *  106 async_launched vs 4 sync completed. We therefore report:
 *     'completed'     - sync spawn whose tool_result carries status 'completed',
 *                       or a hook SubagentStop was observed for this agentId
 *     'running'       - no tool_result for the spawning tool_use at all
 *     'async-unknown' - async_launched and no hook evidence; the transcript
 *                       cannot tell us whether it finished
 *  The field is named `statusInferred` and `statusSource` says where it came from.
 *  Authoritative completion needs the SubagentStop hook (see hooks-ingest.js).
 */

import { parseFile, ParseStats } from './parser.js';
import { UsageCollector } from './usage.js';

/**
 * @typedef {Object} TreeNode
 * @property {'session'|'agent'} kind
 * @property {string} id                sessionId or agentId
 * @property {string|null} agentType
 * @property {string|null} description
 * @property {string|null} model
 * @property {number} spawnDepth
 * @property {string|null} startedAt    first timestamp in its transcript
 * @property {string|null} endedAt      last timestamp in its transcript
 * @property {number} durationMs
 * @property {number} toolUseCount
 * @property {number} messageCount
 * @property {string|null} spawnedByToolUseId
 * @property {string|null} parentId
 * @property {string} statusInferred
 * @property {string} statusSource
 * @property {any} usage
 * @property {TreeNode[]} children
 */

/**
 * @param {import('./session-index.js').SessionEntry} entry
 * @param {Object} [opts]
 * @param {Set<string>} [opts.stoppedAgentIds]  agentIds known finished from hooks
 * @param {Set<string>} [opts.startedAgentIds]  agentIds known started from hooks
 * @returns {{root: TreeNode, nodes: Map<string,TreeNode>, orphans: TreeNode[], stats: ParseStats}}
 */
export function buildTree(entry, opts = {}) {
  const stats = new ParseStats();
  const stopped = opts.stoppedAgentIds ?? new Set();

  /** toolUseId -> {ownerAgentId: string|null, name, ts} */
  const toolUseIndex = new Map();
  /** toolUseId -> {status, isAsync, agentId, isError} */
  const toolResultIndex = new Map();

  /** agentId|null -> per-transcript stats */
  const perFile = new Map();

  const scan = (file, ownerAgentId) => {
    const acc = {
      firstTs: null,
      lastTs: null,
      toolUseCount: 0,
      messageCount: 0,
      // type:'ai-title' records carry no timestamp; the LAST one in the file is
      // the current title. Captured here so the tree view can name the session
      // without a second full pass over a 35MB transcript.
      aiTitle: null,
      usage: new UsageCollector(),
    };
    parseFile(file, (rec) => {
      if (rec.timestamp) {
        if (!acc.firstTs || rec.timestamp < acc.firstTs) acc.firstTs = rec.timestamp;
        if (!acc.lastTs || rec.timestamp > acc.lastTs) acc.lastTs = rec.timestamp;
      }
      if (rec.type === 'assistant' || rec.type === 'user') acc.messageCount++;
      if (rec.aiTitle) acc.aiTitle = rec.aiTitle;
      acc.usage.add(rec);
      for (const b of rec.blocks) {
        if (b.kind === 'tool_use' && b.id) {
          acc.toolUseCount++;
          toolUseIndex.set(b.id, { ownerAgentId, name: b.name, ts: rec.timestamp, input: b.input });
        } else if (b.kind === 'tool_result' && b.toolUseId) {
          const tur = rec.toolUseResult;
          toolResultIndex.set(b.toolUseId, {
            isError: b.isError === true,
            ts: rec.timestamp,
            status: tur && typeof tur === 'object' ? (tur.status ?? null) : null,
            isAsync: tur && typeof tur === 'object' ? tur.isAsync === true : false,
            agentId: tur && typeof tur === 'object' && typeof tur.agentId === 'string' ? tur.agentId : null,
          });
        }
      }
    }, stats);
    perFile.set(ownerAgentId, acc);
    return acc;
  };

  const rootAcc = scan(entry.jsonlPath, null);
  for (const sub of entry.subagents) scan(sub.jsonlPath, sub.agentId);

  /** @type {Map<string, TreeNode>} */
  const nodes = new Map();

  const root = /** @type {TreeNode} */ ({
    kind: 'session',
    id: entry.sessionId,
    agentType: null,
    description: entry.cwd ?? entry.projectDirName,
    model: null,
    spawnDepth: 0,
    startedAt: rootAcc.firstTs,
    endedAt: rootAcc.lastTs,
    durationMs: spanMs(rootAcc.firstTs, rootAcc.lastTs),
    toolUseCount: rootAcc.toolUseCount,
    messageCount: rootAcc.messageCount,
    aiTitle: rootAcc.aiTitle,
    spawnedByToolUseId: null,
    parentId: null,
    statusInferred: 'n/a',
    statusSource: 'n/a',
    usage: rootAcc.usage.summarize().totals,
    children: [],
  });
  nodes.set(entry.sessionId, root);

  for (const sub of entry.subagents) {
    const acc = perFile.get(sub.agentId) ?? { firstTs: null, lastTs: null, toolUseCount: 0, messageCount: 0, usage: new UsageCollector() };
    const tr = sub.toolUseId ? toolResultIndex.get(sub.toolUseId) : null;
    const { statusInferred, statusSource } = inferStatus(sub, tr, stopped);
    /** @type {TreeNode} */
    const node = {
      kind: 'agent',
      id: sub.agentId,
      agentType: sub.agentType,
      description: sub.description,
      // meta.model is missing on some (14/99); fall back to the model recorded
      // on the agent's own assistant messages.
      model: sub.model ?? dominantModel(acc.usage),
      spawnDepth: sub.spawnDepth,
      startedAt: acc.firstTs,
      endedAt: acc.lastTs,
      durationMs: spanMs(acc.firstTs, acc.lastTs),
      toolUseCount: acc.toolUseCount,
      messageCount: acc.messageCount,
      spawnedByToolUseId: sub.toolUseId,
      parentId: null,
      statusInferred,
      statusSource,
      usage: acc.usage.summarize().totals,
      worktreePath: sub.worktreePath,
      children: [],
    };
    nodes.set(sub.agentId, node);
  }

  /** @type {TreeNode[]} */
  const orphans = [];
  for (const sub of entry.subagents) {
    const node = nodes.get(sub.agentId);
    let parentId = null;
    // (3) explicit parentAgentId wins
    if (sub.parentAgentId && nodes.has(sub.parentAgentId)) {
      parentId = sub.parentAgentId;
    } else if (sub.toolUseId && toolUseIndex.has(sub.toolUseId)) {
      // (2) the transcript that issued the spawning tool_use is the parent
      const owner = toolUseIndex.get(sub.toolUseId).ownerAgentId;
      parentId = owner === null ? entry.sessionId : owner;
    } else if (sub.parentAgentId) {
      parentId = null; // referenced an agent whose transcript is gone
    }
    node.parentId = parentId;
    const parent = parentId ? nodes.get(parentId) : null;
    if (parent) parent.children.push(node);
    else orphans.push(node);
  }

  const byStart = (a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? ''));
  for (const n of nodes.values()) n.children.sort(byStart);
  orphans.sort(byStart);

  return { root, nodes, orphans, stats, toolUseIndex, toolResultIndex };
}

function inferStatus(sub, toolResult, stoppedAgentIds) {
  if (stoppedAgentIds.has(sub.agentId)) {
    return { statusInferred: 'completed', statusSource: 'hook:SubagentStop' };
  }
  if (!toolResult) {
    return { statusInferred: 'running', statusSource: 'jsonl:no-tool-result' };
  }
  if (toolResult.isError) {
    return { statusInferred: 'error', statusSource: 'jsonl:tool-result-is_error' };
  }
  if (toolResult.status === 'completed') {
    return { statusInferred: 'completed', statusSource: 'jsonl:tool-result-status' };
  }
  if (toolResult.isAsync || toolResult.status === 'async_launched') {
    // The result only proves the agent was LAUNCHED, not that it finished.
    return { statusInferred: 'async-unknown', statusSource: 'jsonl:async_launched' };
  }
  return { statusInferred: 'completed', statusSource: 'jsonl:tool-result-present' };
}

function dominantModel(collector) {
  const models = collector.summarize().byModel;
  let best = null;
  let bestN = -1;
  for (const [k, v] of Object.entries(models)) {
    if (k === 'unknown-model') continue;
    if (v.count > bestN) { best = k; bestN = v.count; }
  }
  return best;
}

function spanMs(a, b) {
  if (!a || !b) return 0;
  const d = Date.parse(b) - Date.parse(a);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * Render a tree as indented plain text.
 * @param {TreeNode} node
 */
export function formatTree(node, indent = '', isLast = true, isRoot = true) {
  const lines = [];
  const branch = isRoot ? '' : isLast ? '`- ' : '|- ';
  lines.push(indent + branch + describeNode(node));
  const childIndent = indent + (isRoot ? '' : isLast ? '   ' : '|  ');
  node.children.forEach((c, i) => {
    lines.push(...formatTree(c, childIndent, i === node.children.length - 1, false));
  });
  return lines;
}

function describeNode(n) {
  const parts = [];
  if (n.kind === 'session') {
    parts.push(`session ${n.id}`);
    if (n.description) parts.push(`(${n.description})`);
  } else {
    parts.push(`agent ${n.id}`);
    parts.push(`[${n.agentType ?? '?'}]`);
    if (n.description) parts.push(`"${n.description}"`);
    parts.push(`d${n.spawnDepth}`);
    parts.push(n.model ?? '?');
    parts.push(n.statusInferred);
  }
  parts.push(`tools=${n.toolUseCount}`);
  parts.push(`msgs=${n.messageCount}`);
  parts.push(`out=${n.usage.output_tokens}`);
  if (n.durationMs) parts.push(`${(n.durationMs / 1000).toFixed(0)}s`);
  return parts.join(' ');
}
