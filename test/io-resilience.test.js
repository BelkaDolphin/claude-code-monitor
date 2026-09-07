/**
 * Regression tests for the code-review findings on file I/O:
 *   #3 statSync-then-openSync is a TOCTOU race. Claude Code prunes old
 *      transcripts on its own schedule (observed happening mid-session), so a
 *      file enumerated a moment ago can be gone by the time we open it. That
 *      must degrade to "skipped", never abort a whole aggregate.
 *   #4 a leading UTF-8 BOM must be stripped, but only at offset 0.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JsonlTail, streamLines, stripBomBuffer } from '../src/jsonl-tail.js';
import { parseFile, ParseStats } from '../src/parser.js';
import { aggregateFiles } from '../src/usage.js';
import { makeTmpDir, writeJsonl, assistantRec } from './helpers.js';

describe('missing / vanishing files (review #3)', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('io'); });
  after(() => tmp.cleanup());

  test('streamLines reports missing:true rather than an empty file', () => {
    const seen = [];
    const r = streamLines(path.join(tmp.dir, 'never-existed.jsonl'), (l) => seen.push(l));
    assert.equal(r.missing, true);
    assert.equal(r.lineCount, 0);
    assert.equal(seen.length, 0);
  });

  test('streamLines on a real file reports missing:false', () => {
    const f = writeJsonl(path.join(tmp.dir, 'real.jsonl'), [{ type: 'mode' }]);
    const r = streamLines(f, () => {});
    assert.equal(r.missing, false);
    assert.equal(r.lineCount, 1);
  });

  test('JsonlTail.read survives a file deleted between stat and open', () => {
    // Simulate the race directly: statSync succeeds against a real file, then
    // the file is removed before openSync runs.
    const f = path.join(tmp.dir, 'racy.jsonl');
    fs.writeFileSync(f, '{"a":1}\n{"a":2}\n', 'utf8');
    const tail = new JsonlTail();

    const realStat = fs.statSync;
    let fired = false;
    fs.statSync = (p, ...rest) => {
      const st = realStat(p, ...rest);
      if (!fired && String(p) === f) {
        fired = true;
        fs.rmSync(f, { force: true }); // vanishes right here
      }
      return st;
    };
    try {
      const r = tail.read(f);
      assert.equal(r.missing, true, 'reported as missing, not thrown');
      assert.deepEqual(r.lines, []);
    } finally {
      fs.statSync = realStat;
    }
  });

  test('streamLines survives the same race', () => {
    const f = path.join(tmp.dir, 'racy2.jsonl');
    fs.writeFileSync(f, '{"a":1}\n', 'utf8');

    const realStat = fs.statSync;
    let fired = false;
    fs.statSync = (p, ...rest) => {
      const st = realStat(p, ...rest);
      if (!fired && String(p) === f) {
        fired = true;
        fs.rmSync(f, { force: true });
      }
      return st;
    };
    try {
      const r = streamLines(f, () => { throw new Error('should not be called'); });
      assert.equal(r.missing, true);
      assert.equal(r.lineCount, 0);
    } finally {
      fs.statSync = realStat;
    }
  });

  test('parseFile counts a missing file as skipped and keeps going', () => {
    const stats = new ParseStats();
    const recs = [];
    parseFile(path.join(tmp.dir, 'gone.jsonl'), (r) => recs.push(r), stats);
    assert.equal(stats.skippedFiles, 1);
    assert.equal(recs.length, 0);
    assert.equal(stats.parseFailures, 0, 'a missing file is not a parse failure');
    assert.match(stats.skippedFileSamples[0].error, /disappeared/);
  });

  test('an aggregate over a list that includes deleted files still completes', () => {
    // This is the exact scenario: enumerate the directory, Claude Code prunes
    // some transcripts, then we read the list.
    const alive1 = writeJsonl(path.join(tmp.dir, 'alive1.jsonl'), [
      assistantRec({ messageId: 'a1', usage: { output_tokens: 100 } }),
    ]);
    const doomed = writeJsonl(path.join(tmp.dir, 'doomed.jsonl'), [
      assistantRec({ messageId: 'd1', usage: { output_tokens: 999 } }),
    ]);
    const alive2 = writeJsonl(path.join(tmp.dir, 'alive2.jsonl'), [
      assistantRec({ messageId: 'a2', usage: { output_tokens: 7 } }),
    ]);

    const files = [alive1, doomed, alive2];
    fs.rmSync(doomed); // deleted after enumeration

    const { summary, stats } = aggregateFiles(files);
    assert.equal(summary.totals.output_tokens, 107, 'the surviving files are still summed');
    assert.equal(summary.skippedFiles, 1);
    assert.equal(stats.skippedFiles, 1);
    assert.equal(stats.files, 3, 'all three were attempted');
  });

  test('the skipped count is reported even when every file is gone', () => {
    const { summary, stats } = aggregateFiles([
      path.join(tmp.dir, 'x1.jsonl'),
      path.join(tmp.dir, 'x2.jsonl'),
    ]);
    assert.equal(summary.totals.output_tokens, 0);
    assert.equal(stats.skippedFiles, 2);
  });

  test('skipped files show up in the serialized stats', () => {
    const stats = new ParseStats();
    parseFile(path.join(tmp.dir, 'nope.jsonl'), () => {}, stats);
    const j = stats.toJSON();
    assert.equal(j.skippedFiles, 1);
    assert.equal(j.skippedFileSamples.length, 1);
  });

  test('ParseStats.merge carries skipped counts across', () => {
    const a = new ParseStats();
    const b = new ParseStats();
    parseFile(path.join(tmp.dir, 'no-a.jsonl'), () => {}, a);
    parseFile(path.join(tmp.dir, 'no-b.jsonl'), () => {}, b);
    a.merge(b);
    assert.equal(a.skippedFiles, 2);
    assert.equal(a.skippedFileSamples.length, 2);
  });
});

describe('UTF-8 BOM handling (review #4)', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('bom'); });
  after(() => tmp.cleanup());

  const BOM = '﻿';

  test('stripBomBuffer removes a leading BOM and nothing else', () => {
    assert.deepEqual(stripBomBuffer(Buffer.from(`${BOM}abc`, 'utf8')), Buffer.from('abc', 'utf8'));
    assert.deepEqual(stripBomBuffer(Buffer.from('abc', 'utf8')), Buffer.from('abc', 'utf8'));
    assert.deepEqual(stripBomBuffer(Buffer.alloc(0)), Buffer.alloc(0));
    assert.deepEqual(stripBomBuffer(Buffer.from([0xef, 0xbb])), Buffer.from([0xef, 0xbb]), 'a truncated BOM is left alone');
  });

  test('streamLines strips a BOM so the first line still parses', () => {
    const f = path.join(tmp.dir, 'bom.jsonl');
    fs.writeFileSync(f, `${BOM}{"first":true}\n{"second":true}\n`, 'utf8');
    const lines = [];
    streamLines(f, (l) => lines.push(l));
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { first: true }, 'the BOM would otherwise break JSON.parse');
    assert.equal(lines[0].charCodeAt(0), '{'.charCodeAt(0));
  });

  test('parseFile handles a BOM file with zero parse failures', () => {
    const f = path.join(tmp.dir, 'bom-records.jsonl');
    fs.writeFileSync(f, BOM + [
      JSON.stringify(assistantRec({ messageId: 'b1', usage: { output_tokens: 11 } })),
      JSON.stringify(assistantRec({ messageId: 'b2', usage: { output_tokens: 22 } })),
    ].join('\n') + '\n', 'utf8');

    const recs = [];
    const stats = parseFile(f, (r) => recs.push(r));
    assert.equal(stats.parseFailures, 0);
    assert.equal(recs.length, 2);
    assert.equal(recs[0].messageId, 'b1');
  });

  test('a BOM file aggregates correctly', () => {
    const f = path.join(tmp.dir, 'bom-usage.jsonl');
    fs.writeFileSync(f, BOM + JSON.stringify(assistantRec({ messageId: 'u1', usage: { output_tokens: 42 } })) + '\n', 'utf8');
    const { summary, stats } = aggregateFiles([f]);
    assert.equal(stats.parseFailures, 0);
    assert.equal(summary.totals.output_tokens, 42);
  });

  test('JsonlTail strips a BOM on the first read only', () => {
    const f = path.join(tmp.dir, 'bom-tail.jsonl');
    fs.writeFileSync(f, `${BOM}{"n":1}\n`, 'utf8');
    const tail = new JsonlTail();
    const r1 = tail.read(f);
    assert.deepEqual(r1.lines.map((l) => JSON.parse(l)), [{ n: 1 }]);

    // Appended content must NOT be BOM-scanned again.
    fs.appendFileSync(f, `${BOM}{"n":2}\n`, 'utf8');
    const r2 = tail.read(f);
    assert.equal(r2.lines.length, 1);
    assert.equal(r2.lines[0].charCodeAt(0), 0xfeff, 'a mid-file BOM is content, not a marker, and is preserved');
  });

  test('a BOM split across a tiny chunk boundary is still handled', () => {
    const f = path.join(tmp.dir, 'bom-chunk.jsonl');
    fs.writeFileSync(f, `${BOM}{"deep":"監視"}\n{"x":1}\n`, 'utf8');
    const lines = [];
    // chunkSize 5 forces the first read to cover the BOM plus a partial char.
    streamLines(f, (l) => lines.push(l), { chunkSize: 5 });
    assert.equal(lines.length, 2);
    assert.deepEqual(JSON.parse(lines[0]), { deep: '監視' });
  });

  test('a file with no BOM is completely unaffected', () => {
    const f = path.join(tmp.dir, 'no-bom.jsonl');
    fs.writeFileSync(f, '{"a":1}\n{"b":2}\n', 'utf8');
    const lines = [];
    streamLines(f, (l) => lines.push(l));
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
  });
});
