import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildToolLog, summarizeInput } from '../src/tools-log.js';
import { buildSessionIndex } from '../src/session-index.js';
import { makeTmpDir, writeJsonl, assistantRec, toolResultRec, toolUseBlock } from './helpers.js';

describe('summarizeInput', () => {
  test('Bash shows the leading command text, clipped', () => {
    const long = `echo ${'x'.repeat(200)}`;
    const s = summarizeInput('Bash', { command: long });
    assert.ok(s.length <= 83, `got ${s.length}`);
    assert.ok(s.startsWith('echo xxx'));
    assert.ok(s.endsWith('...'));
  });

  test('Bash collapses newlines so the table stays one row per call', () => {
    assert.equal(summarizeInput('Bash', { command: 'a\nb\n  c' }), 'a b c');
  });

  test('Read/Write/Edit show the file path', () => {
    assert.equal(summarizeInput('Read', { file_path: 'D:\\a\\b.js' }), 'D:\\a\\b.js');
    assert.equal(summarizeInput('Write', { file_path: 'D:\\a\\c.js', content: 'zzz' }), 'D:\\a\\c.js');
    assert.match(summarizeInput('Edit', { file_path: 'D:\\a\\d.js', old_string: 'const x = 1' }), /d\.js :: const x = 1/);
  });

  test('Agent shows the subagent type and description', () => {
    assert.equal(summarizeInput('Agent', { subagent_type: 'Explore', description: 'find stuff', prompt: 'long...' }),
      'Explore: find stuff');
  });

  test('an unknown tool falls back to a compact rendering', () => {
    assert.equal(summarizeInput('BrandNewTool', { file_path: '/x' }), '/x');
    assert.match(summarizeInput('BrandNewTool', { alpha: 1, beta: 2 }), /alpha/);
  });

  test('null/odd inputs never throw', () => {
    assert.equal(summarizeInput('Bash', null), '');
    assert.equal(summarizeInput(null, 'raw string'), 'raw string');
    assert.equal(summarizeInput('X', 42), '42');
  });

  test('Japanese text is preserved', () => {
    assert.equal(summarizeInput('Read', { file_path: 'D:\\develop\\Claude監視\\src\\cli.js' }),
      'D:\\develop\\Claude監視\\src\\cli.js');
  });
});

describe('buildToolLog', () => {
  let tmp;
  let session;
  before(() => {
    tmp = makeTmpDir('tools');
    const sessionId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const proj = path.join(tmp.dir, 'P');
    const subs = path.join(proj, sessionId, 'subagents');
    fs.mkdirSync(subs, { recursive: true });

    writeJsonl(path.join(proj, `${sessionId}.jsonl`), [
      assistantRec({
        sessionId, messageId: 'm1', timestamp: '2026-09-01T00:00:00.000Z',
        content: [toolUseBlock('t_ok', 'Bash', { command: 'ls' })],
      }),
      toolResultRec('t_ok', { sessionId, timestamp: '2026-09-01T00:00:01.500Z' }),
      assistantRec({
        sessionId, messageId: 'm2', timestamp: '2026-09-01T00:00:02.000Z',
        content: [toolUseBlock('t_err', 'Read', { file_path: 'D:\\missing.txt' })],
      }),
      toolResultRec('t_err', { sessionId, timestamp: '2026-09-01T00:00:03.000Z', isError: true }),
      assistantRec({
        sessionId, messageId: 'm3', timestamp: '2026-09-01T00:00:04.000Z',
        content: [toolUseBlock('t_pending', 'Bash', { command: 'sleep 100' })],
      }),
    ]);

    fs.writeFileSync(path.join(subs, 'agent-aSUB.meta.json'),
      JSON.stringify({ agentType: 'Explore', description: 'd', toolUseId: 't_none', spawnDepth: 1 }), 'utf8');
    writeJsonl(path.join(subs, 'agent-aSUB.jsonl'), [
      assistantRec({
        sessionId, agentId: 'aSUB', isSidechain: true, messageId: 'ms1', timestamp: '2026-09-01T00:00:05.000Z',
        content: [toolUseBlock('t_sub', 'Grep', { pattern: 'foo', path: 'src' })],
      }),
      toolResultRec('t_sub', { sessionId, agentId: 'aSUB', timestamp: '2026-09-01T00:00:06.000Z' }),
    ]);

    session = buildSessionIndex({ days: 0, root: tmp.dir }).sessions[0];
  });
  after(() => tmp.cleanup());

  test('pairs tool_use with tool_result and computes duration', () => {
    const { calls } = buildToolLog(session);
    const ok = calls.find((c) => c.id === 't_ok');
    assert.equal(ok.name, 'Bash');
    assert.equal(ok.status, 'ok');
    assert.equal(ok.durationMs, 1500);
    assert.equal(ok.summary, 'ls');
    assert.equal(ok.agentId, null, 'main thread');
  });

  test('flags errors', () => {
    const { calls, errors } = buildToolLog(session);
    assert.equal(errors, 1);
    const err = calls.find((c) => c.id === 't_err');
    assert.equal(err.status, 'error');
    assert.equal(err.isError, true);
  });

  test('a tool_use with no result is pending, not lost', () => {
    const { calls, pending } = buildToolLog(session);
    assert.equal(pending, 1);
    const p = calls.find((c) => c.id === 't_pending');
    assert.equal(p.status, 'pending');
    assert.equal(p.durationMs, null);
  });

  test('attributes calls to the subagent that made them', () => {
    const { calls } = buildToolLog(session);
    const sub = calls.find((c) => c.id === 't_sub');
    assert.equal(sub.agentId, 'aSUB');
    assert.equal(sub.name, 'Grep');
    assert.equal(sub.summary, 'foo | src');
  });

  test('counts calls by tool name and orders chronologically', () => {
    const { calls, byTool } = buildToolLog(session);
    assert.deepEqual(byTool, { Bash: 2, Read: 1, Grep: 1 });
    assert.deepEqual(calls.map((c) => c.id), ['t_ok', 't_err', 't_pending', 't_sub']);
  });

  test('a repeated streaming tool_use is one call, keeping the complete input', () => {
    const dir2 = makeTmpDir('tools2');
    try {
      const sid = 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee';
      const proj = path.join(dir2.dir, 'P');
      fs.mkdirSync(proj, { recursive: true });
      writeJsonl(path.join(proj, `${sid}.jsonl`), [
        assistantRec({ sessionId: sid, messageId: 'm', timestamp: '2026-09-01T00:00:00.000Z', content: [toolUseBlock('t1', 'Bash', { command: 'ech' })] }),
        assistantRec({ sessionId: sid, messageId: 'm', timestamp: '2026-09-01T00:00:01.000Z', content: [toolUseBlock('t1', 'Bash', { command: 'echo complete' })] }),
      ]);
      const s = buildSessionIndex({ days: 0, root: dir2.dir }).sessions[0];
      const { calls } = buildToolLog(s);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].summary, 'echo complete');
      assert.equal(calls[0].startedAt, '2026-09-01T00:00:00.000Z', 'earliest timestamp is the start');
    } finally {
      dir2.cleanup();
    }
  });
});
