/**
 * Enumerate Claude Code sessions from ~/.claude/projects.
 *
 * Layout (verified, Claude Code 2.1.258):
 *   projects/<projectDirName>/<sessionId>.jsonl                     main transcript
 *   projects/<projectDirName>/<sessionId>/subagents/agent-<id>.jsonl subagent transcript
 *   projects/<projectDirName>/<sessionId>/subagents/agent-<id>.meta.json
 *   projects/<projectDirName>/<sessionId>/tool-results/<toolUseId>.txt (spilled large results)
 *   projects/<projectDirName>/memory/*.md                            (not a session)
 *
 * `cwd` MUST come from the `cwd` field inside the jsonl. The directory name is a
 * lossy encoding (every non-alphanumeric char becomes '-'), so Japanese path
 * segments collapse to '-' and cannot be reversed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { projectsDir, readJsonUtf8, subagentsDirFor } from './paths.js';
import { streamLines, stripBomBuffer } from './jsonl-tail.js';
import { parseLine } from './parser.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AGENT_FILE_RE = /^agent-(.+)\.jsonl$/;
const DEFAULT_DAYS = 30;
/**
 * How much of the end of a transcript is read back when looking for the last
 * timestamp. A transcript reaches 35MB; the whole point is never to touch the
 * other 34.9. One record is a few KB at most, so 64KB holds many of them even
 * when the tail is all spilled tool results.
 */
const TAIL_BYTES = 64 * 1024;
/**
 * Timestamped records peekSessionMeta wants in hand before it stops early.
 * Transcript records are not ordered by their clocks (see peekSessionMeta), so
 * one is never enough; five covers every out-of-order cluster measured (the
 * worst was three lines spanning 1ms) without reading past the head window.
 */
const HEAD_TS_RECORDS = 5;
/** Transcripts remembered by readLastTimestamp. LRU; see the cache note there. */
const MAX_LAST_TS_CACHE = 500;
/** resolved path -> {size, mtimeMs, lastTs} */
const lastTsCache = new Map();

/**
 * @typedef {Object} SubagentRef
 * @property {string} agentId
 * @property {string} jsonlPath
 * @property {string|null} metaPath
 * @property {string|null} agentType
 * @property {string|null} description
 * @property {string|null} toolUseId
 * @property {string|null} parentAgentId
 * @property {number} spawnDepth
 * @property {string|null} model
 * @property {string|null} worktreePath
 * @property {number} size
 * @property {number} mtimeMs
 */

/**
 * @typedef {Object} SessionEntry
 * @property {string} sessionId
 * @property {string} projectDirName
 * @property {string} projectPath
 * @property {string} jsonlPath
 * @property {string|null} cwd
 * @property {string|null} firstTs  first timestamp in the transcript
 * @property {string|null} lastTs   last timestamp in the transcript (tail read)
 * @property {number} mtimeMs
 * @property {number} size
 * @property {SubagentRef[]} subagents
 * @property {boolean} hasSubagents
 */

/** List <projectsDir>/* directories. */
export function listProjectDirs(root = projectsDir()) {
  let ents;
  try {
    ents = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, fullPath: path.join(root, e.name) }));
}

/**
 * Read the subagent refs for one session.
 * @param {string} projectPath
 * @param {string} sessionId
 * @returns {SubagentRef[]}
 */
export function listSubagents(projectPath, sessionId) {
  const dir = subagentsDirFor(projectPath, sessionId);
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  /** @type {SubagentRef[]} */
  const out = [];
  for (const e of ents) {
    if (!e.isFile()) continue;
    const m = AGENT_FILE_RE.exec(e.name);
    if (!m) continue;
    const agentId = m[1];
    const jsonlPath = path.join(dir, e.name);
    const metaPath = path.join(dir, `agent-${agentId}.meta.json`);
    const meta = readJsonUtf8(metaPath) || {};
    let st = null;
    try {
      st = fs.statSync(jsonlPath);
    } catch { /* ignore */ }
    out.push({
      agentId,
      jsonlPath,
      metaPath: fs.existsSync(metaPath) ? metaPath : null,
      agentType: typeof meta.agentType === 'string' ? meta.agentType : null,
      description: typeof meta.description === 'string' ? meta.description : null,
      toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : null,
      // parentAgentId is present only for spawnDepth >= 2 (12/99 files measured).
      parentAgentId: typeof meta.parentAgentId === 'string' ? meta.parentAgentId : null,
      spawnDepth: Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : 1,
      model: typeof meta.model === 'string' ? meta.model : null,
      worktreePath: typeof meta.worktreePath === 'string' ? meta.worktreePath : null,
      size: st ? st.size : 0,
      mtimeMs: st ? st.mtimeMs : 0,
    });
  }
  out.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return out;
}

/**
 * Read `cwd` and the earliest timestamp from the head of a transcript.
 *
 * `firstTs` is the MINIMUM over the window, not the first timestamp seen.
 * Measured on e2a7ec22: line 5 carries ...55.266Z while lines 6 and 7 carry
 * ...55.265Z, and lines 1-4 carry none at all. Records are written in the order
 * things happened, which is not the order their clocks read - so "the first
 * record with a timestamp" is simply not the start. buildTree already takes the
 * min over the whole file; this takes it over the window it reads anyway.
 *
 * The early stop therefore needs a second condition: stopping at the first
 * timestamp would reintroduce the bug. It now waits for HEAD_TS_RECORDS
 * timestamped records - enough to cover a cluster of out-of-order lines, and
 * still a handful of lines rather than the whole 35MB file.
 *
 * @param {string} jsonlPath
 * @returns {{cwd: string|null, version: string|null, gitBranch: string|null, firstTs: string|null}}
 */
export function peekSessionMeta(jsonlPath, maxLines = 60) {
  let cwd = null;
  let version = null;
  let gitBranch = null;
  let firstTs = null;
  let tsSeen = 0;
  const STOP = Symbol('stop');
  try {
    streamLines(jsonlPath, (line, lineNo) => {
      if (lineNo > maxLines) throw STOP;
      const rec = parseLine(line, lineNo, {});
      if (!rec) return;
      if (!cwd && rec.cwd) cwd = rec.cwd;
      if (!version && rec.version) version = rec.version;
      if (!gitBranch && rec.gitBranch) gitBranch = rec.gitBranch;
      if (rec.timestamp) {
        tsSeen += 1;
        if (!firstTs || rec.timestamp < firstTs) firstTs = rec.timestamp;
      }
      if (cwd && version && tsSeen >= HEAD_TS_RECORDS) throw STOP;
    });
  } catch (e) {
    if (e !== STOP) { /* swallow: defensive */ }
  }
  return { cwd, version, gitBranch, firstTs };
}

/**
 * The last timestamp in a transcript, read from the END of the file.
 *
 * A session's end time is the latest thing it wrote, and the only alternative to
 * this is the file mtime - which is the time of the last WRITE, not of the last
 * record, and which a copy or a backup tool moves. So the bytes are worth
 * reading, but only the last few: TAIL_BYTES are pulled back and every record
 * in that window is parsed, keeping the MAXIMUM timestamp.
 *
 * The maximum, not the last line: transcript records are written in the order
 * things happened, not in the order their clocks read (measured on e2a7ec22,
 * the last three timestamped lines run .266Z, .265Z, .265Z). Taking the final
 * line would report an end 1ms before the start.
 *
 * Two records deliberately contribute nothing:
 *   - `type: 'ai-title'` carries no timestamp at all ({type, aiTitle,
 *     sessionId}) and is regenerated last on many sessions, so it is very often
 *     the final line. Skipping it is the reason this scans instead of parsing
 *     one line.
 *   - the first line of the window, which starts mid-record unless the window
 *     starts at byte 0.
 *
 * Returns null when nothing in the window has a timestamp; we never widen the
 * window, because "bounded" is the property that makes this safe to call for
 * every session on every request. For the same reason the maximum is the
 * maximum over the WINDOW - a later timestamp further back in the file is out
 * of reach, which is what the caller's final clamp is there to absorb.
 *
 * @param {string} jsonlPath
 * @param {{size: number, mtimeMs: number}} stat  the caller's own stat, reused
 * @returns {string|null} ISO timestamp
 */
export function readLastTimestamp(jsonlPath, stat) {
  const size = stat && Number.isFinite(stat.size) ? stat.size : null;
  const mtimeMs = stat && Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : null;
  if (size === null || mtimeMs === null || size <= 0) return null;

  // Keyed on the bytes, not on a clock: the index is rebuilt every couple of
  // seconds and an unchanged transcript must not be read again, while a live
  // one invalidates itself the moment it grows.
  const key = path.resolve(jsonlPath);
  const hit = lastTsCache.get(key);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) {
    lastTsCache.delete(key);
    lastTsCache.set(key, hit);
    return hit.lastTs;
  }

  const lastTs = scanTailForTimestamp(jsonlPath, size);
  lastTsCache.delete(key);
  lastTsCache.set(key, { size, mtimeMs, lastTs });
  while (lastTsCache.size > MAX_LAST_TS_CACHE) {
    lastTsCache.delete(lastTsCache.keys().next().value);
  }
  return lastTs;
}

/** Forget every cached tail. Tests only; the cache is otherwise self-invalidating. */
export function clearLastTimestampCache() {
  lastTsCache.clear();
}

function scanTailForTimestamp(jsonlPath, size) {
  const start = Math.max(0, size - TAIL_BYTES);
  const want = size - start;
  let bytes;
  let fd;
  try {
    fd = fs.openSync(jsonlPath, 'r');
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(want);
    const n = fs.readSync(fd, buf, 0, want, start);
    bytes = buf.subarray(0, Math.max(0, n));
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
  // A BOM can only be at byte 0; the same three bytes anywhere else are content.
  const text = (start === 0 ? stripBomBuffer(bytes) : bytes).toString('utf8');
  const lines = text.split('\n');
  const floor = start === 0 ? 0 : 1;
  let latest = null;
  for (let i = lines.length - 1; i >= floor; i--) {
    const rec = parseLine(lines[i], i + 1, {});
    if (!rec || !rec.timestamp || !Number.isFinite(rec.tsMs)) continue;
    if (latest === null || rec.timestamp > latest) latest = rec.timestamp;
  }
  return latest;
}

/**
 * Build the session index.
 *
 * @param {Object} [opts]
 * @param {number} [opts.days=30]   only sessions whose transcript mtime is within N days
 * @param {string} [opts.root]      override projects dir
 * @param {boolean} [opts.withCwd=true] read cwd from inside each transcript
 * @param {number} [opts.now]       injectable clock (ms)
 * @returns {{sessions: SessionEntry[], skippedOlder: number, scannedProjects: number}}
 */
export function buildSessionIndex(opts = {}) {
  const days = opts.days ?? DEFAULT_DAYS;
  const root = opts.root ?? projectsDir();
  const withCwd = opts.withCwd !== false;
  const now = opts.now ?? Date.now();
  const cutoff = days > 0 ? now - days * 24 * 60 * 60 * 1000 : -Infinity;

  /** @type {SessionEntry[]} */
  const sessions = [];
  let skippedOlder = 0;
  const projects = listProjectDirs(root);

  for (const proj of projects) {
    let ents;
    try {
      ents = fs.readdirSync(proj.fullPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of ents) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const sessionId = e.name.slice(0, -'.jsonl'.length);
      // Session transcripts are named by UUID. Anything else is not a session.
      if (!UUID_RE.test(sessionId)) continue;
      const jsonlPath = path.join(proj.fullPath, e.name);
      let st;
      try {
        st = fs.statSync(jsonlPath);
      } catch {
        continue;
      }
      if (st.mtimeMs < cutoff) {
        skippedOlder++;
        continue;
      }
      const subagents = listSubagents(proj.fullPath, sessionId);
      // `withCwd` is really "read inside the transcripts": it gates the head
      // peek and the tail scan together, so findSession() can still enumerate
      // all history without touching a single transcript byte.
      const meta = withCwd ? peekSessionMeta(jsonlPath) : { cwd: null, version: null, gitBranch: null, firstTs: null };
      const lastTs = withCwd ? readLastTimestamp(jsonlPath, st) : null;
      sessions.push({
        sessionId,
        projectDirName: proj.name,
        projectPath: proj.fullPath,
        jsonlPath,
        cwd: meta.cwd,
        version: meta.version,
        gitBranch: meta.gitBranch,
        firstTs: meta.firstTs,
        lastTs,
        mtimeMs: st.mtimeMs,
        size: st.size,
        subagents,
        hasSubagents: subagents.length > 0,
      });
    }
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { sessions, skippedOlder, scannedProjects: projects.length };
}

/**
 * Find one session by full id or unique prefix. Searches ALL history (days=0)
 * so old sessions stay reachable on demand, as designed.
 * @param {string} idOrPrefix
 * @param {{root?: string}} [opts]
 * @returns {{session: SessionEntry|null, matches: SessionEntry[]}}
 */
export function findSession(idOrPrefix, opts = {}) {
  const { sessions } = buildSessionIndex({ days: 0, root: opts.root, withCwd: false });
  const needle = String(idOrPrefix || '').toLowerCase();
  const matches = sessions.filter((s) => s.sessionId.toLowerCase().startsWith(needle));
  if (matches.length === 1) {
    const s = matches[0];
    Object.assign(s, peekSessionMeta(s.jsonlPath));
    return { session: s, matches };
  }
  const exact = matches.find((s) => s.sessionId.toLowerCase() === needle);
  if (exact) {
    Object.assign(exact, peekSessionMeta(exact.jsonlPath));
    return { session: exact, matches };
  }
  return { session: null, matches };
}

/** All transcript files belonging to a session (main + every subagent). */
export function sessionFiles(entry) {
  return [entry.jsonlPath, ...entry.subagents.map((s) => s.jsonlPath)];
}
