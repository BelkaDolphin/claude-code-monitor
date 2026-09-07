import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildTree, formatTree } from '../src/tree.js';
import {
  buildSessionIndex,
  listSubagents,
  findSession,
  readLastTimestamp,
  clearLastTimestampCache,
  peekSessionMeta,
} from '../src/session-index.js';
import { listSessionsView } from '../src/tree-view.js';
import { makeTmpDir, writeJsonl, assistantRec, toolResultRec, toolUseBlock } from './helpers.js';

/**
 * Build a fake projects/ layout:
 *   <root>/<project>/<sessionId>.jsonl
 *   <root>/<project>/<sessionId>/subagents/agent-<id>.jsonl + .meta.json
 */
function fixture(dir) {
  const sessionId = '11111111-2222-3333-4444-555555555555';
  const proj = path.join(dir, 'D--test-proj');
  const subs = path.join(proj, sessionId, 'subagents');
  fs.mkdirSync(subs, { recursive: true });

  // main transcript: spawns two agents, one async and one sync
  writeJsonl(path.join(proj, `${sessionId}.jsonl`), [
    { type: 'mode', mode: 'normal', sessionId },
    assistantRec({
      sessionId,
      messageId: 'm-main-1',
      timestamp: '2026-09-01T00:00:00.000Z',
      cwd: 'D:\\develop\\日本語パス',
      usage: { output_tokens: 10 },
      content: [toolUseBlock('toolu_async', 'Agent', { subagent_type: 'general-purpose', description: 'async one' })],
    }),
    // async spawn: the parent gets its tool_result IMMEDIATELY
    toolResultRec('toolu_async', {
      sessionId,
      timestamp: '2026-09-01T00:00:01.000Z',
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: 'aASYNC', description: 'async one' },
    }),
    assistantRec({
      sessionId,
      messageId: 'm-main-2',
      timestamp: '2026-09-01T00:00:02.000Z',
      usage: { output_tokens: 20 },
      content: [toolUseBlock('toolu_sync', 'Agent', { subagent_type: 'Explore', description: 'sync one' })],
    }),
    toolResultRec('toolu_sync', {
      sessionId,
      timestamp: '2026-09-01T00:05:00.000Z',
      toolUseResult: { status: 'completed', agentId: 'aSYNC' },
    }),
    assistantRec({
      sessionId,
      messageId: 'm-main-3',
      timestamp: '2026-09-01T00:06:00.000Z',
      usage: { output_tokens: 30 },
      content: [toolUseBlock('toolu_never', 'Agent', { subagent_type: 'general-purpose', description: 'still running' })],
    }),
    // NOTE: no tool_result for toolu_never -> that agent is genuinely running
  ]);

  const mkAgent = (agentId, meta, recs) => {
    fs.writeFileSync(path.join(subs, `agent-${agentId}.meta.json`), JSON.stringify(meta), 'utf8');
    writeJsonl(path.join(subs, `agent-${agentId}.jsonl`), recs);
  };

  mkAgent('aASYNC',
    { agentType: 'general-purpose', description: 'async one', toolUseId: 'toolu_async', spawnDepth: 1, model: 'sonnet' },
    [
      assistantRec({
        sessionId, agentId: 'aASYNC', isSidechain: true, messageId: 'm-async-1',
        timestamp: '2026-09-01T00:00:10.000Z', usage: { output_tokens: 100 },
        content: [toolUseBlock('toolu_nested', 'Agent', { subagent_type: 'Explore', description: 'nested' })],
      }),
      assistantRec({
        sessionId, agentId: 'aASYNC', isSidechain: true, messageId: 'm-async-2',
        timestamp: '2026-09-01T00:03:00.000Z', usage: { output_tokens: 5 },
        content: [toolUseBlock('toolu_bash', 'Bash', { command: 'echo hi' })],
      }),
    ]);

  mkAgent('aSYNC',
    { agentType: 'Explore', description: 'sync one', toolUseId: 'toolu_sync', spawnDepth: 1 },
    [assistantRec({ sessionId, agentId: 'aSYNC', isSidechain: true, messageId: 'm-sync-1', timestamp: '2026-09-01T00:02:00.000Z', usage: { output_tokens: 40 } })]);

  mkAgent('aNEVER',
    { agentType: 'general-purpose', description: 'still running', toolUseId: 'toolu_never', spawnDepth: 1, model: 'opus' },
    [assistantRec({ sessionId, agentId: 'aNEVER', isSidechain: true, messageId: 'm-never-1', timestamp: '2026-09-01T00:06:30.000Z', usage: { output_tokens: 1 } })]);

  // Depth-2 agent spawned BY aASYNC, living in the same flat subagents dir
  // and carrying an explicit parentAgentId (as real depth-2 metas do).
  mkAgent('aNESTED',
    { agentType: 'Explore', description: 'nested', toolUseId: 'toolu_nested', parentAgentId: 'aASYNC', spawnDepth: 2 },
    [assistantRec({ sessionId, agentId: 'aNESTED', isSidechain: true, messageId: 'm-nested-1', timestamp: '2026-09-01T00:01:00.000Z', usage: { output_tokens: 60 } })]);

  return { sessionId, root: dir, proj };
}

describe('session-index + tree', () => {
  let tmp;
  let fx;
  before(() => {
    tmp = makeTmpDir('tree');
    fx = fixture(tmp.dir);
  });
  after(() => tmp.cleanup());

  test('listSubagents reads every meta field including parentAgentId', () => {
    const subs = listSubagents(fx.proj, fx.sessionId);
    assert.equal(subs.length, 4);
    const nested = subs.find((s) => s.agentId === 'aNESTED');
    assert.equal(nested.spawnDepth, 2);
    assert.equal(nested.parentAgentId, 'aASYNC');
    assert.equal(nested.agentType, 'Explore');
    const sync = subs.find((s) => s.agentId === 'aSYNC');
    assert.equal(sync.model, null, 'meta.model may legitimately be absent');
  });

  test('cwd comes from inside the transcript, not the directory name', () => {
    const { sessions } = buildSessionIndex({ days: 0, root: fx.root });
    assert.equal(sessions.length, 1);
    // The dir name flattens every non-alphanumeric char, so Japanese would be
    // lost; only the in-file cwd preserves it.
    assert.equal(sessions[0].cwd, 'D:\\develop\\日本語パス');
    assert.equal(sessions[0].projectDirName, 'D--test-proj');
    assert.equal(sessions[0].subagents.length, 4);
    assert.equal(sessions[0].hasSubagents, true);
  });

  test('non-UUID .jsonl files are not mistaken for sessions', () => {
    writeJsonl(path.join(fx.proj, 'notes.jsonl'), [{ type: 'mode' }]);
    const { sessions } = buildSessionIndex({ days: 0, root: fx.root });
    assert.equal(sessions.length, 1);
    fs.rmSync(path.join(fx.proj, 'notes.jsonl'));
  });

  test('the days filter drops old transcripts', () => {
    const future = Date.now() + 400 * 24 * 3600 * 1000;
    const { sessions, skippedOlder } = buildSessionIndex({ days: 1, root: fx.root, now: future });
    assert.equal(sessions.length, 0);
    assert.equal(skippedOlder, 1);
  });

  test('findSession resolves a unique prefix', () => {
    const { session } = findSession('11111111', { root: fx.root });
    assert.equal(session.sessionId, fx.sessionId);
  });

  test('builds the parent/child structure including depth-2 nesting', () => {
    const { sessions } = buildSessionIndex({ days: 0, root: fx.root });
    const { root, orphans } = buildTree(sessions[0]);

    assert.equal(orphans.length, 0, 'every agent found its parent');
    assert.equal(root.kind, 'session');
    assert.deepEqual(root.children.map((c) => c.id).sort(), ['aASYNC', 'aNEVER', 'aSYNC']);

    const async1 = root.children.find((c) => c.id === 'aASYNC');
    assert.equal(async1.children.length, 1);
    assert.equal(async1.children[0].id, 'aNESTED');
    assert.equal(async1.children[0].spawnDepth, 2);
    assert.equal(async1.children[0].parentId, 'aASYNC');
  });

  test('async_launched is reported as async-unknown, NOT completed', () => {
    const { sessions } = buildSessionIndex({ days: 0, root: fx.root });
    const { nodes } = buildTree(sessions[0]);
    // The parent receives the tool_result the instant a background agent starts,
    // so its presence proves nothing about completion.
    assert.equal(nodes.get('aASYNC').statusInferred, 'async-unknown');
    assert.equal(nodes.get('aASYNC').statusSource, 'jsonl:async_launched');
  });

  test('a sync spawn with status=completed is completed', () => {
    const { sessions } = buildSessionIndex({ days: 0, root: fx.root });
    const { nodes } = buildTree(sessions[0]);
    assert.equal(nodes.get('aSYNC').statusInferred, 'completed');
  });

  test('no tool_result at all means running', () => {
    const { sessions } = buildSessionIndex({ days: 0, root: fx.root });
    const { nodes } = buildTree(sessions[0]);
    assert.equal(nodes.get('aNEVER').statusInferred, 'running');
  });

  test('a SubagentStop hook overrides the jsonl guess', () => {
    const { sessions } = buildSessionIndex({ days: 0, root: fx.root });
    const { nodes } = buildTree(sessions[0], { stoppedAgentIds: new Set(['aASYNC']) });
    assert.equal(nodes.get('aASYNC').statusInferred, 'completed');
    assert.equal(nodes.get('aASYNC').statusSource, 'hook:SubagentStop');
  });

  test('per-node metrics come from that node transcript only', () => {
    const { sessions } = buildSessionIndex({ days: 0, root: fx.root });
    const { root, nodes } = buildTree(sessions[0]);
    assert.equal(root.usage.output_tokens, 60, 'main transcript only: 10+20+30');
    assert.equal(nodes.get('aASYNC').usage.output_tokens, 105);
    assert.equal(nodes.get('aASYNC').toolUseCount, 2);
    assert.equal(nodes.get('aNESTED').usage.output_tokens, 60);
    assert.equal(nodes.get('aASYNC').startedAt, '2026-09-01T00:00:10.000Z');
    assert.equal(nodes.get('aASYNC').endedAt, '2026-09-01T00:03:00.000Z');
    assert.equal(nodes.get('aASYNC').durationMs, 170000);
  });

  test('model falls back to the transcript when meta.model is absent', () => {
    const { sessions } = buildSessionIndex({ days: 0, root: fx.root });
    const { nodes } = buildTree(sessions[0]);
    assert.equal(nodes.get('aSYNC').model, 'claude-opus-5', 'from the assistant records');
  });

  test('formatTree renders a nested outline', () => {
    const { sessions } = buildSessionIndex({ days: 0, root: fx.root });
    const { root } = buildTree(sessions[0]);
    const text = formatTree(root).join('\n');
    assert.match(text, /session 11111111/);
    assert.match(text, /agent aASYNC/);
    assert.match(text, /agent aNESTED/);
    assert.ok(text.indexOf('aNESTED') > text.indexOf('aASYNC'));
  });

  test('an agent whose spawning tool_use is missing becomes an orphan', () => {
    const orphanDir = makeTmpDir('orphan');
    try {
      const sessionId = '99999999-2222-3333-4444-555555555555';
      const proj = path.join(orphanDir.dir, 'P');
      const subs = path.join(proj, sessionId, 'subagents');
      fs.mkdirSync(subs, { recursive: true });
      writeJsonl(path.join(proj, `${sessionId}.jsonl`), [assistantRec({ sessionId, messageId: 'x' })]);
      fs.writeFileSync(path.join(subs, 'agent-aGHOST.meta.json'),
        JSON.stringify({ agentType: 'x', description: 'ghost', toolUseId: 'toolu_missing', spawnDepth: 1 }), 'utf8');
      writeJsonl(path.join(subs, 'agent-aGHOST.jsonl'), [assistantRec({ sessionId, agentId: 'aGHOST', messageId: 'g' })]);

      const { sessions } = buildSessionIndex({ days: 0, root: orphanDir.dir });
      const { orphans, root } = buildTree(sessions[0]);
      assert.equal(orphans.length, 1);
      assert.equal(orphans[0].id, 'aGHOST');
      assert.equal(root.children.length, 0);
    } finally {
      orphanDir.cleanup();
    }
  });
});

/**
 * The end-of-transcript read behind a session's END time.
 *
 * The property that matters is not "it finds the timestamp" but "it never reads
 * the whole file": this runs for every session on every /api/sessions call and
 * a transcript reaches 35MB.
 */
describe('readLastTimestamp (bounded tail read)', () => {
  let dir;
  before(() => { dir = makeTmpDir('cm-tail'); clearLastTimestampCache(); });
  after(() => { if (dir) dir.cleanup(); });

  const T1 = '2026-09-01T00:00:00.000Z';
  const T2 = '2026-09-01T03:00:00.000Z';
  const statOf = (f) => { const st = fs.statSync(f); return { size: st.size, mtimeMs: st.mtimeMs }; };
  const userRec = (uuid, timestamp) => ({
    type: 'user', uuid, timestamp, sessionId: 's', message: { role: 'user', content: 'x' },
  });

  test('the LAST record with a timestamp wins', () => {
    const f = path.join(dir.dir, 'plain.jsonl');
    writeJsonl(f, [userRec('a', T1), userRec('b', T2)]);
    clearLastTimestampCache();
    assert.equal(readLastTimestamp(f, statOf(f)), T2);
  });

  test('a trailing ai-title is skipped: those records carry no timestamp', () => {
    const f = path.join(dir.dir, 'ai-title-last.jsonl');
    writeJsonl(f, [
      userRec('a', T1),
      userRec('b', T2),
      { type: 'ai-title', aiTitle: 'a name', sessionId: 's' },
    ]);
    clearLastTimestampCache();
    assert.equal(readLastTimestamp(f, statOf(f)), T2);
  });

  test('a file with no timestamps anywhere yields null, not a guess', () => {
    const f = path.join(dir.dir, 'no-times.jsonl');
    writeJsonl(f, [
      { type: 'ai-title', aiTitle: 'x', sessionId: 's' },
      { type: 'mode', mode: 'normal', sessionId: 's' },
    ]);
    clearLastTimestampCache();
    assert.equal(readLastTimestamp(f, statOf(f)), null);
  });

  test('an empty file, a missing file and a corrupt tail are all null, never a throw', () => {
    const empty = path.join(dir.dir, 'empty.jsonl');
    fs.writeFileSync(empty, '', 'utf8');
    clearLastTimestampCache();
    assert.equal(readLastTimestamp(empty, statOf(empty)), null);
    assert.equal(readLastTimestamp(path.join(dir.dir, 'nope.jsonl'), { size: 10, mtimeMs: 1 }), null);
    assert.equal(readLastTimestamp(empty, null), null);

    const broken = path.join(dir.dir, 'broken.jsonl');
    fs.writeFileSync(broken, `${JSON.stringify(userRec('a', T1))}\n{"type":"user",\n`, 'utf8');
    clearLastTimestampCache();
    assert.equal(readLastTimestamp(broken, statOf(broken)), T1,
      'the unparseable last line is skipped, the good one before it is used');
  });

  test('only the tail is read: a timestamp past the window is NOT found', () => {
    const f = path.join(dir.dir, 'far.jsonl');
    // One timestamped record, then well over the 64KB window of records that
    // carry none. Finding T1 here would mean the whole file was read.
    const filler = { type: 'ai-title', aiTitle: 'p'.repeat(900), sessionId: 's' };
    writeJsonl(f, [userRec('a', T1), ...Array.from({ length: 90 }, () => filler)]);
    assert.ok(fs.statSync(f).size > 64 * 1024, 'the fixture has to exceed the window');
    clearLastTimestampCache();
    assert.equal(readLastTimestamp(f, statOf(f)), null);
  });

  test('the cache is keyed on (size, mtimeMs), so an unchanged file is not re-read', () => {
    const f = path.join(dir.dir, 'cached.jsonl');
    writeJsonl(f, [userRec('a', T1)]);
    const st = statOf(f);
    clearLastTimestampCache();
    assert.equal(readLastTimestamp(f, st), T1);

    // Same byte count, same reported stat: the cache must answer, not the disk.
    writeJsonl(f, [userRec('a', T2)]);
    assert.equal(fs.statSync(f).size, st.size, 'the rewrite has to be the same size');
    assert.equal(readLastTimestamp(f, st), T1, 'served from the cache');

    clearLastTimestampCache();
    assert.equal(readLastTimestamp(f, st), T2, 'and the disk once the cache is dropped');
  });

  test('buildSessionIndex carries lastTs, and skips the read when withCwd is off', () => {
    const proj = path.join(dir.dir, 'idx', 'D--p');
    const sid = '99999999-8888-7777-6666-555555555555';
    writeJsonl(path.join(proj, `${sid}.jsonl`), [userRec('a', T1), userRec('b', T2)]);
    clearLastTimestampCache();
    const withRead = buildSessionIndex({ days: 0, root: path.join(dir.dir, 'idx') });
    assert.equal(withRead.sessions[0].lastTs, T2);
    const without = buildSessionIndex({ days: 0, root: path.join(dir.dir, 'idx'), withCwd: false });
    assert.equal(without.sessions[0].lastTs, null);
  });
});

/**
 * Regression: e2a7ec22-c605-478e-ba4f-3fce7dc2e9d0.
 *
 * Its /api/sessions row came back with endedAt ONE MILLISECOND before
 * startedAt, both sourced from the transcript. The cause is that a transcript's
 * records are written in the order things happened, NOT in the order their
 * clocks read: line 5 carries ...55.266Z while lines 6 and 7 carry ...55.265Z,
 * and the records around them carry no timestamp at all. Reading "the first
 * timestamped line" as the start and "the last timestamped line" as the end
 * therefore picks the max as the start and the min as the end.
 */
describe('regression: a transcript whose timestamps are out of order', () => {
  let dir;
  before(() => { dir = makeTmpDir('cm-unordered'); clearLastTimestampCache(); });
  after(() => { if (dir) dir.cleanup(); });

  const EARLY = '2026-09-02T12:40:55.265Z';
  const LATE = '2026-09-02T12:40:55.266Z';
  const SID = 'e2a7ec22-c605-478e-ba4f-3fce7dc2e9d0';

  /** The measured 11-line shape, timestamps and all. */
  function unorderedTranscript(root) {
    const proj = path.join(root, 'D--develop-Claude--');
    const user = (uuid, timestamp) => ({
      type: 'user', uuid, timestamp, sessionId: SID, cwd: 'D:\develop\Claude監視',
      version: '2.1.258', message: { role: 'user', content: 'x' },
    });
    writeJsonl(path.join(proj, `${SID}.jsonl`), [
      { type: 'mode', mode: 'normal', sessionId: SID },
      { type: 'permission-mode', mode: 'default', sessionId: SID },
      { type: 'bridge-session', sessionId: SID },
      { type: 'file-history-snapshot', sessionId: SID },
      user('u5', LATE),   // <- the LATEST time arrives FIRST
      user('u6', EARLY),
      user('u7', EARLY),
      { type: 'cost-state', sessionId: SID },
      { type: 'last-prompt', sessionId: SID },
      { type: 'ai-title', aiTitle: 'out of order', sessionId: SID },
      { type: 'cost-state', sessionId: SID },
    ]);
    return proj;
  }

  test('the index takes the min for the head and the max for the tail', () => {
    const root = path.join(dir.dir, 'projects');
    unorderedTranscript(root);
    clearLastTimestampCache();
    const { sessions } = buildSessionIndex({ days: 0, root });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].firstTs, EARLY, 'firstTs is the MINIMUM, not line 5');
    assert.equal(sessions[0].lastTs, LATE, 'lastTs is the MAXIMUM, not line 7');
    assert.ok(Date.parse(sessions[0].lastTs) >= Date.parse(sessions[0].firstTs));
  });

  test('peekSessionMeta does not stop at the first timestamp it sees', () => {
    const root = path.join(dir.dir, 'peek');
    const proj = unorderedTranscript(root);
    assert.equal(peekSessionMeta(path.join(proj, `${SID}.jsonl`)).firstTs, EARLY);
  });

  test('and the list row comes out with a non-negative duration', () => {
    const root = path.join(dir.dir, 'view');
    unorderedTranscript(root);
    clearLastTimestampCache();
    const index = buildSessionIndex({ days: 0, root });
    const [row] = listSessionsView({ index, snapshot: null, days: 0 });
    assert.equal(row.startedAt, EARLY);
    assert.equal(row.startedAtSource, 'transcript');
    assert.equal(row.endedAt, LATE);
    assert.equal(row.endedAtSource, 'transcript');
    assert.equal(row.durationMs, 1);
  });
});
