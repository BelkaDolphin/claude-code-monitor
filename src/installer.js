/**
 * Install / uninstall our hooks and statusLine into ~/.claude/settings.json.
 *
 * Safety rules:
 *  - Existing hooks and every unrelated key are preserved verbatim. This user
 *    already has a SessionEnd hook (session_end.ps1) that MUST survive.
 *  - Idempotent: an identical command is never added twice.
 *  - A timestamped backup settings.json.bak-<ts> is written before any change.
 *  - --dry-run prints the resulting JSON and writes nothing.
 *
 * async:true / async:false decision (from the hooks docs):
 *  - "The hook command is not enforced on async: true hooks - they run fully in
 *    background." Good for our fire-and-forget writer, so every event uses it...
 *  - ...EXCEPT SessionEnd. "SessionEnd hooks of any type share a 1.5-second
 *    budget." Our writer finishes in tens of ms, well inside that budget, and a
 *    backgrounded process racing process teardown could lose the final event.
 *    So SessionEnd is installed SYNCHRONOUSLY (no async flag) with a small
 *    explicit timeout.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeHome, writeFileAtomic, stripBom } from './paths.js';
import { TRACKED_EVENTS } from './hooks-ingest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');

/** SessionEnd runs inside a 1.5s shared budget -> keep it synchronous. */
const SYNC_EVENTS = new Set(['SessionEnd']);

export function hookScriptPath(root = PROJECT_ROOT) {
  return path.join(root, 'hooks', 'monitor-hook.js');
}

export function statuslineScriptPath(root = PROJECT_ROOT) {
  return path.join(root, 'hooks', 'statusline.js');
}

/** The exact command string we install (also our idempotency key). */
export function hookCommand(root = PROJECT_ROOT) {
  return `node "${hookScriptPath(root)}"`;
}

export function statuslineCommand(root = PROJECT_ROOT) {
  return `node "${statuslineScriptPath(root)}"`;
}

export function settingsPath() {
  return path.join(claudeHome(), 'settings.json');
}

/**
 * Compute the new settings object without touching disk.
 * @param {any} current parsed settings.json (or null)
 * @param {{root?: string, events?: string[]}} [opts]
 * @returns {{next: any, added: string[], skipped: string[], statusLine: string}}
 */
export function planInstall(current, opts = {}) {
  const root = opts.root ?? PROJECT_ROOT;
  const events = opts.events ?? TRACKED_EVENTS;
  const cmd = hookCommand(root);
  const next = deepClone(current && typeof current === 'object' ? current : {});
  next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};

  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const skipped = [];

  for (const event of events) {
    const list = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    const already = list.some((matcherEntry) =>
      Array.isArray(matcherEntry?.hooks) && matcherEntry.hooks.some((h) => h && h.command === cmd));
    if (already) {
      skipped.push(event);
      next.hooks[event] = list;
      continue;
    }
    const entry = SYNC_EVENTS.has(event)
      ? { hooks: [{ type: 'command', command: cmd, timeout: 5 }] }
      : { hooks: [{ type: 'command', command: cmd, async: true }] };
    next.hooks[event] = [...list, entry];
    added.push(event);
  }

  const slCmd = statuslineCommand(root);
  const statusLineAction = next.statusLine?.command === slCmd
    ? 'unchanged'
    : next.statusLine
      ? 'replaced'
      : 'added';
  next.statusLine = { type: 'command', command: slCmd };

  return { next, added, skipped, statusLine: statusLineAction };
}

/**
 * Compute settings with our hooks and statusLine removed.
 * @param {any} current
 * @param {{root?: string}} [opts]
 */
export function planUninstall(current, opts = {}) {
  const root = opts.root ?? PROJECT_ROOT;
  const cmd = hookCommand(root);
  const slCmd = statuslineCommand(root);
  const next = deepClone(current && typeof current === 'object' ? current : {});
  /** @type {string[]} */
  const removed = [];

  if (next.hooks && typeof next.hooks === 'object') {
    for (const [event, list] of Object.entries(next.hooks)) {
      if (!Array.isArray(list)) continue;
      const cleaned = list
        .map((entry) => {
          if (!entry || !Array.isArray(entry.hooks)) return entry;
          const hooks = entry.hooks.filter((h) => !(h && h.command === cmd));
          if (hooks.length === entry.hooks.length) return entry;
          removed.push(event);
          return hooks.length ? { ...entry, hooks } : null;
        })
        .filter(Boolean);
      if (cleaned.length) next.hooks[event] = cleaned;
      else delete next.hooks[event];
    }
    if (!Object.keys(next.hooks).length) delete next.hooks;
  }

  let statusLine = 'unchanged';
  if (next.statusLine && next.statusLine.command === slCmd) {
    delete next.statusLine;
    statusLine = 'removed';
  }
  return { next, removed: [...new Set(removed)], statusLine };
}

function deepClone(o) {
  return JSON.parse(JSON.stringify(o));
}

/** Raised when settings.json exists but is not parseable JSON. */
export class CorruptSettingsError extends Error {
  /** @param {string} file @param {any} cause @param {string|null} backupFile */
  constructor(file, cause, backupFile = null) {
    super(
      `settings.json exists but is not valid JSON: ${file}\n` +
      `  ${cause && cause.message ? cause.message : cause}\n` +
      '  Refusing to overwrite it - that would destroy your existing settings.\n' +
      (backupFile ? `  A copy was saved to ${backupFile}\n` : '') +
      '  Fix the file by hand (or restore a backup), then run this command again.',
    );
    this.name = 'CorruptSettingsError';
    this.file = file;
    this.backupFile = backupFile;
    this.cause = cause;
  }
}

/**
 * Read settings.json, distinguishing "absent" from "present but unparseable".
 * Conflating the two would make a corrupt file look like a fresh install and
 * silently clobber every existing setting.
 * @param {string} file
 * @returns {{state: 'missing'|'ok'|'corrupt', data: any, text: string|null, error: any}}
 */
export function readSettingsFile(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) {
      return { state: 'missing', data: null, text: null, error: null };
    }
    // EACCES/EBUSY etc.: the file is there but unreadable. Never treat that as
    // "no settings" either.
    return { state: 'corrupt', data: null, text: null, error: err };
  }
  try {
    const data = JSON.parse(stripBom(text));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { state: 'corrupt', data: null, text, error: new Error('top-level value is not a JSON object') };
    }
    return { state: 'ok', data, text, error: null };
  } catch (err) {
    return { state: 'corrupt', data: null, text, error: err };
  }
}

/**
 * Detect the indentation used by an existing JSON file so a rewrite keeps the
 * user's formatting. Returns a string for JSON.stringify's `space` argument.
 * @param {string|null} text
 * @returns {string|number}
 */
export function detectIndent(text) {
  if (typeof text !== 'string') return 2;
  // The first line that is indented under the opening brace defines the unit.
  const m = /\n([ \t]+)\S/.exec(text);
  if (!m) return 2;
  const ws = m[1];
  if (ws.includes('\t')) return '\t';
  return ws.length > 0 && ws.length <= 8 ? ws.length : 2;
}

function backupName(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${file}.bak-${stamp}`;
}

/**
 * @param {'install'|'uninstall'} mode
 * @param {{dryRun?: boolean, root?: string, settingsFile?: string, events?: string[]}} [opts]
 * @throws {CorruptSettingsError} when settings.json exists but cannot be parsed
 */
export function applySettings(mode, opts = {}) {
  const file = opts.settingsFile ?? settingsPath();
  const dryRun = opts.dryRun === true;
  const read = readSettingsFile(file);

  if (read.state === 'corrupt') {
    // Preserve whatever is there before complaining, so a hand-edit mistake is
    // recoverable. A dry run only reports; it must not write anything.
    let backup = null;
    if (!dryRun) {
      try {
        backup = backupName(file);
        fs.copyFileSync(file, backup);
      } catch {
        backup = null;
      }
    }
    throw new CorruptSettingsError(file, read.error, backup);
  }

  const existed = read.state === 'ok';
  const current = read.data;
  const indent = detectIndent(read.text);
  const plan = mode === 'install'
    ? planInstall(current, { root: opts.root, events: opts.events })
    : planUninstall(current, { root: opts.root });

  const json = `${JSON.stringify(plan.next, null, indent)}\n`;
  const unchanged = existed && json === `${JSON.stringify(current, null, indent)}\n`;

  const result = {
    mode,
    file,
    existed,
    indent,
    dryRun,
    unchanged,
    backupFile: null,
    ...plan,
    json,
  };
  delete result.next;

  if (dryRun) return result;
  if (unchanged) return result;

  if (existed) {
    const backup = backupName(file);
    fs.copyFileSync(file, backup);
    result.backupFile = backup;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Atomic: a crash mid-write must never leave a half-written settings.json.
  writeFileAtomic(file, json);
  return result;
}
