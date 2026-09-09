/**
 * Live session state from ~/.claude/sessions/<pid>.json.
 *
 * NOTE: this directory is UNDOCUMENTED. The docs never mention it, so every
 * field here is treated as best-effort and may vanish in any Claude Code
 * release. Verified shape on 2.1.258:
 *   {"pid":29340,"sessionId":"...","cwd":"D:\\develop\\...","startedAt":<ms>,
 *    "procStart":"134328265116630248",  <- Windows FILETIME as a string
 *                                          (Linux: /proc/<pid>/stat starttime
 *                                           in clock ticks, e.g. "254037")
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
 * The reuse verdict is REMEMBERED between calls (keyed by file + pid + the
 * file's own start records). The collector runs the start-time check only on
 * every 30th tick because it shells out on Windows; without the memory, the 29
 * cheap ticks in between would each report kill(0)'s "alive" and the dashboard
 * would show a reused PID as live for 58 s out of every 60 (measured on WSL).
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

/**
 * Linux: seconds since the Unix epoch at which the kernel booted (`btime` in
 * /proc/stat). Cached for the life of the process - it never changes.
 * @param {string} [statText] contents of /proc/stat (injected by tests)
 * @returns {number|null}
 */
let cachedBtimeSec;
export function linuxBootTimeSec(statText) {
  if (statText === undefined && cachedBtimeSec !== undefined) return cachedBtimeSec;
  let text = statText;
  if (text === undefined) {
    try {
      text = fs.readFileSync('/proc/stat', 'utf8');
    } catch {
      text = '';
    }
  }
  const m = /^btime\s+(\d+)\s*$/m.exec(text);
  const v = m ? Number(m[1]) : null;
  if (statText === undefined) cachedBtimeSec = v;
  return v;
}

/** Kernel USER_HZ - the unit of /proc/<pid>/stat starttime. Fixed at 100 on Linux. */
const LINUX_USER_HZ = 100;

/**
 * Linux: the `starttime` (field 22) of a /proc/<pid>/stat line, in clock ticks
 * since boot. The comm field (in parentheses) may contain spaces, so split
 * after the LAST ')' - field 3 (state) is then index 0.
 * @param {string} statLine
 * @returns {number|null}
 */
export function parseProcStatStartTicks(statLine) {
  if (typeof statLine !== 'string') return null;
  const close = statLine.lastIndexOf(')');
  if (close < 0) return null;
  const rest = statLine.slice(close + 1).trim().split(/\s+/);
  const ticks = Number(rest[22 - 3]);
  return Number.isInteger(ticks) && ticks >= 0 ? ticks : null;
}

/**
 * Linux: clock ticks since boot -> epoch ms. Claude Code stores this same tick
 * value as `procStart` (a decimal string) on Linux, so both sides go through
 * here and the comparison does not depend on how accurate btime is.
 * @param {string|number} ticks
 * @param {number|null} [btimeSec]
 * @returns {number|null}
 */
export function linuxTicksToEpochMs(ticks, btimeSec = linuxBootTimeSec()) {
  if (btimeSec == null) return null;
  const t = Number(String(ticks).trim());
  if (!Number.isFinite(t) || t < 0 || !/^\d+$/.test(String(ticks).trim())) return null;
  return Math.round((btimeSec + t / LINUX_USER_HZ) * 1000);
}

/**
 * Platform-aware `procStart` -> epoch ms. Windows writes a FILETIME, Linux the
 * /proc starttime in ticks. Anything else: unknown, null (callers fall back to
 * `startedAt`).
 * @param {string|number|null|undefined} value
 * @param {string} [platform]
 * @param {number|null} [btimeSec] Linux boot time (injected by tests)
 * @returns {number|null}
 */
export function procStartToEpochMs(value, platform = process.platform, btimeSec) {
  if (value == null) return null;
  if (platform === 'win32') return filetimeToEpochMs(value);
  if (platform === 'linux') return linuxTicksToEpochMs(value, btimeSec ?? linuxBootTimeSec());
  return null;
}

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
 * Linux: /proc/<pid>/stat starttime (readable for other users' processes too,
 * which matters because a reused low PID is often root's). Other platforms:
 * empty map. Resolves to an empty map on any failure - callers must not
 * depend on it.
 * @param {number[]} pids
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Map<number, number>>} pid -> epoch ms
 */
export function getProcessStartTimes(pids, opts = {}) {
  const timeout = opts.timeoutMs ?? 4000;
  const unique = [...new Set(pids.filter((p) => Number.isInteger(p) && p > 0))];
  if (!unique.length) return Promise.resolve(new Map());
  if (process.platform === 'linux') {
    const map = new Map();
    const btime = linuxBootTimeSec();
    if (btime == null) return Promise.resolve(map);
    for (const pid of unique) {
      let line;
      try {
        line = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      } catch {
        continue;
      }
      const ticks = parseProcStatStartTicks(line);
      const ms = ticks == null ? null : linuxTicksToEpochMs(ticks, btime);
      if (ms != null) map.set(pid, ms);
    }
    return Promise.resolve(map);
  }
  if (process.platform !== 'win32') return Promise.resolve(new Map());
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
 * Last start-time verdict per session file, applied on the ticks that do not
 * re-check. Key: file + pid + procStart + startedAt, so a rewritten file (new
 * session on the same pid) never inherits an old verdict.
 * @type {Map<string, {pidReused: boolean, procStartActualMs: number}>}
 */
const reuseVerdicts = new Map();

/** Forget every remembered verdict (tests). */
export function resetReuseVerdicts() {
  reuseVerdicts.clear();
}

function verdictKey(s) {
  return `${s.file}|${s.pid}|${s.procStart ?? ''}|${s.startedAt ?? ''}`;
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
      procStartMs: procStartToEpochMs(json.procStart),
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

  // A pid kill(0) says is gone cannot be reused-and-alive; drop its memory so
  // a later session that lands on the same pid starts clean.
  for (const s of sessions) {
    if (!s.alive) reuseVerdicts.delete(verdictKey(s));
  }

  if (opts.checkProcStart !== false) {
    const alivePids = sessions.filter((s) => s.alive).map((s) => s.pid);
    const starts = await getProcessStartTimes(alivePids);
    for (const s of sessions) {
      const actual = starts.get(s.pid);
      if (actual == null) continue;
      s.procStartActualMs = actual;
      // Check EVERY reference we have, not the first one. On Linux `procStart`
      // is ticks since boot, so a session from a previous boot can carry a tick
      // value that happens to land within slack of a process born early in THIS
      // boot (measured: an old file with procStart 3594 vs a bash at 779 ticks -
      // 28 s apart). `startedAt` is absolute and catches that; the tick value
      // is exact within one boot and catches a reuse startedAt cannot.
      const refs = [s.procStartMs, s.startedAt].filter((v) => v != null);
      if (!refs.length) continue;
      // Allow generous slack: startedAt is recorded slightly after process start.
      s.pidReused = refs.some((expected) => Math.abs(actual - expected) > 60_000);
      reuseVerdicts.set(verdictKey(s), { pidReused: s.pidReused, procStartActualMs: actual });
      if (s.pidReused) {
        s.alive = false;
        s.aliveSource = 'pid-reused';
      }
    }
  } else {
    for (const s of sessions) {
      if (!s.alive) continue;
      const v = reuseVerdicts.get(verdictKey(s));
      if (!v) continue;
      s.pidReused = v.pidReused;
      s.procStartActualMs = v.procStartActualMs;
      if (v.pidReused) {
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
