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
 * Liveness: process.kill(pid, 0) is the primary check. Because PIDs are reused,
 * we additionally try to read the real process start time and compare it with
 * the file's own record; a mismatch flags a likely PID reuse. That check is
 * best-effort - if it fails we still report the kill(0) result.
 *
 * How the two sides are compared depends on the platform:
 *   win32 (and any other platform reached through an injected probe)
 *     `procStart` is a FILETIME, so it and the observed start time are both
 *     absolute: compare `procStartMs` - falling back to `startedAt` only when
 *     the file has no `procStart` - with PID_START_SLACK_MS of slack.
 *     `startedAt` stays a fallback rather than a hard condition: `--resume` and
 *     a slow start can move it legitimately, and it must not sink a session
 *     that `procStart` vouches for.
 *   linux
 *     `procStart` is the /proc/<pid>/stat starttime in ticks since boot, so we
 *     compare TICKS TO TICKS as integers. That comparison never touches
 *     `btime`, which means a clock step (NTP, or WSL2 resyncing after sleep)
 *     cannot manufacture a mismatch. Ticks only identify a process within one
 *     boot, so a stale file from a PREVIOUS boot can land within slack of a
 *     young process in this one (measured: procStart 3594 vs a bash born at
 *     779 ticks); the boot-crossing guard catches that with `startedAt`, which
 *     is absolute. Only when the tick value is unusable do we fall back to
 *     comparing `startedAt` against the observed start time.
 *
 * The reuse verdict is REMEMBERED between calls (keyed by file + pid + the
 * file's own start records). The collector runs the start-time check only on
 * every 30th tick because it shells out on Windows; without the memory, the 29
 * cheap ticks in between would each report kill(0)'s "alive" and the dashboard
 * would show a reused PID as live for 58 s out of every 60 (measured on WSL).
 * The memory is applied to every live session FIRST and only then overwritten
 * for the pids whose start time we could actually read, so a probe that fails
 * keeps the previous verdict instead of quietly reverting to "alive". Keys the
 * current listing did not produce (file deleted, or rewritten for a new
 * session) are swept, as is the key of any pid kill(0) reports dead.
 *
 * IMPORTANT (measured): `status` is written only on state TRANSITIONS, not as a
 * heartbeat. A session stayed "busy" with an unchanged mtime for 7.5+ minutes.
 * Never treat a stale mtime alone as "dead".
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { sessionsDir, readJsonUtf8, readUtf8 } from './paths.js';

/** Windows FILETIME epoch (1601-01-01) to Unix epoch offset, in ms. */
const FILETIME_EPOCH_DIFF_MS = 11644473600000;

/**
 * How far a recorded start time may be from the observed one and still be the
 * same process. Generous on purpose: `startedAt` is written a moment after the
 * process starts, and a clock adjustment can move either side.
 */
export const PID_START_SLACK_MS = 60_000;

/** Kernel USER_HZ - the unit of /proc/<pid>/stat starttime. Fixed at 100 on Linux. */
const LINUX_USER_HZ = 100;

/** The same slack in Linux clock ticks (60 s -> 6000 ticks). */
const LINUX_TICK_SLACK = (PID_START_SLACK_MS / 1000) * LINUX_USER_HZ;

/**
 * Linux boot-crossing guard: how far before `btime` a session may claim to have
 * started and still be believed. A session that began before this boot cannot
 * still own a process that is alive now, but the slack matters because a clock
 * step (NTP, or WSL2 resyncing after sleep) can move `btime` forward past a
 * genuine session that started right after boot. With 10 minutes, a stale file
 * slips through only when the previous boot ended less than 10 minutes ago AND
 * its tick value happens to agree within 60 s.
 */
const BOOT_SLACK_MS = 10 * 60_000;

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
 * /proc/stat). NOT cached - btime moves when the clock is stepped (NTP, WSL2
 * waking from sleep), and caching a null would poison every later read.
 * @param {string} [statText] contents of /proc/stat (injected by tests)
 * @returns {number|null}
 */
export function linuxBootTimeSec(statText) {
  const text = statText === undefined ? readUtf8('/proc/stat') : statText;
  if (text == null) return null;
  const m = /^btime\s+(\d+)\s*$/m.exec(text);
  return m ? Number(m[1]) : null;
}

/**
 * A decimal tick count, or null. Rejects signs, decimal points, empty strings
 * and anything too large to stay exact (a FILETIME landing here, for instance).
 * @param {string|number|null|undefined} value
 * @returns {number|null}
 */
function ticksOrNull(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!/^\d+$/.test(s)) return null;
  const t = Number(s);
  return Number.isSafeInteger(t) ? t : null;
}

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
 * Linux: clock ticks since boot -> epoch ms, using the btime handed in. There
 * is deliberately no fallback read: a caller without a btime gets null rather
 * than a value quietly built from a boot time it did not choose.
 * @param {string|number|null|undefined} ticks
 * @param {number|null} [btimeSec]
 * @returns {number|null}
 */
export function linuxTicksToEpochMs(ticks, btimeSec) {
  if (btimeSec == null) return null;
  const t = ticksOrNull(ticks);
  if (t == null) return null;
  return Math.round((btimeSec + t / LINUX_USER_HZ) * 1000);
}

/**
 * Platform-aware `procStart` -> epoch ms. Windows writes a FILETIME, Linux the
 * /proc starttime in ticks. Anything else: unknown, null (callers fall back to
 * `startedAt`).
 * @param {string|number|null|undefined} value
 * @param {string} [platform]
 * @param {number|null} [btimeSec] Linux boot time
 * @returns {number|null}
 */
export function procStartToEpochMs(value, platform = process.platform, btimeSec = null) {
  if (value == null) return null;
  if (platform === 'win32') return filetimeToEpochMs(value);
  if (platform === 'linux') return linuxTicksToEpochMs(value, btimeSec);
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

function uniquePids(pids) {
  return [...new Set((pids || []).filter((p) => Number.isInteger(p) && p > 0))];
}

/** Windows: one PowerShell call for the start times of these pids. */
function winStartTimes(unique, opts = {}) {
  const timeout = opts.timeoutMs ?? 4000;
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
 * @typedef {Object} ProbedStart
 * @property {number|null} startMs absolute start time, when one can be computed
 * @property {number|null} ticks Linux clock ticks since boot (null elsewhere)
 */

/**
 * Best-effort start times of live processes, in the shape the reuse check
 * wants. Windows: PowerShell Get-Process. Linux: /proc/<pid>/stat, readable for
 * other users' processes too (which matters - a reused low PID is often root's)
 * - `ticks` is the value that survives a clock step, `startMs` is derived from
 * btime and is null without one. Other platforms: an empty map, as is any
 * failure. Callers must not depend on a pid being present.
 * @param {number[]} pids
 * @param {string} [platform]
 * @param {number|null} [btimeSec]
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Map<number, ProbedStart>>}
 */
export function probeStartTimes(pids, platform = process.platform, btimeSec = null, opts = {}) {
  const unique = uniquePids(pids);
  if (!unique.length) return Promise.resolve(new Map());
  if (platform === 'linux') {
    /** @type {Map<number, ProbedStart>} */
    const map = new Map();
    for (const pid of unique) {
      const line = readUtf8(`/proc/${pid}/stat`);
      if (line == null) continue;
      const ticks = parseProcStatStartTicks(line);
      if (ticks == null) continue;
      map.set(pid, { startMs: linuxTicksToEpochMs(ticks, btimeSec), ticks });
    }
    return Promise.resolve(map);
  }
  if (platform !== 'win32') return Promise.resolve(new Map());
  return winStartTimes(unique, opts).then((raw) => {
    /** @type {Map<number, ProbedStart>} */
    const map = new Map();
    for (const [pid, ms] of raw) map.set(pid, { startMs: ms, ticks: null });
    return map;
  });
}

/**
 * Best-effort process start time as plain epoch ms, for callers that only want
 * the absolute value. The reuse check uses probeStartTimes() instead, because
 * on Linux it needs the raw ticks as well.
 * @param {number[]} pids
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<Map<number, number>>} pid -> epoch ms
 */
export function getProcessStartTimes(pids, opts = {}) {
  // Read btime per call: it moves when the clock is stepped.
  const btime = process.platform === 'linux' ? linuxBootTimeSec() : null;
  return probeStartTimes(pids, process.platform, btime, opts).then((probed) => {
    const map = new Map();
    for (const [pid, v] of probed) {
      if (v && v.startMs != null) map.set(pid, v.startMs);
    }
    return map;
  });
}

/**
 * Last start-time verdict per session file, applied on the ticks that do not
 * re-check. Key: file + pid + procStart + startedAt, so a rewritten file (a new
 * session on the same pid) never inherits an old verdict.
 * @type {Map<string, {pidReused: boolean}>}
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
 * Does the process observed at this pid look like a DIFFERENT one than the file
 * describes? true / false / null, where null means nothing was comparable and
 * the caller should keep whatever it already believed.
 * @param {LiveSession} s
 * @param {ProbedStart} actual
 * @param {string} platform
 * @param {number|null} btimeSec
 * @returns {boolean|null}
 */
function judgeReuse(s, actual, platform, btimeSec) {
  if (platform === 'linux') {
    const fileTicks = ticksOrNull(s.procStart);
    let reused = null;
    if (fileTicks != null && actual.ticks != null) {
      // Integer ticks on both sides: btime is not involved, so a clock step
      // cannot turn a live session into a false "reused".
      reused = Math.abs(actual.ticks - fileTicks) > LINUX_TICK_SLACK;
    } else if (actual.startMs != null && s.startedAt != null) {
      // No usable tick on one side - compare absolute times instead.
      reused = Math.abs(actual.startMs - s.startedAt) > PID_START_SLACK_MS;
    }
    // Ticks repeat every boot: a session that began before this boot cannot own
    // a process that is alive now, however well the ticks agree - and even when
    // nothing else was comparable.
    if (reused !== true && btimeSec != null && s.startedAt != null
        && s.startedAt < btimeSec * 1000 - BOOT_SLACK_MS) {
      return true;
    }
    return reused;
  }
  // Windows, and anything reached through an injected probe: `procStart` is
  // authoritative when present and `startedAt` is only the fallback.
  const expected = s.procStartMs ?? s.startedAt;
  if (expected == null || actual.startMs == null) return null;
  return Math.abs(actual.startMs - expected) > PID_START_SLACK_MS;
}

/**
 * Read ~/.claude/sessions/*.json (never *.key).
 * @param {{dir?: string, checkProcStart?: boolean, platform?: string,
 *          btimeSec?: number|null,
 *          probe?: (pids: number[]) => Promise<Map<number, ProbedStart>>}} [opts]
 * @returns {Promise<{sessions: LiveSession[], skippedKeyFiles: number, dir: string}>}
 */
export async function readLiveSessions(opts = {}) {
  const dir = opts.dir ?? sessionsDir();
  const platform = opts.platform ?? process.platform;
  // One btime read per call on Linux (it moves when the clock is stepped), and
  // none at all anywhere else.
  const btimeSec = opts.btimeSec !== undefined
    ? opts.btimeSec
    : (platform === 'linux' ? linuxBootTimeSec() : null);
  const probe = typeof opts.probe === 'function'
    ? opts.probe
    : (pids) => probeStartTimes(pids, platform, btimeSec);

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
      procStartMs: procStartToEpochMs(json.procStart, platform, btimeSec),
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

  // Apply what we already know, whether or not this tick re-checks: a pid whose
  // start time we cannot read must keep its previous verdict rather than fall
  // back to kill(0)'s "alive". A pid kill(0) says is gone cannot be
  // reused-and-alive, so its memory goes - and so does every key this listing
  // did not produce, otherwise a finished session's key would sit there for the
  // life of the process.
  const listedKeys = new Set();
  for (const s of sessions) {
    const key = verdictKey(s);
    listedKeys.add(key);
    if (!s.alive) {
      reuseVerdicts.delete(key);
      continue;
    }
    const v = reuseVerdicts.get(key);
    if (v) s.pidReused = v.pidReused;
  }
  for (const key of [...reuseVerdicts.keys()]) {
    if (!listedKeys.has(key)) reuseVerdicts.delete(key);
  }

  if (opts.checkProcStart !== false) {
    const alivePids = sessions.filter((s) => s.alive).map((s) => s.pid);
    const starts = alivePids.length ? await probe(alivePids) : new Map();
    for (const s of sessions) {
      if (!s.alive) continue;
      const actual = starts.get(s.pid);
      if (actual == null) continue; // unreadable - keep the remembered verdict
      if (actual.startMs != null) s.procStartActualMs = actual.startMs;
      const verdict = judgeReuse(s, actual, platform, btimeSec);
      if (verdict == null) continue; // nothing comparable - keep what we had
      s.pidReused = verdict;
      reuseVerdicts.set(verdictKey(s), { pidReused: verdict });
    }
  }

  // One place decides what a "reused" verdict means for liveness.
  for (const s of sessions) {
    if (s.pidReused === true && s.alive) {
      s.alive = false;
      s.aliveSource = 'pid-reused';
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
