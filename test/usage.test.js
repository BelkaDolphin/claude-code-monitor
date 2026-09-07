import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { UsageCollector, aggregateFiles, usageTotal } from '../src/usage.js';
import { parseLine } from '../src/parser.js';
import { makeTmpDir, writeJsonl, assistantRec } from './helpers.js';

const rec = (o) => parseLine(JSON.stringify(assistantRec(o)), 1, {});

describe('UsageCollector dedupe', () => {
  test('the LATEST line for a message.id wins (the streaming-snapshot case)', () => {
    // This is the exact failure mode measured on real data: the same message.id
    // is written twice, first with a partial usage snapshot then with the final
    // one. Taking the first line undercounted a real day by 4.5x.
    const c = new UsageCollector();
    c.add(rec({ messageId: 'msg_stream', timestamp: '2026-09-01T00:00:01.000Z', usage: { output_tokens: 3 } }));
    c.add(rec({ messageId: 'msg_stream', timestamp: '2026-09-01T00:00:02.000Z', usage: { output_tokens: 5174 } }));

    const s = c.summarize();
    assert.equal(s.totals.output_tokens, 5174, 'final snapshot wins');
    assert.equal(s.uniqueMessages, 1);
    assert.equal(s.usageLines, 2);
    assert.equal(s.duplicateLines, 1);
    assert.equal(s.rawTotals.output_tokens, 5177, 'raw sum is kept for comparison');
  });

  test('an out-of-order feed still keeps the latest timestamp', () => {
    const c = new UsageCollector();
    c.add(rec({ messageId: 'm', timestamp: '2026-09-01T00:00:09.000Z', usage: { output_tokens: 900 } }));
    c.add(rec({ messageId: 'm', timestamp: '2026-09-01T00:00:01.000Z', usage: { output_tokens: 1 } }));
    assert.equal(c.summarize().totals.output_tokens, 900);
  });

  test('on an identical timestamp the larger usage wins (later line)', () => {
    const c = new UsageCollector();
    const ts = '2026-09-01T00:00:05.000Z';
    c.add(rec({ messageId: 'm', timestamp: ts, usage: { output_tokens: 10 } }));
    c.add(rec({ messageId: 'm', timestamp: ts, usage: { output_tokens: 2000 } }));
    assert.equal(c.summarize().totals.output_tokens, 2000);
  });

  test('taking the FIRST line would be wrong - guard against a regression', () => {
    const c = new UsageCollector();
    c.add(rec({ messageId: 'm', timestamp: '2026-09-01T00:00:01.000Z', usage: { output_tokens: 3 } }));
    c.add(rec({ messageId: 'm', timestamp: '2026-09-01T00:00:02.000Z', usage: { output_tokens: 5174 } }));
    assert.notEqual(c.summarize().totals.output_tokens, 3);
  });

  test('distinct message ids are all counted', () => {
    const c = new UsageCollector();
    c.add(rec({ messageId: 'a', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } }));
    c.add(rec({ messageId: 'b', usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 } }));
    const t = c.summarize().totals;
    assert.deepEqual(
      { i: t.input_tokens, o: t.output_tokens, cc: t.cache_creation_input_tokens, cr: t.cache_read_input_tokens },
      { i: 11, o: 22, cc: 33, cr: 44 },
    );
    assert.equal(t.totalTokens, 110);
  });

  test('records with no message.id fall back to requestId then uuid', () => {
    const c = new UsageCollector();
    const noId = assistantRec({ usage: { output_tokens: 5 } });
    delete noId.message.id;
    noId.requestId = 'req_shared';
    const a = parseLine(JSON.stringify({ ...noId, timestamp: '2026-09-01T00:00:01.000Z' }), 1, {});
    const b = parseLine(JSON.stringify({ ...noId, timestamp: '2026-09-01T00:00:02.000Z', message: { ...noId.message, usage: { output_tokens: 50 } } }), 2, {});
    c.add(a);
    c.add(b);
    assert.equal(c.summarize().uniqueMessages, 1, 'same requestId -> one entry');
    assert.equal(c.summarize().totals.output_tokens, 50);
  });

  test('non-assistant records and usage-less records are ignored', () => {
    const c = new UsageCollector();
    assert.equal(c.add(parseLine(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x' } }), 1, {})), false);
    const noUsage = assistantRec({});
    delete noUsage.message.usage;
    assert.equal(c.add(parseLine(JSON.stringify(noUsage), 1, {})), false);
    assert.equal(c.summarize().uniqueMessages, 0);
  });

  test('missing metric fields are treated as zero, not NaN', () => {
    const c = new UsageCollector();
    const r = assistantRec({});
    r.message.usage = { output_tokens: 7 }; // only one metric present
    c.add(parseLine(JSON.stringify(r), 1, {}));
    const t = c.summarize().totals;
    assert.equal(t.input_tokens, 0);
    assert.equal(t.output_tokens, 7);
    assert.ok(Number.isFinite(t.totalTokens));
  });

  test('grouping by date uses the LOCAL calendar day', () => {
    const c = new UsageCollector();
    // Build a timestamp that is unambiguously "today" in local time.
    const d = new Date(2026, 8, 2, 13, 0, 0); // local 2026-09-02 13:00
    c.add(rec({ messageId: 'd1', timestamp: d.toISOString(), usage: { output_tokens: 5 } }));
    const s = c.summarize();
    assert.ok(s.byDate['2026-09-02'], `expected local date bucket, got ${Object.keys(s.byDate)}`);
    assert.equal(s.byDate['2026-09-02'].output_tokens, 5);
  });

  test('byDateModel splits each day by model with the same buckets as byDate', () => {
    const c = new UsageCollector();
    const d1 = new Date(2026, 8, 2, 10, 0, 0); // local 2026-09-02
    const d2 = new Date(2026, 8, 3, 10, 0, 0); // local 2026-09-03
    c.add(rec({ messageId: 'a', timestamp: d1.toISOString(), usage: { output_tokens: 5, input_tokens: 1 } }));
    const sonnet = assistantRec({ messageId: 'b', timestamp: d1.toISOString(), usage: { output_tokens: 7 } });
    sonnet.message.model = 'claude-sonnet-5';
    c.add(parseLine(JSON.stringify(sonnet), 1, {}));
    c.add(rec({ messageId: 'c', timestamp: d2.toISOString(), usage: { output_tokens: 11 } }));

    const s = c.summarize();
    assert.deepEqual(Object.keys(s.byDateModel), ['2026-09-02', '2026-09-03']);
    assert.deepEqual(Object.keys(s.byDateModel['2026-09-02']), ['claude-opus-5', 'claude-sonnet-5']);
    assert.equal(s.byDateModel['2026-09-02']['claude-opus-5'].output_tokens, 5);
    assert.equal(s.byDateModel['2026-09-02']['claude-opus-5'].totalTokens, 6);
    assert.equal(s.byDateModel['2026-09-02']['claude-opus-5'].count, 1);
    assert.equal(s.byDateModel['2026-09-02']['claude-sonnet-5'].output_tokens, 7);
    assert.equal(s.byDateModel['2026-09-03']['claude-opus-5'].output_tokens, 11);

    // A day's models must add back up to that day's total, exactly.
    for (const date of Object.keys(s.byDate)) {
      const sum = Object.values(s.byDateModel[date]).reduce((n, v) => n + v.totalTokens, 0);
      assert.equal(sum, s.byDate[date].totalTokens, `${date} does not add up`);
    }
  });

  test('byDateModel obeys the same dedupe as everything else', () => {
    const c = new UsageCollector();
    const ts1 = new Date(2026, 8, 2, 10, 0, 0).toISOString();
    const ts2 = new Date(2026, 8, 2, 10, 0, 1).toISOString();
    c.add(rec({ messageId: 'dup', timestamp: ts1, usage: { output_tokens: 3 } }));
    c.add(rec({ messageId: 'dup', timestamp: ts2, usage: { output_tokens: 5174 } }));
    const s = c.summarize();
    assert.equal(s.byDateModel['2026-09-02']['claude-opus-5'].output_tokens, 5174);
    assert.equal(s.byDateModel['2026-09-02']['claude-opus-5'].count, 1);
  });

  test('a record with no parsable date lands in UNKNOWN_DATE, not in a real day', () => {
    const c = new UsageCollector();
    const noTs = assistantRec({ messageId: 'nots', usage: { output_tokens: 4 } });
    noTs.timestamp = null;
    c.add(parseLine(JSON.stringify(noTs), 1, {}));
    const s = c.summarize();
    assert.ok(s.byDateModel.UNKNOWN_DATE, 'expected an UNKNOWN_DATE bucket');
    assert.equal(s.byDateModel.UNKNOWN_DATE['claude-opus-5'].output_tokens, 4);
  });

  test('splits by model, session and agent', () => {
    const c = new UsageCollector();
    c.add(rec({ messageId: 'a', usage: { output_tokens: 1 } }));
    const sub = assistantRec({ messageId: 'b', usage: { output_tokens: 2 }, agentId: 'aXYZ', isSidechain: true });
    sub.message.model = 'claude-sonnet-5';
    sub.sessionId = 'sess-2';
    c.add(parseLine(JSON.stringify(sub), 1, {}));

    const s = c.summarize();
    assert.equal(s.byModel['claude-opus-5'].output_tokens, 1);
    assert.equal(s.byModel['claude-sonnet-5'].output_tokens, 2);
    assert.equal(s.byAgent['(main)'].output_tokens, 1);
    assert.equal(s.byAgent.aXYZ.output_tokens, 2);
    assert.equal(s.bySession['sess-1'].output_tokens, 1);
    assert.equal(s.bySession['sess-2'].output_tokens, 2);
  });
});

describe('aggregateFiles', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('usage'); });
  after(() => tmp.cleanup());

  test('dedupes ACROSS files, as ccusage does', () => {
    // The same message.id can appear in both the parent transcript and a
    // sidechain copy; the aggregate must count it once.
    const f1 = writeJsonl(path.join(tmp.dir, 'main.jsonl'), [
      assistantRec({ messageId: 'shared', timestamp: '2026-09-01T00:00:01.000Z', usage: { output_tokens: 100 } }),
    ]);
    const f2 = writeJsonl(path.join(tmp.dir, 'sub.jsonl'), [
      assistantRec({ messageId: 'shared', timestamp: '2026-09-01T00:00:02.000Z', usage: { output_tokens: 100 }, isSidechain: true, agentId: 'aS' }),
      assistantRec({ messageId: 'own', timestamp: '2026-09-01T00:00:03.000Z', usage: { output_tokens: 7 }, isSidechain: true, agentId: 'aS' }),
    ]);
    const { summary } = aggregateFiles([f1, f2]);
    assert.equal(summary.uniqueMessages, 2);
    assert.equal(summary.totals.output_tokens, 107);
    assert.equal(summary.rawTotals.output_tokens, 207, 'raw double-counts, deduped does not');
  });

  test('a corrupt line does not stop the aggregate', () => {
    const f = writeJsonl(path.join(tmp.dir, 'corrupt.jsonl'), [
      assistantRec({ messageId: 'k1', usage: { output_tokens: 5 } }),
      'not json at all {{{',
      assistantRec({ messageId: 'k2', usage: { output_tokens: 6 } }),
    ]);
    const { summary, stats } = aggregateFiles([f]);
    assert.equal(summary.totals.output_tokens, 11);
    assert.equal(stats.parseFailures, 1);
  });
});

test('usageTotal sums the four billable metrics only', () => {
  assert.equal(usageTotal({
    input_tokens: 1,
    output_tokens: 2,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 4,
    output_tokens_details: { thinking_tokens: 999 },
    server_tool_use: { web_search_requests: 5 },
  }), 10);
  assert.equal(usageTotal(null), 0);
});
