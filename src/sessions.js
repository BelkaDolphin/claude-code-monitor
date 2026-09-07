/**
 * Live session state from ~/.claude/sessions/<pid>.json.
 *
 * NOTE: this directory is UNDOCUMENTED. The docs never mention it, so every
 * field here is treated as best-effort and may vanish in any Claude Code
 * release. Verified shape on 2.1.258:
 *   {"pid":29340,"sessionId":"...","cwd":"D:\\develop\\...","startedAt":<ms>,
 *    "procStart":"134328265116630248",  <- Windows FILETIME as a string
 *    "version":"2.1.258","peerProtocol":1,"peerFeatures":["notify_idle",...],
 *    "kind":"interactive","entrypoint":"cli","pidDomain":"win32:mypc",
 *    "messagingSocketPath":"\\\\.\\pipe\\LOCAL\\cc-msg-...","name":"claude-37",
 *    "nameSource":"derived","nameSince":<ms>,"status":"busy",
 *    "updatedAt":<ms>,"statusUpdatedAt":<ms>,"bridgeSessionId":"session_..."}
 *
 * `*.key` files sit alongside and are IGNORED (never read - they look like
 * credentials).
 *
 * Liveness: process.kill(pid, 0) is the primary check. Because Windows reuses
 * PIDs, we additionally try to read the real process start time and compare it
 * with the file's own record; a mismatch flags a likely PID reuse. That check
 * is best-effort - if it fails we still report the kill(0) result.
 *
 * IMPORTANT (measured): `status` is written only on state TRANSITIONS, not as a
 * heartbeat. A session stayed "busy" with an unchanged mtime for 7.5+ minutes.
 * Never treat a stale mtime alone as "dead".
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { sessionsDir, readJsonUtf8 } from './paths.js';

/** Windows FILETIME epoch (1601-01-01) to Unix epoch offset, in ms. */
const FILETIME_EPOCH_DIFF_MS = 11644473600000;

/**
 * @typedef {Object} LiveSession
 * @property {number} pid
 * @property {string|null} sessionId
 * @property {string|null} cwd
 * @property {string|null} status
 * @property {number|null} startedAt
 * @property {number|null} updatedAt
 * @property {number|null} statusUpdatedAt
 * @property {string|null} version
 * @property {string|null} name
 * @property {string|null} kind
 * @property {boolean} alive
 * @property {string} aliveSource
 * @property {boolean|null} pidReused
 * @property {string} file
 * @property {number} fileMtimeMs
 */

/** @param {string} value FILETIME string @returns {number|null} epoch ms */
export function filetimeToEpochMs(value) {
  if (value == null) return null;
  let big;
  try {
    big = BigInt(String(value).trim());
  } catch {
    return null;
  }
  if (big <= 0n) return null;
  // FILETIME is 100ns ticks since 1601-01-01 UTC.
  const ms = Number(big / 10000n) - FILETIME_EPOCH_DIFF_MS;
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Is a PID currently alive? signal 0 performs the permission/existence check
 * without delivering a signal.
 * @param {number} pid
 * @returns {{alive: boolean, source: string}}
 */
export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive: false, source: 'invalid-pid' };
  try {
    process.kill(pid, 0);
    return { alive: true, source: 'kill0' };
  } catch (err) {
    // EPERM means the process exists but we may not signal it -> still alive.
    if (err && err.code === 'EPERM') return { alive: true, source: 'kill0:EPERM' };
    return { alive: false, source: `kill0:${(err && err.code) || 'ESRCH'}` };
  }
}

/**
 * Best-effort process start time. Windows: PowerShell Get-Process.
 * Resolves to null on any failure - callers must not depend on it.
 * @param {number[]} pids
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Map<number, number>>} pid -> epoch ms
 */
export function getProcessStartTimes(pids, opts = {}) {
  const timeout = opts.timeoutMs ?? 4000;
  const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (!unique.length || process.platform !== 'win32') return Promise.resolve(new Map());
  const script =
    `Get-Process -Id ${unique.join(',')} -ErrorAction SilentlyContinue | ` +
    'ForEach-Object { "$($_.Id)=$($_.StartTime.ToUniversalTime().ToString(\'o\'))" }';
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { timeout, windowsHide: true },
      (err, stdout) => {
        const map = new Map();
        if (err && !stdout) return resolve(map);
        for (const line of String(stdout || '').split(/\r?\n/)) {
          const m = /^(\d+)=(.+)$/.exec(line.trim());
          if (!m) continue;
          const ms = Date.parse(m[2]);
          if (Number.isFinite(ms)) map.set(Number(m[1]), ms);
        }
        resolve(map);
      },
    );
  });
}

/**
 * Read ~/.claude/sessions/*.json (never *.key).
 * @param {{dir?: string, checkProcStart?: boolean}} [opts]
 * @returns {Promise<{sessions: LiveSession[], skippedKeyFiles: number, dir: string}>}
 */
export async function readLiveSessions(opts = {}) {
  const dir = opts.dir ?? sessionsDir();
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { sessions: [], skippedKeyFiles: 0, dir };
  }

  let skippedKeyFiles = 0;
  /** @type {LiveSession[]} */
  const sessions = [];
  for (const e of ents) {
    if (!e.isFile()) continue;
    // Explicitly never touch key material.
    if (e.name.endsWith('.key')) {
      skippedKeyFiles++;
      continue;
    }
    if (!e.name.endsWith('.json')) continue;
    const file = path.join(dir, e.name);
    const json = readJsonUtf8(file);
    if (!json || typeof json !== 'object') continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch { /* ignore */ }
    const pidFromName = Number.parseInt(e.name.split('.')[0], 10);
    const pid = Number.isInteger(json.pid) ? json.pid : pidFromName;
    const { alive, source } = isPidAlive(pid);
    sessions.push({
      pid,
      sessionId: strOrNull(json.sessionId),
      cwd: strOrNull(json.cwd),
      status: strOrNull(json.status),
      startedAt: numOrNull(json.startedAt),
      updatedAt: numOrNull(json.updatedAt),
      statusUpdatedAt: numOrNull(json.statusUpdatedAt),
      procStart: json.procStart != null ? String(json.procStart) : null,
      procStartMs: filetimeToEpochMs(json.procStart),
      version: strOrNull(json.version),
      name: strOrNull(json.name),
      kind: strOrNull(json.kind),
      entrypoint: strOrNull(json.entrypoint),
      bridgeSessionId: strOrNull(json.bridgeSessionId),
      alive,
      aliveSource: source,
      pidReused: null,
      file,
      fileMtimeMs: mtimeMs,
    });
  }

  if (opts.checkProcStart !== false) {
    const alivePids = sessions.filter((s) => s.alive).map((s) => s.pid);
    const starts = await getProcessStartTimes(alivePids);
    for (const s of sessions) {
      const actual = starts.get(s.pid);
      if (actual == null) continue;
      s.procStartActualMs = actual;
      const expected = s.procStartMs ?? s.startedAt;
      if (expected == null) continue;
      // Allow generous slack: startedAt is recorded slightly after process start.
      s.pidReused = Math.abs(actual - expected) > 60_000;
      if (s.pidReused) {
        s.alive = false;
        s.aliveSource = 'pid-reused';
      }
    }
  }

  sessions.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  return { sessions, skippedKeyFiles, dir };
}

function strOrNull(v) {
  return typeof v === 'string' && v.length ? v : null;
}
function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
