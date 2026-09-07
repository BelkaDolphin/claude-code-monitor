/**
 * The persisted token and the files that make a hidden instance findable.
 *
 * Every case uses an explicit path in a temp dir, so ~/.claude-monitor is never
 * read or written.
 */

import { test, describe, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeTmpDir } from './helpers.js';
import {
  isValidToken,
  readStoredToken,
  loadOrCreateToken,
  writeUrlFile,
  readUrlFile,
  readUrlPort,
  tokenFilePath,
  urlFilePath,
  defaultLogFilePath,
} from '../src/token-store.js';
import { generateToken } from '../src/auth.js';

let tmp;
let file;
let envBefore;

before(() => {
  tmp = makeTmpDir('cm-token');
  file = path.join(tmp.dir, 'token');
  envBefore = process.env.CLAUDE_MONITOR_DIR;
});

after(() => {
  if (envBefore === undefined) delete process.env.CLAUDE_MONITOR_DIR;
  else process.env.CLAUDE_MONITOR_DIR = envBefore;
  if (tmp) tmp.cleanup();
});

afterEach(() => {
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
});

describe('token shape', () => {
  test('accepts exactly what auth.generateToken produces', () => {
    for (let i = 0; i < 5; i++) assert.equal(isValidToken(generateToken()), true);
  });

  test('rejects everything else, without trimming or case folding', () => {
    const good = 'a'.repeat(64);
    for (const bad of [
      '', 'x', good.slice(0, 63), `${good}a`,
      good.toUpperCase(),
      `${good.slice(0, 32)} ${good.slice(33)}`, // interior space
      'g'.repeat(64),
      null, undefined, 42, {}, ['a'.repeat(64)],
    ]) {
      assert.equal(isValidToken(bad), false, `accepted ${JSON.stringify(bad)}`);
    }
  });
});

describe('readStoredToken', () => {
  test('a missing file is null, not an exception', () => {
    assert.equal(readStoredToken(path.join(tmp.dir, 'nope')), null);
  });

  test('a directory where the file should be is null', () => {
    const dir = path.join(tmp.dir, 'as-a-dir');
    fs.mkdirSync(dir, { recursive: true });
    assert.equal(readStoredToken(dir), null);
  });

  test('surrounding whitespace and a BOM are tolerated', () => {
    const t = generateToken();
    fs.writeFileSync(file, `﻿  ${t}\r\n`, 'utf8');
    assert.equal(readStoredToken(file), t);
  });

  test('anything malformed reads as no token at all', () => {
    for (const content of [
      '', '   ', 'not-a-token',
      'a'.repeat(63),
      'a'.repeat(65),
      'A'.repeat(64),
      `${'a'.repeat(64)}\n${'b'.repeat(64)}`, // two tokens: which one?
      '{"token":"' + 'a'.repeat(64) + '"}',
    ]) {
      fs.writeFileSync(file, content, 'utf8');
      assert.equal(readStoredToken(file), null, `accepted ${JSON.stringify(content.slice(0, 40))}`);
    }
  });
});

describe('loadOrCreateToken', () => {
  test('creates one when there is nothing there', () => {
    const r = loadOrCreateToken({ file });
    assert.equal(r.action, 'created');
    assert.equal(isValidToken(r.token), true);
    assert.equal(fs.readFileSync(file, 'utf8').trim(), r.token);
  });

  test('reuses it on the next start - this is what makes a bookmark work', () => {
    const first = loadOrCreateToken({ file });
    const second = loadOrCreateToken({ file });
    const third = loadOrCreateToken({ file });
    assert.equal(second.action, 'reused');
    assert.equal(third.action, 'reused');
    assert.equal(second.token, first.token);
    assert.equal(third.token, first.token);
  });

  test('regenerates over a malformed file rather than serving half a secret', () => {
    fs.writeFileSync(file, 'garbage\n', 'utf8');
    const r = loadOrCreateToken({ file });
    assert.equal(r.action, 'regenerated');
    assert.equal(isValidToken(r.token), true);
    assert.equal(readStoredToken(file), r.token);
  });

  test('rotate replaces a perfectly good token', () => {
    const first = loadOrCreateToken({ file });
    const rotated = loadOrCreateToken({ file, rotate: true });
    assert.equal(rotated.action, 'rotated');
    assert.notEqual(rotated.token, first.token);
    assert.equal(readStoredToken(file), rotated.token);
    // ...and the new one then sticks.
    assert.equal(loadOrCreateToken({ file }).token, rotated.token);
  });

  test('rotate on a fresh install just creates one', () => {
    const r = loadOrCreateToken({ file, rotate: true });
    assert.equal(r.action, 'created');
  });

  test('a generator that produces junk is a loud failure, not a silent one', () => {
    assert.throws(
      () => loadOrCreateToken({ file, generate: () => 'nope' }),
      /64-hex/,
    );
    // Nothing half-written was left behind.
    assert.equal(fs.existsSync(file), false);
  });

  test('it creates the parent directory', () => {
    const deep = path.join(tmp.dir, 'a', 'b', 'c', 'token');
    const r = loadOrCreateToken({ file: deep });
    assert.equal(isValidToken(r.token), true);
    assert.equal(readStoredToken(deep), r.token);
  });
});

describe('url.txt', () => {
  test('round-trips the bookmarkable url', () => {
    const target = path.join(tmp.dir, 'url.txt');
    const url = `http://127.0.0.1:47321/?t=${generateToken()}`;
    const w = writeUrlFile(url, target);
    assert.equal(w.written, true);
    assert.equal(readUrlFile(target), url);
    assert.equal(fs.readFileSync(target, 'utf8').endsWith('\n'), true);
  });

  test('an unwritable path is reported, never thrown - the server still starts', () => {
    const asDir = path.join(tmp.dir, 'url-dir');
    fs.mkdirSync(asDir, { recursive: true });
    const w = writeUrlFile('http://127.0.0.1:1/?t=x', asDir);
    assert.equal(w.written, false);
    assert.ok(w.error);
  });

  test('an empty url writes nothing', () => {
    const target = path.join(tmp.dir, 'url-empty.txt');
    assert.equal(writeUrlFile('', target).written, false);
    assert.equal(fs.existsSync(target), false);
  });

  test('a missing url file reads as null', () => {
    assert.equal(readUrlFile(path.join(tmp.dir, 'no-url.txt')), null);
  });
});

describe('the port recorded in url.txt', () => {
  /**
   * `rotate-token` is run bare, long after `serve --port N`. Without this the
   * new URL would name the default port and simply fail to connect - a silent
   * wrong answer, which is worse than a refusal.
   */
  test('comes back from the URL the last serve wrote', () => {
    const target = path.join(tmp.dir, 'port-url.txt');
    writeUrlFile(`http://127.0.0.1:48123/?t=${generateToken()}`, target);
    assert.equal(readUrlPort(target), 48123);
  });

  test('a missing file is null, so the caller can say it is guessing', () => {
    assert.equal(readUrlPort(path.join(tmp.dir, 'absent.txt')), null);
  });

  test('anything that is not a URL with a port is null, never a guess', () => {
    const target = path.join(tmp.dir, 'port-junk.txt');
    for (const content of [
      '',
      '   ',
      'not a url',
      'http://127.0.0.1/?t=x',      // no explicit port: 80 is not one we ever chose
      'http://127.0.0.1:0/?t=x',    // 0 means "pick one", never a live port
      'http://127.0.0.1:99999/',
      '127.0.0.1:47321',
    ]) {
      fs.writeFileSync(target, `${content}\n`, 'utf8');
      assert.equal(readUrlPort(target), null, `accepted ${JSON.stringify(content)}`);
    }
  });
});

describe('default locations follow CLAUDE_MONITOR_DIR', () => {
  test('token, url and log all live in the monitor dir', () => {
    process.env.CLAUDE_MONITOR_DIR = path.join(tmp.dir, 'md');
    assert.equal(tokenFilePath(), path.join(tmp.dir, 'md', 'token'));
    assert.equal(urlFilePath(), path.join(tmp.dir, 'md', 'url.txt'));
    assert.equal(defaultLogFilePath(), path.join(tmp.dir, 'md', 'serve.log'));
  });
});
