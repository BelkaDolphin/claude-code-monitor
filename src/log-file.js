/**
 * Tee stdout/stderr into a size-capped file.
 *
 * An instance started at logon has no console: nothing writes to a window
 * nobody opened. The startup URL, the "port already in use" refusal and -
 * most importantly - the crash reason from installCrashHandlers (architecture
 * 4.7) would all vanish. A monitoring tool that dies silently is the failure
 * this whole project is against, so hidden operation needs a log or it is not
 * allowed to be hidden.
 *
 * Design notes:
 *
 *  - Writes go through `fs.writeSync` on an appended fd, NOT a stream. The
 *    crash path ends in `process.exit(1)`, which does not flush pending async
 *    writes; a buffered logger loses exactly the line that mattered.
 *  - The tee wraps `process.stdout.write` / `process.stderr.write` rather than
 *    asking every caller to log twice. That catches cli.js's own `fail()`, the
 *    signal handler's message and anything else that ever prints.
 *  - The cap keeps ONE previous generation (`<file>.1`). A monitor that runs
 *    from logon to shutdown for months must not be able to fill a disk, and a
 *    log with no history is hard to read after a crash.
 *  - Every write is wrapped: a full disk, a locked file or a deleted directory
 *    must never take the server down. Failures are counted, not thrown.
 *  - Every write is SCRUBBED of the dashboard's bearer token. The log outlives
 *    the process, so a live credential in it is a credential with no expiry.
 *    Scrubbing happens here, once, rather than at each of the callers that
 *    might one day print a URL - a rule enforced in one place is a rule that
 *    holds.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Rotate at 4 MiB, keeping one previous generation: 8 MiB worst case. */
export const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

/**
 * Where the 64-hex bearer token can appear in a line somebody printed, and what
 * takes its place.
 *
 * The replacement drops the `t=` along with the value on purpose: "the log
 * never contains an entry URL" is then one grep for `?t=` away from being
 * checked, instead of a judgement call about whether the hex after it was real.
 */
const TOKEN_PATTERNS = [
  // http://127.0.0.1:47321/?t=<64 hex>  - the startup URL and url.txt
  [/([?&])t=[0-9a-f]{64}/gi, '$1<token redacted>'],
  // cm_token=<64 hex> - the session cookie, in a Cookie or Set-Cookie header
  [/cm_token=[0-9a-f]{64}/gi, 'cm_token=<redacted>'],
];

/**
 * Replace any bearer token in `text` with a marker.
 *
 * Pattern-based rather than "the token this process is serving with", because
 * the log file is also written by `rotate-token` runs and by crash handlers
 * that may be holding an older token - all of them are secrets and none of them
 * belong on disk in a file that is kept for months.
 * @param {string} text
 * @returns {string}
 */
export function redactSecrets(text) {
  let out = String(text ?? '');
  for (const [re, replacement] of TOKEN_PATTERNS) out = out.replace(re, replacement);
  return out;
}

export class LogFile {
  /**
   * @param {Object} opts
   * @param {string} opts.file
   * @param {number} [opts.maxBytes]
   * @param {() => Date} [opts.now]
   */
  constructor(opts = {}) {
    if (!opts.file) throw new Error('LogFile needs a file path');
    this.file = opts.file;
    this.maxBytes = Number.isFinite(opts.maxBytes) && opts.maxBytes > 0
      ? opts.maxBytes
      : DEFAULT_MAX_BYTES;
    this.now = typeof opts.now === 'function' ? opts.now : () => new Date();
    this.fd = null;
    this.bytes = 0;
    this.rotations = 0;
    this.writeErrors = 0;
    this.lastError = null;
    // A rotation that failed must not be retried on every single write: the
    // file only gets bigger, so the "over the cap" condition stays true and
    // each write would pay for another doomed rename. After a failure the next
    // attempt waits until the file has grown by a further generation.
    this.retryRotateAtBytes = 0;
    this.open();
  }

  /** The file one generation back. */
  get rotatedFile() {
    return `${this.file}.1`;
  }

  /**
   * Windows note: `openSync(<a directory>, 'a')` SUCCEEDS here and hands back a
   * usable-looking fd - it is the first write that fails, not the open. So the
   * contract callers can rely on is "write() returns false and writeErrors goes
   * up", never "fd is null".
   */
  open() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this.fd = fs.openSync(this.file, 'a');
      this.bytes = statSize(this.file);
    } catch (err) {
      this.fd = null;
      this.writeErrors += 1;
      this.lastError = String(err && err.message ? err.message : err);
    }
  }

  /**
   * Move the current file aside and start an empty one.
   * Renaming (rather than truncating) keeps the log readable across the cut.
   *
   * ONE rename, and nothing is removed before it succeeds. `renameSync` already
   * replaces an existing target (MoveFileEx with MOVEFILE_REPLACE_EXISTING on
   * Windows, rename(2) elsewhere), so deleting `<file>.1` first buys nothing and
   * costs the previous generation whenever the rename then fails.
   *
   * A failed rename leaves BOTH files exactly as they were. It must never fall
   * back to truncating: another process may be appending to this very file - a
   * second instance, or the same log opened by a hand-started server - and
   * `writeFileSync(file, '')` would throw its lines away. Going over the cap is
   * the smaller failure, and the size is re-read from the filesystem by open()
   * rather than assumed, so the next decision is made on facts.
   */
  rotate() {
    if (this.fd === null) return false;
    try {
      fs.closeSync(this.fd);
    } catch { /* already gone */ }
    this.fd = null;
    let rotated = false;
    try {
      fs.renameSync(this.file, this.rotatedFile);
      this.rotations += 1;
      rotated = true;
    } catch (err) {
      this.writeErrors += 1;
      this.lastError = String(err && err.message ? err.message : err);
    }
    this.open();
    this.retryRotateAtBytes = rotated ? 0 : this.bytes + this.maxBytes;
    return true;
  }

  /**
   * Append a chunk, timestamping each line so a log spanning weeks is legible.
   *
   * The token is scrubbed on the way in and an oversized chunk is cut, so what
   * reaches the file is always redacted and always inside the cap - callers do
   * not have to remember either rule.
   * @param {string} chunk raw text as it was written to the console
   * @param {string} [stream] 'out' | 'err'
   */
  write(chunk, stream = 'out') {
    const raw = typeof chunk === 'string' ? chunk : String(chunk ?? '');
    if (!raw) return true;
    const stamped = this.stamp(redactSecrets(raw), stream);
    if (this.fd === null) this.open();
    if (this.fd === null) return false;
    const buf = this.capChunk(Buffer.from(stamped, 'utf8'));
    if (this.bytes + buf.length > this.maxBytes && this.bytes >= this.retryRotateAtBytes) this.rotate();
    if (this.fd === null) return false;
    try {
      fs.writeSync(this.fd, buf);
      this.bytes += buf.length;
      return true;
    } catch (err) {
      this.writeErrors += 1;
      this.lastError = String(err && err.message ? err.message : err);
      return false;
    }
  }

  /**
   * Keep one call from spending the whole budget.
   *
   * Rotating before a write bounds the file at 2x maxBytes only while a single
   * chunk still fits in one generation. A megabyte-long stack trace or a paste
   * into the console does not, so it is cut - and the cut is stated in the file,
   * because a log that quietly loses its tail is the failure this module exists
   * to prevent. A cap too small to hold the marker keeps the bound instead of
   * the explanation.
   * @param {Buffer} buf
   * @returns {Buffer}
   */
  capChunk(buf) {
    if (buf.length <= this.maxBytes) return buf;
    const marker = (dropped) => Buffer.from(`...[truncated ${dropped} bytes]\n`, 'utf8');
    // The widest the marker can get is the one naming the whole chunk, so
    // sizing against it can only leave the result under the cap.
    const room = this.maxBytes - marker(buf.length).length;
    if (room <= 0) return cutUtf8(buf, this.maxBytes);
    const kept = cutUtf8(buf, room);
    return Buffer.concat([kept, marker(buf.length - kept.length)]);
  }

  /**
   * `2026-09-03T20:44:01.123Z out | text`, one prefix per line. A trailing
   * newline is preserved and never turns into an empty stamped line.
   */
  stamp(text, stream) {
    const at = this.now().toISOString();
    const tag = `${at} ${stream === 'err' ? 'err' : 'out'} | `;
    const endsWithNewline = text.endsWith('\n');
    const body = endsWithNewline ? text.slice(0, -1) : text;
    const lines = body.split('\n').map((l) => tag + l);
    return lines.join('\n') + (endsWithNewline ? '\n' : '');
  }

  close() {
    if (this.fd === null) return;
    try {
      fs.closeSync(this.fd);
    } catch { /* ignore */ }
    this.fd = null;
  }

  stats() {
    return {
      file: this.file,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      rotations: this.rotations,
      writeErrors: this.writeErrors,
      lastError: this.lastError,
    };
  }
}

/**
 * Mirror everything written to stdout/stderr into `log`, keeping the original
 * console output intact (a foreground run still behaves exactly as before).
 *
 * @param {LogFile} log
 * @param {{stdout?: NodeJS.WriteStream, stderr?: NodeJS.WriteStream}} [streams]
 * @returns {() => void} restore function; calling it twice is harmless
 */
export function teeConsole(log, streams = {}) {
  const out = streams.stdout ?? process.stdout;
  const err = streams.stderr ?? process.stderr;
  // The UNBOUND originals, so restore() puts back the very same function
  // object. A bound copy behaves identically but would defeat any other code
  // that checks whether the stream is still pristine.
  const originalOut = out.write;
  const originalErr = err.write;
  let restored = false;

  out.write = function teedOut(chunk, ...rest) {
    try {
      log.write(decode(chunk), 'out');
    } catch { /* logging must never break printing */ }
    return originalOut.call(out, chunk, ...rest);
  };
  err.write = function teedErr(chunk, ...rest) {
    try {
      log.write(decode(chunk), 'err');
    } catch { /* logging must never break printing */ }
    return originalErr.call(err, chunk, ...rest);
  };

  return function restore() {
    if (restored) return;
    restored = true;
    out.write = originalOut;
    err.write = originalErr;
  };
}

function decode(chunk) {
  if (typeof chunk === 'string') return chunk;
  if (chunk && typeof chunk === 'object' && typeof chunk.toString === 'function') {
    return chunk.toString('utf8');
  }
  return String(chunk ?? '');
}

/**
 * Cut a UTF-8 buffer to at most `limit` bytes without splitting a character.
 * A half-written multi-byte sequence would put a replacement character in the
 * log at exactly the moment somebody is reading it to find out what went wrong.
 * @param {Buffer} buf
 * @param {number} limit
 */
function cutUtf8(buf, limit) {
  if (buf.length <= limit) return buf;
  let end = limit;
  // A continuation byte (10xxxxxx) at the cut means the cut is inside a
  // character; back up to its lead byte.
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end -= 1;
  return buf.subarray(0, end);
}

function statSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}
