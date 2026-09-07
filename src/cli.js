#!/usr/bin/env node
/**
 * claude-monitor CLI (M1 core - no UI).
 *
 * Every subcommand supports --json for machine-readable output.
 */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { claudeHome, projectsDir, monitorDir, localDateKey, ensureDir } from './paths.js';
import { buildSessionIndex, findSession, sessionFiles, listProjectDirs } from './session-index.js';
import { buildTree, formatTree } from './tree.js';
import { resolveSessionSpan } from './tree-merge.js';
import { aggregateFiles, UsageCollector, METRICS } from './usage.js';
import { buildToolLog } from './tools-log.js';
import { readLiveSessions } from './sessions.js';
import { HooksIngest, foldState, listEventDates, todayKey } from './hooks-ingest.js';
import { latestRateLimits, readSidecars } from './statusline-sidecar.js';
import {
  applySettings,
  hookCommand,
  statuslineCommand,
  settingsPath,
  PROJECT_ROOT,
  CorruptSettingsError,
  UnsafeCommandPathError,
} from './installer.js';
import { ccusageDaily, normalizeDailyRow } from './ccusage.js';
import {
  loadOrCreateToken,
  tokenFilePath,
  urlFilePath,
  writeUrlFile,
  readUrlFile,
  readUrlPort,
  defaultLogFilePath,
} from './token-store.js';
import { LogFile, teeConsole } from './log-file.js';
import {
  installAutostart,
  uninstallAutostart,
  autostartStatus,
  planAutostart,
  launcherPath,
  cliPath,
  buildLauncherVbs,
  launcherCommand,
  toUtf16LeBom,
  trayScriptPath,
  trayPidPath,
  trayStatus,
  signalTrayStop,
  stopTrayProcesses,
  launcherHealth,
  displayCommand,
  decodeConsole,
  TASK_NAME,
} from './autostart.js';
import { parseFile, ParseStats } from './parser.js';
import {
  startServer,
  installSignalHandlers,
  installCrashHandlers,
  openBrowser,
  resolvePort,
  isPortNumber,
  DEFAULT_PORT,
} from './server.js';

const USAGE = `claude-monitor - Claude Code monitoring core

Usage: node src/cli.js <command> [options]

Commands:
  sessions [--utc]               live sessions from ~/.claude/sessions + PID liveness
  list [--days N] [--utc]        session index from ~/.claude/projects (default 30 days)
  tree <sessionId|prefix> [--utc]  session -> subagent tree
  usage <sessionId|prefix>       token usage for one session (main + subagents)
  usage --daily [--since D] [--until D] [--compare-ccusage]
                                 daily usage across all transcripts
  tools <sessionId|prefix> [--limit N] [--errors] [--utc]
  events [--date YYYY-MM-DD] [--limit N] [--state] [--utc]
  serve [--port N] [--open] [--persist-token] [--rotate-token]
        [--token-file P] [--log-file [P]] [--events-keep-days N]
                                 live dashboard on http://127.0.0.1:<port>
                                 (default 47321; --port or CLAUDE_MONITOR_PORT)
                                 --events-keep-days sets how many days of
                                 <monitorDir>/events are kept (default 30,
                                 0 keeps everything)
  rotate-token [--token-file P] [--port N]
                                 replace the STORED token; the running server
                                 keeps the old one until it is restarted
  statusline                     rate limits captured by the statusline sidecar
  stats <sessionId|prefix>       parser statistics for one session
  install-hooks [--dry-run] [--force-statusline]
                                 write hooks + statusLine into ~/.claude/settings.json.
                                 An existing statusLine that is not ours is left
                                 alone unless --force-statusline, which saves it
                                 so uninstall-hooks can put it back.
  uninstall-hooks [--dry-run]    remove them again
  install-autostart [--port N] [--no-tray] [--dry-run]
                                 start the dashboard hidden at Windows logon.
                                 By default the logon task starts the TRAY HOST,
                                 which shows a notification-area icon and
                                 restarts the server if it dies. --no-tray
                                 registers the old direct wscript -> node command.
  uninstall-autostart [--dry-run]  remove the scheduled task and its launcher
  autostart-status [--show-url]  read-only: is the logon task registered, is the
                                 tray host running, and do the paths the
                                 launcher names still exist? The entry URL is
                                 redacted unless --show-url
  tray [--port N] [--no-wait] [--dry-run]
                                 start the tray host now, detached, without
                                 registering anything. Windows only.
  tray-stop [--port N] [--dry-run]
                                 stop the tray host (and the server it supervises).
                                 Windows only. --port only matters when tray.pid
                                 does not name one. Exits 1 if anything survives.
  paths                          show every resolved path

Global options:
  --json                         JSON output
  -h, --help
`;

/**
 * Every flag the CLI accepts, and whether it takes a value.
 *
 * This table exists because the parser used to have no idea. It gave the next
 * token to whatever flag came before it, so `install-hooks --dry-run foo` set
 * `dry-run` to "foo", the `=== true` test for a dry run failed, and the command
 * WROTE settings.json. A misspelled `--dry-runn` was accepted just as quietly
 * and registered a scheduled task. And `usage --json <id>` put the session id
 * into `--json`, leaving `usage` with no argument and printing the all-time
 * daily aggregate instead.
 *
 * Three kinds:
 *   bool     a switch. Never consumes the next token. `--flag=false` still
 *            works; `--flag false` does not, because the whole bug above was a
 *            switch swallowing the word after it.
 *   value    needs one. `--days` with nothing usable after it is an error, not
 *            a silent fall back to the default.
 *   optional `--log-file` alone means "the default path", `--log-file X` means
 *            X. The two token-bearing flags of `serve` and nothing else.
 *
 * A test asserts this table and the USAGE text name exactly the same flags, so
 * neither can grow a flag the other has never heard of.
 * @type {Record<string, 'bool'|'value'|'optional'>}
 */
export const FLAGS = {
  // global
  json: 'bool',
  help: 'bool',
  utc: 'bool',
  // list
  days: 'value',
  // usage
  daily: 'bool',
  since: 'value',
  until: 'value',
  'compare-ccusage': 'bool',
  // tools / events
  limit: 'value',
  errors: 'bool',
  date: 'value',
  state: 'bool',
  // serve / rotate-token
  port: 'value',
  open: 'bool',
  'persist-token': 'bool',
  'rotate-token': 'bool',
  'token-file': 'optional',
  'log-file': 'optional',
  'events-keep-days': 'value',
  // install-hooks / uninstall-hooks
  'dry-run': 'bool',
  'force-statusline': 'bool',
  // autostart / tray
  'no-tray': 'bool',
  'no-wait': 'bool',
  'show-url': 'bool',
};

/** `--flag`, `--flag=x`: the flag names USAGE mentions. */
export function flagsNamedIn(text) {
  return new Set((String(text).match(/--[a-z][a-z0-9-]*/g) ?? []).map((f) => f.slice(2)));
}

/** The USAGE text, so the flag table can be checked against what we document. */
export const usageText = () => USAGE;

/**
 * @param {string[]} argv
 * @param {Record<string, 'bool'|'value'|'optional'>} [spec]
 * @returns {{_: string[], flags: Record<string, any>, errors: string[]}}
 */
export function parseArgs(argv, spec = FLAGS) {
  const out = { _: [], flags: {}, errors: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') && a.length > 2) {
      const eq = a.indexOf('=');
      const key = eq > 0 ? a.slice(2, eq) : a.slice(2);
      const kind = Object.prototype.hasOwnProperty.call(spec, key) ? spec[key] : null;
      if (!kind) {
        // Deliberately does NOT consume the next token: a typo must not also
        // eat the session id that followed it.
        out.errors.push(`unknown flag --${key}`);
        continue;
      }
      if (eq > 0) {
        const raw = a.slice(eq + 1);
        if (kind === 'bool' && !/^(true|false)$/i.test(raw)) {
          out.errors.push(`--${key} is a switch and takes no value (got "${raw}"); write --${key} or --${key}=false`);
          continue;
        }
        // A switch is stored as a real boolean, so the many places that read
        // `args.flags.json` directly cannot be fooled by the STRING "false".
        out.flags[key] = kind === 'bool' ? /^true$/i.test(raw) : raw;
        continue;
      }
      if (kind === 'bool') {
        out.flags[key] = true;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out.flags[key] = next;
        i++;
        continue;
      }
      if (kind === 'optional') {
        out.flags[key] = true;
        continue;
      }
      out.errors.push(`--${key} needs a value`);
    } else if (a === '-h') {
      out.flags.help = true;
    } else {
      out._.push(a);
    }
  }
  return out;
}

const NUM = new Intl.NumberFormat('en-US');
const n = (v) => NUM.format(Math.round(Number(v) || 0));

/**
 * Times are written as UTC ISO strings everywhere on disk, but a human reading
 * a monitor wants their own wall clock. `--utc` restores the raw view.
 * @param {string|null} iso
 * @param {boolean} utc
 * @param {{ms?: boolean}} [opts]
 */
function timeOf(iso, utc, opts = {}) {
  if (!iso) return '-';
  if (utc) return opts.ms ? iso.slice(11, 23) : iso.slice(11, 19);
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  const p2 = (x) => String(x).padStart(2, '0');
  const base = `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  return opts.ms ? `${base}.${String(d.getMilliseconds()).padStart(3, '0')}` : base;
}

/**
 * 'YYYY-MM-DD HH:MM:SS'. Local by default - the same rule `events` follows:
 * the disk holds UTC ISO, the human reads their own wall clock. `--utc` puts
 * the old behaviour back.
 */
function dateTimeOf(value, utc) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '-';
  if (utc) return d.toISOString().replace('T', ' ').slice(0, 19);
  const p2 = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
}

/** The timezone note the time-bearing tables print under their header. */
function tzNote(utc) {
  return utc ? '[times: UTC]' : `[times: local ${Intl.DateTimeFormat().resolvedOptions().timeZone}]`;
}

/** A finished span as "12s" / "4m 03s" / "1h 04m". Same shape the UI uses. */
function spanOf(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const p2 = (x) => String(x).padStart(2, '0');
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${p2(sec % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${p2(m % 60)}m`;
}

/** ISO or epoch ms, whichever a source happens to hand over. */
function msOf(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v) {
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return null;
}

function emit(json, obj, textFn) {
  if (json) {
    process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`);
  } else {
    process.stdout.write(`${textFn()}\n`);
  }
}

function table(rows, headers) {
  if (!rows.length) return '(none)';
  const cols = headers.map((h) => h.key);
  const widths = headers.map((h, i) =>
    Math.max(h.label.length, ...rows.map((r) => String(r[cols[i]] ?? '').length)));
  const line = (cells) => cells.map((c, i) => (headers[i].right ? String(c).padStart(widths[i]) : String(c).padEnd(widths[i]))).join('  ');
  const out = [line(headers.map((h) => h.label)), line(widths.map((w) => '-'.repeat(w)))];
  for (const r of rows) out.push(line(cols.map((c) => r[c] ?? '')));
  return out.join('\n');
}

function resolveSession(idOrPrefix) {
  if (!idOrPrefix) {
    fail('missing <sessionId|prefix>');
  }
  const { session, matches } = findSession(idOrPrefix);
  if (!session) {
    if (!matches.length) fail(`no session matches "${idOrPrefix}"`);
    fail(`ambiguous prefix "${idOrPrefix}" (${matches.length} matches):\n  ${matches.slice(0, 10).map((s) => s.sessionId).join('\n  ')}`);
  }
  return session;
}

/**
 * @param {string} msg
 * @param {number} [code] 2 for "you typed it wrong", 1 for "it did not work"
 */
function fail(msg, code = 1) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(code);
}

/**
 * `--port`, as an actual port.
 *
 * Absent means "no choice was made" and the caller falls through to the
 * environment and then the default. Anything else has to BE a port: resolvePort
 * used to swallow a bad one, which is how `install-autostart --port 70000` came
 * to register a logon task on 47321 without saying so.
 * @param {{flags: Record<string, any>}} args
 * @returns {number|undefined}
 */
export function portFlag(args) {
  const v = args.flags.port;
  if (v === undefined) return undefined;
  if (!isPortNumber(v)) {
    fail(`--port must be a whole number 0..65535 (got "${v === true ? '' : v}"); 0 lets the OS pick one`, 2);
  }
  return Number(String(v).trim());
}

/* ------------------------------- commands ------------------------------- */

/**
 * Where one session's START and END come from, in the same order the dashboard
 * uses (see tree-view.resolveSessionStart / resolveSessionEnd):
 *
 *   START  hooks `SessionStart` > `startedAt` in sessions/<pid>.json
 *   END    hooks `SessionEnd`, and only once the session is over
 *
 * The transcript is not consulted here: `sessions` is a live-process listing and
 * reading 70 transcripts to date a running session would be absurd.
 *
 * @param {any} live one readLiveSessions() entry
 * @param {any} hook the foldState record for it, or null
 */
function sessionSpan(live, hook) {
  const hookStart = hook && hook.startedAt ? hook.startedAt : null;
  const startedAt = hookStart ?? (live && live.startedAt != null ? live.startedAt : null);
  const startedAtSource = startedAt === null ? null : (hookStart ? 'hooks' : 'sessions');
  const ended = hook && hook.state === 'ended' && hook.endedAt ? hook.endedAt : null;
  const durationMs = msOf(startedAt) !== null && msOf(ended) !== null
    ? msOf(ended) - msOf(startedAt)
    : null;
  return {
    sessionId: live ? live.sessionId : null,
    startedAt: startedAt === null ? null : new Date(msOf(startedAt)).toISOString(),
    startedAtSource,
    endedAt: ended,
    endedAtSource: ended ? 'hooks' : null,
    durationMs: durationMs !== null && durationMs >= 0 ? durationMs : null,
  };
}

async function cmdSessions(args) {
  const utc = args.flags.utc === true || args.flags.utc === 'true';
  const { sessions, skippedKeyFiles, dir } = await readLiveSessions();
  const ingest = new HooksIngest();
  const events = ingest.readAll();
  const folded = foldState(events);

  const times = [];
  const rows = sessions.map((s) => {
    const hook = s.sessionId ? folded.sessions.get(s.sessionId) : null;
    const span = sessionSpan(s, hook);
    times.push(span);
    return {
      pid: s.pid,
      alive: s.alive ? 'yes' : 'no',
      status: s.status ?? '-',
      hookState: hook ? hook.state : '-',
      sessionId: s.sessionId ? `${s.sessionId.slice(0, 8)}...` : '-',
      name: s.name ?? '-',
      cwd: s.cwd ?? '-',
      started: span.startedAt ? dateTimeOf(span.startedAt, utc) : '-',
      ended: span.endedAt ? dateTimeOf(span.endedAt, utc) : '-',
      statusAge: s.statusUpdatedAt ? `${Math.round((Date.now() - s.statusUpdatedAt) / 1000)}s` : '-',
      pidReused: s.pidReused === true ? 'REUSED?' : '',
    };
  });

  emit(args.flags.json, { dir, skippedKeyFiles, sessions, times, hookStates: [...folded.sessions.values()] }, () =>
    [
      `sessions dir: ${dir}  (${sessions.length} file(s), ${skippedKeyFiles} *.key ignored)  ${tzNote(utc)}`,
      table(rows, [
        { key: 'pid', label: 'PID', right: true },
        { key: 'alive', label: 'ALIVE' },
        { key: 'status', label: 'STATUS' },
        { key: 'hookState', label: 'HOOK' },
        { key: 'sessionId', label: 'SESSION' },
        { key: 'name', label: 'NAME' },
        { key: 'started', label: utc ? 'START (UTC)' : 'START' },
        { key: 'ended', label: utc ? 'END (UTC)' : 'END' },
        { key: 'statusAge', label: 'AGE', right: true },
        { key: 'pidReused', label: '' },
        { key: 'cwd', label: 'CWD' },
      ]),
      '',
      'note: `status` is written only on state transitions (no heartbeat), so a stale',
      '      timestamp does not mean the session is dead. HOOK is the hook-derived state',
      '      and is "-" until install-hooks has been run.',
      '      START is the hooks SessionStart, else sessions/<pid>.json startedAt; END is',
      '      the hooks SessionEnd and stays "-" while the session is alive. --json adds',
      '      a `times` array naming the source of each value.',
    ].join('\n'));
}

function cmdList(args) {
  const days = args.flags.days !== undefined ? Number(args.flags.days) : 30;
  const utc = args.flags.utc === true || args.flags.utc === 'true';
  const { sessions, skippedOlder, scannedProjects } = buildSessionIndex({ days });
  const rows = sessions.map((s) => ({
    session: s.sessionId.slice(0, 8),
    modified: dateTimeOf(s.mtimeMs, utc),
    sizeKB: Math.round(s.size / 1024),
    subs: s.subagents.length,
    project: s.projectDirName,
    cwd: s.cwd ?? '(unknown)',
  }));
  emit(args.flags.json, { days, scannedProjects, skippedOlder, count: sessions.length, sessions }, () =>
    [
      `projects dir: ${projectsDir()}`,
      `${sessions.length} session(s) within ${days} day(s); ${skippedOlder} older skipped; ${scannedProjects} project dir(s)  ${tzNote(utc)}`,
      table(rows, [
        { key: 'session', label: 'SESSION' },
        { key: 'modified', label: utc ? 'MODIFIED (UTC)' : 'MODIFIED' },
        { key: 'sizeKB', label: 'KB', right: true },
        { key: 'subs', label: 'SUBS', right: true },
        { key: 'project', label: 'PROJECT' },
        { key: 'cwd', label: 'CWD' },
      ]),
    ].join('\n'));
}

function cmdTree(args) {
  const utc = args.flags.utc === true || args.flags.utc === 'true';
  const session = resolveSession(args._[1]);
  const ingest = new HooksIngest();
  const folded = foldState(ingest.readAll());
  const { root, orphans, stats } = buildTree(session, { stoppedAgentIds: folded.stoppedAgentIds });
  // The same resolver the dashboard's root node uses, fed the hook record this
  // command already folded, so the two never disagree about when a session ran.
  const hook = folded.sessions.get(session.sessionId) ?? null;
  const span = resolveSessionSpan(root, hook ? {
    startedAt: hook.startedAt,
    startedAtSource: hook.startedAt ? 'hooks' : null,
    endedAt: hook.endedAt,
    endedAtSource: hook.endedAt ? 'hooks' : null,
  } : null, !!hook && hook.state !== 'ended');
  const elapsed = msOf(span.startedAt) !== null && msOf(span.endedAt) !== null
    ? msOf(span.endedAt) - msOf(span.startedAt)
    : null;
  emit(args.flags.json, { session: session.sessionId, cwd: session.cwd, span, root, orphans, stats: stats.toJSON() }, () => {
    const lines = [
      `session ${session.sessionId}`,
      `cwd     ${session.cwd ?? '(unknown)'}`,
      `files   ${1 + session.subagents.length} (main + ${session.subagents.length} subagent transcript(s))`,
      `start   ${span.startedAt ? dateTimeOf(span.startedAt, utc) : '(unknown)'}` +
        `${span.startedAtSource ? `  <- ${span.startedAtSource}` : ''}`,
      `end     ${span.endedAt ? dateTimeOf(span.endedAt, utc) : '(still running)'}` +
        `${span.endedAtSource ? `  <- ${span.endedAtSource}` : ''}`,
      `elapsed ${elapsed === null ? '-' : spanOf(elapsed)}  ${tzNote(utc)}`,
      '',
      ...formatTree(root),
    ];
    if (orphans.length) {
      lines.push('', 'orphans (spawning tool_use not found in any transcript):');
      for (const o of orphans) lines.push(...formatTree(o));
    }
    lines.push(
      '',
      'status legend: completed = sync spawn finished or SubagentStop hook seen;',
      '               running = no tool_result for the spawning tool_use;',
      '               async-unknown = background agent was launched (the parent gets its',
      '               tool_result immediately) and no hook evidence of completion exists.',
    );
    if (stats.parseFailures) lines.push('', `parse failures: ${stats.parseFailures}`);
    return lines.join('\n');
  });
}

function cmdUsageSession(args) {
  const session = resolveSession(args._[1]);
  const files = sessionFiles(session);
  const stats = new ParseStats();
  const { summary } = aggregateFiles(files, { stats });
  emit(args.flags.json, { session: session.sessionId, files: files.length, summary, stats: stats.toJSON() }, () => {
    const t = summary.totals;
    const lines = [
      `session ${session.sessionId}  (${files.length} transcript file(s))`,
      '',
      `input              ${n(t.input_tokens)}`,
      `output             ${n(t.output_tokens)}`,
      `cache_creation     ${n(t.cache_creation_input_tokens)}`,
      `cache_read         ${n(t.cache_read_input_tokens)}`,
      `total              ${n(t.totalTokens)}`,
      `messages (dedup)   ${n(summary.uniqueMessages)}  (from ${n(summary.usageLines)} usage-bearing lines, ${n(summary.duplicateLines)} duplicates dropped)`,
      '',
      'raw (no dedupe, for comparison only - NOT a valid figure):',
      `  output ${n(summary.rawTotals.output_tokens)}  total ${n(summary.rawTotals.totalTokens)}`,
      '',
      'by agent:',
      table(Object.entries(summary.byAgent).map(([k, v]) => ({
        agent: k, msgs: n(v.count), input: n(v.input_tokens), output: n(v.output_tokens),
        cacheC: n(v.cache_creation_input_tokens), cacheR: n(v.cache_read_input_tokens),
      })), [
        { key: 'agent', label: 'AGENT' },
        { key: 'msgs', label: 'MSGS', right: true },
        { key: 'input', label: 'INPUT', right: true },
        { key: 'output', label: 'OUTPUT', right: true },
        { key: 'cacheC', label: 'CACHE_CR', right: true },
        { key: 'cacheR', label: 'CACHE_RD', right: true },
      ]),
      '',
      'by model:',
      table(Object.entries(summary.byModel).map(([k, v]) => ({
        model: k, msgs: n(v.count), input: n(v.input_tokens), output: n(v.output_tokens),
        cacheC: n(v.cache_creation_input_tokens), cacheR: n(v.cache_read_input_tokens),
      })), [
        { key: 'model', label: 'MODEL' },
        { key: 'msgs', label: 'MSGS', right: true },
        { key: 'input', label: 'INPUT', right: true },
        { key: 'output', label: 'OUTPUT', right: true },
        { key: 'cacheC', label: 'CACHE_CR', right: true },
        { key: 'cacheR', label: 'CACHE_RD', right: true },
      ]),
    ];
    return lines.join('\n');
  });
}

/** Walk every transcript under projects/ (including subagents). */
function allTranscripts(root = projectsDir()) {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  };
  walk(root);
  return out;
}

async function cmdUsageDaily(args) {
  const files = allTranscripts();
  const collector = new UsageCollector();
  const stats = new ParseStats();
  for (const f of files) parseFile(f, (rec) => collector.add(rec), stats);
  const summary = collector.summarize();

  const since = typeof args.flags.since === 'string' ? args.flags.since : null;
  const until = typeof args.flags.until === 'string' ? args.flags.until : null;
  const today = localDateKey(new Date());

  let dates = Object.keys(summary.byDate).filter((d) => d !== 'UNKNOWN_DATE');
  if (since) dates = dates.filter((d) => d >= since);
  if (until) dates = dates.filter((d) => d <= until);
  dates.sort();

  /** @type {any} */
  let comparison = null;
  if (args.flags['compare-ccusage']) {
    const res = await ccusageDaily({ since: since ?? undefined, until: until ?? undefined });
    if (!res.ok) {
      comparison = { ok: false, error: res.error, raw: res.raw };
    } else {
      // ccusage 20.0.20 emits one row per (period, agent); `agent:"all"` is the
      // rolled-up row and the only one we must compare against.
      const rows = (Array.isArray(res.data?.daily) ? res.data.daily : [])
        .filter((r) => r?.agent === undefined || r.agent === 'all');
      const byDate = new Map(rows.map((r) => {
        const nr = normalizeDailyRow(r);
        return [nr.date, nr];
      }));
      const diffs = [];
      for (const d of dates) {
        const mine = summary.byDate[d];
        const theirs = byDate.get(d);
        const rec = { date: d, isToday: d === today, match: false, metrics: {} };
        for (const m of METRICS) {
          const a = mine?.[m] ?? 0;
          const b = theirs?.[m] ?? 0;
          rec.metrics[m] = { mine: a, ccusage: b, delta: a - b };
        }
        rec.match = theirs != null && METRICS.every((m) => rec.metrics[m].delta === 0);
        diffs.push(rec);
      }
      comparison = { ok: true, ccusageDates: rows.length, diffs };
    }
  }

  emit(args.flags.json, {
    files: files.length,
    since, until, today,
    stats: stats.toJSON(),
    uniqueMessages: summary.uniqueMessages,
    byDate: Object.fromEntries(dates.map((d) => [d, summary.byDate[d]])),
    rawTotals: summary.rawTotals,
    comparison,
  }, () => {
    const lines = [
      `scanned ${files.length} transcript file(s), ${n(stats.totalLines)} lines, ${stats.parseFailures} parse failure(s)`
      + (stats.skippedFiles ? `, ${stats.skippedFiles} file(s) skipped (unreadable/deleted mid-scan)` : ''),
      `dedupe: message.id, latest timestamp wins -> ${n(summary.uniqueMessages)} unique messages`,
      '',
      table(dates.map((d) => {
        const v = summary.byDate[d];
        return {
          date: d + (d === today ? ' *' : ''),
          msgs: n(v.count),
          input: n(v.input_tokens),
          output: n(v.output_tokens),
          cacheC: n(v.cache_creation_input_tokens),
          cacheR: n(v.cache_read_input_tokens),
        };
      }), [
        { key: 'date', label: 'DATE' },
        { key: 'msgs', label: 'MSGS', right: true },
        { key: 'input', label: 'INPUT', right: true },
        { key: 'output', label: 'OUTPUT', right: true },
        { key: 'cacheC', label: 'CACHE_CR', right: true },
        { key: 'cacheR', label: 'CACHE_RD', right: true },
      ]),
    ];
    if (comparison) {
      lines.push('', '--- ccusage comparison ---');
      if (!comparison.ok) {
        lines.push(`ccusage failed: ${comparison.error}`);
      } else {
        lines.push(table(comparison.diffs.map((d) => ({
          date: d.date + (d.isToday ? ' *' : ''),
          verdict: d.match ? 'MATCH' : 'DIFF',
          dIn: d.metrics.input_tokens.delta,
          dOut: d.metrics.output_tokens.delta,
          dCC: d.metrics.cache_creation_input_tokens.delta,
          dCR: d.metrics.cache_read_input_tokens.delta,
        })), [
          { key: 'date', label: 'DATE' },
          { key: 'verdict', label: 'RESULT' },
          { key: 'dIn', label: 'd(input)', right: true },
          { key: 'dOut', label: 'd(output)', right: true },
          { key: 'dCC', label: 'd(cacheC)', right: true },
          { key: 'dCR', label: 'd(cacheR)', right: true },
        ]));
        lines.push(
          '',
          '* = today. A mismatch on today is EXPECTED and not a bug: ccusage snapshots',
          '  the transcripts when it runs, and the session keeps appending afterwards, so',
          '  our numbers are read at a later moment than ccusage read them.',
        );
      }
    }
    return lines.join('\n');
  });
}

function cmdTools(args) {
  const session = resolveSession(args._[1]);
  const utc = args.flags.utc === true || args.flags.utc === 'true';
  const { calls, byTool, pending, errors, stats } = buildToolLog(session);
  const limit = args.flags.limit !== undefined ? Number(args.flags.limit) : 40;
  let shown = calls;
  if (args.flags.errors) shown = shown.filter((c) => c.status === 'error');
  const tail = shown.slice(-limit);

  emit(args.flags.json, { session: session.sessionId, total: calls.length, byTool, pending, errors, calls: shown, stats: stats.toJSON() }, () =>
    [
      `session ${session.sessionId}: ${calls.length} tool call(s), ${errors} error(s), ${pending} pending  ${tzNote(utc)}`,
      `by tool: ${Object.entries(byTool).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}=${v}`).join(' ')}`,
      '',
      table(tail.map((c) => ({
        time: timeOf(c.startedAt, utc),
        tool: c.name ?? '?',
        st: c.status,
        ms: c.durationMs ?? '-',
        agent: c.agentId ? c.agentId.slice(0, 8) : '(main)',
        summary: c.summary,
      })), [
        { key: 'time', label: utc ? 'TIME(UTC)' : 'TIME' },
        { key: 'tool', label: 'TOOL' },
        { key: 'st', label: 'STATUS' },
        { key: 'ms', label: 'MS', right: true },
        { key: 'agent', label: 'AGENT' },
        { key: 'summary', label: 'INPUT' },
      ]),
      shown.length > tail.length ? `\n(showing last ${tail.length} of ${shown.length}; use --limit N)` : '',
    ].join('\n'));
}

function cmdEvents(args) {
  const dates = listEventDates();
  const date = typeof args.flags.date === 'string' ? args.flags.date : (dates[dates.length - 1] ?? todayKey());
  const ingest = new HooksIngest();
  const events = ingest.rereadDay(date);
  const limit = args.flags.limit !== undefined ? Number(args.flags.limit) : 50;
  const folded = foldState(events);
  const utc = args.flags.utc === true || args.flags.utc === 'true';

  emit(args.flags.json, {
    dir: monitorDir(),
    availableDates: dates,
    date,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    count: events.length,
    parseFailures: ingest.parseFailures,
    unknownEvents: Object.fromEntries(ingest.unknownEvents),
    events: events.slice(-limit),
    sessions: [...folded.sessions.values()],
    agents: [...folded.agents.values()],
  }, () => {
    if (!dates.length) {
      return [
        `no event files under ${path.join(monitorDir(), 'events')}`,
        'run `node src/cli.js install-hooks` first, then start a new Claude Code session.',
      ].join('\n');
    }
    const lines = [
      `events for ${date} (available: ${dates.join(', ')})`,
      `${events.length} event(s), ${ingest.parseFailures} parse failure(s)` +
        `  [times: ${utc ? 'UTC' : `local ${Intl.DateTimeFormat().resolvedOptions().timeZone}`}]`,
      '',
      table(events.slice(-limit).map((e) => ({
        at: timeOf(e.receivedAt, utc, { ms: true }),
        event: e.event,
        session: e.sessionId ? e.sessionId.slice(0, 8) : '-',
        agent: e.agentId ? e.agentId.slice(0, 8) : '-',
        detail: e.toolName ?? e.notificationType ?? e.reason ?? e.agentType ?? '',
      })), [
        { key: 'at', label: utc ? 'TIME(UTC)' : 'TIME' },
        { key: 'event', label: 'EVENT' },
        { key: 'session', label: 'SESSION' },
        { key: 'agent', label: 'AGENT' },
        { key: 'detail', label: 'DETAIL' },
      ]),
    ];
    if (args.flags.state) {
      lines.push('', 'folded session state:');
      for (const s of folded.sessions.values()) {
        lines.push(`  ${s.sessionId.slice(0, 8)}  ${s.state}  lastEvent=${s.lastEvent} tool=${s.activeTool ?? '-'}`);
      }
      lines.push('folded agent state:');
      for (const a of folded.agents.values()) {
        lines.push(`  ${a.agentId.slice(0, 8)}  ${a.state}  type=${a.agentType ?? '-'}`);
      }
    }
    return lines.join('\n');
  });
}

function cmdStatusline(args) {
  const rl = latestRateLimits();
  const { entries } = readSidecars();
  emit(args.flags.json, { ...rl, sessions: entries.map((e) => ({ sessionId: e.sessionId, capturedAt: e.capturedAt, model: e.model, contextUsedPct: e.contextUsedPct, costUsd: e.costUsd, rateLimits: e.rateLimits })) }, () => {
    const lines = [`statusline sidecar dir: ${rl.dir}`, `captured sessions: ${rl.sessionCount}`];
    if (!rl.available) {
      lines.push('', `rate_limits unavailable: ${rl.unavailableReason}`);
      lines.push('rate_limits only exists for Claude.ai Pro/Max (or a gateway with a spend limit)');
      lines.push('and only after the first API response of a session.');
    } else {
      lines.push('', `source session ${rl.sourceSessionId} captured ${rl.capturedAt}`);
      for (const [k, v] of Object.entries(rl.rateLimits)) {
        lines.push(`  ${k}: ${v.used_percentage}% resets ${v.resetsAtIso ?? '-'}`);
      }
    }
    if (entries.length) {
      lines.push('', table(entries.map((e) => ({
        session: e.sessionId.slice(0, 8),
        model: e.model ?? '-',
        ctx: e.contextUsedPct != null ? `${e.contextUsedPct}%` : '-',
        cost: e.costUsd != null ? `$${e.costUsd.toFixed(4)}` : '-',
        at: e.capturedAt ?? '-',
      })), [
        { key: 'session', label: 'SESSION' },
        { key: 'model', label: 'MODEL' },
        { key: 'ctx', label: 'CTX', right: true },
        { key: 'cost', label: 'COST', right: true },
        { key: 'at', label: 'CAPTURED' },
      ]));
    }
    return lines.join('\n');
  });
}

/* ---------------------- serve / token / autostart ----------------------- */

/** `--flag` with no value, `--flag=true` and `--flag true` all mean true. */
export function boolFlag(args, name) {
  const v = args.flags[name];
  return v === true || v === 'true';
}

/**
 * A flag whose value is a non-negative whole number.
 *
 * A bare `--flag`, a missing one and anything that is not a number all fall
 * back: a typo must not silently turn a retention policy into "keep nothing".
 * An explicit `0` is a real answer and is kept.
 * @param {{flags: Record<string, any>}} args
 * @param {string} name
 * @param {number|undefined} fallback
 * @returns {number|undefined}
 */
export function countFlag(args, name, fallback) {
  const v = args.flags[name];
  if (v === undefined || v === true) return fallback;
  const n = Number(String(v).trim());
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

/**
 * A flag that may be given bare (use the default path) or with a path.
 * `--log-file` -> the default; `--log-file X` -> X; absent -> null.
 *
 * `--log-file` as the LAST argument and `--log-file=` (an empty value) both
 * mean the bare form: the user asked for a log, so they get the default path
 * rather than silently no log at all.
 */
export function pathFlag(args, name, fallback) {
  const v = args.flags[name];
  if (v === undefined) return null;
  if (v === true || v === 'true') return fallback;
  if (typeof v === 'string' && v) return path.resolve(v);
  return fallback;
}

/**
 * Open the log and mirror stdout/stderr into it.
 * Done FIRST in cmdServe so that a port-collision refusal and anything the
 * crash handler prints land in the file - a hidden instance has no console for
 * any of it.
 *
 * `rawOut` is captured BEFORE the tee is installed. The entry URL carries the
 * bearer token, and it is the one thing that must reach the console without
 * reaching the file; see printWithToken.
 */
function openServeLog(args) {
  const file = pathFlag(args, 'log-file', defaultLogFilePath());
  if (!file) return null;
  const rawOut = process.stdout.write.bind(process.stdout);
  const log = new LogFile({ file });
  const restore = teeConsole(log);
  return { log, restore, file, rawOut };
}

/**
 * Print a line that contains the bearer token.
 *
 * The console must show it - somebody starting the server by hand has no other
 * way to open the dashboard - but the log file must not. That file lives in the
 * profile directory, survives every restart, keeps a rotated generation and is
 * written on every autostart run: a live credential in it is a credential with
 * no expiry. So the line goes to the pre-tee stdout, and the log gets the same
 * line with the token replaced (LogFile.write scrubs it; see log-file.js).
 *
 * The on-disk copy of the URL is url.txt, which sits next to the token file on
 * purpose and is the supported way for a hidden instance to be found.
 *
 * The log is written FIRST. Its write is a synchronous fs call while stdout on
 * a Windows pipe is asynchronous, so a process that is killed around this point
 * (which is exactly when a supervisor or a test stops it) keeps the durable
 * record and loses at most the console copy - never the other way round.
 *
 * @param {{rawOut: Function, log: LogFile}|null} logging
 * @param {string} text
 */
function printWithToken(logging, text) {
  if (!logging) {
    process.stdout.write(text);
    return;
  }
  logging.log.write(text, 'out');
  logging.rawOut(text);
}

async function cmdServe(args) {
  const logging = openServeLog(args);
  const port = resolvePort(portFlag(args));
  const open = boolFlag(args, 'open');
  const rotate = boolFlag(args, 'rotate-token');
  // Rotating a per-process token would be meaningless, so it implies storing
  // one. Naming a token file implies it too.
  const tokenFile = pathFlag(args, 'token-file', tokenFilePath());
  const persist = boolFlag(args, 'persist-token') || rotate || tokenFile !== null;

  // BIND FIRST, before anything is created, rotated or written.
  //
  // Starting a second instance by hand on the port a hidden one already holds
  // is the normal accident, and it must change nothing. With the token read (or
  // `--rotate-token`-ed) first, the instance that LOSES the race would have
  // replaced the secret of the instance that is actually serving, and the
  // user's bookmark would start returning 403 for no visible reason.
  const eventsKeepDays = countFlag(args, 'events-keep-days', undefined);

  let handle;
  try {
    handle = await startServer({
      port,
      collectorOptions: eventsKeepDays === undefined ? undefined : { eventsKeepDays },
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') fail(err.message);
    throw err;
  }

  let tokenInfo = null;
  if (persist) {
    try {
      tokenInfo = loadOrCreateToken({ file: tokenFile ?? tokenFilePath(), rotate });
    } catch (err) {
      fail(`could not prepare the token file: ${err && err.message ? err.message : err}`);
    }
    // The port is only known after listen() and so, now, is the token; Auth
    // learns both after the fact and handle.url reads through to it.
    if (tokenInfo) handle.auth.setToken(tokenInfo.token);
  }

  // The bookmarkable URL, on disk, because an instance started at logon prints
  // it to a console nobody will ever see. Only for a PERSISTED token: a
  // per-process one dies with this process, so writing its URL would leave a
  // file that looks like a way in, is not one, and that rotate-token would then
  // read a port out of.
  const urlWrite = tokenInfo ? writeUrlFile(handle.url) : null;

  // Opened here rather than by startServer, because the URL is only final once
  // the persisted token has been adopted.
  if (open) openBrowser(handle.url);

  const closeLog = () => {
    if (!logging) return;
    logging.restore();
    logging.log.close();
  };
  installSignalHandlers(handle, {
    log: (m) => process.stdout.write(`${m}\n`),
  });
  process.on('exit', closeLog);
  installCrashHandlers(handle, { log: (m) => process.stderr.write(`${m}\n`) });

  if (args.flags.json) {
    // The payload carries the url, so the whole line is token-bearing and goes
    // out the same way the plain one does: console in full, log redacted.
    printWithToken(logging, `${JSON.stringify({
      ok: true,
      port: handle.port,
      url: handle.url,
      tokenPersisted: !!tokenInfo,
      tokenFile: tokenInfo ? tokenInfo.file : null,
      tokenAction: tokenInfo ? tokenInfo.action : 'per-process',
      urlFile: urlWrite && urlWrite.written ? urlWrite.file : null,
      logFile: logging ? logging.file : null,
    })}\n`);
  } else {
    // One line, with the token, because this is the only place it is shown.
    printWithToken(logging, `${handle.url}\n`);
    const lines = [
      `claude-monitor serving on 127.0.0.1:${handle.port} (loopback only)`,
      'open the URL above once; it sets a cookie and the token leaves the address bar.',
      'do NOT share the URL - it is the only credential.',
    ];
    if (tokenInfo) {
      lines.push(
        `token: ${tokenInfo.action} (${tokenInfo.file})`,
        'the URL survives a restart, so it can be bookmarked. `rotate-token` replaces it.',
      );
    } else {
      lines.push('token: per-process (nothing stored; the URL dies with this process)');
    }
    if (urlWrite && urlWrite.written) lines.push(`url written to: ${urlWrite.file}`);
    if (logging) lines.push(`log: ${logging.file}`);
    lines.push('Ctrl+C to stop.', '');
    process.stderr.write(lines.join('\n'));
  }
  // Resolve never: the process lives until a signal arrives.
  return new Promise(() => {});
}

/**
 * Which port the rotated URL should name, and where that came from.
 *
 * `rotate-token` is normally run bare, long after `serve` was started - by hand
 * with a `--port`, or by the logon task with the port baked into the launcher.
 * This process has no way to ask the running server, so the port recorded in
 * url.txt by that serve is the only evidence of the choice, and it beats the
 * compiled-in default. An explicit flag and CLAUDE_MONITOR_PORT still win: they
 * are what the user is saying right now.
 *
 * url.txt is only trusted while the token file it was written next to is still
 * there. serve writes the two together and only for a persisted token, so a
 * url.txt on its own is a leftover - from a build that wrote it for
 * per-process tokens too, or from a token file the user deleted - and a
 * leftover is not evidence.
 *
 * @param {{flags: Record<string, any>}} args
 * @param {string} tokenFile the token file this rotation is about to write
 * @returns {{port: number, source: string, guessed: boolean}}
 */
function rotateTokenPort(args, tokenFile) {
  // A bare `--port` no longer reaches here at all (the parser refuses it), but
  // the check stays: this function is also called with hand-built args.
  const explicit = portFlag(args);
  if (explicit !== undefined) {
    return { port: explicit, source: '--port', guessed: false };
  }
  if (process.env.CLAUDE_MONITOR_PORT) {
    return { port: resolvePort(undefined), source: 'CLAUDE_MONITOR_PORT', guessed: false };
  }
  const recorded = fs.existsSync(tokenFile) ? readUrlPort() : null;
  if (recorded !== null) {
    return { port: recorded, source: urlFilePath(), guessed: false };
  }
  return { port: DEFAULT_PORT, source: 'default', guessed: true };
}

function cmdRotateToken(args) {
  const file = pathFlag(args, 'token-file', tokenFilePath()) ?? tokenFilePath();
  const { port, source, guessed } = rotateTokenPort(args, file);
  let info;
  try {
    info = loadOrCreateToken({ file, rotate: true });
  } catch (err) {
    fail(`could not write the token file: ${err && err.message ? err.message : err}`);
    return;
  }
  const url = `http://127.0.0.1:${port}/?t=${info.token}`;
  const urlWrite = writeUrlFile(url);
  // What rotation does and does not do: it replaces the token FILE, and nothing
  // else. A server that is already listening holds its token in memory (see
  // src/server.js startServer -> new Auth) and the cookie it issued is that very
  // token, compared against the in-memory one (auth.js hasValidCookie ->
  // isToken -> safeEqual) - there is no HMAC and no derivation, so nothing about
  // an open session changes when the file does. Until that server is restarted
  // the OLD bookmark and the OLD cookie keep working and the NEW url is the one
  // that gets 403. After the restart it is the other way round.
  //
  // There is deliberately no way to signal the running server: the dashboard has
  // no write endpoints, and adding one to reload a secret would be the only
  // privileged operation in the whole server.
  emit(args.flags.json, {
    ok: true,
    action: info.action,
    tokenFile: info.file,
    port,
    portSource: source,
    portGuessed: guessed,
    url,
    urlFile: urlWrite.written ? urlWrite.file : null,
    urlFileError: urlWrite.error,
  }, () => [
    `token ${info.action}: ${info.file}`,
    `port ${port} (from ${source})`,
    urlWrite.written ? `url written to: ${urlWrite.file}` : `could not write the url file: ${urlWrite.error}`,
    '',
    url,
    '',
    ...(guessed ? [
      `WARNING: no port was given and no port could be read from ${urlFilePath()},`,
      `         so the URL above assumes the default port ${DEFAULT_PORT}. If the server was`,
      '         started with --port N or CLAUDE_MONITOR_PORT, re-run with the same --port N.',
      '',
    ] : []),
    'this replaced the token FILE. Nothing else changed yet:',
    '  - a server that is ALREADY RUNNING still holds the previous token in memory,',
    '    so the OLD url and the cookie it already handed out keep working, and the',
    '    NEW url above is the one it answers with 403.',
    '  - restart it (or log off and on again, for the autostart task). From then on',
    '    only the new url works: the old bookmark and every old cookie get 403.',
  ].join('\n'));
}

/**
 * The one-line summary of the tray host for `autostart-status`.
 *
 * The pid file is a claim, not a fact - a host killed with /F leaves it behind -
 * so the wording follows what the process table actually says, and calls a file
 * naming a dead process what it is.
 * @param {ReturnType<import('./autostart.js').trayStatus>} tray
 */
function trayLine(tray) {
  if (!tray.trayPid) return tray.exists ? 'stopped (tray.pid is a leftover)' : 'stopped (no tray.pid)';
  if (!tray.trayAlive) {
    // `gone` and `reused by X` are different worlds: the first is a leftover to
    // clean up, the second is a number that now belongs to somebody else and
    // must never be killed. Say which.
    return `stale tray.pid (pid ${tray.trayPid} ${tray.trayReason ?? 'is gone'})`;
  }
  const server = tray.serverAlive
    ? `server pid ${tray.serverPid}`
    : (tray.serverPid ? `server pid ${tray.serverPid} ${tray.serverReason ?? 'is GONE'}` : 'no server yet');
  return `running (tray pid ${tray.trayPid}, ${server}, port ${tray.port ?? '?'})`;
}

/**
 * Does the registered launcher still point at files that exist?
 * @param {ReturnType<import('./autostart.js').launcherHealth>} health
 */
function launcherLines(health) {
  if (!health.exists) {
    return [`launcher pts: (no ${path.basename(health.file)} - re-run install-autostart to enable this check)`];
  }
  if (health.info === null) return [`launcher pts: (${health.file} is unreadable)`];
  if (health.ok) return ['launcher pts: every path it names still exists'];
  return [
    'launcher pts: *** LAUNCHER POINTS AT A MISSING FILE ***',
    ...health.missing.map((m) => `              ${m.key}: ${m.path} (MISSING)`),
    '              the logon task will appear to succeed and start nothing: wscript',
    '              fires the command off without waiting, so a missing executable is',
    '              never reported, and the tray host cannot log what it never ran.',
    '              Re-run install-autostart from the current location to fix it.',
  ];
}

/**
 * install-autostart / uninstall-autostart / autostart-status.
 * Same discipline as install-hooks: --dry-run prints exactly what would run and
 * exactly what would be written, and touches nothing.
 * @param {'install'|'uninstall'|'status'} mode
 */
function cmdAutostart(args, mode) {
  const dryRun = boolFlag(args, 'dry-run');

  if (mode === 'status') {
    // The tray is queried separately from the task: autostartStatus() only ever
    // runs schtasks /Query, and keeping the process lookup out of it keeps that
    // promise easy to check.
    const tray = trayStatus();
    const health = launcherHealth();
    const showUrl = boolFlag(args, 'show-url');
    const st = { ...autostartStatus(), tray, launcherHealth: health };
    emit(args.flags.json, st, () => {
      const lines = [
        `task        : ${st.taskName} ${st.installed ? '(registered)' : '(not registered)'}`,
        `query       : ${st.schtasks.display}`,
      ];
      if (st.installed) {
        lines.push(
          `enabled     : ${st.enabled === null ? '(unknown)' : st.enabled}`,
          `trigger     : ${st.onLogon ? 'at logon' : '(not a logon trigger)'}`,
          // The trigger's UserId, not the principal's: an empty one means the
          // task fires for EVERY user's logon, which is not what we register
          // and not something a non-admin can create.
          `  for user  : ${st.triggerUserId ?? '*** EMPTY - this trigger fires for EVERY user ***'}`,
          `  delay     : ${st.triggerDelay ?? '(none)'}`,
          `runs as     : ${st.userId ?? '(unknown)'}`,
          `runs        : ${st.command ?? '(unknown)'} ${st.arguments ?? ''}`.trimEnd(),
          `run level   : ${st.runLevel ?? '(unknown)'}`,
          // PT0S is "no limit". Anything else is a countdown to the scheduler
          // killing the tray host - the default, PT72H, would do it every third
          // day.
          `time limit  : ${st.executionTimeLimit === 'PT0S'
            ? 'PT0S (none - correct)'
            : `${st.executionTimeLimit ?? '(unknown)'} *** NOT PT0S: the scheduler will stop the tray host after this ***`}`,
          `if running  : ${st.multipleInstancesPolicy ?? '(unknown)'}`,
        );
      } else if (st.queryError) {
        lines.push(`schtasks says: ${st.queryError}`);
      }
      lines.push(
        `launcher    : ${st.launcher} ${st.launcherExists ? '(present)' : '(missing)'}`,
        `task xml    : ${st.xmlFile} ${st.xmlExists ? '(present)' : '(missing)'}`,
        `log         : ${st.logFile} ${st.logExists ? '(present)' : '(missing)'}`,
        `url file    : ${urlFilePath()}`,
        `tray        : ${trayLine(tray)}`,
        `tray.pid    : ${tray.file} ${tray.exists ? '(present)' : '(missing)'}`,
        ...launcherLines(health),
      );
      const url = readUrlFile();
      // The entry URL is the only credential there is, and `autostart-status`
      // is the command a user runs to paste output into a bug report. So it is
      // redacted here by default - unlike `serve`, which prints it once because
      // showing it is the whole point of that line. --show-url opts back in.
      if (url) {
        lines.push(showUrl
          ? `last url    : ${url}`
          : `last url    : ${url.replace(/([?&])t=[0-9a-f]{64}/i, '$1t=<redacted>')}  (--show-url to see it)`);
      }
      if (st.raw) lines.push('', '--- schtasks /Query /FO LIST /V ---', st.raw);
      return lines.join('\n');
    });
    return;
  }

  if (mode === 'uninstall') {
    // installAutostart throws on a non-Windows host after its dry run; the
    // removal has to say the same thing rather than run a schtasks that is not
    // there and report its failure as "the task was not registered".
    if (!dryRun && process.platform !== 'win32') {
      fail(`uninstall-autostart is Windows-only (Task Scheduler); this is ${process.platform}`);
      return;
    }
    const res = uninstallAutostart({ dryRun });
    emit(args.flags.json, res, () => {
      // A dry run promising a removal for a launcher that is not there reads as
      // "it exists" to anyone following the output; say what is actually there.
      const note = (removed, exists) => (removed
        ? ' (removed)'
        : exists
          ? (dryRun ? ' (would be removed)' : ' (still present)')
          : ' (missing)');
      const lines = [
        `uninstall-autostart${dryRun ? ' (DRY RUN - nothing executed)' : ''}`,
        `${dryRun ? 'would run' : 'ran      '} : ${res.schtasks.display}`,
        `launcher  : ${res.launcher}${note(res.launcherRemoved, res.launcherExists)}`,
        `sidecar   : ${res.launcherInfoFile}${note(res.launcherInfoRemoved, res.launcherInfoExists)}`,
        `task xml  : ${res.xmlFile}${note(res.xmlRemoved, res.xmlExists)}`,
      ];
      if (!dryRun) {
        lines.push(`schtasks exit code: ${res.code}`);
        if (res.stdout.trim()) lines.push(res.stdout.trim());
        if (res.stderr.trim()) lines.push(res.stderr.trim());
        if (res.code !== 0) lines.push('(a non-zero code here usually just means the task was not registered)');
      }
      lines.push(
        '',
        'NOTE: this removes the logon task only. A server that is running RIGHT NOW',
        'keeps running - there is no shutdown endpoint by design (the dashboard is',
        'read-only). See the README for how to stop a hidden instance.',
      );
      return lines.join('\n');
    });
    return;
  }

  const port = resolvePort(portFlag(args));
  // The tray is the default; --no-tray puts the old direct wscript -> node
  // command back for anyone who wants one process fewer and no icon.
  const tray = !boolFlag(args, 'no-tray');
  let res;
  try {
    res = installAutostart({ port, dryRun, tray });
  } catch (err) {
    fail(err && err.message ? err.message : String(err));
    return;
  }
  emit(args.flags.json, res, () => {
    const lines = [
      `install-autostart${dryRun ? ' (DRY RUN - nothing written, nothing executed)' : ''}`,
      `task name : ${res.taskName}`,
      `for user  : ${res.user} (the account running this command)`,
      `port      : ${res.port}`,
      `node      : ${res.node}`,
      `cli       : ${res.cli}`,
      `log file  : ${res.logFile}`,
      `tray      : ${res.tray ? 'ON - the logon task starts the tray host, which starts and supervises the server' : 'OFF (--no-tray) - the logon task starts node directly; no icon, no restart'}`,
      ...(res.tray ? [`  script  : ${res.trayScript} ${res.trayScriptExists ? '(present)' : '(MISSING)'}`] : []),
      '',
      `${dryRun ? 'would write' : 'wrote      '}: ${res.launcherInfoFile}`,
      '  a sidecar recording what the launcher points at, so autostart-status can',
      '  tell you if the repo is moved later. wscript cannot report that itself.',
      '',
      `${dryRun ? 'would write' : 'wrote      '}: ${res.launcher}`,
      `  encoding : ${res.vbsEncoding} (${res.vbsBytes} bytes)`,
      `  wscript reads UTF-16LE+BOM reliably; without the BOM the Japanese path`,
      `  segments would be decoded with the ANSI codepage and point nowhere.`,
      '',
      `${dryRun ? 'would write' : 'wrote      '}: ${res.xmlFile}`,
      `  encoding : ${res.xmlEncoding} (${res.xmlBytes} bytes)`,
      `  runs as  : ${res.principalId} ${res.principalIsSid ? '(SID, from `whoami /user`)' : '(NAME - the SID could not be read; the scheduler accepts this too)'}`,
      `  fires for: logon of ${res.userId}, 10s after`,
      '',
      `${dryRun ? 'would run  ' : 'ran        '}: ${res.schtasks.display}`,
      `  argv     : ${JSON.stringify([res.schtasks.file, ...res.schtasks.args])}`,
      '',
      '  Registration goes through /XML, NOT /SC ONLOGON. Measured here,',
      '  non-elevated: `/SC ONLOGON` exits 1 with "アクセスが拒否されました"',
      '  (access denied), because an ONLOGON trigger with no user attached fires',
      '  for EVERY user and creating one is an administrative act. No schtasks',
      '  flag narrows it to one user (/RU sets who it runs AS, not whose logon',
      '  starts it), so only the XML form can express this task - and it needs',
      '  no elevation.',
      '',
      '--- the command the launcher runs ---',
      res.innerCommand,
      '--- end ---',
      '',
      '--- launcher contents ---',
      res.vbs.replace(/\r\n/g, '\n').trimEnd(),
      '--- end ---',
      '',
      '--- task definition (autostart.xml) ---',
      res.xml.replace(/\r\n/g, '\n').trimEnd(),
      '--- end ---',
    ];
    if (!dryRun) {
      lines.push(
        '',
        `launcher written: ${res.launcherWritten}`,
        `schtasks exit code: ${res.code}`,
      );
      if (res.stdout.trim()) lines.push(res.stdout.trim());
      if (res.stderr.trim()) lines.push(res.stderr.trim());
      if (res.ok) {
        lines.push('', 'registered. It starts at your next logon; nothing is running yet.');
        lines.push(res.tray
          ? `start it now with: node "${res.cli}" tray --port ${res.port}`
          : `start it now with: node "${res.cli}" serve --persist-token --port ${res.port}`);
      }
    } else {
      lines.push('', 'nothing was written or executed. Re-run without --dry-run to register.');
    }
    lines.push('', 'What this does and does not survive:');
    if (res.tray) {
      lines.push(
        '  - a CRASHED SERVER IS RESTARTED by the tray host, backing off 5s, 15s then 60s.',
        '    After 5 restarts inside 10 minutes it stops trying, turns the icon red and',
        `    shows a balloon; the reason is in ${res.logFile}.`,
        '  - if the TRAY HOST ITSELF dies, the icon and the server go with it, and',
        '    nothing brings either back until the next logon.',
        '  - Windows 11 hides a NEW notification icon under the "^" overflow. Until you',
        '    pin it there is no icon to see, which looks exactly like a failure:',
        '    Settings > Personalization > Taskbar > Other system tray icons.',
      );
    } else {
      lines.push(
        '  - Task Scheduler does NOT restart a crashed process on a logon trigger.',
        `    If the server exits, it stays down until the next logon - check ${res.logFile}.`,
        '  - there is no icon, so nothing on screen says whether it is running.',
        '    Drop --no-tray to get both.',
      );
    }
    lines.push(
      '  - if you also start one by hand on the same port, the second one exits with a',
      '    clear "port is already in use" error before it reads, rotates or writes',
      '    anything: the token file and url.txt are left exactly as the running server',
      '    left them. Only the log file records the refusal.',
    );
    return lines.join('\n');
  });
}

/* ---------------------------------- tray --------------------------------- */

/** Is anything listening on 127.0.0.1:port? A connect, not a request. */
function probePort(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* already gone */ }
      resolve(ok);
    };
    const sock = net.connect({ host: '127.0.0.1', port });
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The tray host's plan: the exact command, and every path it needs.
 * Shared by `tray` and by its --dry-run, so what is printed is what runs.
 *
 * It goes through the SAME `.vbs` + wscript launcher the logon task uses, and
 * for the same reason the logon task needs one. A tray host started as a plain
 * child of node does not outlive it: `spawn(..., {detached: true})` is
 * DETACHED_PROCESS, which leaves powershell.exe with no console at all and it
 * dies before running a line; and without `detached` it dies as soon as this
 * process does. wscript.exe's `Run(cmd, 0, False)` hands the command to the
 * shell and returns, leaving a host with no parent to lose. Measured both ways;
 * see docs/autostart-verification.md.
 */
function planTray(args) {
  const port = resolvePort(portFlag(args));
  const inner = {
    tray: true,
    trayScript: trayScriptPath(),
    node: process.execPath,
    cli: cliPath(),
    port,
    logFile: defaultLogFilePath(),
    monitorDir: monitorDir(),
  };
  const launcher = path.join(monitorDir(), 'tray-launch.vbs');
  return {
    port,
    launcher,
    vbs: buildLauncherVbs(inner),
    innerCommand: launcherCommand(inner),
    file: 'wscript.exe',
    args: [launcher],
    display: displayCommand([launcher], 'wscript.exe'),
    trayScript: trayScriptPath(),
    trayScriptExists: fs.existsSync(trayScriptPath()),
    trayPidFile: trayPidPath(),
    logFile: defaultLogFilePath(),
    monitorDir: monitorDir(),
  };
}

/**
 * `tray` - start the tray host by hand, registering nothing.
 *
 * The same command install-autostart bakes into the launcher, spawned detached
 * so it outlives this process the way the logon task's would. This is how the
 * arrangement gets tried before anything is written to Task Scheduler.
 */
async function cmdTray(args) {
  const dryRun = boolFlag(args, 'dry-run');
  const noWait = boolFlag(args, 'no-wait');
  const plan = planTray(args);

  if (dryRun) {
    emit(args.flags.json, { ...plan, dryRun: true, spawned: false }, () => [
      'tray (DRY RUN - nothing started)',
      `port        : ${plan.port}`,
      `tray script : ${plan.trayScript} ${plan.trayScriptExists ? '(present)' : '(MISSING)'}`,
      `log file    : ${plan.logFile}`,
      `monitor dir : ${plan.monitorDir}`,
      `tray.pid    : ${plan.trayPidFile}`,
      '',
      `would write : ${plan.launcher} (UTF-16LE with BOM, deleted again once wscript has read it)`,
      `would run   : ${plan.display}`,
      `  argv      : ${JSON.stringify([plan.file, ...plan.args])}`,
      '',
      '--- the command the launcher runs ---',
      plan.innerCommand,
      '--- end ---',
      '',
      'nothing was started. Re-run without --dry-run.',
    ].join('\n'));
    return;
  }

  if (process.platform !== 'win32') {
    fail(`tray is Windows-only (System.Windows.Forms NotifyIcon); this is ${process.platform}`);
    return;
  }
  if (!plan.trayScriptExists) {
    fail(`the tray host script is missing: ${plan.trayScript}`);
    return;
  }

  // The launcher is written, handed to wscript, and removed again. wscript has
  // already executed `sh.Run` by the time it exits, so the file has done its
  // job - and leaving a second .vbs next to autostart.vbs, which
  // `uninstall-autostart` does not know about, would be litter.
  ensureDir(path.dirname(plan.launcher));
  fs.writeFileSync(plan.launcher, toUtf16LeBom(plan.vbs));
  let spawned;
  try {
    // spawnSync: wscript exits as soon as it has fired the command off, so this
    // waits milliseconds, not for the tray host.
    spawned = spawnSync(plan.file, plan.args, { windowsHide: true, shell: false });
  } finally {
    try { fs.rmSync(plan.launcher, { force: true }); } catch { /* best effort */ }
  }
  // spawnSync does not throw when the host cannot be started; it hands back an
  // `error` and a null status. Reporting ok:true on that told the user the tray
  // was running when wscript had never launched.
  if (spawned && spawned.error) {
    fail(`could not start ${plan.file}: ${spawned.error.message ?? spawned.error}`);
  }
  if (!spawned || spawned.status !== 0) {
    const why = decodeConsole(spawned?.stderr).trim() || decodeConsole(spawned?.stdout).trim();
    fail(`${plan.display} exited ${spawned?.status ?? 'without a status'}${why ? `: ${why}` : ''}\n`
      + `  nothing was started. The tray host log, if it got that far, is ${plan.logFile}`);
  }

  let ready = false;
  let info = null;
  if (!noWait) {
    // The host writes tray.pid before it spawns the server, so the file appears
    // well before the port does; both are worth waiting for, and neither is
    // worth failing over - a slow first run is not a broken one.
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      // The cheap check first. A TCP connect costs nothing; trayStatus() spawns
      // a PowerShell to read the process table, and asking it forty times would
      // take longer than the thing being waited for.
      if (await probePort(plan.port)) {
        info = trayStatus();
        if (info.trayAlive) { ready = true; break; }
      }
      await sleep(500);
    }
    // Whatever happened, report the PIDs as they stand rather than as they were.
    info = trayStatus();
  }
  const url = readUrlFile();

  emit(args.flags.json, {
    ok: true,
    dryRun: false,
    spawned: true,
    waited: !noWait,
    ready,
    port: plan.port,
    trayPidFile: plan.trayPidFile,
    trayPid: info ? info.trayPid : null,
    serverPid: info ? info.serverPid : null,
    urlFile: url ? urlFilePath() : null,
    logFile: plan.logFile,
    command: plan.display,
  }, () => {
    const lines = [
      'tray host started (nothing was registered with Task Scheduler)',
      `ran        : ${plan.display}`,
      `port       : ${plan.port}`,
      `tray.pid   : ${plan.trayPidFile}`,
    ];
    if (info && info.trayPid) lines.push(`tray pid   : ${info.trayPid}`, `server pid : ${info.serverPid ?? '(not yet)'}`);
    lines.push(`log        : ${plan.logFile}`);
    if (noWait) {
      lines.push('', 'not waited on (--no-wait): check `autostart-status` in a few seconds.');
    } else if (ready) {
      lines.push('', `the server is answering on 127.0.0.1:${plan.port}.`);
      if (url) lines.push(`open ${urlFilePath()} for the bookmarkable URL (it carries the token - do not share it).`);
    } else {
      lines.push('', `nothing is answering on 127.0.0.1:${plan.port} yet - check ${plan.logFile}.`);
    }
    lines.push(
      '',
      'Windows 11 hides a NEW notification icon under the "^" overflow. To pin it:',
      '  Settings > Personalization > Taskbar > Other system tray icons > claude-monitor',
      '',
      'stop it with: node src/cli.js tray-stop',
    );
    return lines.join('\n');
  });
}

/**
 * `tray-stop` - stop the tray host, and with it the server it supervises.
 *
 * Asks first (a named event the host's poll timer checks, so its cleanup runs)
 * and only kills the tree if that is ignored. Whether anything actually stopped
 * is decided by the PROCESS TABLE, not by the pid file: this command used to
 * delete the file and then read it back, so it reported success no matter what
 * survived. It now exits 1 with the surviving pids, and leaves the pid file
 * where it is so a second run can still find them.
 */
async function cmdTrayStop(args) {
  const dryRun = boolFlag(args, 'dry-run');
  const before = trayStatus();
  const port = before.port ?? resolvePort(portFlag(args));

  if (dryRun) {
    emit(args.flags.json, { ...before, dryRun: true, port, stopped: false }, () => [
      'tray-stop (DRY RUN - nothing signalled, nothing killed)',
      `tray.pid   : ${before.file} ${before.exists ? '(present)' : '(missing)'}`,
      `tray pid   : ${before.trayPid ?? '(unknown)'} ${before.trayPid ? (before.trayAlive ? '(alive)' : '(gone)') : ''}`.trimEnd(),
      `server pid : ${before.serverPid ?? '(unknown)'} ${before.serverPid ? (before.serverAlive ? '(alive)' : '(gone)') : ''}`.trimEnd(),
      `port       : ${port}`,
      '',
      'would ask the host to exit through its named stop event, wait for both',
      'PIDs to go, and only then fall back to `taskkill /PID <tray> /T /F`.',
    ].join('\n'));
    return;
  }

  // Same order as `tray` and `install-autostart`: the dry run works anywhere,
  // the real thing needs the OS whose stop event and taskkill it uses.
  if (process.platform !== 'win32') {
    fail(`tray-stop is Windows-only (a named Win32 event and taskkill); this is ${process.platform}`);
    return;
  }

  if (!before.trayPid) {
    // Still worth asking. A tray whose pid file was lost - deleted by hand, or
    // by an older build's mutex loser - is invisible here but still holds its
    // named stop event, and signalling costs one short PowerShell call.
    const signalledBlind = signalTrayStop(port);
    // A pid file that named nothing useful is a leftover; take it with us.
    let removed = false;
    if (before.exists) {
      try { fs.rmSync(before.file, { force: true }); removed = true; } catch { /* best effort */ }
    }
    emit(args.flags.json, {
      ...before, dryRun: false, port, stopped: signalledBlind,
      signalled: signalledBlind, killed: false, pidFileRemoved: removed,
    }, () => [
      `no tray host recorded at ${before.file}`,
      before.exists
        ? `(the file named no usable tray PID - removed as a leftover${removed ? '' : ', but it could not be deleted'})`
        : '(nothing recorded)',
      signalledBlind
        ? `asked      : yes - a tray host WAS listening on port ${port} and has been told to exit`
        : `asked      : no tray host was listening for the stop event on port ${port}`,
    ].join('\n'));
    return;
  }

  // A pid file naming a RECYCLED pid must not be acted on at all. Killing is
  // out of the question, and the stop event belongs to whoever holds the port
  // now, so leave it alone; the file is the only thing here that is ours.
  if (before.trayPid && !before.trayAlive && /reused/.test(before.trayReason ?? '')) {
    let removed = false;
    try { fs.rmSync(before.file, { force: true }); removed = true; } catch { /* best effort */ }
    emit(args.flags.json, {
      ...before, dryRun: false, port, stopped: false, signalled: false, killed: false, pidFileRemoved: removed,
    }, () => [
      `tray pid   : ${before.trayPid} - ${before.trayReason}`,
      'NOTHING was signalled and NOTHING was killed: that pid belongs to another',
      'process now, and this file is only a stale record of one that is gone.',
      `tray.pid   : ${removed ? 'removed as a leftover' : `${before.file} (could not be removed)`}`,
    ].join('\n'));
    return;
  }

  // Signal, wait, kill, and re-read the process table - never the pid file,
  // which this sequence is the thing that deletes. See stopTrayProcesses.
  const res = await stopTrayProcesses(before, { port });

  emit(args.flags.json, {
    ok: res.ok,
    dryRun: false,
    port,
    signalled: res.signalled,
    killed: res.killed,
    refusals: res.refusals,
    stopped: res.ok,
    trayPid: before.trayPid,
    serverPid: before.serverPid,
    trayAlive: res.trayAlive,
    serverAlive: res.serverAlive,
    pidFile: before.file,
    pidFileRemoved: res.pidFileRemoved,
  }, () => [
    `tray pid   : ${before.trayPid} ${res.trayAlive ? '(STILL ALIVE)' : '(gone)'}`,
    `server pid : ${before.serverPid ?? '(unknown)'} ${res.serverAlive ? '(STILL ALIVE)' : '(gone)'}`,
    `asked      : ${res.signalled ? 'yes (stop event was there)' : 'no (no tray host was listening for it)'}`,
    `killed     : ${res.killed ? 'yes (taskkill /T /F - it did not go quietly)' : 'no'}`,
    ...res.refusals.map((r) => `refused    : ${r}`),
    `tray.pid   : ${res.pidFileRemoved ? 'removed' : `${before.file} ${fs.existsSync(before.file) ? '(STILL PRESENT)' : '(gone)'}`}`,
    ...(res.ok ? [] : [
      '',
      'NOT STOPPED. The pid file is deliberately left alone so a second run can',
      'still find these processes; deleting it would hide a tray that is holding',
      `the port. Try again, or stop them by hand: taskkill /PID <pid> /T /F`,
    ]),
  ].join('\n'));

  // The exit code is the only part of this a script can act on.
  if (!res.ok) process.exitCode = 1;
}

function cmdStats(args) {
  const session = resolveSession(args._[1]);
  const files = sessionFiles(session);
  const stats = new ParseStats({ maxSamples: 5 });
  for (const f of files) parseFile(f, () => {}, stats);
  const j = stats.toJSON();
  emit(args.flags.json, { session: session.sessionId, files, stats: j }, () =>
    [
      `session ${session.sessionId}`,
      `files ${j.files}, skipped ${j.skippedFiles}, lines ${n(j.totalLines)}, parsed ${n(j.parsed)}, blank ${j.blankLines}, parse failures ${j.parseFailures}`,
      j.skippedFiles ? `skipped files:\n${j.skippedFileSamples.map((s) => `  ${s.file}: ${s.error}`).join('\n')}` : '',
      '',
      'record types:',
      ...Object.entries(j.typeCounts).map(([k, v]) => `  ${k.padEnd(28)} ${String(v).padStart(7)}`),
      '',
      'content blocks:',
      ...Object.entries(j.blockCounts).map(([k, v]) => `  ${k.padEnd(28)} ${String(v).padStart(7)}`),
      '',
      Object.keys(j.unknownTypes).length
        ? `UNKNOWN types (not in the parser's known list - the format may have changed):\n${Object.entries(j.unknownTypes).map(([k, v]) => `  ${k} ${v}`).join('\n')}`
        : 'unknown types: none',
      j.failureSamples.length
        ? `\nparse failure samples:\n${j.failureSamples.map((s) => `  line ${s.lineNo}: ${s.error}\n    ${s.snippet}`).join('\n')}`
        : '',
    ].join('\n'));
}

function cmdInstall(args, mode) {
  const dryRun = boolFlag(args, 'dry-run');
  const forceStatusLine = boolFlag(args, 'force-statusline');
  let res;
  try {
    res = applySettings(mode, { dryRun, forceStatusLine });
  } catch (err) {
    if (err instanceof CorruptSettingsError || err instanceof UnsafeCommandPathError) {
      // Never silently rewrite a settings file we could not read, and never
      // write a command line that would not run what it reads like.
      const error = err instanceof CorruptSettingsError ? 'corrupt-settings' : 'unsafe-command-path';
      if (args.flags.json) {
        process.stdout.write(`${JSON.stringify({ ok: false, error, file: err.file ?? null, backupFile: err.backupFile ?? null, path: err.path ?? null, message: err.message }, null, 2)}\n`);
      } else {
        process.stderr.write(`error: ${err.message}\n`);
      }
      process.exit(1);
    }
    throw err;
  }
  emit(args.flags.json, res, () => {
    const lines = [
      `${mode}${dryRun ? ' (DRY RUN - nothing written)' : ''}`,
      `settings: ${res.file} ${res.existed ? '(exists)' : '(missing -> would be created)'}`,
    ];
    if (mode === 'install') {
      lines.push(`hook command: ${hookCommand()}`);
      lines.push(`statusLine  : ${statuslineCommand()} (${res.statusLine})`);
      lines.push(`indent      : ${res.indent === '\t' ? 'tab (kept from the existing file)' : `${res.indent} spaces`}`);
      lines.push(`events added: ${res.added.join(', ') || '(none)'}`);
      lines.push(`events updated: ${res.replaced.join(', ') || '(none)'}`);
      lines.push(`already present: ${res.skipped.join(', ') || '(none)'}`);
      if (res.replaced.length) {
        lines.push(
          '  (an entry naming our script but running a different node - an older',
          '   install, or a node that has since been replaced - was rewritten in',
          '   place rather than added a second time.)',
        );
      }
      if (res.statusLine === 'kept-foreign') {
        lines.push(
          '',
          `statusLine NOT registered: ${res.file} already has one, and it is not ours:`,
          `  ${res.statusLineExisting}`,
          '  The hooks above are unaffected - only rate limits and context% need the',
          '  statusLine. Re-run with --force-statusline to take it over; the current',
          '  value is saved and uninstall-hooks puts it back.',
        );
      } else if (res.statusLine === 'replaced') {
        lines.push('', `the previous statusLine was saved and will be restored by uninstall-hooks:\n  ${res.statusLineExisting}`);
      }
    } else {
      lines.push(`hooks removed from: ${res.removed.join(', ') || '(none)'}`);
      lines.push(`statusLine: ${res.statusLine}${res.statusLine === 'restored' ? ' (the one --force-statusline replaced is back)' : ''}`);
    }
    if (res.unchanged) lines.push('no change needed');
    if (res.backupFile) lines.push(`backup: ${res.backupFile}`);
    if (dryRun) lines.push('', '--- resulting settings.json ---', res.json.trimEnd());
    return lines.join('\n');
  });
}

/** Call something that may refuse, and report the refusal as the value. */
function safely(fn) {
  try {
    return fn();
  } catch (err) {
    return `(unavailable: ${err && err.message ? err.message.split('\n')[0] : err})`;
  }
}

function cmdPaths(args) {
  const info = {
    claudeHome: claudeHome(),
    projectsDir: projectsDir(),
    sessionsDir: path.join(claudeHome(), 'sessions'),
    settingsPath: settingsPath(),
    monitorDir: monitorDir(),
    eventsDir: path.join(monitorDir(), 'events'),
    statuslineDir: path.join(monitorDir(), 'statusline'),
    projectRoot: PROJECT_ROOT,
    // `paths` is the command someone runs when something is wrong, so a path
    // we would refuse to build a command out of has to be reportable rather
    // than fatal here.
    hookScript: safely(hookCommand),
    statuslineScript: safely(statuslineCommand),
    tokenFile: tokenFilePath(),
    urlFile: urlFilePath(),
    serveLog: defaultLogFilePath(),
    autostartLauncher: launcherPath(),
    autostartTask: TASK_NAME,
    trayScript: trayScriptPath(),
    trayPidFile: trayPidPath(),
    projectDirs: listProjectDirs().length,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    servePort: resolvePort(undefined),
    servePortDefault: DEFAULT_PORT,
  };
  emit(args.flags.json, info, () => Object.entries(info).map(([k, v]) => `${k.padEnd(18)} ${v}`).join('\n'));
}

/* --------------------------------- main --------------------------------- */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Before anything else, and before --help: a typo the parser could not place
  // is the whole reason this check exists, and it must not be silently ignored
  // by a command that happens to run anyway.
  if (args.errors.length) {
    for (const e of args.errors) process.stderr.write(`error: ${e}\n`);
    process.stderr.write(`\n${USAGE}`);
    process.exit(2);
  }
  const cmd = args._[0];
  if (!cmd || args.flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  switch (cmd) {
    case 'sessions': return cmdSessions(args);
    case 'list': return cmdList(args);
    case 'tree': return cmdTree(args);
    case 'usage':
      return args.flags.daily || !args._[1] ? cmdUsageDaily(args) : cmdUsageSession(args);
    case 'tools': return cmdTools(args);
    case 'events': return cmdEvents(args);
    case 'serve': return cmdServe(args);
    case 'statusline': return cmdStatusline(args);
    case 'stats': return cmdStats(args);
    case 'rotate-token': return cmdRotateToken(args);
    case 'install-hooks': return cmdInstall(args, 'install');
    case 'uninstall-hooks': return cmdInstall(args, 'uninstall');
    case 'install-autostart': return cmdAutostart(args, 'install');
    case 'uninstall-autostart': return cmdAutostart(args, 'uninstall');
    case 'autostart-status': return cmdAutostart(args, 'status');
    case 'tray': return cmdTray(args);
    case 'tray-stop': return cmdTrayStop(args);
    case 'paths': return cmdPaths(args);
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${USAGE}`);
      process.exit(1);
  }
}

/**
 * Run only when this file IS the program.
 *
 * The argument helpers above are worth unit-testing (a `--log-file` at the end
 * of the line and a `--log-file=` with nothing after it are exactly the shapes
 * that decide whether a hidden instance gets a log at all), and importing the
 * module to reach them must not start a server as a side effect.
 */
const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exit(1);
  });
}
