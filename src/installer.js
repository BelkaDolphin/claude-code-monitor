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

/**
 * Where a statusLine we replaced is kept so `uninstall-hooks` can put it back.
 * A top-level key, prefixed so it cannot collide with a real setting.
 */
export const STATUSLINE_BACKUP_KEY = '_claudeMonitorStatusLineBackup';

/** Raised when a path cannot be pasted into a hook command line safely. */
export class UnsafeCommandPathError extends Error {
  /** @param {string} p @param {string} what @param {string} why */
  constructor(p, what, why) {
    super(
      `refusing to build a hook command for a ${what} that ${why}: ${p}\n` +
      '  Claude Code runs a hook command through a shell, so this would not run\n' +
      '  what it reads like. Move the repo (or node) somewhere plainer and run\n' +
      '  install-hooks again.',
    );
    this.name = 'UnsafeCommandPathError';
    this.path = p;
    this.what = what;
  }
}

/** POSIX `sh -c`: still live inside double quotes. */
const POSIX_META = /[$`\\!]/;
/** cmd.exe: `%VAR%` IS expanded inside double quotes. */
const WINDOWS_META = /%/;

/**
 * Reject a path that could change what a hook command actually runs.
 *
 * Hooks are declared as `type: "command"` and Claude Code hands that string to
 * a shell, so the reasoning autostart.assertQuotablePath applies to the .vbs
 * launcher and to schtasks /TR applies here too, one layer further out.
 *
 * Always rejected: `"` (it would close our own quoting), CR, LF and NUL. A
 * Windows path cannot contain any of them, so a value that does is not a path.
 *
 * Then the shell-specific set, because "the shell" is not the same program on
 * the two platforms and the harmless character on one is the dangerous one on
 * the other:
 *  - POSIX: inside double quotes `$`, a backtick and a backslash are still
 *    live, so a path holding one is a substitution waiting to happen. `!` is
 *    history expansion and only bites interactively, but a path with one in it
 *    is not worth the argument.
 *  - Windows: `%` is expanded inside double quotes; `$` and a backtick are not,
 *    and the backslash is the separator every path here is made of - rejecting
 *    it would reject every Windows path there is.
 *
 * @param {string} p
 * @param {string} what what to call it in the message
 * @returns {string} the path, unchanged
 */
export function assertCommandSafePath(p, what = 'path') {
  const s = String(p);
  if (s.includes('"')) throw new UnsafeCommandPathError(s, what, 'contains a double quote');
  if (/[\r\n\0]/.test(s)) throw new UnsafeCommandPathError(s, what, 'contains a newline or a NUL');
  const m = (process.platform === 'win32' ? WINDOWS_META : POSIX_META).exec(s);
  if (m) throw new UnsafeCommandPathError(s, what, `contains the shell metacharacter ${m[0]}`);
  return s;
}

export function hookScriptPath(root = PROJECT_ROOT) {
  return path.join(root, 'hooks', 'monitor-hook.js');
}

export function statuslineScriptPath(root = PROJECT_ROOT) {
  return path.join(root, 'hooks', 'statusline.js');
}

/**
 * The node that runs our hooks: THIS one, by absolute path.
 *
 * A bare `node` is resolved out of whatever PATH the process running the hook
 * happens to have. Claude Code started from the GUI does not inherit the shell
 * profile a version manager (nvm/fnm/volta) puts node on the PATH from, so a
 * bare `node` is how the hooks - and only the hooks - die silently on a machine
 * where everything else works. autostart.js already bakes in process.execPath
 * for exactly this reason; this is the same rule one layer up.
 */
export function nodePath() {
  return process.execPath;
}

/** A path as it goes into a hook command: checked first, then quoted. */
function quoteForCommand(p, what) {
  return `"${assertCommandSafePath(p, what)}"`;
}

/**
 * The exact command string we install.
 *
 * NOT the idempotency key any more: the node path is baked in, so an entry
 * written by another node - or by a build that wrote a bare `node` - is still
 * ours and has to be recognised as such. See ownsCommand().
 */
export function hookCommand(root = PROJECT_ROOT, node = nodePath()) {
  return `${quoteForCommand(node, 'node executable')} ${quoteForCommand(hookScriptPath(root), 'hook script path')}`;
}

export function statuslineCommand(root = PROJECT_ROOT, node = nodePath()) {
  return `${quoteForCommand(node, 'node executable')} ${quoteForCommand(statuslineScriptPath(root), 'statusLine script path')}`;
}

/**
 * Is this command string one of ours - in ANY generation?
 *
 * The identity is the SCRIPT PATH, not the whole command line. Builds before
 * this one wrote `node "<script>"`, and a user who swaps node out gets a
 * different absolute path. Both have to be recognised and replaced, or
 * install-hooks would append a second copy of every hook on every such change.
 * @param {unknown} command
 * @param {string} scriptPath
 */
export function ownsCommand(command, scriptPath) {
  return typeof command === 'string' && command.includes(scriptPath);
}

export function settingsPath() {
  return path.join(claudeHome(), 'settings.json');
}

/**
 * Compute the new settings object without touching disk.
 *
 * `statusLine` is the one key a user can already be using for something else,
 * and there is exactly one of it. So a FOREIGN statusLine is left alone and
 * reported (`kept-foreign`) unless `forceStatusLine` says otherwise, in which
 * case the old value is parked under STATUSLINE_BACKUP_KEY and uninstall puts
 * it back. Hooks need none of this: they are a list, and ours are added beside
 * whatever is already there.
 *
 * @param {any} current parsed settings.json (or null)
 * @param {{root?: string, events?: string[], forceStatusLine?: boolean}} [opts]
 * @returns {{next: any, added: string[], replaced: string[], skipped: string[],
 *            statusLine: string, statusLineExisting: string|null}}
 */
export function planInstall(current, opts = {}) {
  const root = opts.root ?? PROJECT_ROOT;
  const events = opts.events ?? TRACKED_EVENTS;
  const cmd = hookCommand(root);
  const script = hookScriptPath(root);
  const next = deepClone(current && typeof current === 'object' ? current : {});
  next.hooks = next.hooks && typeof next.hooks === 'object' ? next.hooks : {};

  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const replaced = [];
  /** @type {string[]} */
  const skipped = [];

  for (const event of events) {
    const list = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    let found = false;
    let rewritten = false;
    // An entry naming our script but not our current command line was written
    // by an older build (bare `node`) or by another node. Rewrite it in place:
    // appending instead would run the hook twice, for ever.
    const updated = list.map((matcherEntry) => {
      if (!matcherEntry || !Array.isArray(matcherEntry.hooks)) return matcherEntry;
      const hooks = matcherEntry.hooks.map((h) => {
        if (!h || !ownsCommand(h.command, script)) return h;
        found = true;
        if (h.command === cmd) return h;
        rewritten = true;
        return { ...h, command: cmd };
      });
      return hooks === matcherEntry.hooks ? matcherEntry : { ...matcherEntry, hooks };
    });

    if (found) {
      (rewritten ? replaced : skipped).push(event);
      next.hooks[event] = updated;
      continue;
    }
    const entry = SYNC_EVENTS.has(event)
      ? { hooks: [{ type: 'command', command: cmd, timeout: 5 }] }
      : { hooks: [{ type: 'command', command: cmd, async: true }] };
    next.hooks[event] = [...updated, entry];
    added.push(event);
  }

  const slCmd = statuslineCommand(root);
  const slScript = statuslineScriptPath(root);
  const existing = next.statusLine && typeof next.statusLine === 'object' ? next.statusLine : null;
  const ours = existing ? ownsCommand(existing.command, slScript) : false;

  let statusLine;
  let statusLineExisting = null;
  if (!existing) {
    next.statusLine = { type: 'command', command: slCmd };
    statusLine = 'added';
  } else if (ours) {
    // Ours, but written by another node or an older build: same rewrite.
    if (existing.command === slCmd) {
      statusLine = 'unchanged';
    } else {
      next.statusLine = { ...existing, type: 'command', command: slCmd };
      statusLine = 'updated';
    }
  } else {
    statusLineExisting = typeof existing.command === 'string' ? existing.command : JSON.stringify(existing);
    if (opts.forceStatusLine === true) {
      // deepClone above already detached this from the caller's object.
      next[STATUSLINE_BACKUP_KEY] = existing;
      next.statusLine = { type: 'command', command: slCmd };
      statusLine = 'replaced';
    } else {
      statusLine = 'kept-foreign';
    }
  }

  return { next, added, replaced, skipped, statusLine, statusLineExisting };
}

/**
 * Compute settings with our hooks and statusLine removed.
 * @param {any} current
 * @param {{root?: string}} [opts]
 */
export function planUninstall(current, opts = {}) {
  const root = opts.root ?? PROJECT_ROOT;
  const script = hookScriptPath(root);
  const slScript = statuslineScriptPath(root);
  const next = deepClone(current && typeof current === 'object' ? current : {});
  /** @type {string[]} */
  const removed = [];

  if (next.hooks && typeof next.hooks === 'object') {
    for (const [event, list] of Object.entries(next.hooks)) {
      if (!Array.isArray(list)) continue;
      const cleaned = list
        .map((entry) => {
          if (!entry || !Array.isArray(entry.hooks)) return entry;
          // By script path, not by command line: an entry an older build wrote
          // as `node "<script>"` is just as much ours to remove.
          const hooks = entry.hooks.filter((h) => !(h && ownsCommand(h.command, script)));
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
  if (next.statusLine && ownsCommand(next.statusLine.command, slScript)) {
    // Put back whatever --force-statusline displaced. Removing ours and leaving
    // the user with nothing would be a silent loss of a setting they had.
    const backup = next[STATUSLINE_BACKUP_KEY];
    if (backup && typeof backup === 'object' && !Array.isArray(backup)) {
      next.statusLine = backup;
      statusLine = 'restored';
    } else {
      delete next.statusLine;
      statusLine = 'removed';
    }
    // Only ever dropped in the branch that acted on it: a backup key sitting
    // next to a statusLine that is not ours is not ours to delete either.
    delete next[STATUSLINE_BACKUP_KEY];
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
 * @param {{dryRun?: boolean, root?: string, settingsFile?: string, events?: string[],
 *          forceStatusLine?: boolean}} [opts]
 * @throws {CorruptSettingsError} when settings.json exists but cannot be parsed
 * @throws {UnsafeCommandPathError} when a path cannot be quoted into a command
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
  // Both plans build a command out of two paths, and either can be unquotable.
  // Doing it here means the refusal happens before a backup is taken and before
  // a single byte is written - and identically under --dry-run.
  const plan = mode === 'install'
    ? planInstall(current, { root: opts.root, events: opts.events, forceStatusLine: opts.forceStatusLine })
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
