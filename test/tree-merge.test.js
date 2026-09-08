/**
 * The pure merge (src/tree-merge.js).
 *
 * Every input is synthesized here - no disk, no clock, no collector - so each
 * precedence rule can be pinned on its own. The shapes mirror what the real
 * producers emit: `jnode()` is a buildTree node, `hook()` is what
 * state.toPublicAgent() returns, `meta()` is one entry of
 * session-index.listSubagents().
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeTree,
  resolveStatus,
  resolveModel,
  nodeLabel,
  toTokens,
  byStart,
} from '../src/tree-merge.js';

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const A1 = 'a1111111111111111';
const A2 = 'a2222222222222222';
const A3 = 'a3333333333333333';

function totals(over = {}) {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    count: 0,
    totalTokens: 0,
    ...over,
  };
}

/** A node as buildTree() emits it. */
function jnode(id, over = {}) {
  return {
    kind: 'agent',
    id,
    agentType: null,
    description: null,
    model: null,
    spawnDepth: 1,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    toolUseCount: 0,
    messageCount: 0,
    spawnedByToolUseId: null,
    parentId: SID,
    statusInferred: 'async-unknown',
    statusSource: 'jsonl:async_launched',
    usage: totals(),
    children: [],
    ...over,
  };
}

function rootNode(over = {}) {
  return {
    kind: 'session',
    id: SID,
    description: null,
    aiTitle: null,
    spawnDepth: 0,
    startedAt: null,
    endedAt: null,
    durationMs: 0,
    toolUseCount: 0,
    messageCount: 0,
    parentId: null,
    usage: totals(),
    children: [],
    ...over,
  };
}

/** A tree in the shape buildTree() returns. */
function treeOf(nodes, rootOver = {}) {
  const root = rootNode(rootOver);
  const map = new Map();
  map.set(SID, root);
  for (const n of nodes) map.set(n.id, n);
  return { root, nodes: map, orphans: [] };
}

/** A state.toPublicAgent() record. */
function hook(agentId, over = {}) {
  return {
    agentId,
    agentType: null,
    description: null,
    model: null,
    modelSource: null,
    label: agentId.slice(0, 8),
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
    ...over,
  };
}

/** A session-index.listSubagents() ref. */
function meta(agentId, over = {}) {
  return {
    agentId,
    jsonlPath: `D:\\p\\subagents\\agent-${agentId}.jsonl`,
    metaPath: `D:\\p\\subagents\\agent-${agentId}.meta.json`,
    agentType: null,
    description: null,
    toolUseId: null,
    parentAgentId: null,
    spawnDepth: 1,
    model: null,
    worktreePath: null,
    size: 0,
    mtimeMs: 0,
    ...over,
  };
}

/** Find one merged node by id anywhere in the result. */
function find(res, id) {
  const stack = [res.root, ...res.orphans];
  while (stack.length) {
    const n = stack.pop();
    if (!n) continue;
    if (n.id === id) return n;
    for (const c of n.children || []) stack.push(c);
  }
  return null;
}

describe('status precedence: hooks > stale inference > jsonl', () => {
  test('a SubagentStop outranks the transcript saying async-unknown', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1)]),
      hookAgents: [hook(A1, { status: 'completed', statusSource: 'hooks' })],
    });
    const n = find(res, A1);
    assert.equal(n.status, 'completed');
    assert.equal(n.statusSource, 'hooks:SubagentStop');
  });

  test('hooks saying running outranks the transcript', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1, { statusInferred: 'running', statusSource: 'jsonl:no-tool-result' })]),
      hookAgents: [hook(A1, { status: 'running', statusSource: 'hooks' })],
    });
    assert.equal(find(res, A1).statusSource, 'hooks');
  });

  test('a stale sweep outranks the transcript GUESSES', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1)]), // async_launched: proves only the launch
      hookAgents: [hook(A1, { status: 'stale', statusSource: 'inferred', staleReason: 'silent' })],
    });
    const n = find(res, A1);
    assert.equal(n.status, 'stale');
    assert.equal(n.statusSource, 'inferred');
    assert.equal(n.statusDetail, 'silent');
  });

  test('a stale sweep does NOT outrank a real tool_result verdict', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1, {
        statusInferred: 'completed',
        statusSource: 'jsonl:tool-result-status',
      })]),
      hookAgents: [hook(A1, { status: 'stale', statusSource: 'inferred', staleReason: 'silent' })],
    });
    const n = find(res, A1);
    assert.equal(n.status, 'completed');
    assert.equal(n.statusSource, 'jsonl:tool-result-status');
  });

  test('an is_error tool_result also beats a stale guess', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1, {
        statusInferred: 'error',
        statusSource: 'jsonl:tool-result-is_error',
      })]),
      hookAgents: [hook(A1, { status: 'stale', statusSource: 'inferred' })],
    });
    assert.equal(find(res, A1).status, 'error');
  });

  test('with no hooks at all the transcript decides', () => {
    const res = mergeTree({ tree: treeOf([jnode(A1)]) });
    const n = find(res, A1);
    assert.equal(n.status, 'async-unknown');
    assert.equal(n.statusSource, 'jsonl:async_launched');
  });

  test('resolveStatus never claims a completion out of nothing', () => {
    const r = resolveStatus(null, null);
    assert.equal(r.status, 'async-unknown');
    assert.equal(r.statusSource, 'none');
  });
});

describe('agentType / description precedence', () => {
  test('meta.json wins over hooks', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1, { agentType: 'general-purpose', description: 'from meta' })]),
      metas: [meta(A1, { agentType: 'general-purpose', description: 'from meta' })],
      hookAgents: [hook(A1, { agentType: 'hooked-type', description: 'from hooks' })],
    });
    const n = find(res, A1);
    assert.equal(n.agentType, 'general-purpose');
    assert.equal(n.agentTypeSource, 'meta');
    assert.equal(n.description, 'from meta');
    assert.equal(n.descriptionSource, 'meta');
  });

  test('hooks fill in when there is no meta.json', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1)]),
      hookAgents: [hook(A1, { agentType: 'Explore', description: 'find it' })],
    });
    const n = find(res, A1);
    assert.equal(n.agentType, 'Explore');
    assert.equal(n.agentTypeSource, 'hooks');
    assert.equal(n.description, 'find it');
  });

  test('SubagentStop delivers agent_type:"" and it must be IGNORED', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1)]),
      metas: [meta(A1, { agentType: '', description: '' })],
      hookAgents: [hook(A1, { agentType: '', description: '' })],
    });
    const n = find(res, A1);
    assert.equal(n.agentType, null);
    assert.equal(n.agentTypeSource, null);
    assert.equal(n.description, null);
    // With nothing to call it by, the label is the short id - never "".
    assert.equal(n.label, A1.slice(0, 8));
  });

  test('an empty agent_type does not erase a real one from meta', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1)]),
      metas: [meta(A1, { agentType: 'code-reviewer' })],
      hookAgents: [hook(A1, { agentType: '' })],
    });
    assert.equal(find(res, A1).agentType, 'code-reviewer');
  });

  test('the label matches the Live view: description（agentType）', () => {
    assert.equal(nodeLabel('レビュー', 'code-reviewer', A1), 'レビュー（code-reviewer）');
    assert.equal(nodeLabel(null, 'code-reviewer', A1), 'code-reviewer');
    assert.equal(nodeLabel('レビュー', null, A1), 'レビュー');
    assert.equal(nodeLabel(null, null, A1), A1.slice(0, 8));
  });
});

describe('model precedence: meta > hooks > child transcript', () => {
  test('meta.json wins', () => {
    const r = resolveModel(meta(A1, { model: 'opus' }), hook(A1, { model: 'sonnet' }), jnode(A1, { model: 'claude-haiku-4-5' }));
    assert.deepEqual(r, { model: 'opus', modelSource: 'meta' });
  });

  test('hooks fill the gap and keep their own source label', () => {
    const r = resolveModel(meta(A1), hook(A1, { model: 'sonnet', modelSource: 'meta' }), jnode(A1, { model: 'claude-opus-5' }));
    assert.deepEqual(r, { model: 'sonnet', modelSource: 'meta' });
  });

  test('the transcript is the last resort (meta.model is missing on some)', () => {
    const r = resolveModel(meta(A1), null, jnode(A1, { model: 'claude-sonnet-5' }));
    assert.deepEqual(r, { model: 'claude-sonnet-5', modelSource: 'transcript' });
  });

  test('nothing anywhere is null, not a guess', () => {
    assert.deepEqual(resolveModel(null, null, null), { model: null, modelSource: null });
  });
});

describe('timestamps', () => {
  test('startedAt: hooks > child transcript > the spawning tool_use', () => {
    const spawns = new Map([['toolu_1', { at: '2026-09-01T00:00:00.000Z', prompt: null }]]);
    const base = { tree: treeOf([jnode(A1, { spawnedByToolUseId: 'toolu_1' })]), spawns };

    const fromSpawn = mergeTree(base);
    assert.equal(find(fromSpawn, A1).startedAt, '2026-09-01T00:00:00.000Z');
    assert.equal(find(fromSpawn, A1).startedAtSource, 'spawn');

    const withJsonl = mergeTree({
      ...base,
      tree: treeOf([jnode(A1, { spawnedByToolUseId: 'toolu_1', startedAt: '2026-09-01T00:00:05.000Z' })]),
    });
    assert.equal(find(withJsonl, A1).startedAtSource, 'transcript');

    const withHooks = mergeTree({
      ...base,
      tree: treeOf([jnode(A1, { spawnedByToolUseId: 'toolu_1', startedAt: '2026-09-01T00:00:05.000Z' })]),
      hookAgents: [hook(A1, { startedAt: '2026-09-01T00:00:01.000Z' })],
    });
    assert.equal(find(withHooks, A1).startedAt, '2026-09-01T00:00:01.000Z');
    assert.equal(find(withHooks, A1).startedAtSource, 'hooks');
  });

  test('endedAt comes from SubagentStop when there is one', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1, { startedAt: '2026-09-01T00:00:00.000Z', endedAt: '2026-09-01T00:09:00.000Z' })]),
      hookAgents: [hook(A1, {
        status: 'completed',
        statusSource: 'hooks',
        startedAt: '2026-09-01T00:00:00.000Z',
        endedAt: '2026-09-01T00:10:00.000Z',
      })],
    });
    const n = find(res, A1);
    assert.equal(n.endedAt, '2026-09-01T00:10:00.000Z');
    assert.equal(n.endedAtSource, 'hooks');
    assert.equal(n.durationMs, 600000);
  });

  test('a still-running agent gets no endedAt and no duration', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1, {
        statusInferred: 'running',
        statusSource: 'jsonl:no-tool-result',
        startedAt: '2026-09-01T00:00:00.000Z',
        endedAt: '2026-09-01T00:03:00.000Z',
      })]),
    });
    const n = find(res, A1);
    assert.equal(n.status, 'running');
    assert.equal(n.endedAt, null);
    assert.equal(n.durationMs, null);
  });

  test('a finished agent may take its endedAt from the transcript', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1, {
        statusInferred: 'completed',
        statusSource: 'jsonl:tool-result-status',
        startedAt: '2026-09-01T00:00:00.000Z',
        endedAt: '2026-09-01T00:02:00.000Z',
      })]),
    });
    const n = find(res, A1);
    assert.equal(n.endedAtSource, 'transcript');
    assert.equal(n.durationMs, 120000);
  });

  test('an end before the start is refused rather than shown negative', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1, { startedAt: '2026-09-01T01:00:00.000Z' })]),
      hookAgents: [hook(A1, {
        status: 'completed',
        statusSource: 'hooks',
        startedAt: '2026-09-01T01:00:00.000Z',
        endedAt: '2026-09-01T00:00:00.000Z',
      })],
    });
    assert.equal(find(res, A1).durationMs, null);
  });

  test('unparseable timestamps produce null, never NaN', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1, { startedAt: 'not-a-time', endedAt: 'nope', statusInferred: 'completed', statusSource: 'jsonl:tool-result-status' })]),
    });
    assert.equal(find(res, A1).durationMs, null);
  });
});

describe('ordering', () => {
  test('children sort by startedAt with the unknown ones last', () => {
    const res = mergeTree({
      tree: treeOf([
        jnode(A3, { startedAt: null }),
        jnode(A2, { startedAt: '2026-09-01T00:00:02.000Z' }),
        jnode(A1, { startedAt: '2026-09-01T00:00:01.000Z' }),
      ]),
    });
    assert.deepEqual(res.root.children.map((c) => c.id), [A1, A2, A3]);
  });

  test('byStart is null-safe in both directions', () => {
    assert.equal(byStart({ startedAt: null }, { startedAt: null }), 0);
    assert.ok(byStart({ startedAt: null }, { startedAt: '2026-01-01T00:00:00Z' }) > 0);
    assert.ok(byStart({ startedAt: '2026-01-01T00:00:00Z' }, { startedAt: null }) < 0);
    assert.equal(byStart(null, null), 0);
  });
});

describe('nesting and orphans', () => {
  test('a depth-2 agent hangs off its parent, not off the session', () => {
    const res = mergeTree({
      tree: treeOf([
        jnode(A1),
        jnode(A2, { parentId: A1, spawnDepth: 2 }),
      ]),
    });
    assert.equal(res.root.children.length, 1);
    assert.equal(res.root.children[0].id, A1);
    assert.equal(res.root.children[0].children[0].id, A2);
    assert.equal(res.root.children[0].children[0].parentId, A1);
  });

  test('a node whose parent is gone becomes an orphan', () => {
    const res = mergeTree({ tree: treeOf([jnode(A1, { parentId: null })]) });
    assert.equal(res.root.children.length, 0);
    assert.equal(res.orphans.length, 1);
    assert.equal(res.orphans[0].id, A1);
  });

  test('the a458ad0670a1f500e case: hooks only, no transcript, no meta', () => {
    const ghost = 'a458ad0670a1f500e';
    const res = mergeTree({
      tree: treeOf([]),
      hookAgents: [hook(ghost, {
        status: 'stale',
        statusSource: 'inferred',
        staleReason: 'silent',
        startedAt: '2026-09-02T14:39:42.411Z',
        tools: 1,
      })],
    });
    assert.equal(res.agentCount, 1);
    assert.equal(res.hooksOnly, 1);
    const n = res.orphans[0];
    assert.equal(n.id, ghost);
    assert.equal(n.origin, 'hooks');
    assert.equal(n.status, 'stale');
    assert.equal(n.startedAt, '2026-09-02T14:39:42.411Z');
    // With no transcript the only tool count we have is the hooks one.
    assert.equal(n.toolCount, 1);
    assert.equal(n.toolCountSource, 'hooks');
    assert.equal(n.transcriptPath, null);
  });

  test('a hooks-only agent that DOES have a meta.json still gets its name', () => {
    const res = mergeTree({
      tree: treeOf([]),
      metas: [meta(A1, { agentType: 'general-purpose', description: '調査' })],
      hookAgents: [hook(A1, { status: 'completed', statusSource: 'hooks' })],
    });
    assert.equal(res.orphans[0].label, '調査（general-purpose）');
    assert.equal(res.orphans[0].origin, 'hooks');
  });
});

describe('root node', () => {
  test('the title follows the Live view: ai-title, else the cwd tail', () => {
    const res = mergeTree({ tree: treeOf([]), aiTitle: 'ツリービュー', cwd: 'D:\\develop\\Claude監視' });
    assert.equal(res.root.title, 'ツリービュー');
  });

  test('a placeholder ai-title is refused and the cwd wins', () => {
    const res = mergeTree({ tree: treeOf([]), aiTitle: 'Image #1', cwd: 'D:\\develop\\Claude監視' });
    assert.equal(res.root.title, 'Claude監視');
  });

  test('a live session title from hooks beats the transcript copy', () => {
    const res = mergeTree({
      tree: treeOf([]),
      aiTitle: '古い題',
      hookSession: { sessionId: SID, aiTitle: '新しい題', phase: 'busy', phaseSource: 'hooks', agents: [] },
    });
    assert.equal(res.root.title, '新しい題');
    assert.equal(res.root.live, true);
    assert.equal(res.root.phase, 'busy');
  });

  test('an ended session is not live', () => {
    const res = mergeTree({
      tree: treeOf([]),
      hookSession: { sessionId: SID, phase: 'ended', phaseSource: 'hooks', agents: [] },
    });
    assert.equal(res.root.live, false);
  });

  test('totals are carried through in the names the UI already uses', () => {
    const res = mergeTree({
      tree: treeOf([], {
        usage: totals({
          input_tokens: 10,
          output_tokens: 20,
          cache_creation_input_tokens: 30,
          cache_read_input_tokens: 40,
          count: 5,
          totalTokens: 100,
        }),
        toolUseCount: 7,
        messageCount: 9,
      }),
    });
    assert.deepEqual(res.root.tokens, {
      input: 10, output: 20, cacheCreate: 30, cacheRead: 40, total: 100, messages: 5,
    });
    assert.equal(res.root.toolCount, 7);
    assert.equal(res.root.messageCount, 9);
  });
});

describe('per-node extras', () => {
  test('the prompt comes from the spawning Agent tool_use, else the description', () => {
    const spawns = new Map([['toolu_1', { at: null, prompt: '  do   the\nthing  ' }]]);
    const withPrompt = mergeTree({
      tree: treeOf([jnode(A1, { spawnedByToolUseId: 'toolu_1' })]),
      spawns,
    });
    assert.equal(find(withPrompt, A1).promptExcerpt, 'do the thing');

    const withoutPrompt = mergeTree({
      tree: treeOf([jnode(A1)]),
      metas: [meta(A1, { description: '説明だけ' })],
    });
    assert.equal(find(withoutPrompt, A1).promptExcerpt, '説明だけ');
  });

  test('currentTool is shown only while the agent is running', () => {
    const tool = { name: 'Bash', toolUseId: 'toolu_9', since: '2026-09-01T00:00:00.000Z', agentId: A1 };
    const running = mergeTree({
      tree: treeOf([jnode(A1)]),
      hookAgents: [hook(A1, { status: 'running', statusSource: 'hooks', currentTool: tool })],
    });
    assert.equal(find(running, A1).currentTool.name, 'Bash');

    const done = mergeTree({
      tree: treeOf([jnode(A1)]),
      hookAgents: [hook(A1, { status: 'completed', statusSource: 'hooks', currentTool: tool })],
    });
    assert.equal(find(done, A1).currentTool, null);
  });

  test('lastToolAt and the transcript path come through', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1)]),
      metas: [meta(A1)],
      lastToolAt: new Map([[A1, '2026-09-01T00:05:00.000Z']]),
    });
    const n = find(res, A1);
    assert.equal(n.lastToolAt, '2026-09-01T00:05:00.000Z');
    assert.match(n.transcriptPath, /agent-a1111111111111111\.jsonl$/);
  });

  test('the tool count prefers the transcript when there is one', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1, { toolUseCount: 42 })]),
      hookAgents: [hook(A1, { tools: 3, errors: 2 })],
    });
    const n = find(res, A1);
    assert.equal(n.toolCount, 42);
    assert.equal(n.toolCountSource, 'transcript');
    assert.equal(n.hookToolCount, 3);
    assert.equal(n.errorCount, 2);
  });
});

describe('null safety', () => {
  test('an empty call returns an empty tree instead of throwing', () => {
    const res = mergeTree();
    assert.equal(res.agentCount, 0);
    assert.deepEqual(res.orphans, []);
    assert.equal(res.root.id, null);
    assert.equal(res.root.children.length, 0);
  });

  test('garbage in the collections is skipped, not fatal', () => {
    const res = mergeTree({
      tree: treeOf([jnode(A1)]),
      metas: [null, {}, { agentId: '' }, meta(A1, { description: 'ok' })],
      hookAgents: [null, undefined, { agentId: null }],
      spawns: 'not a map',
      lastToolAt: null,
    });
    assert.equal(res.agentCount, 1);
    assert.equal(find(res, A1).description, 'ok');
  });

  test('the root session node: when it ran, and how we know', () => {
    const FIRST = '2026-09-01T00:00:00.000Z';
    const LAST = '2026-09-01T01:00:00.000Z';
    const tree = () => treeOf([], { startedAt: FIRST, endedAt: LAST, durationMs: 3600000 });
    const session = (over) => ({ sessionId: SID, phase: 'ended', phaseSource: 'hooks', agents: [], ...over });

    // No hooks at all: the transcript is everything, and says so.
    const bare = mergeTree({ tree: tree() }).root;
    assert.equal(bare.startedAt, FIRST);
    assert.equal(bare.startedAtSource, 'transcript');
    assert.equal(bare.endedAt, LAST);
    assert.equal(bare.endedAtSource, 'transcript');

    // Hook facts outrank the first and last lines of the file.
    const hooked = mergeTree({
      tree: tree(),
      hookSession: session({
        startedAt: '2026-08-31T23:00:00.000Z', startedAtSource: 'hooks',
        endedAt: '2026-09-01T01:30:00.000Z', endedAtSource: 'hooks',
      }),
    }).root;
    assert.equal(hooked.startedAt, '2026-08-31T23:00:00.000Z');
    assert.equal(hooked.startedAtSource, 'hooks');
    assert.equal(hooked.endedAt, '2026-09-01T01:30:00.000Z');
    assert.equal(hooked.endedAtSource, 'hooks');
    assert.equal(hooked.durationMs, 9000000);

    // A start that came from sessions/<pid>.json is NOT a hook fact and must
    // not be relabelled as one; the transcript wins the label here.
    const fromSessions = mergeTree({
      tree: tree(),
      hookSession: session({ startedAt: '2026-08-31T22:00:00.000Z', startedAtSource: 'sessions' }),
    }).root;
    assert.equal(fromSessions.startedAt, FIRST);
    assert.equal(fromSessions.startedAtSource, 'transcript');
  });

  test('a live root has NO end time - its last record is not an ending', () => {
    const LAST = '2026-09-01T01:00:00.000Z';
    const root = mergeTree({
      tree: treeOf([], { startedAt: '2026-09-01T00:00:00.000Z', endedAt: LAST, durationMs: 3600000 }),
      hookSession: {
        sessionId: SID, phase: 'busy', phaseSource: 'hooks', agents: [],
        endedAt: '2026-08-30T00:00:00.000Z', endedAtSource: 'hooks',
      },
    }).root;
    assert.equal(root.live, true);
    assert.equal(root.endedAt, null);
    assert.equal(root.endedAtSource, null);
    // With no end to measure to, the span is still the transcript's own.
    assert.equal(root.durationMs, 3600000);
  });

  test('a root end before its start is clamped up - a resume starts after the file ends', () => {
    // A SessionStart from a RESUME is later than everything already written, so
    // hooks-start over transcript-end inverts the pair.
    const root = mergeTree({
      tree: treeOf([], {
        startedAt: '2026-09-01T00:00:00.000Z',
        endedAt: '2026-09-02T12:40:55.265Z',
        durationMs: 1,
      }),
      hookSession: {
        sessionId: SID, phase: 'ended', phaseSource: 'hooks', agents: [],
        startedAt: '2026-09-02T12:40:55.266Z', startedAtSource: 'hooks',
      },
    }).root;
    assert.equal(root.startedAt, '2026-09-02T12:40:55.266Z');
    assert.equal(root.startedAtSource, 'hooks');
    assert.equal(root.endedAt, root.startedAt);
    assert.equal(root.endedAtSource, 'transcript');
    assert.equal(root.durationMs, 0, 'never negative');
  });

  test('a root with no timestamps anywhere reports null, never a fabricated time', () => {
    const root = mergeTree({ tree: treeOf([]) }).root;
    assert.equal(root.startedAt, null);
    assert.equal(root.startedAtSource, null);
    assert.equal(root.endedAt, null);
    assert.equal(root.endedAtSource, null);
  });

  test('toTokens turns anything unusable into zeroes', () => {
    assert.deepEqual(toTokens(null), {
      input: 0, output: 0, cacheCreate: 0, cacheRead: 0, total: 0, messages: 0,
    });
    assert.equal(toTokens({ input_tokens: 'x', output_tokens: 5 }).total, 5);
  });
});
