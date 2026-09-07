/**
 * Start the dashboard at Windows logon, with no window.
 *
 * Two problems have to be solved together:
 *
 * 1. A console program launched by Task Scheduler gets a console. `node.exe`
 *    is a console subsystem binary, so an ONLOGON task pointing straight at it
 *    flashes - or parks - a black window on every logon. The fix is a tiny
 *    `.vbs` launcher run by `wscript.exe` (a GUI subsystem host, so no console
 *    of its own) which calls `WScript.Shell.Run cmd, 0, False`: window style 0
 *    is hidden, and False means "do not wait", so wscript exits immediately and
 *    the task is reported complete while node keeps running.
 *
 * 2. The token. Per-process randomness is unreachable when nobody sees the
 *    console, so the launcher passes `--persist-token` and the URL is written
 *    to `<monitorDir>/url.txt`. The two go together: `serve` writes url.txt
 *    ONLY when the token is persisted, because a per-process token dies with
 *    the process and its URL would be a file that looks like a way in and is
 *    not one. See src/token-store.js for that trade.
 *
 * The launcher is written as UTF-16 LE **with a BOM**. This matters: the paths
 * here contain Japanese (`D:\develop\Claude監視`), and wscript decodes a
 * BOM-less file with the system ANSI codepage, which mangles them into a path
 * that does not exist. With the BOM, wscript reads Unicode reliably.
 *
 * 3. Being invisible. A server nobody can see is a server nobody can tell is
 *    running, and Task Scheduler will not restart it if it dies (an ONLOGON
 *    trigger fires on logon and never again). So the launcher does not start
 *    node directly any more: it starts the TRAY HOST, `tray/claude-monitor-tray.ps1`,
 *    which puts an icon in the notification area and spawns and supervises the
 *    server itself. The process tree is
 *
 *      wscript.exe (autostart.vbs)
 *        -> powershell.exe -STA -WindowStyle Hidden (the tray host)
 *             -> node.exe src/cli.js serve ...
 *
 *    `--no-tray` puts the old, direct `wscript -> node` command back; the tray
 *    is a supervisor, not a requirement.
 *
 * Safety, mirroring installer.js:
 *  - `--dry-run` prints the exact argv that would be executed and the exact
 *    bytes that would be written, and touches nothing.
 *  - Nothing is registered without the user asking for it.
 *  - Uninstall removes only our task name.
 *  - `status` is read-only.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { monitorDir, ensureDir } from './paths.js';
import { defaultLogFilePath } from './token-store.js';
import { DEFAULT_PORT } from './server.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(HERE, '..');

/** The one task name we ever create, query or delete. */
export const TASK_NAME = 'claude-monitor';

/** @returns {string} absolute path of the CLI entry point */
export function cliPath(root = PROJECT_ROOT) {
  return path.join(root, 'src', 'cli.js');
}

/** @returns {string} absolute path of the tray host script */
export function trayScriptPath(root = PROJECT_ROOT) {
  return path.join(root, 'tray', 'claude-monitor-tray.ps1');
}

/** @returns {string} `<monitorDir>/autostart.vbs` */
export function launcherPath() {
  return path.join(monitorDir(), 'autostart.vbs');
}

/** @returns {string} `<monitorDir>/tray.pid` - written by the tray host */
export function trayPidPath() {
  return path.join(monitorDir(), 'tray.pid');
}

/** @returns {string} `<monitorDir>/autostart.json` - the launcher's sidecar */
export function launcherInfoPath() {
  return path.join(monitorDir(), 'autostart.json');
}

/** @returns {string} `<monitorDir>/autostart.xml` - the task definition */
export function taskXmlPath() {
  return path.join(monitorDir(), 'autostart.xml');
}

/**
 * Reject a path that could break out of the command line it is about to be
 * pasted into.
 *
 * Windows paths cannot contain `"`, CR, LF or NUL, so a value that does is not
 * a path - it is a corrupted setting or an injection attempt, and either way we
 * refuse to build a command out of it. Shared by the VBS string literal and the
 * schtasks `/TR` value: both are places where an unescaped quote would change
 * what actually runs at logon, silently and once per logon forever.
 * @param {string} p
 * @returns {string} the path, unchanged
 */
function assertQuotablePath(p) {
  const s = String(p);
  if (s.includes('"')) throw new Error(`refusing to build a launcher for a path containing a quote: ${s}`);
  if (s.includes('\r') || s.includes('\n') || s.includes('\0')) {
    throw new Error(`refusing to build a launcher for a path containing a newline: ${s}`);
  }
  return s;
}

/**
 * A path that can be embedded in a VBS double-quoted string literal.
 * @param {string} p
 */
export function vbsQuote(p) {
  return `""${assertQuotablePath(p)}""`;
}

/**
 * A path fit to sit after a PowerShell parameter name.
 *
 * `powershell.exe -File x.ps1 -Cli "C:\dir\"` does not do what it reads like:
 * the backslash escapes the closing quote and everything after it joins the
 * value. Real values here never end in a separator (path.join does not leave
 * one), but a hand-passed `--monitor-dir C:\tmp\` would, and the failure would
 * be a tray host started with a garbled command line at every logon.
 * @param {string} p
 */
function noTrailingSep(p) {
  const s = assertQuotablePath(p);
  // Leave a bare drive root (`D:\`) alone: stripping it changes the meaning.
  return /^[A-Za-z]:\\$/.test(s) ? s : s.replace(/[\\/]+$/, '');
}

/**
 * The tray host's argv, as a real argument array (no quoting): what
 * `spawn('powershell.exe', ...)` wants, and the source the VBS rendering is
 * derived from so the two can never drift apart.
 * @param {{trayScript: string, node: string, cli: string, port: number, logFile: string, monitorDir: string}} opts
 */
export function trayHostArgv(opts) {
  return [
    // -STA: NotifyIcon needs a single-threaded apartment and a message loop.
    // -WindowStyle Hidden: powershell.exe is a console binary too, and this is
    // the flag that was verified to keep its window off the screen while the
    // notification icon still appears.
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy', 'Bypass',
    '-STA',
    '-WindowStyle', 'Hidden',
    '-File', noTrailingSep(opts.trayScript),
    '-Port', String(opts.port),
    '-Node', noTrailingSep(opts.node),
    '-Cli', noTrailingSep(opts.cli),
    '-LogFile', noTrailingSep(opts.logFile),
    '-MonitorDir', noTrailingSep(opts.monitorDir),
  ];
}

/**
 * One argv element inside a VBS double-quoted string literal. Flags, `Bypass`
 * and the port number carry nothing a shell could misread, so they stay bare;
 * anything else is a path and is quoted. Note `\w` is ASCII-only in JS, so the
 * Japanese path segments fall to the quoted branch, which is where they belong.
 * @param {string} a
 */
function vbsArg(a) {
  return /^[-\w.]+$/.test(a) ? a : vbsQuote(a);
}

/**
 * The command the launcher hands to the shell, fully quoted.
 *
 * Default: the tray host, which spawns the server itself. `tray: false` is the
 * old direct command - one process less, no icon, and no restart after a crash.
 *
 * @param {{node: string, cli: string, port: number, logFile: string,
 *          tray?: boolean, trayScript?: string, monitorDir?: string}} opts
 */
export function launcherCommand(opts) {
  if (opts.tray !== false) {
    const argv = trayHostArgv({
      trayScript: opts.trayScript ?? trayScriptPath(),
      node: opts.node,
      cli: opts.cli,
      port: opts.port,
      logFile: opts.logFile,
      monitorDir: opts.monitorDir ?? monitorDir(),
    });
    return ['powershell.exe', ...argv.map(vbsArg)].join(' ');
  }
  const parts = [
    vbsQuote(opts.node),
    vbsQuote(opts.cli),
    'serve',
    '--persist-token',
    '--port',
    String(opts.port),
    '--log-file',
    vbsQuote(opts.logFile),
  ];
  // Note: `serve` does NOT open a browser unless --open is passed, so there is
  // no flag to suppress here - the default is already what a hidden instance
  // needs.
  return parts.join(' ');
}

/**
 * The `.vbs` source. CRLF throughout: this is a Windows Script Host file.
 * @param {{node: string, cli: string, port: number, logFile: string,
 *          tray?: boolean, trayScript?: string, monitorDir?: string}} opts
 */
export function buildLauncherVbs(opts) {
  const lines = [
    "' claude-monitor - autostart launcher.",
    "' Generated by `node src/cli.js install-autostart`. Safe to delete;",
    "' `uninstall-autostart` removes it along with the scheduled task.",
    "'",
    "' Run(cmd, 0, False): 0 = hidden window, False = do not wait. wscript.exe",
    "' is a GUI-subsystem host, so nothing flashes on screen at logon.",
    'Option Explicit',
    'Dim sh, cmd',
    'Set sh = CreateObject("WScript.Shell")',
    `cmd = "${launcherCommand(opts)}"`,
    'sh.Run cmd, 0, False',
    '',
  ];
  return lines.join('\r\n');
}

/**
 * UTF-16 LE with a byte order mark - the encoding wscript reads without
 * guessing. Without the BOM the Japanese path segments are decoded with the
 * ANSI codepage and the launcher points at a directory that does not exist.
 * @param {string} text
 * @returns {Buffer}
 */
export function toUtf16LeBom(text) {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(String(text), 'utf16le')]);
}

/**
 * The `<Arguments>` value for the task's Exec action: the launcher path,
 * quoted.
 *
 * REAL quotes, not escaped ones, and not XML-escaped here either - escapeXml()
 * does that on the way into the document, and Task Scheduler hands the decoded
 * string to CreateProcess. Quoted unconditionally: inside an XML element there
 * is no shell to confuse, and a path that gains a space later should not change
 * whether the registered task still works.
 *
 * The same refusal as vbsQuote applies: a `"` in the path would close our quote
 * and turn the rest of it into further arguments, and a CR or LF would split
 * the value. Neither is a real Windows path.
 * @param {string} launcher
 */
export function taskArguments(launcher) {
  return `"${assertQuotablePath(launcher)}"`;
}

/** `DOMAIN\user`, or just the username when there is no domain to name. */
export function userAccount() {
  const domain = process.env.USERDOMAIN;
  let name = process.env.USERNAME;
  if (!name) {
    try {
      name = os.userInfo().username;
    } catch {
      name = null;
    }
  }
  if (!name) return null;
  return domain ? `${domain}\\${name}` : name;
}

/**
 * The current user's SID, for the task's Principal.
 *
 * A SID rather than a name because it is the thing that cannot be ambiguous -
 * a renamed account, or a local name that collides with a domain one, still
 * resolves. The scheduler accepts `DOMAIN\user` here too, so a failure to read
 * the SID is a fallback rather than an error; installAutostart reports which
 * one it used.
 *
 * `whoami /user /fo csv /nh` prints one line: `"domain\user","S-1-5-..."`.
 *
 * The ABSOLUTE System32 path, not the bare name. `whoami` is one of the
 * commands Git for Windows also ships (MSYS coreutils), and when this runs from
 * a shell whose PATH puts Git's `usr/bin` first, the bare name finds that one -
 * which does not understand `/user` and exits 1 with
 * `whoami: extra operand '/user'`. Observed here; the effect was a silent
 * fallback to the account name, which works but is not what was asked for.
 * @param {{run?: Function}} [opts]
 * @returns {string|null}
 */
export function whoamiPath() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  const abs = path.join(root, 'System32', 'whoami.exe');
  return fileSafe(abs) ? abs : 'whoami.exe';
}

export function currentUserSid(opts = {}) {
  const runner = typeof opts.run === 'function' ? opts.run : defaultRunner;
  try {
    const r = runner(whoamiPath(), ['/user', '/fo', 'csv', '/nh']);
    const line = toText(r.stdout).trim().split(/\r?\n/).pop() ?? '';
    const m = /"([^"]*)"\s*,\s*"(S-1-[0-9-]+)"/.exec(line);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}

/** Text that is safe between XML tags (and inside an attribute). */
export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The task definition, as Task Scheduler XML.
 *
 * WHY XML AND NOT `/SC ONLOGON`. Measured on this machine, non-elevated:
 *
 *   schtasks /Create /TN X /TR "cmd.exe /c exit" /SC ONLOGON /RL LIMITED /F
 *   -> exit 1, "エラー: アクセスが拒否されました。"
 *
 * `/SC ONLOGON` with no user attached registers a trigger that fires for
 * EVERY user's logon, and creating one of those is an administrative act. There
 * is no schtasks command-line flag that narrows an ONLOGON trigger to a single
 * user (`/RU` sets the account the task RUNS as, not the account whose logon
 * fires it), so the command-line form cannot express the task we actually want.
 * The XML form can: a LogonTrigger with a <UserId> is per-user, and registering
 * it needs no elevation. The same command with /XML returned 0.
 *
 * Element order follows the schema sequence (RegistrationInfo, Triggers,
 * Principals, Settings, Actions; and within a LogonTrigger, Enabled then UserId
 * then Delay). Task Scheduler rejects a document that is out of order.
 *
 * Two settings are load-bearing:
 *  - ExecutionTimeLimit PT0S = no limit. The DEFAULT IS 72 HOURS, after which
 *    the scheduler stops the task - which for us means killing the tray host,
 *    and with it the server, three days into every session. A supervisor that
 *    is itself killed on a timer is worse than none.
 *  - MultipleInstancesPolicy IgnoreNew, so a second trigger cannot start a
 *    second host. The named mutex in the .ps1 already refuses, but the two
 *    guards cost nothing and fail in different ways.
 *
 * The <Delay>PT10S</Delay> gives the shell time to create the notification area
 * before the icon is added to it; an icon added to a taskbar that does not
 * exist yet is silently dropped.
 *
 * @param {{launcher: string, userId?: string, principalId?: string, taskName?: string}} opts
 */
export function buildTaskXml(opts) {
  const account = opts.userId ?? userAccount() ?? '';
  const principal = opts.principalId || account;
  const lines = [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    `    <Description>${escapeXml('claude-monitor tray host (installed by `node src/cli.js install-autostart`)')}</Description>`,
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <LogonTrigger>',
    '      <Enabled>true</Enabled>',
    // Per-user. This one element is the difference between a task that
    // registers without elevation and one that does not.
    `      <UserId>${escapeXml(account)}</UserId>`,
    '      <Delay>PT10S</Delay>',
    '    </LogonTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${escapeXml(principal)}</UserId>`,
    '      <LogonType>InteractiveToken</LogonType>',
    // LeastPrivilege = the user's normal token. This must never ask for
    // elevation: an admin prompt at logon that nobody can see is a hang.
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    '      <Command>wscript.exe</Command>',
    `      <Arguments>${escapeXml(taskArguments(opts.launcher))}</Arguments>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ];
  return lines.join('\r\n');
}

/**
 * argv for `schtasks` (no shell involved - the array form does the quoting).
 * @param {{taskName?: string, xmlFile: string}} opts
 */
export function createTaskArgs(opts) {
  return [
    '/Create',
    '/TN', opts.taskName ?? TASK_NAME,
    '/XML', assertQuotablePath(opts.xmlFile),
    '/F',
  ];
}

/** @param {{taskName?: string}} [opts] */
export function deleteTaskArgs(opts = {}) {
  return ['/Delete', '/TN', opts.taskName ?? TASK_NAME, '/F'];
}

/** @param {{taskName?: string}} [opts] */
export function queryTaskArgs(opts = {}) {
  return ['/Query', '/TN', opts.taskName ?? TASK_NAME, '/XML', 'ONE'];
}

/** @param {{taskName?: string}} [opts] */
export function queryTaskVerboseArgs(opts = {}) {
  return ['/Query', '/TN', opts.taskName ?? TASK_NAME, '/FO', 'LIST', '/V'];
}

/**
 * A copy-pasteable rendering of an argv, for the dry-run report and the docs.
 * For DISPLAY only - the real call passes the array, so nothing we print here
 * is ever parsed by us.
 *
 * Inner quotes are rendered CRT-style (backslash-quote) because that is what a human
 * pasting the line into cmd.exe needs; the argv path produces the same bytes on
 * the far side without anyone having to type them.
 * @param {string[]} args
 */
export function displayCommand(args, file = 'schtasks') {
  const quoted = args.map((a) => {
    if (!/[\s"]/.test(a)) return a;
    return `"${a.replace(/"/g, '\\"')}"`;
  });
  return [file, ...quoted].join(' ');
}

/**
 * Everything install-autostart would do, computed without touching disk.
 *
 * @param {Object} [opts]
 * @param {number} [opts.port]
 * @param {string} [opts.node]      absolute node.exe (defaults to this process')
 * @param {string} [opts.root]      project root
 * @param {string} [opts.launcher]  where to write the .vbs
 * @param {string} [opts.logFile]
 * @param {string} [opts.taskName]
 * @param {boolean} [opts.tray]     false = the old direct `wscript -> node` command
 * @param {string} [opts.trayScript]
 * @param {string} [opts.monitorDir]
 */
export function planAutostart(opts = {}) {
  const port = Number.isInteger(opts.port) ? opts.port : DEFAULT_PORT;
  const node = opts.node ?? process.execPath;
  const root = opts.root ?? PROJECT_ROOT;
  const cli = cliPath(root);
  const launcher = opts.launcher ?? launcherPath();
  const logFile = opts.logFile ?? defaultLogFilePath();
  const taskName = opts.taskName ?? TASK_NAME;
  const tray = opts.tray !== false;
  const trayScript = opts.trayScript ?? trayScriptPath(root);
  const dir = opts.monitorDir ?? monitorDir();

  const inner = { node, cli, port, logFile, tray, trayScript, monitorDir: dir };
  const vbs = buildLauncherVbs(inner);
  const bytes = toUtf16LeBom(vbs);
  // Beside the LAUNCHER, not beside monitorDir(). They are one set of files -
  // the .vbs, the .xml that registers it and the .json that describes it - and
  // redirecting the launcher (which is how tests stay out of the real profile
  // directory) has to take all three with it. Defaulting these to monitorDir()
  // would have `installAutostart({launcher: <tmp>})` write into the user's real
  // ~/.claude-monitor, which is exactly what the tests must never do.
  const beside = (name) => path.join(path.dirname(launcher), name);
  const xmlFile = opts.xmlFile ?? beside('autostart.xml');
  const account = opts.userId ?? userAccount();
  // The SID is looked up once, here, so the dry-run shows exactly what a real
  // install would write - including the fallback when whoami is unavailable.
  //
  // `sidRun`, NOT `run`: `run` is the schtasks stand-in tests inject, and
  // borrowing it here would both feed whoami output to a schtasks fake and add
  // a call to the list those tests count. Two different programs, two hooks.
  const sid = opts.principalId !== undefined
    ? opts.principalId
    : currentUserSid({ run: opts.sidRun });
  const principal = sid || account;
  const xml = buildTaskXml({ launcher, userId: account, principalId: principal, taskName });
  const args = createTaskArgs({ taskName, xmlFile });

  return {
    taskName,
    port,
    node,
    cli,
    launcher,
    launcherInfoFile: opts.launcherInfo ?? beside('autostart.json'),
    xmlFile,
    xml,
    xmlBytes: toUtf16LeBom(xml).length,
    xmlEncoding: 'UTF-16LE with BOM',
    userId: account,
    principalId: principal,
    principalIsSid: Boolean(sid),
    logFile,
    tray,
    trayScript,
    trayScriptExists: fileSafe(trayScript),
    monitorDir: dir,
    trayPidFile: path.join(dir, 'tray.pid'),
    user: safeUser(),
    platform: process.platform,
    vbs,
    vbsBytes: bytes.length,
    vbsEncoding: 'UTF-16LE with BOM',
    innerCommand: launcherCommand(inner),
    schtasks: { file: 'schtasks', args, display: displayCommand(args) },
  };
}

/**
 * Write the launcher and register the task.
 * @param {Object} [opts] same as planAutostart, plus `dryRun`
 */
export function installAutostart(opts = {}) {
  const plan = planAutostart(opts);
  const dryRun = opts.dryRun === true;
  const info = buildLauncherInfo(plan);
  const result = {
    ...plan,
    dryRun,
    launcherInfo: info,
    launcherInfoFile: opts.launcherInfo ?? plan.launcherInfoFile,
    launcherWritten: false,
    launcherInfoWritten: false,
    xmlWritten: false,
    schtasksRun: false,
    code: null,
    stdout: '',
    stderr: '',
  };
  if (dryRun) return result;
  if (process.platform !== 'win32') {
    throw new Error(`install-autostart is Windows-only (Task Scheduler); this is ${process.platform}`);
  }
  ensureDir(path.dirname(plan.launcher));
  fs.writeFileSync(plan.launcher, toUtf16LeBom(plan.vbs));
  result.launcherWritten = true;
  // UTF-16LE with a BOM, matching the `encoding="UTF-16"` in the declaration.
  // The repo path contains Japanese and schtasks reads this file itself; the
  // same reasoning as the .vbs, one layer up.
  ensureDir(path.dirname(plan.xmlFile));
  fs.writeFileSync(plan.xmlFile, toUtf16LeBom(plan.xml));
  result.xmlWritten = true;
  // Best effort: the sidecar only powers a diagnostic, so failing to write it
  // must not stop the install that is otherwise fine.
  try {
    ensureDir(path.dirname(result.launcherInfoFile));
    fs.writeFileSync(result.launcherInfoFile, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
    result.launcherInfoWritten = true;
  } catch (err) {
    result.launcherInfoError = String(err && err.message ? err.message : err);
  }

  const run = runSchtasks(plan.schtasks.args, opts);
  result.schtasksRun = true;
  result.code = run.code;
  result.stdout = run.stdout;
  result.stderr = run.stderr;
  result.ok = run.code === 0;
  return result;
}

/**
 * Delete the task and the launcher. Does NOT stop a server that is already
 * running - see the README; there is no shutdown endpoint by design.
 * @param {{dryRun?: boolean, taskName?: string, launcher?: string, run?: Function}} [opts]
 */
export function uninstallAutostart(opts = {}) {
  const taskName = opts.taskName ?? TASK_NAME;
  const launcher = opts.launcher ?? launcherPath();
  const launcherInfoFile = opts.launcherInfo ?? launcherInfoPath();
  const xmlFile = opts.xmlFile ?? taskXmlPath();
  const args = deleteTaskArgs({ taskName });
  const dryRun = opts.dryRun === true;
  const result = {
    taskName,
    launcher,
    launcherInfoFile,
    launcherInfoExists: fileSafe(launcherInfoFile),
    launcherInfoRemoved: false,
    xmlFile,
    xmlExists: fileSafe(xmlFile),
    xmlRemoved: false,
    dryRun,
    // Whether the launcher is there BEFORE anything is deleted, so a dry run can
    // report what would really happen instead of promising a removal.
    launcherExists: fileSafe(launcher),
    launcherRemoved: false,
    schtasksRun: false,
    code: null,
    stdout: '',
    stderr: '',
    schtasks: { file: 'schtasks', args, display: displayCommand(args) },
  };
  if (dryRun) return result;

  const run = runSchtasks(args, opts);
  result.schtasksRun = true;
  result.code = run.code;
  result.stdout = run.stdout;
  result.stderr = run.stderr;
  // Exit 1 here usually means "there was no such task", which is a fine
  // outcome for an uninstall.
  result.ok = run.code === 0;
  try {
    if (fs.existsSync(launcher)) {
      fs.rmSync(launcher, { force: true });
      result.launcherRemoved = true;
    }
  } catch (err) {
    result.launcherError = String(err && err.message ? err.message : err);
  }
  // The sidecar goes with the launcher it describes. Leaving it would make
  // `autostart-status` report on a launcher that is not there any more.
  try {
    if (fs.existsSync(launcherInfoFile)) {
      fs.rmSync(launcherInfoFile, { force: true });
      result.launcherInfoRemoved = true;
    }
  } catch (err) {
    result.launcherInfoError = String(err && err.message ? err.message : err);
  }
  // The task definition is kept after registration so `autostart-status` can
  // show what was registered; it goes when the task does.
  try {
    if (fs.existsSync(xmlFile)) {
      fs.rmSync(xmlFile, { force: true });
      result.xmlRemoved = true;
    }
  } catch (err) {
    result.xmlError = String(err && err.message ? err.message : err);
  }
  return result;
}

/* ---------------------------- launcher sidecar ---------------------------- */

/**
 * What the launcher points at, recorded next to it at install time.
 *
 * The failure this exists to catch: the repo gets moved or renamed, and the
 * logon task now runs a launcher naming paths that are not there. NOTHING
 * reports that today - the .vbs runs, `sh.Run` fires off a command line whose
 * executable does not exist, wscript exits 0 regardless (Run with wait=False
 * cannot report a failure), and the tray host never loads, so it cannot log the
 * problem either. Task Scheduler says the task succeeded. The only visible
 * symptom is an icon that never appears, which looks exactly like "Windows put
 * it in the overflow".
 *
 * So the check has to happen from outside, and it needs to know what the
 * launcher was built to run. A sidecar is used rather than parsing the .vbs
 * back: we would be re-deriving quoted paths out of a string we generated, in
 * two different shapes (tray and --no-tray), to recover values we had in hand
 * when we wrote it.
 *
 * @param {ReturnType<planAutostart>} plan
 */
export function buildLauncherInfo(plan) {
  return {
    version: 1,
    writtenAt: new Date().toISOString(),
    taskName: plan.taskName,
    port: plan.port,
    tray: plan.tray,
    trayScript: plan.tray ? plan.trayScript : null,
    node: plan.node,
    cli: plan.cli,
    logFile: plan.logFile,
    monitorDir: plan.monitorDir,
    launcher: plan.launcher,
  };
}

/**
 * Read the sidecar and check that everything it names is still there.
 * Never throws; a missing sidecar is reported as such rather than guessed at.
 * @param {{file?: string}} [opts]
 */
export function launcherHealth(opts = {}) {
  const file = opts.file ?? launcherInfoPath();
  let info;
  try {
    info = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return { file, exists: false, info: null, missing: [], ok: null };
  }
  if (!info || typeof info !== 'object' || Array.isArray(info)) {
    return { file, exists: true, info: null, missing: [], ok: null };
  }
  const missing = [];
  for (const key of ['trayScript', 'node', 'cli', 'launcher']) {
    const p = info[key];
    if (typeof p !== 'string' || !p) continue;
    if (!fileSafe(p)) missing.push({ key, path: p });
  }
  return { file, exists: true, info, missing, ok: missing.length === 0 };
}

/* --------------------------------- tray ---------------------------------- */

/**
 * Parse `<monitorDir>/tray.pid`.
 *
 * Written by the tray host on every state change and deleted when it exits
 * cleanly - so a file that IS there is a claim, not a fact, and every caller
 * checks the PIDs before believing it (a host killed with /F leaves the file
 * behind). Never throws: junk, a directory or a missing file are all "no tray".
 *
 * @param {string} [file]
 * @returns {{trayPid: number|null, serverPid: number|null, port: number|null,
 *            startedAt: string|null, logFile: string|null}|null}
 */
export function readTrayPid(file = trayPidPath()) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const pid = (v) => (Number.isInteger(v) && v > 0 ? v : null);
  const str = (v) => (typeof v === 'string' && v ? v : null);
  const out = {
    trayPid: pid(parsed.trayPid),
    trayName: str(parsed.trayName),
    trayStartedAt: str(parsed.trayStartedAt),
    serverPid: pid(parsed.serverPid),
    serverName: str(parsed.serverName),
    serverStartedAt: str(parsed.serverStartedAt),
    port: pid(parsed.port),
    startedAt: str(parsed.startedAt),
    logFile: str(parsed.logFile),
  };
  // A record with no tray PID names nothing we could check; treat it as absent
  // rather than reporting a tray whose identity we do not know.
  return out.trayPid === null ? null : out;
}

/**
 * How far a recorded start time may be from the observed one and still be the
 * same process. The tray reads its own StartTime from the OS, so the two should
 * agree exactly - but the server's is read a moment after Process.Start, and a
 * clock adjustment can move either. The same 60s slack sessions.js allows.
 */
export const PID_START_SLACK_MS = 60_000;

/**
 * Look up what is actually running at these PIDs: name and start time, not just
 * existence.
 *
 * Same shape as sessions.getProcessStartTimes - one PowerShell call,
 * Get-Process with -ErrorAction SilentlyContinue so a dead PID is a missing
 * line rather than an error, best-effort throughout, and injectable so tests
 * never look at the real process table.
 *
 * StartTime is wrapped on the PowerShell side because it throws for a process
 * that exits mid-pipeline, and for ones we are not allowed to ask about. A
 * missing time comes back as null rather than dropping the row: the name is
 * still worth something.
 *
 * @param {number[]} pids
 * @param {{run?: Function}} [opts]
 * @returns {Map<number, {pid: number, name: string|null, startedAtMs: number|null}>}
 */
export function probeProcesses(pids, opts = {}) {
  const unique = [...new Set((pids || []).filter((p) => Number.isInteger(p) && p > 0))];
  const found = new Map();
  if (!unique.length) return found;
  const runner = typeof opts.run === 'function' ? opts.run : defaultRunner;
  if (typeof opts.run !== 'function' && process.platform !== 'win32') return found;
  const script =
    `Get-Process -Id ${unique.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { ` +
    "$s = ''; try { $s = $_.StartTime.ToUniversalTime().ToString('o') } catch { }; " +
    '"$($_.Id)|$($_.ProcessName)|$s" }';
  try {
    const r = runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
    for (const line of toText(r.stdout).split(/\r?\n/)) {
      const m = /^(\d+)\|([^|]*)\|(.*)$/.exec(line.trim());
      if (!m) continue;
      const id = Number(m[1]);
      if (!unique.includes(id)) continue;
      const ms = Date.parse(m[3].trim());
      found.set(id, {
        pid: id,
        name: m[2].trim() || null,
        startedAtMs: Number.isFinite(ms) ? ms : null,
      });
    }
  } catch {
    // Nothing observed is not the same as "nothing is running", and the caller
    // is told which it is by the empty map plus the file that is still there.
  }
  return found;
}

/** `powershell.exe` and `powershell` are the same name to us. */
function sameProcName(a, b) {
  const norm = (v) => String(v ?? '').trim().toLowerCase().replace(/\.exe$/, '');
  return norm(a) === norm(b) && norm(a) !== '';
}

/**
 * Is the process sitting at this PID the one tray.pid recorded?
 *
 * Windows reuses PIDs, and a machine up for weeks has wrapped many times. A
 * reader that trusts a bare number will eventually call somebody else's process
 * "the server" - and `tray-stop` would then kill it. So a match needs positive
 * evidence, not merely the absence of contradiction: an unverifiable record is
 * reported stale rather than assumed good.
 *
 * @param {{name: string|null, startedAtMs: number|null}|null|undefined} observed
 * @param {{name: string|null, startedAt: string|null}|null|undefined} expected
 * @returns {{ok: boolean, reason: string|null}}
 */
export function pidMatches(observed, expected) {
  if (!observed) return { ok: false, reason: 'gone' };
  const wantName = expected && expected.name ? expected.name : null;
  const wantMs = expected && expected.startedAt ? Date.parse(expected.startedAt) : NaN;
  const haveWantMs = Number.isFinite(wantMs);
  if (!wantName && !haveWantMs) {
    // Written by a tray host older than this check, or hand-edited. We will not
    // guess, and we will certainly not kill on a guess.
    return { ok: false, reason: 'no recorded identity to verify against' };
  }
  if (wantName && observed.name && !sameProcName(observed.name, wantName)) {
    return { ok: false, reason: `reused by ${observed.name}` };
  }
  if (haveWantMs && observed.startedAtMs !== null
      && Math.abs(observed.startedAtMs - wantMs) > PID_START_SLACK_MS) {
    return { ok: false, reason: `reused (started ${new Date(observed.startedAtMs).toISOString()}, expected ${expected.startedAt})` };
  }
  // At least one check has to have actually run. A row with no name and no
  // readable start time proves nothing.
  const checkedName = Boolean(wantName && observed.name);
  const checkedTime = haveWantMs && observed.startedAtMs !== null;
  if (!checkedName && !checkedTime) {
    return { ok: false, reason: 'could not read the name or start time of that pid' };
  }
  return { ok: true, reason: null };
}

/**
 * Read-only view of the tray host: is the pid file there, and are the two
 * processes it names still THE ONES IT MEANT?
 * @param {{file?: string, run?: Function}} [opts]
 */
export function trayStatus(opts = {}) {
  const file = opts.file ?? trayPidPath();
  const info = readTrayPid(file);
  const exists = fileSafe(file);
  if (!info) {
    return { file, exists, ...emptyTray(), stale: exists };
  }
  const live = probeTrayProcesses(info, opts);
  return {
    file,
    exists,
    ...info,
    ...live,
    // A pid file naming a process that is gone - or one that has since been
    // handed to somebody else - is what a /F kill leaves behind.
    stale: !live.trayAlive,
  };
}

/** The named event the tray host polls; setting it asks for a CLEAN exit. */
export function trayStopEventName(port) {
  return `Local\\claude-monitor-tray-stop-${port}`;
}

/**
 * argv that sets that event.
 *
 * Why not just kill the tray. taskkill /T /F would work - node is its child -
 * but the host would die between statements, leaving tray.pid on disk and a
 * ghost icon in the notification area until the shell next repaints it. The
 * event is checked by the poll timer the host already runs, so the exit goes
 * through its finally block: server stopped, icon removed, pid file deleted.
 * @param {number} port
 */
export function trayStopArgs(port) {
  const name = trayStopEventName(port);
  const script =
    `try { $e = [System.Threading.EventWaitHandle]::OpenExisting('${name}'); ` +
    '[void]$e.Set(); $e.Dispose(); Write-Output "signalled" } ' +
    'catch { Write-Output "no-tray" }';
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script];
}

/**
 * Ask the tray host on this port to exit. Returns whether the event existed.
 * @param {number} port
 * @param {{run?: Function}} [opts]
 */
export function signalTrayStop(port, opts = {}) {
  const runner = typeof opts.run === 'function' ? opts.run : defaultRunner;
  try {
    const r = runner('powershell.exe', trayStopArgs(port));
    return /signalled/.test(toText(r.stdout));
  } catch {
    return false;
  }
}

/**
 * The last resort when a host will not go quietly: kill it and everything under
 * it. /T because node spawns powershell of its own (src/sessions.js) and a
 * half-killed tree is exactly the leftover this command exists to prevent.
 *
 * `expect` IS REQUIRED, and the PID is re-checked against it immediately before
 * the kill. This function takes a number out of a file on disk and hands it to
 * `taskkill /T /F`; if that number has been recycled, the thing that dies is
 * whatever now holds it - along with all of its children. There is no version
 * of that which is acceptable, so there is deliberately no way to call this
 * without saying which process you mean.
 *
 * @param {number} pid
 * @param {{expect?: {name: string|null, startedAt: string|null}, run?: Function}} [opts]
 * @returns {{ran: boolean, code: number|null, refused?: string}}
 */
export function killTree(pid, opts = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return { ran: false, code: null, refused: 'not a pid' };
  const expect = opts.expect;
  if (!expect || (!expect.name && !expect.startedAt)) {
    return { ran: false, code: null, refused: 'no identity to verify against - refusing to kill a bare pid' };
  }
  const seen = probeProcesses([pid], opts);
  const match = pidMatches(seen.get(pid), expect);
  if (!match.ok) {
    // Already gone is the common case and not a problem; recycled is the one
    // this guard exists for. Either way we run nothing.
    return { ran: false, code: null, refused: match.reason };
  }
  const runner = typeof opts.run === 'function' ? opts.run : defaultRunner;
  try {
    const r = runner('taskkill', ['/PID', String(pid), '/T', '/F']) ?? {};
    // spawnSync does NOT throw when the executable cannot be started - it
    // returns `{ error }` with a null status. Reporting that as "ran" is how
    // tray-stop came to say "stopped" about a process that was never signalled.
    if (r.error) {
      return { ran: false, code: null, refused: `taskkill could not be started: ${r.error.message ?? r.error}` };
    }
    const code = typeof r.status === 'number' ? r.status : null;
    if (code !== 0) {
      const why = toText(r.stderr).trim() || toText(r.stdout).trim();
      return {
        ran: false,
        code,
        refused: `taskkill exited ${code === null ? 'without a status' : code}${why ? `: ${why}` : ''}`,
      };
    }
    return { ran: true, code };
  } catch (err) {
    return { ran: false, code: null, refused: `taskkill threw: ${err && err.message ? err.message : err}` };
  }
}

/**
 * Are the two processes tray.pid named STILL the ones it meant?
 *
 * trayStatus() answers the same question by reading the file - which is exactly
 * what the stop sequence is about to delete, and what made the old `tray-stop`
 * report success unconditionally: it removed the file and then asked the file.
 * This asks the process table and takes the identities as arguments, so the
 * answer does not depend on a file that may already be gone.
 *
 * @param {{trayPid: number|null, trayName: string|null, trayStartedAt: string|null,
 *          serverPid: number|null, serverName: string|null, serverStartedAt: string|null}} record
 * @param {{run?: Function}} [opts]
 * @returns {{trayAlive: boolean, serverAlive: boolean, trayReason: string|null, serverReason: string|null}}
 */
export function probeTrayProcesses(record, opts = {}) {
  const seen = probeProcesses([record.trayPid, record.serverPid], opts);
  const tray = record.trayPid === null
    ? { ok: false, reason: 'no tray recorded' }
    : pidMatches(seen.get(record.trayPid), { name: record.trayName, startedAt: record.trayStartedAt });
  const server = record.serverPid === null
    ? { ok: false, reason: 'no server recorded' }
    : pidMatches(seen.get(record.serverPid), { name: record.serverName, startedAt: record.serverStartedAt });
  return {
    trayAlive: tray.ok,
    serverAlive: server.ok,
    trayReason: tray.reason,
    serverReason: server.reason,
  };
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Stop the tray host and the server it supervises, and report WHAT IS LEFT.
 *
 * Ask first - a named event the host's poll timer checks, so its own cleanup
 * runs - and only kill the tree if that is ignored. Every step re-reads the
 * process table rather than the pid file, and the file is removed at the end
 * ONLY once both processes are actually gone. A pid file deleted over a tray
 * that is still running is worse than one left behind: the host keeps the port
 * and there is no longer anything on disk that says where it is.
 *
 * @param {ReturnType<typeof trayStatus>} record what tray.pid said before we started
 * @param {{port?: number, run?: Function, sleep?: Function, waitMs?: number, settleMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, signalled: boolean, killed: boolean, refusals: string[],
 *                    trayAlive: boolean, serverAlive: boolean, pidFileRemoved: boolean}>}
 */
export async function stopTrayProcesses(record, opts = {}) {
  const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
  const waitMs = Number.isFinite(opts.waitMs) ? opts.waitMs : 10000;
  const settleMs = Number.isFinite(opts.settleMs) ? opts.settleMs : 500;
  const port = opts.port ?? record.port;
  const probe = () => probeTrayProcesses(record, opts);

  const signalled = signalTrayStop(port, opts);

  let alive = probe();
  const deadline = Date.now() + waitMs;
  while ((alive.trayAlive || alive.serverAlive) && Date.now() < deadline) {
    await sleep(400);
    alive = probe();
  }

  let killed = false;
  /** @type {string[]} */
  const refusals = [];
  if (alive.trayAlive || alive.serverAlive) {
    if (alive.trayAlive) {
      const r = killTree(record.trayPid, {
        ...opts, expect: { name: record.trayName, startedAt: record.trayStartedAt },
      });
      if (r.ran) killed = true; else refusals.push(`tray pid ${record.trayPid}: ${r.refused}`);
    }
    // The server is the tray's child, so /T should already have taken it - but
    // "should" is not a check, and a stray node holding the port is the exact
    // leftover this command exists to prevent.
    await sleep(settleMs);
    if (probe().serverAlive && record.serverPid) {
      const r = killTree(record.serverPid, {
        ...opts, expect: { name: record.serverName, startedAt: record.serverStartedAt },
      });
      if (r.ran) killed = true; else refusals.push(`server pid ${record.serverPid}: ${r.refused}`);
    }
    await sleep(settleMs);
    alive = probe();
  }

  const ok = !alive.trayAlive && !alive.serverAlive;
  // Nobody ran a /F-killed host's finally block, so the file is ours to clear -
  // but only now that the process table agrees it names nothing.
  let pidFileRemoved = false;
  if (ok && record.file && fileSafe(record.file)) {
    try {
      fs.rmSync(record.file, { force: true });
      pidFileRemoved = true;
    } catch { /* best effort; the caller reports the file that is still there */ }
  }

  return { ok, signalled, killed, refusals, ...alive, pidFileRemoved };
}

function emptyTray() {
  return {
    trayPid: null,
    trayName: null,
    trayStartedAt: null,
    serverPid: null,
    serverName: null,
    serverStartedAt: null,
    port: null,
    startedAt: null,
    logFile: null,
    trayAlive: false,
    serverAlive: false,
    trayReason: 'no tray.pid',
    serverReason: 'no tray.pid',
  };
}

/**
 * Read-only status. Never creates or changes anything.
 * @param {{taskName?: string, run?: Function}} [opts]
 */
export function autostartStatus(opts = {}) {
  const taskName = opts.taskName ?? TASK_NAME;
  const xmlArgs = queryTaskArgs({ taskName });
  const verboseArgs = queryTaskVerboseArgs({ taskName });
  const xml = runSchtasks(xmlArgs, opts);
  const installed = xml.code === 0;
  const details = installed ? parseTaskXml(xml.stdout) : emptyDetails();
  const verbose = installed ? runSchtasks(verboseArgs, opts) : { code: null, stdout: '', stderr: '' };
  return {
    taskName,
    installed,
    ...details,
    launcher: launcherPath(),
    launcherExists: fileSafe(launcherPath()),
    xmlFile: taskXmlPath(),
    xmlExists: fileSafe(taskXmlPath()),
    logFile: defaultLogFilePath(),
    logExists: fileSafe(defaultLogFilePath()),
    queryCode: xml.code,
    queryError: installed ? null : (xml.stderr || xml.stdout || '').trim() || null,
    raw: (verbose.stdout || '').trim(),
    schtasks: { file: 'schtasks', args: xmlArgs, display: displayCommand(xmlArgs) },
  };
}

/**
 * Pull the few facts we care about out of the task XML.
 *
 * XML rather than `/FO LIST` on purpose: the list output's field names are
 * LOCALISED (this machine reports them in Japanese), so parsing it would work
 * on an English Windows and quietly return nothing here. The XML schema is
 * fixed in every locale.
 *
 * @param {string} xmlText
 */
export function parseTaskXml(xmlText) {
  const text = typeof xmlText === 'string' ? xmlText.replace(/^\uFEFF/, '') : '';
  const pick = (tag) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
    return m ? decodeXml(m[1].trim()) : null;
  };
  // The trigger's own UserId, not the Principal's. These are different things
  // and only the first one decides WHOSE logon starts the task: a task with no
  // trigger UserId fires for every user, which is the registration schtasks
  // refuses to create without elevation. Seeing it here is how a wrong
  // registration becomes visible instead of merely not working.
  const trigger = /<LogonTrigger>([\s\S]*?)<\/LogonTrigger>/i.exec(text);
  const triggerBody = trigger ? trigger[1] : '';
  const inTrigger = (tag) => {
    const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(triggerBody);
    return m ? decodeXml(m[1].trim()) : null;
  };
  return {
    command: pick('Command'),
    arguments: pick('Arguments'),
    enabled: /<Enabled>true<\/Enabled>/i.test(text) ? true : (/<Enabled>false<\/Enabled>/i.test(text) ? false : null),
    onLogon: /<LogonTrigger[\s>]/i.test(text),
    // pick() finds the Principal's UserId (the account it runs as).
    userId: pick('UserId'),
    triggerUserId: inTrigger('UserId'),
    triggerDelay: inTrigger('Delay'),
    executionTimeLimit: pick('ExecutionTimeLimit'),
    multipleInstancesPolicy: pick('MultipleInstancesPolicy'),
    runLevel: pick('RunLevel'),
    hasXml: text.includes('<Task'),
  };
}

function emptyDetails() {
  return {
    command: null,
    arguments: null,
    enabled: null,
    onLogon: false,
    userId: null,
    triggerUserId: null,
    triggerDelay: null,
    executionTimeLimit: null,
    multipleInstancesPolicy: null,
    runLevel: null,
    hasXml: false,
  };
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Run schtasks and normalise the result. Injectable so tests never touch the
 * real Task Scheduler.
 * @param {string[]} args
 * @param {{run?: Function}} [opts]
 */
export function runSchtasks(args, opts = {}) {
  const runner = typeof opts.run === 'function' ? opts.run : defaultRunner;
  try {
    const r = runner('schtasks', args);
    return {
      code: typeof r.status === 'number' ? r.status : (r.error ? -1 : 0),
      stdout: toText(r.stdout),
      stderr: toText(r.stderr),
      error: r.error ? String(r.error.message ?? r.error) : null,
    };
  } catch (err) {
    return { code: -1, stdout: '', stderr: String(err && err.message ? err.message : err), error: String(err) };
  }
}

function defaultRunner(file, args) {
  // No shell: the argv array is passed through, so nothing here is re-parsed
  // by cmd.exe and no quoting of ours can be misread.
  // No `encoding` either - see decodeConsole for why the bytes are kept.
  return spawnSync(file, args, { windowsHide: true, shell: false });
}

function toText(v) {
  if (typeof v === 'string') return v;
  if (Buffer.isBuffer(v)) return decodeConsole(v);
  if (v && typeof v.toString === 'function') return v.toString('utf8');
  return '';
}

/**
 * Decode console output that is not necessarily UTF-8.
 *
 * `schtasks /XML` writes ASCII, but its ERROR messages come out in the console
 * codepage - CP932 on this machine, which `Buffer.toString('utf8')` turns into
 * a row of replacement characters. The exit code is what we actually act on, so
 * this only affects the message a human reads; best effort is the right level
 * of effort, and it must never throw.
 *
 * Order: a UTF-16LE BOM decides outright; otherwise UTF-8 wins unless it
 * produced replacement characters, in which case CP932 is tried and kept only
 * if it produced none. Other locales fall back to the UTF-8 reading, which is
 * exactly what happened before this existed.
 * @param {Buffer} buf
 */
export function decodeConsole(buf) {
  if (!buf || !buf.length) return '';
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('�')) return utf8;
  try {
    const cp932 = new TextDecoder('shift_jis').decode(buf);
    if (!cp932.includes('�')) return cp932;
  } catch { /* no ICU for it; keep the UTF-8 reading */ }
  return utf8;
}

function fileSafe(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function safeUser() {
  try {
    const u = os.userInfo().username;
    const domain = process.env.USERDOMAIN;
    return domain ? `${domain}\\${u}` : u;
  } catch {
    return null;
  }
}
