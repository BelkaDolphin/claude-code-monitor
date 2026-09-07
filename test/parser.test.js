import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { parseLine, parseFile, ParseStats, KNOWN_IGNORED_TYPES, toolUses, toolResults } from '../src/parser.js';
import { makeTmpDir, writeJsonl, assistantRec, toolUseBlock } from './helpers.js';

describe('parseLine', () => {
  test('extracts assistant fields and content blocks', () => {
    const stats = new ParseStats();
    const rec = parseLine(JSON.stringify(assistantRec({
      messageId: 'msg_abc',
      usage: { input_tokens: 5, output_tokens: 7, cache_creation_input_tokens: 11, cache_read_input_tokens: 13 },
      content: [
        { type: 'thinking', thinking: 'hmm' },
        { type: 'text', text: 'hello' },
        toolUseBlock('toolu_1', 'Bash', { command: 'ls -la' }),
      ],
      agentId: 'aAAA',
      isSidechain: true,
    })), 1, { stats });

    assert.equal(rec.type, 'assistant');
    assert.equal(rec.messageId, 'msg_abc');
    assert.equal(rec.model, 'claude-opus-5');
    assert.equal(rec.agentId, 'aAAA');
    assert.equal(rec.isSidechain, true);
    assert.equal(rec.usage.output_tokens, 7);
    assert.ok(Number.isFinite(rec.tsMs));
    assert.deepEqual(rec.blocks.map((b) => b.kind), ['thinking', 'text', 'tool_use']);
    const tu = toolUses(rec);
    assert.equal(tu.length, 1);
    assert.equal(tu[0].id, 'toolu_1');
    assert.equal(tu[0].name, 'Bash');
    assert.equal(tu[0].input.command, 'ls -la');
  });

  test('extracts tool_result blocks and toolUseResult from user records', () => {
    const stats = new ParseStats();
    const rec = parseLine(JSON.stringify({
      type: 'user',
      uuid: 'u1',
      timestamp: '2026-09-01T00:00:00.000Z',
      sessionId: 's',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_9', is_error: true, content: 'boom' }] },
      toolUseResult: { stdout: '', stderr: 'boom' },
    }), 1, { stats });

    const tr = toolResults(rec);
    assert.equal(tr.length, 1);
    assert.equal(tr[0].toolUseId, 'toolu_9');
    assert.equal(tr[0].isError, true);
    assert.deepEqual(rec.toolUseResult, { stdout: '', stderr: 'boom' });
  });

  test('sessionId falls back to the snake_case session_id field', () => {
    const rec = parseLine(JSON.stringify({ type: 'system', session_id: 'snake-1', subtype: 'turn_duration' }), 1, {});
    assert.equal(rec.sessionId, 'snake-1');
    assert.equal(rec.subtype, 'turn_duration');
  });

  test('a broken line is counted with its line number, not thrown', () => {
    const stats = new ParseStats();
    assert.equal(parseLine('{"a":', 42, { stats, file: 'x.jsonl' }), null);
    assert.equal(stats.parseFailures, 1);
    assert.equal(stats.failureSamples[0].lineNo, 42);
    assert.equal(stats.failureSamples[0].file, 'x.jsonl');
    assert.ok(stats.failureSamples[0].error.length > 0);
    assert.equal(stats.failureSamples[0].snippet, '{"a":');
  });

  test('a JSON array line is rejected as not-an-object', () => {
    const stats = new ParseStats();
    assert.equal(parseLine('[1,2,3]', 1, { stats }), null);
    assert.equal(stats.parseFailures, 1);
  });

  test('blank lines are counted separately and never fail', () => {
    const stats = new ParseStats();
    assert.equal(parseLine('   ', 1, { stats }), null);
    assert.equal(stats.blankLines, 1);
    assert.equal(stats.parseFailures, 0);
  });

  test('known non-message types parse but are not flagged unknown', () => {
    const stats = new ParseStats();
    for (const t of ['mode', 'permission-mode', 'bridge-session', 'atis-latch', 'attachment', 'last-prompt', 'queue-operation', 'file-history-snapshot', 'ai-title', 'cost-state', 'frame-link', 'agent-name']) {
      assert.ok(KNOWN_IGNORED_TYPES.has(t), `${t} is in the known list`);
      const rec = parseLine(JSON.stringify({ type: t, sessionId: 's' }), 1, { stats });
      assert.equal(rec.type, t);
    }
    assert.equal(stats.unknownTypes.size, 0);
  });

  test('a genuinely unknown type is counted so a format change is visible', () => {
    const stats = new ParseStats();
    parseLine(JSON.stringify({ type: 'brand-new-type-2027', sessionId: 's' }), 1, { stats });
    parseLine(JSON.stringify({ type: 'brand-new-type-2027', sessionId: 's' }), 2, { stats });
    assert.equal(stats.unknownTypes.get('brand-new-type-2027'), 2);
    assert.equal(stats.typeCounts.get('brand-new-type-2027'), 2);
  });

  test('a record with no type at all is tolerated', () => {
    const stats = new ParseStats();
    const rec = parseLine('{"hello":"world"}', 1, { stats });
    assert.equal(rec.type, '(missing-type)');
    assert.equal(stats.unknownTypes.get('(missing-type)'), 1);
  });

  test('message.content given as a plain string still yields a text block', () => {
    const rec = parseLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'plain text' } }), 1, {});
    assert.deepEqual(rec.blocks.map((b) => b.kind), ['text']);
    assert.equal(rec.blocks[0].textLength, 10);
  });
});

describe('parseFile', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('parser'); });
  after(() => tmp.cleanup());

  test('streams a mixed file and keeps going past corruption', () => {
    const file = path.join(tmp.dir, 'mixed.jsonl');
    writeJsonl(file, [
      { type: 'mode', mode: 'normal', sessionId: 's' },
      assistantRec({ messageId: 'm1', usage: { output_tokens: 3 } }),
      '{"broken": ',
      { type: 'unknown-future-type' },
      assistantRec({ messageId: 'm2', usage: { output_tokens: 4 } }),
      '',
    ]);
    const recs = [];
    const stats = parseFile(file, (r) => recs.push(r));
    assert.equal(recs.length, 4, 'the broken line is skipped, everything else survives');
    assert.equal(stats.parseFailures, 1);
    assert.equal(stats.failureSamples[0].lineNo, 3);
    assert.equal(stats.unknownTypes.get('unknown-future-type'), 1);
    assert.equal(stats.files, 1);
    assert.equal(stats.blankLines, 1);
  });
});
