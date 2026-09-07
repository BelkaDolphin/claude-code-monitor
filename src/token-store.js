/**
 * A token that survives a restart, so the dashboard URL can be bookmarked.
 *
 * WHY THIS IS OPT-IN. The default stays a fresh random token per process: the
 * secret then exists only in the process and in one HttpOnly cookie, and a
 * restart invalidates everything. That is the strongest posture and costs
 * nothing as long as a human starts the server by hand.
 *
 * It stops working the moment the server is started at logon by Task Scheduler
 * with no console to read the URL from. `--persist-token` trades a little of
 * that strength for a URL that stays valid:
 *
 *   - the token lands in `<monitorDir>/token`, readable by this user;
 *   - the bookmark (and the browser's history) then contains the token.
 *
 * That is the SAME threat model the cookie already lives in - anything that can
 * read the user's profile directory or their browser profile has already won -
 * but it is a real widening, so it is a flag and it is documented.
 *
 * Windows note: `fs` mode bits are not enforced on NTFS, so chmod would be
 * theatre. `%USERPROFILE%` is already ACL'd to the user (and SYSTEM and the
 * local Administrators group); we do not add to that and we do not pretend to.
 *
 * Anything unexpected in the file - wrong length, uppercase, whitespace in the
 * middle, a stray line, a directory - is treated as "no usable token" and a
 * fresh one is written over it. A half-valid secret is not a secret.
 */

import fs from 'node:fs';
import path from 'node:path';

import { generateToken } from './auth.js';
import { monitorDir, stripBom, writeFileAtomic } from './paths.js';

/** 32 bytes hex, exactly as auth.generateToken() produces. */
const TOKEN_RE = /^[0-9a-f]{64}$/;

/** @returns {string} `<monitorDir>/token` */
export function tokenFilePath() {
  return path.join(monitorDir(), 'token');
}

/** @returns {string} `<monitorDir>/url.txt` */
export function urlFilePath() {
  return path.join(monitorDir(), 'url.txt');
}

/** @returns {string} `<monitorDir>/serve.log` */
export function defaultLogFilePath() {
  return path.join(monitorDir(), 'serve.log');
}

/**
 * Is this exactly the shape auth.js issues?
 * Deliberately strict: no trimming of interior whitespace, no case folding.
 * @param {unknown} value
 */
export function isValidToken(value) {
  return typeof value === 'string' && TOKEN_RE.test(value);
}

/**
 * Read the stored token, or null if there is not exactly one usable token
 * there. Never throws: an unreadable file is the same as an absent one.
 * @param {string} [file]
 * @returns {string|null}
 */
export function readStoredToken(file = tokenFilePath()) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  // Surrounding whitespace is what an editor adds; interior whitespace means
  // the file is not what we wrote.
  const trimmed = stripBom(text).trim();
  return isValidToken(trimmed) ? trimmed : null;
}

/**
 * The token to serve with, creating or replacing the stored one as needed.
 *
 * @param {Object} [opts]
 * @param {string} [opts.file]      where the token lives
 * @param {boolean} [opts.rotate]   discard whatever is there and mint a new one
 * @param {() => string} [opts.generate] injectable for tests
 * @returns {{token: string, file: string, action: 'reused'|'created'|'regenerated'|'rotated'}}
 */
export function loadOrCreateToken(opts = {}) {
  const file = opts.file ?? tokenFilePath();
  const generate = typeof opts.generate === 'function' ? opts.generate : generateToken;
  const existedAtAll = fileExists(file);
  const stored = opts.rotate === true ? null : readStoredToken(file);

  if (stored) return { token: stored, file, action: 'reused' };

  const token = generate();
  if (!isValidToken(token)) {
    // A generator that produces something we would refuse to read back would
    // make every restart silently mint a new token. Fail loudly instead.
    throw new Error('generated token does not match the expected 64-hex shape');
  }
  writeFileAtomic(file, `${token}\n`);
  const action = opts.rotate === true && existedAtAll
    ? 'rotated'
    : existedAtAll ? 'regenerated' : 'created';
  return { token, file, action };
}

/**
 * Record the bookmarkable entry URL so an instance started at logon - with no
 * console anyone ever sees - can still be found.
 *
 * It contains the token, which is the whole point and also the reason it sits
 * next to the token file rather than anywhere more public.
 *
 * @param {string} url
 * @param {string} [file]
 * @returns {{file: string, written: boolean, error: string|null}}
 */
export function writeUrlFile(url, file = urlFilePath()) {
  if (typeof url !== 'string' || !url) return { file, written: false, error: 'empty url' };
  try {
    writeFileAtomic(file, `${url}\n`);
    return { file, written: true, error: null };
  } catch (err) {
    // A monitor must not refuse to start because a convenience file failed.
    return { file, written: false, error: err && err.message ? err.message : String(err) };
  }
}

/** @param {string} [file] @returns {string|null} the URL last written, if any */
export function readUrlFile(file = urlFilePath()) {
  try {
    const text = stripBom(fs.readFileSync(file, 'utf8')).trim();
    return text || null;
  } catch {
    return null;
  }
}

/**
 * The port recorded in the last URL we wrote, or null if there is not a usable
 * one there.
 *
 * `rotate-token` needs it. It is normally run with no arguments, long after
 * `serve --port N` was started by hand or by the logon task, and the URL it
 * writes has to name the port the server actually listens on - a URL with the
 * default port in it is silently wrong and 403s nothing, it just fails to
 * connect. url.txt is the only record of that choice this process can read.
 *
 * @param {string} [file]
 * @returns {number|null}
 */
export function readUrlPort(file = urlFilePath()) {
  const url = readUrlFile(file);
  if (!url) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // An explicit port only: a URL with none is http's default 80, which is not a
  // port this server has ever been started on.
  const port = Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return port;
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}
