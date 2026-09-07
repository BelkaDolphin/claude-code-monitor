/**
 * The log a hidden instance writes instead of talking to a console.
 *
 * The two things that actually matter: a line written on the way to
 * process.exit() must already be on disk (so the crash reason survives), and
 * a server running from logon to shutdown must not be able to fill the disk.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';

import { makeTmpDir } from './helpers.js';
import { LogFile, teeConsole, redactSecrets, DEFAULT_MAX_BYTES } from '../src/log-file.js';

let tmp;
let file;
let seq = 0;

before(() => { tmp = makeTmpDir('cm-log'); });
after(() => { if (tmp) tmp.cleanup(); });
beforeEach(() => { seq += 1; file = path.join(tmp.dir, `serve-${seq}.log`); });

/** A clock that does not move, so timestamps are assertable. */
const fixedNow = () => new Date('2026-09-03T12:00:00.000Z');

/** The shape auth.generateToken() produces: 32 bytes as 64 lowercase hex. */
const TOKEN = 'a1b2c3d4'.repeat(8);

describe('writing', () => {
  test('appends immediately - nothing is buffered past the call', () => {
    const log = new LogFile({ file, now: fixedNow });
    log.write('hello\n');
    // No close(), no flush: the crash path never gets to call either.
    assert.equal(fs.readFileSync(file, 'utf8'), '2026-09-03T12:00:00.000Z out | hello\n');
    log.close();
  });

  test('every line is stamped and tagged, including inside one chunk', () => {
    const log = new LogFile({ file, now: fixedNow });
    log.write('one\ntwo\nthree\n', 'err');
    log.close();
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    assert.deepEqual(lines, [
      '2026-09-03T12:00:00.000Z err | one',
      '2026-09-03T12:00:00.000Z err | two',
      '2026-09-03T12:00:00.000Z err | three',
    ]);
  });

  test('a trailing newline does not become an empty stamped line', () => {
    const log = new LogFile({ file, now: fixedNow });
    log.write('x\n');
    log.close();
    assert.equal(fs.readFileSync(file, 'utf8').split('\n').length, 2); // 'x' + ''
  });

  test('appends to an existing log across restarts', () => {
    const a = new LogFile({ file, now: fixedNow });
    a.write('first\n');
    a.close();
    const b = new LogFile({ file, now: fixedNow });
    assert.equal(b.bytes > 0, true, 'it picked up the existing size');
    b.write('second\n');
    b.close();
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('first'));
    assert.ok(text.includes('second'));
  });

  test('an empty chunk writes nothing', () => {
    const log = new LogFile({ file, now: fixedNow });
    log.write('');
    log.close();
    assert.equal(fs.readFileSync(file, 'utf8'), '');
  });

  test('utf-8 survives, including the Japanese in our own paths', () => {
    const log = new LogFile({ file, now: fixedNow });
    log.write('D:\\develop\\Claude監視\\src\\cli.js\n');
    log.close();
    assert.ok(fs.readFileSync(file, 'utf8').includes('Claude監視'));
  });
});

describe('the size cap', () => {
  test('rotates to <file>.1 instead of growing without bound', () => {
    const log = new LogFile({ file, maxBytes: 400, now: fixedNow });
    for (let i = 0; i < 40; i++) log.write(`line ${i} padding padding padding\n`);
    log.close();
    assert.ok(log.rotations >= 1, `expected a rotation, got ${log.rotations}`);
    assert.equal(fs.existsSync(`${file}.1`), true, 'the previous generation is kept');
    assert.ok(fs.statSync(file).size <= 400, 'the live file stays under the cap');
    // The newest lines are in the live file; older ones survive one generation.
    assert.ok(fs.readFileSync(file, 'utf8').includes('line 39'));
  });

  test('only ONE generation is kept, so the ceiling is 2x maxBytes', () => {
    const log = new LogFile({ file, maxBytes: 300, now: fixedNow });
    for (let i = 0; i < 200; i++) log.write(`filling ${i}\n`);
    log.close();
    assert.equal(fs.existsSync(`${file}.2`), false, 'no unbounded generations');
    const live = fs.statSync(file).size;
    const rotated = fs.statSync(`${file}.1`).size;
    assert.ok(live + rotated <= 300 * 2 + 200, `total ${live + rotated} is bounded`);
  });

  test('the default cap is a few MB, not unlimited', () => {
    assert.equal(DEFAULT_MAX_BYTES, 4 * 1024 * 1024);
    const log = new LogFile({ file });
    assert.equal(log.maxBytes, DEFAULT_MAX_BYTES);
    log.close();
  });

  test('a nonsense maxBytes falls back to the default', () => {
    for (const bad of [0, -1, NaN, 'lots', null]) {
      const log = new LogFile({ file, maxBytes: bad });
      assert.equal(log.maxBytes, DEFAULT_MAX_BYTES, `maxBytes ${String(bad)}`);
      log.close();
    }
  });

  test('a single chunk larger than the cap is cut, so the bound still holds', () => {
    // Rotating before a write only bounds the file while one chunk fits in one
    // generation. A megabyte-long stack trace does not.
    const log = new LogFile({ file, maxBytes: 200, now: fixedNow });
    log.write(`${'x'.repeat(5000)}\n`);
    log.close();
    assert.ok(fs.statSync(file).size <= 200, `wrote ${fs.statSync(file).size} bytes into a 200 byte cap`);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\.\.\.\[truncated \d+ bytes\]/, 'the cut is stated, not silent');
    assert.ok(text.startsWith('2026-09-03T12:00:00.000Z out | xxx'), 'the head of the line survives');
  });

  test('cutting an oversized chunk never splits a multi-byte character', () => {
    // Every cap here lands the cut at a different offset inside a 3-byte
    // character; none of them may produce a replacement character.
    for (const maxBytes of [100, 101, 102, 103, 104, 140]) {
      const f = `${file}.utf8-${maxBytes}`;
      const log = new LogFile({ file: f, maxBytes, now: fixedNow });
      log.write(`${'監視'.repeat(500)}\n`);
      log.close();
      const text = fs.readFileSync(f, 'utf8');
      assert.equal(text.includes('�'), false, `maxBytes ${maxBytes}: ${text}`);
      assert.ok(fs.statSync(f).size <= maxBytes, `maxBytes ${maxBytes}`);
    }
  });
});

describe('a rotation that cannot happen', () => {
  /**
   * `<file>.1` as a non-empty DIRECTORY makes renameSync fail on every platform,
   * standing in for the real case: another program holding the previous
   * generation open, which is exactly when Windows refuses the rename.
   */
  function blockRotation(target) {
    const holder = path.join(`${target}.1`, 'held-open.txt');
    fs.mkdirSync(`${target}.1`, { recursive: true });
    fs.writeFileSync(holder, 'previous generation', 'utf8');
    return holder;
  }

  test('never truncates a file it may not own', () => {
    const holder = blockRotation(file);
    const log = new LogFile({ file, maxBytes: 300, now: fixedNow });
    for (let i = 0; i < 60; i++) log.write(`line ${i} padding padding padding\n`);
    log.close();

    const text = fs.readFileSync(file, 'utf8');
    // The old fallback was writeFileSync(file, ''), which would have thrown
    // away every line another appender had written to the same file.
    assert.ok(text.includes('line 0 '), 'the earliest line is still there');
    assert.ok(text.includes('line 59 '), 'and writing carried on regardless');
    assert.equal(log.rotations, 0);
    assert.ok(log.writeErrors > 0, 'the failure was recorded, not hidden');
    assert.ok(log.lastError);
    assert.equal(fs.readFileSync(holder, 'utf8'), 'previous generation',
      'nothing was removed before the rename was known to succeed');
  });

  test('is retried per generation of growth, not per write', () => {
    blockRotation(file);
    const log = new LogFile({ file, maxBytes: 2000, now: fixedNow });
    for (let i = 0; i < 300; i++) log.write(`line ${i} padding padding padding\n`);
    log.close();
    // Without the backoff the condition stays true forever and every one of the
    // 300 writes pays for a doomed rename.
    assert.ok(log.writeErrors <= 20, `${log.writeErrors} failed rotations for 300 writes`);
    assert.ok(log.writeErrors > 0, 'it does keep trying occasionally');
  });

  test('the size is re-read from disk, not assumed, after a failed rotation', () => {
    blockRotation(file);
    const log = new LogFile({ file, maxBytes: 300, now: fixedNow });
    for (let i = 0; i < 20; i++) log.write(`line ${i} padding padding padding\n`);
    assert.equal(log.bytes, fs.statSync(file).size, 'bytes tracks the real file');
    log.close();
  });
});

describe('never taking the server down', () => {
  test('a path that cannot be written is recorded, not thrown', () => {
    const asDir = path.join(tmp.dir, 'log-as-dir');
    fs.mkdirSync(asDir, { recursive: true });
    const log = new LogFile({ file: asDir });
    // On Windows openSync() on a DIRECTORY succeeds and only the write fails,
    // so the contract is about write(), never about fd.
    assert.equal(log.write('anything\n'), false);
    assert.ok(log.writeErrors > 0);
    assert.ok(log.lastError);
    log.close();
  });

  test('a write failure after the fd goes bad is counted, not fatal', () => {
    const log = new LogFile({ file, now: fixedNow });
    log.write('before\n');
    fs.closeSync(log.fd);
    log.fd = 12345; // an fd we do not own
    assert.equal(log.write('after\n'), false);
    assert.ok(log.writeErrors > 0);
    log.fd = null;
    log.close();
  });

  test('it insists on a file path', () => {
    assert.throws(() => new LogFile({}), /needs a file path/);
  });

  test('close is idempotent', () => {
    const log = new LogFile({ file });
    log.close();
    log.close();
    assert.equal(log.fd, null);
  });

  test('stats report the cap, the rotations and the failures', () => {
    const log = new LogFile({ file, maxBytes: 1024 });
    log.write('x\n');
    const s = log.stats();
    assert.equal(s.file, file);
    assert.equal(s.maxBytes, 1024);
    assert.equal(s.rotations, 0);
    assert.equal(s.writeErrors, 0);
    assert.ok(s.bytes > 0);
    log.close();
  });
});

describe('teeConsole', () => {
  test('mirrors stdout and stderr while still printing', () => {
    const log = new LogFile({ file, now: fixedNow });
    const out = new PassThrough();
    const err = new PassThrough();
    const seenOut = [];
    const seenErr = [];
    out.on('data', (c) => seenOut.push(c.toString('utf8')));
    err.on('data', (c) => seenErr.push(c.toString('utf8')));

    const restore = teeConsole(log, { stdout: out, stderr: err });
    out.write('to stdout\n');
    err.write('to stderr\n');
    restore();
    log.close();

    // The console still got everything.
    assert.deepEqual(seenOut, ['to stdout\n']);
    assert.deepEqual(seenErr, ['to stderr\n']);
    // ...and so did the file, tagged by stream.
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('out | to stdout'));
    assert.ok(text.includes('err | to stderr'));
  });

  test('restore puts the original writers back, and is idempotent', () => {
    const log = new LogFile({ file, now: fixedNow });
    const out = new PassThrough();
    const original = out.write;
    const restore = teeConsole(log, { stdout: out, stderr: new PassThrough() });
    assert.notEqual(out.write, original);
    restore();
    restore();
    assert.equal(out.write, original);
    out.write('after restore\n');
    log.close();
    assert.equal(fs.readFileSync(file, 'utf8').includes('after restore'), false);
  });

  test('Buffer chunks are decoded, not stringified as [object Object]', () => {
    const log = new LogFile({ file, now: fixedNow });
    const out = new PassThrough();
    const restore = teeConsole(log, { stdout: out, stderr: new PassThrough() });
    out.write(Buffer.from('buffered 監視\n', 'utf8'));
    restore();
    log.close();
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('buffered 監視'), text);
  });

  test('what goes through the tee is redacted too', () => {
    const log = new LogFile({ file, now: fixedNow });
    const out = new PassThrough();
    const seen = [];
    out.on('data', (c) => seen.push(c.toString('utf8')));
    const restore = teeConsole(log, { stdout: out, stderr: new PassThrough() });
    out.write(`http://127.0.0.1:47321/?t=${TOKEN}\n`);
    restore();
    log.close();
    // The console still gets the real URL - a human needs it to open the page.
    assert.deepEqual(seen, [`http://127.0.0.1:47321/?t=${TOKEN}\n`]);
    assert.equal(fs.readFileSync(file, 'utf8').includes(TOKEN), false);
  });

  test('a broken log never breaks printing', () => {
    const asDir = path.join(tmp.dir, 'tee-as-dir');
    fs.mkdirSync(asDir, { recursive: true });
    const log = new LogFile({ file: asDir });
    const out = new PassThrough();
    const seen = [];
    out.on('data', (c) => seen.push(c.toString('utf8')));
    const restore = teeConsole(log, { stdout: out, stderr: new PassThrough() });
    out.write('still printed\n');
    restore();
    log.close();
    assert.deepEqual(seen, ['still printed\n']);
  });
});

describe('the bearer token never lands in the file', () => {
  test('a startup URL loses the token, and the `?t=` with it', () => {
    const log = new LogFile({ file, now: fixedNow });
    log.write(`http://127.0.0.1:47321/?t=${TOKEN}\n`);
    log.close();
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes(TOKEN), false, text);
    // Dropping the key as well as the value makes "no entry URL is in this log"
    // one grep away from being checkable.
    assert.equal(text.includes('?t='), false, text);
    assert.ok(text.includes('http://127.0.0.1:47321/?<token redacted>'), text);
  });

  test('a token in a JSON payload goes too', () => {
    const log = new LogFile({ file, now: fixedNow });
    log.write(`${JSON.stringify({ ok: true, url: `http://127.0.0.1:47321/?t=${TOKEN}` })}\n`);
    log.close();
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes(TOKEN), false, text);
    assert.ok(text.includes('"ok":true'), 'the rest of the payload is untouched');
  });

  test('the session cookie is redacted wherever it is printed', () => {
    const log = new LogFile({ file, now: fixedNow });
    log.write(`Cookie: cm_token=${TOKEN}; other=1\n`, 'err');
    log.close();
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.includes(TOKEN), false, text);
    assert.ok(text.includes('cm_token=<redacted>; other=1'), text);
  });

  test('redactSecrets leaves everything else alone', () => {
    for (const plain of [
      'listening on 127.0.0.1:47321',
      'token: reused (C:\\Users\\alice\\.claude-monitor\\token)',
      'GET /api/state 200',
      'D:\\develop\\Claude監視\\src\\cli.js',
      '',
    ]) {
      assert.equal(redactSecrets(plain), plain, plain);
    }
    // Not a token: too short to be one, so nothing is guessed at.
    assert.equal(redactSecrets('?t=abc'), '?t=abc');
  });

  test('every occurrence goes, not just the first', () => {
    const other = 'f'.repeat(64);
    const text = redactSecrets(`a ?t=${TOKEN} b &t=${other} c cm_token=${TOKEN}`);
    assert.equal(text.includes(TOKEN), false, text);
    assert.equal(text.includes(other), false, text);
  });
});
