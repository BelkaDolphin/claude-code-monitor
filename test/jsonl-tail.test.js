import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { JsonlTail, streamLines } from '../src/jsonl-tail.js';
import { makeTmpDir } from './helpers.js';

describe('JsonlTail', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('tail'); });
  after(() => tmp.cleanup());

  test('reads only newly appended lines', () => {
    const file = path.join(tmp.dir, 'a.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n', 'utf8');
    const tail = new JsonlTail();

    const r1 = tail.read(file);
    assert.deepEqual(r1.lines, ['{"a":1}', '{"a":2}']);
    assert.equal(r1.firstLineNo, 1);

    const r2 = tail.read(file);
    assert.deepEqual(r2.lines, [], 'no new data -> no lines');
    assert.equal(r2.bytesRead, 0);

    fs.appendFileSync(file, '{"a":3}\n', 'utf8');
    const r3 = tail.read(file);
    assert.deepEqual(r3.lines, ['{"a":3}']);
    assert.equal(r3.firstLineNo, 3, 'line numbering continues across reads');
  });

  test('buffers an unterminated trailing line until its newline arrives', () => {
    const file = path.join(tmp.dir, 'partial.jsonl');
    fs.writeFileSync(file, '{"x":1}\n{"par', 'utf8');
    const tail = new JsonlTail();

    const r1 = tail.read(file);
    assert.deepEqual(r1.lines, ['{"x":1}'], 'partial line is withheld');

    fs.appendFileSync(file, 'tial":true}\n', 'utf8');
    const r2 = tail.read(file);
    assert.deepEqual(r2.lines, ['{"partial":true}'], 'joined across reads');
    assert.deepEqual(JSON.parse(r2.lines[0]), { partial: true });
  });

  test('multi-byte characters split across a chunk boundary survive', () => {
    const file = path.join(tmp.dir, 'utf8.jsonl');
    // Each of these is 3 bytes in UTF-8, so a small chunk size is guaranteed to
    // land mid-character.
    const text = 'あいうえお監視かきくけこ日本語テスト';
    const lines = [];
    for (let i = 0; i < 20; i++) lines.push(JSON.stringify({ i, text }));
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    // 7 is deliberately coprime with the 3-byte character width.
    const tail = new JsonlTail({ chunkSize: 7 });
    const r = tail.read(file);
    assert.equal(r.lines.length, 20);
    for (let i = 0; i < 20; i++) {
      const obj = JSON.parse(r.lines[i]);
      assert.equal(obj.text, text, `line ${i} decoded intact`);
    }
    assert.ok(!r.lines.join('').includes('�'), 'no replacement characters');
  });

  test('multi-byte split across an APPEND boundary survives', () => {
    const file = path.join(tmp.dir, 'utf8-append.jsonl');
    const payload = Buffer.from(`${JSON.stringify({ t: '監視ダッシュボード' })}\n`, 'utf8');
    // Split the buffer in the middle of a 3-byte character.
    const cut = 12;
    fs.writeFileSync(file, payload.subarray(0, cut));
    const tail = new JsonlTail();
    assert.deepEqual(tail.read(file).lines, [], 'incomplete line withheld');

    fs.appendFileSync(file, payload.subarray(cut));
    const r = tail.read(file);
    assert.equal(r.lines.length, 1);
    assert.equal(JSON.parse(r.lines[0]).t, '監視ダッシュボード');
  });

  test('truncation resets the offset instead of returning garbage', () => {
    const file = path.join(tmp.dir, 'trunc.jsonl');
    fs.writeFileSync(file, '{"n":1}\n{"n":2}\n{"n":3}\n', 'utf8');
    const tail = new JsonlTail();
    assert.equal(tail.read(file).lines.length, 3);

    fs.writeFileSync(file, '{"n":9}\n', 'utf8'); // rotated / truncated
    const r = tail.read(file);
    assert.equal(r.reset, true);
    assert.deepEqual(r.lines, ['{"n":9}']);
    assert.equal(r.firstLineNo, 1, 'line numbering restarts after a reset');
  });

  test('missing file is reported, not thrown', () => {
    const tail = new JsonlTail();
    const r = tail.read(path.join(tmp.dir, 'nope.jsonl'));
    assert.equal(r.missing, true);
    assert.deepEqual(r.lines, []);
  });

  test('CRLF line endings are stripped', () => {
    const file = path.join(tmp.dir, 'crlf.jsonl');
    fs.writeFileSync(file, '{"a":1}\r\n{"a":2}\r\n', 'utf8');
    const r = new JsonlTail().read(file);
    assert.deepEqual(r.lines, ['{"a":1}', '{"a":2}']);
  });

  test('readAll includes a file-final line with no newline', () => {
    const file = path.join(tmp.dir, 'nonewline.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"a":2}', 'utf8');
    const r = new JsonlTail().readAll(file);
    assert.deepEqual(r.lines, ['{"a":1}', '{"a":2}']);
  });

  test('offsets round-trip through toJSON/fromJSON', () => {
    const file = path.join(tmp.dir, 'persist.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n{"pa', 'utf8');
    const t1 = new JsonlTail();
    t1.read(file);
    const t2 = JsonlTail.fromJSON(t1.toJSON());
    fs.appendFileSync(file, 'rt":true}\n', 'utf8');
    const r = t2.read(file);
    assert.deepEqual(r.lines, ['{"part":true}']);
  });
});

describe('streamLines', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('stream'); });
  after(() => tmp.cleanup());

  test('yields every line with 1-based numbering and no blank callbacks', () => {
    const file = path.join(tmp.dir, 's.jsonl');
    fs.writeFileSync(file, 'a\n\nb\nc', 'utf8');
    const seen = [];
    const r = streamLines(file, (line, no) => seen.push([no, line]));
    assert.deepEqual(seen, [[1, 'a'], [3, 'b'], [4, 'c']]);
    assert.equal(r.lineCount, 4, 'blank lines still advance the counter');
  });

  test('missing file yields nothing', () => {
    const seen = [];
    const r = streamLines(path.join(tmp.dir, 'missing.jsonl'), () => seen.push(1));
    assert.equal(seen.length, 0);
    assert.equal(r.lineCount, 0);
  });
});

describe('JsonlTail: a read that fails halfway through', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('tail-partial'); });
  after(() => tmp.cleanup());

  test('offset, pending and lineNo stay in step, and the retry loses nothing', () => {
    // offset used to be assigned AFTER the chunk loop while pending and lineNo
    // were assigned inside it. A throw on the second chunk therefore left a
    // stale offset next to a pending buffer that had already moved on, and the
    // next read spliced the same bytes into the middle of a line.
    const file = path.join(tmp.dir, 'partial.jsonl');
    const lines = [];
    for (let i = 0; i < 40; i++) lines.push(JSON.stringify({ i, pad: 'x'.repeat(20) }));
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf8');

    // Chunks small enough that the file needs several of them, and a partial
    // line straddles every boundary.
    const tail = new JsonlTail({ chunkSize: 64 });
    const realRead = fs.readSync;
    let calls = 0;
    fs.readSync = (...args) => {
      calls += 1;
      if (calls === 2) {
        const err = new Error('EIO simulated');
        err.code = 'EIO';
        throw err;
      }
      return realRead(...args);
    };
    let first;
    try {
      first = tail.read(file);
    } finally {
      fs.readSync = realRead;
    }
    assert.ok(first.error, 'the failure is reported on the result');
    assert.equal(first.error.code, 'EIO');
    assert.ok(first.lines.length >= 1, 'the chunk that DID succeed is still handed back');

    // The retry must produce exactly the rest of the file, in order, with no
    // duplicated or spliced bytes.
    const rest = tail.read(file);
    assert.equal(rest.error, null);
    assert.deepEqual([...first.lines, ...rest.lines], lines);
    assert.equal(first.firstLineNo, 1);
    assert.equal(rest.firstLineNo, first.lines.length + 1);
    assert.equal(tail.read(file).lines.length, 0, 'and nothing is read twice');
  });

  test('a failure on the very first chunk still throws', () => {
    const file = path.join(tmp.dir, 'firstchunk.jsonl');
    fs.writeFileSync(file, '{"a":1}\n{"a":2}\n', 'utf8');
    const tail = new JsonlTail({ chunkSize: 8 });
    const realRead = fs.readSync;
    fs.readSync = () => { throw new Error('EIO on chunk 1'); };
    try {
      assert.throws(() => tail.read(file), /EIO on chunk 1/);
    } finally {
      fs.readSync = realRead;
    }
    // Nothing was consumed, so the whole file is still there to read.
    assert.deepEqual(tail.read(file).lines, ['{"a":1}', '{"a":2}']);
  });
});
