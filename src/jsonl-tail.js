/**
 * Incremental (byte-offset) tail reader for JSONL files.
 *
 * Why: transcripts reach 35MB+. Re-reading them on every poll is wasteful, and
 * naive utf8 chunk decoding corrupts multi-byte characters that straddle a
 * chunk boundary. So we read into Buffers, split on 0x0A, and only decode
 * COMPLETE lines. A trailing partial line stays in a Buffer until the next read.
 *
 * Truncate / rotate handling: if the file is smaller than our stored offset the
 * file was replaced or truncated, so we reset offset to 0 and drop the pending
 * partial buffer.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, stateDir } from './paths.js';

const LF = 0x0a;
const CR = 0x0d;
const DEFAULT_CHUNK = 1 << 20; // 1MiB
/** UTF-8 byte order mark. */
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Strip a leading UTF-8 BOM. Only ever call this on bytes read from offset 0 -
 * the same three bytes anywhere else are legitimate content.
 * @param {Buffer} buf
 * @returns {Buffer}
 */
export function stripBomBuffer(buf) {
  return buf.length >= 3 && buf[0] === BOM[0] && buf[1] === BOM[1] && buf[2] === BOM[2]
    ? buf.subarray(3)
    : buf;
}

/**
 * @typedef {Object} TailState
 * @property {number} offset  bytes consumed and decoded so far
 * @property {Buffer} pending trailing bytes not yet terminated by a newline
 * @property {number} size    last observed file size
 * @property {number} lineNo  1-based number of the last decoded line
 */

export class JsonlTail {
  /** @param {{chunkSize?: number}} [opts] */
  constructor(opts = {}) {
    /** @type {Map<string, TailState>} */
    this.states = new Map();
    this.chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  }

  /** @param {string} file */
  stateFor(file) {
    const key = path.resolve(file);
    let st = this.states.get(key);
    if (!st) {
      st = { offset: 0, pending: Buffer.alloc(0), size: 0, lineNo: 0 };
      this.states.set(key, st);
    }
    return st;
  }

  /** Forget a file's offset so the next read starts from the beginning. */
  reset(file) {
    this.states.delete(path.resolve(file));
  }

  /**
   * Read everything appended since the previous call.
   *
   * @param {string} file
   * @returns {{lines: string[], firstLineNo: number, reset: boolean, missing: boolean, bytesRead: number}}
   *   `lines` are complete, newline-terminated lines decoded as UTF-8 (newline
   *   stripped, CR stripped, blank lines removed). `firstLineNo` is the 1-based
   *   file line number of lines[0]. `reset` is true when a truncate/rotate was
   *   detected. `missing` is true when the file does not exist (offset kept).
   */
  read(file) {
    const st = this.stateFor(file);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return { lines: [], firstLineNo: st.lineNo + 1, reset: false, missing: true, bytesRead: 0 };
    }

    let didReset = false;
    if (stat.size < st.offset) {
      st.offset = 0;
      st.pending = Buffer.alloc(0);
      st.lineNo = 0;
      didReset = true;
    }
    st.size = stat.size;

    if (stat.size === st.offset) {
      return { lines: [], firstLineNo: st.lineNo + 1, reset: didReset, missing: false, bytesRead: 0 };
    }

    const firstLineNo = st.lineNo + 1;
    /** @type {string[]} */
    const lines = [];
    let bytesRead = 0;
    // Only the very first bytes of a file can carry a BOM.
    let atFileStart = st.offset === 0;

    // TOCTOU: the file can vanish between statSync and openSync. Claude Code
    // deletes old transcripts on its own schedule (observed mid-session), so
    // this race is real, not theoretical.
    let fd;
    try {
      fd = fs.openSync(file, 'r');
    } catch (err) {
      if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
        return { lines: [], firstLineNo, reset: didReset, missing: true, bytesRead: 0 };
      }
      throw err;
    }
    try {
      const buf = Buffer.allocUnsafe(this.chunkSize);
      let pos = st.offset;
      while (pos < stat.size) {
        const want = Math.min(this.chunkSize, stat.size - pos);
        const n = fs.readSync(fd, buf, 0, want, pos);
        if (n <= 0) break;
        pos += n;
        bytesRead += n;
        let chunk = st.pending.length ? Buffer.concat([st.pending, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
        if (atFileStart) {
          chunk = stripBomBuffer(chunk);
          atFileStart = false;
        }
        let start = 0;
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] !== LF) continue;
          let end = i;
          if (end > start && chunk[end - 1] === CR) end--;
          if (end > start) {
            lines.push(chunk.toString('utf8', start, end));
          } else {
            lines.push('');
          }
          st.lineNo++;
          start = i + 1;
        }
        st.pending = start < chunk.length ? Buffer.from(chunk.subarray(start)) : Buffer.alloc(0);
      }
      st.offset = pos;
    } finally {
      fs.closeSync(fd);
    }

    return { lines, firstLineNo, reset: didReset, missing: false, bytesRead };
  }

  /**
   * Flush the trailing partial line (a file whose last line has no newline).
   * Call this when you know the writer is done, e.g. when reading a historical
   * file in one shot. The pending bytes are consumed.
   * @param {string} file
   * @returns {{line: string, lineNo: number}|null}
   */
  flushPending(file) {
    const st = this.stateFor(file);
    if (!st.pending.length) return null;
    let end = st.pending.length;
    if (end > 0 && st.pending[end - 1] === CR) end--;
    const line = st.pending.toString('utf8', 0, end);
    st.pending = Buffer.alloc(0);
    st.lineNo++;
    return { line, lineNo: st.lineNo };
  }

  /**
   * Read a whole file as lines, including a trailing unterminated line.
   * Offsets are still tracked so a follow-up read() only returns new data.
   * @param {string} file
   */
  readAll(file) {
    const r = this.read(file);
    const tail = this.flushPending(file);
    if (tail) r.lines.push(tail.line);
    return r;
  }

  /** Serialize offsets so they survive process restarts. */
  toJSON() {
    /** @type {Record<string, {offset:number,size:number,lineNo:number,pending:string}>} */
    const out = {};
    for (const [k, v] of this.states) {
      out[k] = { offset: v.offset, size: v.size, lineNo: v.lineNo, pending: v.pending.toString('base64') };
    }
    return out;
  }

  /** @param {Record<string, any>} obj */
  static fromJSON(obj, opts) {
    const t = new JsonlTail(opts);
    for (const [k, v] of Object.entries(obj || {})) {
      t.states.set(k, {
        offset: Number(v.offset) || 0,
        size: Number(v.size) || 0,
        lineNo: Number(v.lineNo) || 0,
        pending: v.pending ? Buffer.from(v.pending, 'base64') : Buffer.alloc(0),
      });
    }
    return t;
  }

  /** Persist offsets under <monitorDir>/state/<name>.json */
  save(name) {
    const file = path.join(stateDir(), `${name}.json`);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(this.toJSON()), 'utf8');
    return file;
  }

  /** Load offsets previously saved with save(). Missing file -> empty tail. */
  static load(name, opts) {
    const file = path.join(stateDir(), `${name}.json`);
    try {
      return JsonlTail.fromJSON(JSON.parse(fs.readFileSync(file, 'utf8')), opts);
    } catch {
      return new JsonlTail(opts);
    }
  }
}

/**
 * One-shot streaming line reader with a callback. Never loads the whole file.
 * Used by the aggregators so a 35MB transcript never lands in memory at once.
 *
 * @param {string} file
 * @param {(line: string, lineNo: number) => void} onLine
 * @param {{chunkSize?: number}} [opts]
 * @returns {{lineCount: number, bytes: number, missing: boolean}}
 *   `missing` is true when the file did not exist (or vanished between the
 *   stat and the open); callers should treat that as "skip this file", never
 *   as an empty file.
 */
export function streamLines(file, onLine, opts = {}) {
  const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return { lineCount: 0, bytes: 0, missing: true };
  }
  // TOCTOU: enumerating a directory and then opening its files is not atomic.
  let fd;
  try {
    fd = fs.openSync(file, 'r');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { lineCount: 0, bytes: 0, missing: true };
    }
    throw err;
  }
  let lineNo = 0;
  let pos = 0;
  let pending = Buffer.alloc(0);
  let atFileStart = true;
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    while (pos < stat.size) {
      const want = Math.min(chunkSize, stat.size - pos);
      const n = fs.readSync(fd, buf, 0, want, pos);
      if (n <= 0) break;
      pos += n;
      let chunk = pending.length ? Buffer.concat([pending, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      if (atFileStart) {
        chunk = stripBomBuffer(chunk);
        atFileStart = false;
      }
      let start = 0;
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] !== LF) continue;
        let end = i;
        if (end > start && chunk[end - 1] === CR) end--;
        lineNo++;
        if (end > start) onLine(chunk.toString('utf8', start, end), lineNo);
        start = i + 1;
      }
      pending = start < chunk.length ? Buffer.from(chunk.subarray(start)) : Buffer.alloc(0);
    }
    if (pending.length) {
      let end = pending.length;
      if (pending[end - 1] === CR) end--;
      lineNo++;
      if (end > 0) onLine(pending.toString('utf8', 0, end), lineNo);
    }
  } finally {
    fs.closeSync(fd);
  }
  return { lineCount: lineNo, bytes: pos, missing: false };
}
