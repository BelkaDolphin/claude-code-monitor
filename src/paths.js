/**
 * Path resolution for Claude Code data and for our own monitor data store.
 *
 * Rules (decided in design phase):
 *  - ~/.claude is READ ONLY. We never write anything under it.
 *  - Our own data lives in %USERPROFILE%\.claude-monitor (override: CLAUDE_MONITOR_DIR).
 *  - Claude home is CLAUDE_CONFIG_DIR if set, else os.homedir()/.claude.
 *  - Everything goes through `path`; no hardcoded separators.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @returns {string} absolute path to the Claude Code config dir (~/.claude) */
export function claudeHome() {
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.claude');
}

/** @returns {string} ~/.claude/projects */
export function projectsDir() {
  return path.join(claudeHome(), 'projects');
}

/** @returns {string} ~/.claude/sessions (undocumented, best-effort) */
export function sessionsDir() {
  return path.join(claudeHome(), 'sessions');
}

/** @returns {string} our own writable data dir */
export function monitorDir() {
  const env = process.env.CLAUDE_MONITOR_DIR;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.claude-monitor');
}

/** @returns {string} <monitorDir>/events */
export function eventsDir() {
  return path.join(monitorDir(), 'events');
}

/** @returns {string} <monitorDir>/statusline */
export function statuslineDir() {
  return path.join(monitorDir(), 'statusline');
}

/** @returns {string} <monitorDir>/state - offsets and caches */
export function stateDir() {
  return path.join(monitorDir(), 'state');
}

/**
 * Directory holding subagent transcripts for a session.
 * Layout verified on Claude Code 2.1.258:
 *   <projectsDir>/<projectDirName>/<sessionId>/subagents/agent-<agentId>.jsonl
 *   <projectsDir>/<projectDirName>/<sessionId>/subagents/agent-<agentId>.meta.json
 * Nested subagents (spawnDepth >= 2) live in the SAME flat directory and carry
 * a `parentAgentId` field in their meta.json.
 * @param {string} projectPath absolute path of <projectsDir>/<projectDirName>
 * @param {string} sessionId
 */
export function subagentsDirFor(projectPath, sessionId) {
  return path.join(projectPath, sessionId, 'subagents');
}

/** @param {string} p @returns {void} */
export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/**
 * Read a file as UTF-8. Returns null when unreadable (never throws).
 * @param {string} file
 * @returns {string|null}
 */
export function readUtf8(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Read + JSON.parse a file as UTF-8. Returns null on any failure.
 * @param {string} file
 * @returns {any}
 */
export function readJsonUtf8(file) {
  const text = readUtf8(file);
  if (text === null) return null;
  try {
    return JSON.parse(stripBom(text));
  } catch {
    return null;
  }
}

/** @param {string} s */
export function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}

/**
 * Atomic-ish write: write to <file>.tmp-<pid>-<rand> then rename over the target.
 * rename() is atomic within a volume on both NTFS and POSIX.
 * @param {string} file
 * @param {string} content
 */
export function writeFileAtomic(file, content) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // Windows can fail rename when the target is momentarily locked; fall back.
    try {
      fs.rmSync(file, { force: true });
      fs.renameSync(tmp, file);
    } catch (e2) {
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e2;
    }
  }
}

/** local YYYY-MM-DD for a Date or timestamp string/number */
export function localDateKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
