/**
 * The tray host: the command that starts it, the file it leaves behind, and
 * one real run of the script itself.
 *
 * NOTHING here starts a tray, spawns a server or binds a port. The only child
 * process is `claude-monitor-tray.ps1 -SelfTest`, which by contract loads the
 * assemblies, builds the three icons, constructs the NotifyIcon and the menu,
 * prints one line and exits - it shows nothing and spawns nothing. That run is
 * the only way to find out that WinForms, System.Drawing and the DestroyIcon
 * P/Invoke are all reachable on this machine, and it is skipped off Windows.
 *
 * The end-to-end behaviour these cannot reach - that the icon appears, that a
 * killed server is restarted, that tray-stop leaves nothing alive - was
 * measured by hand; see docs/autostart-verification.md.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeTmpDir } from './helpers.js';
import {
  trayScriptPath,
  trayHostArgv,
  launcherCommand,
  buildLauncherVbs,
  readTrayPid,
  trayStatus,
  probeProcesses,
  pidMatches,
  trayStopEventName,
  trayStopArgs,
  killTree,
  launcherHealth,
  buildLauncherInfo,
  planAutostart,
  PID_START_SLACK_MS,
  PROJECT_ROOT,
} from '../src/autostart.js';
import { redactSecrets } from '../src/log-file.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CLI_JP = 'D:\\develop\\Claude監視\\src\\cli.js';
const TRAY_JP = 'D:\\develop\\Claude監視\\tray\\claude-monitor-tray.ps1';
const LOG = 'C:\\Users\\alice\\.claude-monitor\\serve.log';
const DIR = 'C:\\Users\\alice\\.claude-monitor';

const opts = { node: NODE, cli: CLI_JP, port: 47321, logFile: LOG, trayScript: TRAY_JP, monitorDir: DIR };

let tmp;
before(() => { tmp = makeTmpDir('cm-tray'); });
after(() => { if (tmp) tmp.cleanup(); });

describe('the tray host command', () => {
  test('the argv names the script, the port and every path, in order', () => {
    assert.deepEqual(trayHostArgv(opts), [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy', 'Bypass',
      '-STA',
      '-WindowStyle', 'Hidden',
      '-File', TRAY_JP,
      '-Port', '47321',
      '-Node', NODE,
      '-Cli', CLI_JP,
      '-LogFile', LOG,
      '-MonitorDir', DIR,
    ]);
  });

  test('-STA and -WindowStyle Hidden are both there', () => {
    // NotifyIcon needs an STA thread with a message loop, and powershell.exe is
    // a console binary - without Hidden a window appears at every logon, which
    // is the problem the launcher exists to solve.
    const argv = trayHostArgv(opts);
    assert.ok(argv.includes('-STA'));
    assert.equal(argv[argv.indexOf('-WindowStyle') + 1], 'Hidden');
  });

  test('the VBS command doubles the quotes around paths and leaves flags bare', () => {
    const cmd = launcherCommand(opts);
    assert.equal(
      cmd,
      'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -STA -WindowStyle Hidden ' +
      '-File ""D:\\develop\\Claude監視\\tray\\claude-monitor-tray.ps1"" -Port 47321 ' +
      '-Node ""C:\\Program Files\\nodejs\\node.exe"" -Cli ""D:\\develop\\Claude監視\\src\\cli.js"" ' +
      '-LogFile ""C:\\Users\\alice\\.claude-monitor\\serve.log"" ' +
      '-MonitorDir ""C:\\Users\\alice\\.claude-monitor""',
    );
  });

  test('the Japanese path is quoted - \\w is ASCII-only, which is the point', () => {
    const cmd = launcherCommand(opts);
    assert.ok(cmd.includes('""D:\\develop\\Claude監視\\tray\\claude-monitor-tray.ps1""'));
    assert.ok(cmd.includes('""D:\\develop\\Claude監視\\src\\cli.js""'));
  });

  test('a path with a space survives, and Bypass is NOT quoted', () => {
    const cmd = launcherCommand({ ...opts, trayScript: 'C:\\My Tools\\tray.ps1' });
    assert.ok(cmd.includes('-File ""C:\\My Tools\\tray.ps1""'));
    assert.ok(cmd.includes('-ExecutionPolicy Bypass -STA'));
  });

  test('a trailing backslash is stripped: it would escape the closing quote', () => {
    // `-MonitorDir "C:\dir\"` reads as an unterminated value to PowerShell.
    const argv = trayHostArgv({ ...opts, monitorDir: 'C:\\dir\\' });
    assert.equal(argv[argv.indexOf('-MonitorDir') + 1], 'C:\\dir');
    // A bare drive root still means the drive root.
    assert.equal(trayHostArgv({ ...opts, monitorDir: 'D:\\' })[argv.indexOf('-MonitorDir') + 1], 'D:\\');
  });

  test('a path that could break out of the command line is refused', () => {
    assert.throws(() => launcherCommand({ ...opts, trayScript: 'C:\\a"b.ps1' }), /containing a quote/);
    assert.throws(() => launcherCommand({ ...opts, monitorDir: 'C:\\a\nb' }), /containing a newline/);
  });

  test('the tray is the default, and --no-tray gets the old direct command back', () => {
    assert.ok(launcherCommand(opts).startsWith('powershell.exe '));
    const direct = launcherCommand({ ...opts, tray: false });
    assert.ok(direct.startsWith('""C:\\Program Files\\nodejs\\node.exe""'));
    assert.ok(direct.includes('serve --persist-token --port 47321'));
    assert.equal(direct.includes('powershell'), false);
  });

  test('the launcher still hides the window and does not wait', () => {
    // The tray host replaces what runs, not how it is launched: wscript is
    // still the thing with no console of its own.
    const vbs = buildLauncherVbs(opts);
    assert.match(vbs, /sh\.Run cmd, 0, False/);
    assert.match(vbs, /^Option Explicit$/m);
    assert.equal(/[^\r]\n/.test(vbs), false, 'CRLF only');
  });

  test('it does NOT pass --open, with the tray as with the direct command', () => {
    assert.equal(buildLauncherVbs(opts).includes('--open'), false);
  });
});

describe('tray.pid', () => {
  const write = (name, text) => {
    const f = path.join(tmp.dir, name);
    fs.writeFileSync(f, text, 'utf8');
    return f;
  };

  test('a record written by the host round-trips, identities and all', () => {
    const f = write('ok.pid', JSON.stringify({
      trayPid: 4321, trayName: 'powershell', trayStartedAt: '2026-09-04T13:52:28.0000000Z',
      serverPid: 8765, serverName: 'node', serverStartedAt: '2026-09-04T13:52:29.0000000Z',
      port: 47321,
      startedAt: '2026-09-04T13:52:28.4381231Z',
      logFile: 'C:\\Users\\alice\\.claude-monitor\\serve.log',
    }));
    assert.deepEqual(readTrayPid(f), {
      trayPid: 4321,
      trayName: 'powershell',
      trayStartedAt: '2026-09-04T13:52:28.0000000Z',
      serverPid: 8765,
      serverName: 'node',
      serverStartedAt: '2026-09-04T13:52:29.0000000Z',
      port: 47321,
      startedAt: '2026-09-04T13:52:28.4381231Z',
      logFile: 'C:\\Users\\alice\\.claude-monitor\\serve.log',
    });
  });

  test('a host that has not spawned the server yet has a null serverPid', () => {
    const f = write('nostart.pid', JSON.stringify({ trayPid: 10, serverPid: null, port: 1 }));
    const got = readTrayPid(f);
    assert.equal(got.trayPid, 10);
    assert.equal(got.serverPid, null);
    assert.equal(got.startedAt, null);
  });

  test('a UTF-8 BOM does not stop it being read', () => {
    const f = write('bom.pid', `\uFEFF${JSON.stringify({ trayPid: 7, port: 2 })}`);
    assert.equal(readTrayPid(f).trayPid, 7);
  });

  test('junk, a missing file and a record with no tray PID are all "no tray"', () => {
    assert.equal(readTrayPid(path.join(tmp.dir, 'nope.pid')), null);
    assert.equal(readTrayPid(write('junk.pid', 'not json')), null);
    assert.equal(readTrayPid(write('empty.pid', '')), null);
    assert.equal(readTrayPid(write('arr.pid', '[1,2]')), null);
    // Nothing to check the liveness of, so it names no tray.
    assert.equal(readTrayPid(write('nopid.pid', '{"serverPid":5}')), null);
    assert.equal(readTrayPid(write('zero.pid', '{"trayPid":0}')), null);
    assert.equal(readTrayPid(write('neg.pid', '{"trayPid":-3}')), null);
    assert.equal(readTrayPid(write('str.pid', '{"trayPid":"4321"}')), null);
  });

  test('readTrayPid never throws, whatever is there', () => {
    assert.doesNotThrow(() => readTrayPid(tmp.dir));
  });
});

describe('probeProcesses', () => {
  test('it reads pid, name and start time, and only for real PIDs', () => {
    const calls = [];
    const run = (file, args) => {
      calls.push({ file, args });
      return { status: 0, stdout: '5|powershell|2026-09-04T13:52:28.0000000Z\r\n' };
    };
    const seen = probeProcesses([5, 0, -1, null, 5, 'x'], { run });
    assert.deepEqual([...seen.keys()], [5]);
    assert.equal(seen.get(5).name, 'powershell');
    assert.equal(seen.get(5).startedAtMs, Date.parse('2026-09-04T13:52:28.000Z'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'powershell.exe');
    assert.match(calls[0].args[calls[0].args.length - 1], /^Get-Process -Id 5 /);
    // Nothing to look up must not spawn anything at all.
    assert.equal(probeProcesses([], { run }).size, 0);
    assert.equal(calls.length, 1);
  });

  test('a pid nobody asked about, and junk lines, are ignored', () => {
    const seen = probeProcesses([7, 9], {
      run: () => ({ status: 0, stdout: '9|node|2026-09-04T00:00:00.0000000Z\r\nGet-Process : oops\r\n13|node|\r\n' }),
    });
    assert.deepEqual([...seen.keys()], [9]);
  });

  test('an unreadable StartTime still yields a row, with a null time', () => {
    // Get-Process can see the process but not its start time; the NAME is still
    // worth having, so the row must not be dropped.
    const seen = probeProcesses([4], { run: () => ({ status: 0, stdout: '4|node|\r\n' }) });
    assert.equal(seen.get(4).name, 'node');
    assert.equal(seen.get(4).startedAtMs, null);
  });

  test('a runner that throws means "nothing observed", not a crash', () => {
    assert.doesNotThrow(() => probeProcesses([1], { run: () => { throw new Error('no powershell'); } }));
    assert.equal(probeProcesses([1], { run: () => { throw new Error('x'); } }).size, 0);
  });
});

describe('pidMatches - a bare PID is not an identity', () => {
  const START = '2026-09-04T13:52:28.0000000Z';
  const MS = Date.parse(START);
  const expect = { name: 'powershell', startedAt: START };

  test('same name and same start time is a match', () => {
    assert.equal(pidMatches({ name: 'powershell', startedAtMs: MS }, expect).ok, true);
  });

  test('.exe on either side is the same name', () => {
    assert.equal(pidMatches({ name: 'powershell.exe', startedAtMs: MS }, expect).ok, true);
    assert.equal(pidMatches({ name: 'powershell', startedAtMs: MS }, { ...expect, name: 'powershell.exe' }).ok, true);
  });

  test('a different name is a reused pid, and says so', () => {
    const r = pidMatches({ name: 'notepad', startedAtMs: MS }, expect);
    assert.equal(r.ok, false);
    assert.match(r.reason, /reused by notepad/);
  });

  test('a start time outside the slack is a reused pid', () => {
    assert.equal(pidMatches({ name: 'powershell', startedAtMs: MS + PID_START_SLACK_MS + 1 }, expect).ok, false);
    assert.match(pidMatches({ name: 'powershell', startedAtMs: MS - 3600_000 }, expect).reason, /reused/);
  });

  test('inside the slack is the same process - the two clocks are not the same', () => {
    assert.equal(pidMatches({ name: 'powershell', startedAtMs: MS + PID_START_SLACK_MS - 1 }, expect).ok, true);
    assert.equal(pidMatches({ name: 'powershell', startedAtMs: MS - 30_000 }, expect).ok, true);
  });

  test('nothing at that pid is "gone", not a match', () => {
    assert.equal(pidMatches(undefined, expect).ok, false);
    assert.equal(pidMatches(null, expect).reason, 'gone');
  });

  test('a record with no identity is never a match - it must not be guessed at', () => {
    // Written by an older tray host, or hand-edited. Refusing here is what stops
    // tray-stop killing a pid it cannot prove anything about.
    const r = pidMatches({ name: 'powershell', startedAtMs: MS }, { name: null, startedAt: null });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no recorded identity/);
    assert.equal(pidMatches({ name: 'x', startedAtMs: 1 }, null).ok, false);
  });

  test('a pid whose name AND time are both unreadable proves nothing', () => {
    const r = pidMatches({ name: null, startedAtMs: null }, expect);
    assert.equal(r.ok, false);
    assert.match(r.reason, /could not read/);
  });

  test('one readable check is enough', () => {
    assert.equal(pidMatches({ name: 'powershell', startedAtMs: null }, expect).ok, true);
    assert.equal(pidMatches({ name: null, startedAtMs: MS }, expect).ok, true);
  });
});

describe('trayStatus', () => {
  const START = '2026-09-04T13:52:28.0000000Z';
  const LIVE = {
    trayPid: 111, trayName: 'powershell', trayStartedAt: START,
    serverPid: 222, serverName: 'node', serverStartedAt: START,
    port: 47321,
  };
  /** A Get-Process stand-in returning whatever rows the test names. */
  const runner = (rows) => (file, args) => {
    assert.equal(file, 'powershell.exe');
    assert.ok(args.includes('-Command'));
    return { status: 0, stdout: rows.join('\r\n'), stderr: '' };
  };
  const writePid = (name, obj) => {
    const f = path.join(tmp.dir, name);
    fs.writeFileSync(f, JSON.stringify(obj));
    return f;
  };

  test('both alive, both matching, is running', () => {
    const st = trayStatus({
      file: writePid('live.pid', LIVE),
      run: runner([`111|powershell|${START}`, `222|node|${START}`]),
    });
    assert.equal(st.trayAlive, true);
    assert.equal(st.serverAlive, true);
    assert.equal(st.stale, false);
    assert.equal(st.port, 47321);
  });

  test('a pid file naming a dead tray is a leftover, not a running tray', () => {
    // What a `taskkill /F` leaves behind: the host never ran its finally block.
    const st = trayStatus({ file: writePid('stale.pid', LIVE), run: runner([]) });
    assert.equal(st.trayAlive, false);
    assert.equal(st.stale, true);
    assert.equal(st.trayReason, 'gone');
  });

  test('a REUSED tray pid is stale, and names what holds it now', () => {
    // The whole point: pid 111 exists, so a bare existence check would have
    // called this "running" - and tray-stop would have killed a stranger.
    const st = trayStatus({
      file: writePid('reused.pid', LIVE),
      run: runner([`111|chrome|${START}`, `222|node|${START}`]),
    });
    assert.equal(st.trayAlive, false);
    assert.equal(st.stale, true);
    assert.match(st.trayReason, /reused by chrome/);
  });

  test('a tray pid recycled by another powershell is caught by the start time', () => {
    const st = trayStatus({
      file: writePid('recycled.pid', LIVE),
      run: runner([`111|powershell|2026-09-05T09:00:00.0000000Z`, `222|node|${START}`]),
    });
    assert.equal(st.trayAlive, false);
    assert.match(st.trayReason, /reused \(started/);
  });

  test('a tray whose server pid has been reused is reported separately', () => {
    const st = trayStatus({
      file: writePid('halfdead.pid', LIVE),
      run: runner([`111|powershell|${START}`, `222|explorer|${START}`]),
    });
    assert.equal(st.trayAlive, true);
    assert.equal(st.serverAlive, false);
    assert.match(st.serverReason, /reused by explorer/);
  });

  test('a pid file from an older host, with no identity, is stale not running', () => {
    const st = trayStatus({
      file: writePid('legacy.pid', { trayPid: 111, serverPid: 222, port: 47321 }),
      run: runner([`111|powershell|${START}`, `222|node|${START}`]),
    });
    assert.equal(st.trayAlive, false);
    assert.match(st.trayReason, /no recorded identity/);
  });

  test('no file at all is stopped, and nothing is asked of the process table', () => {
    let called = false;
    const st = trayStatus({
      file: path.join(tmp.dir, 'absent.pid'),
      run: () => { called = true; return { status: 0, stdout: '' }; },
    });
    assert.equal(st.trayAlive, false);
    assert.equal(st.exists, false);
    assert.equal(called, false, 'there were no PIDs to look up');
  });
});

describe('stopping the tray', () => {
  test('the event name is per-port, in the session-local namespace', () => {
    assert.equal(trayStopEventName(47321), 'Local\\claude-monitor-tray-stop-47321');
    assert.notEqual(trayStopEventName(1), trayStopEventName(2));
    // Distinct from the single-instance mutex, which is the same name without
    // `-stop`: opening one must never be mistaken for holding the other.
    assert.notEqual(trayStopEventName(47321), 'Local\\claude-monitor-tray-47321');
  });

  test('the stop command opens that event and says which happened', () => {
    const args = trayStopArgs(48000);
    assert.ok(args.includes('-NonInteractive'));
    const script = args[args.length - 1];
    assert.ok(script.includes("OpenExisting('Local\\claude-monitor-tray-stop-48000')"));
    // Both outcomes are reported rather than thrown: no tray is a normal answer.
    assert.ok(script.includes('signalled'));
    assert.ok(script.includes('no-tray'));
  });

  const START = '2026-09-04T13:52:28.0000000Z';
  const EXPECT = { name: 'powershell', startedAt: START };
  /** Answers the Get-Process probe, then records the taskkill. */
  const runnerFor = (rows, calls) => (file, args) => {
    calls.push([file, ...args]);
    if (file === 'powershell.exe') return { status: 0, stdout: rows.join('\r\n') };
    return { status: 0, stdout: '' };
  };

  test('killTree walks the whole tree when the pid checks out', () => {
    const calls = [];
    const r = killTree(1234, { expect: EXPECT, run: runnerFor([`1234|powershell|${START}`], calls) });
    assert.equal(r.ran, true);
    assert.deepEqual(calls[calls.length - 1], ['taskkill', '/PID', '1234', '/T', '/F']);
  });

  test('killTree REFUSES a pid that has been reused - nothing is killed', () => {
    // The finding this guards: tray.pid holds a number, the number got recycled,
    // and `taskkill /T /F` would take out a stranger and all of its children.
    const calls = [];
    const r = killTree(1234, { expect: EXPECT, run: runnerFor([`1234|chrome|${START}`], calls) });
    assert.equal(r.ran, false);
    assert.match(r.refused, /reused by chrome/);
    assert.equal(calls.filter((c) => c[0] === 'taskkill').length, 0, 'taskkill must not have run');
  });

  test('killTree REFUSES on a start time outside the slack', () => {
    const calls = [];
    const r = killTree(1234, {
      expect: EXPECT,
      run: runnerFor(['1234|powershell|2026-09-05T09:00:00.0000000Z'], calls),
    });
    assert.equal(r.ran, false);
    assert.match(r.refused, /reused/);
    assert.equal(calls.filter((c) => c[0] === 'taskkill').length, 0);
  });

  test('killTree REFUSES when there is no identity to check against', () => {
    const calls = [];
    for (const bad of [undefined, {}, { name: null, startedAt: null }]) {
      const r = killTree(1234, { expect: bad, run: runnerFor([`1234|powershell|${START}`], calls) });
      assert.equal(r.ran, false);
      assert.match(r.refused, /no identity to verify against/);
    }
    assert.equal(calls.length, 0, 'it did not even look the pid up');
  });

  test('killTree refuses a value that is not a PID at all', () => {
    const calls = [];
    for (const bad of [0, -1, null, undefined, 'x', 1.5]) {
      assert.equal(killTree(bad, { expect: EXPECT, run: runnerFor([], calls) }).ran, false);
    }
    assert.equal(calls.length, 0);
  });

  test('killTree on a pid that is simply gone runs nothing and says so', () => {
    const calls = [];
    const r = killTree(1234, { expect: EXPECT, run: runnerFor([], calls) });
    assert.equal(r.ran, false);
    assert.equal(r.refused, 'gone');
  });
});

describe('the launcher sidecar (a moved repo is otherwise silent)', () => {
  test('it records everything the launcher points at', () => {
    const plan = planAutostart({ port: 48200, node: NODE, monitorDir: DIR });
    const info = buildLauncherInfo(plan);
    assert.equal(info.tray, true);
    assert.equal(info.port, 48200);
    assert.equal(info.node, NODE);
    assert.equal(info.trayScript, plan.trayScript);
    assert.equal(info.cli, plan.cli);
    assert.ok(info.writtenAt);
  });

  test('--no-tray records no tray script to check', () => {
    assert.equal(buildLauncherInfo(planAutostart({ tray: false })).trayScript, null);
  });

  test('a sidecar whose paths all exist is ok', () => {
    const f = path.join(tmp.dir, 'good.json');
    fs.writeFileSync(f, JSON.stringify({
      trayScript: trayScriptPath(), node: process.execPath, cli: CLI, launcher: f,
    }));
    const h = launcherHealth({ file: f });
    assert.equal(h.ok, true);
    assert.deepEqual(h.missing, []);
  });

  test('a sidecar naming a moved repo reports exactly which paths are gone', () => {
    const f = path.join(tmp.dir, 'moved.json');
    const gone = path.join(tmp.dir, 'not-here', 'claude-monitor-tray.ps1');
    fs.writeFileSync(f, JSON.stringify({
      trayScript: gone, node: process.execPath, cli: path.join(tmp.dir, 'nope', 'cli.js'), launcher: f,
    }));
    const h = launcherHealth({ file: f });
    assert.equal(h.ok, false);
    assert.deepEqual(h.missing.map((m) => m.key).sort(), ['cli', 'trayScript']);
    assert.equal(h.missing.find((m) => m.key === 'trayScript').path, gone);
  });

  test('no sidecar is "unknown", not "ok" and not "broken"', () => {
    const h = launcherHealth({ file: path.join(tmp.dir, 'absent.json') });
    assert.equal(h.exists, false);
    assert.equal(h.ok, null);
  });

  test('junk in the sidecar is unknown too, and never throws', () => {
    const f = path.join(tmp.dir, 'junk.json');
    fs.writeFileSync(f, 'not json');
    assert.doesNotThrow(() => launcherHealth({ file: f }));
    assert.equal(launcherHealth({ file: f }).ok, null);
    const g = path.join(tmp.dir, 'arr.json');
    fs.writeFileSync(g, '[1,2]');
    assert.equal(launcherHealth({ file: g }).ok, null);
  });
});

/* --------------------------- the script itself --------------------------- */

describe('claude-monitor-tray.ps1', () => {
  test('it starts with a UTF-8 BOM', () => {
    // PowerShell 5.1 decodes a BOM-less .ps1 with the ANSI codepage (CP932
    // here), which turns every Japanese menu string into mojibake and can break
    // the parse outright. Observed, not assumed - see the verification doc.
    const buf = fs.readFileSync(trayScriptPath());
    assert.deepEqual([...buf.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  });

  test('the menu labels really are Japanese in the bytes on disk', () => {
    const text = fs.readFileSync(trayScriptPath(), 'utf8');
    for (const label of ['ダッシュボードを開く', 'ログを開く', '再起動', '終了']) {
      assert.ok(text.includes(label), `missing menu label ${label}`);
    }
  });

  test('it lives where trayScriptPath says it does', () => {
    assert.equal(trayScriptPath(), path.join(PROJECT_ROOT, 'tray', 'claude-monitor-tray.ps1'));
    assert.ok(fs.statSync(trayScriptPath()).isFile());
  });

  test('-SelfTest builds the icons and the menu for real, and exits 0', (t) => {
    if (process.platform !== 'win32') {
      t.skip('WinForms and the DestroyIcon P/Invoke are Windows-only');
      return;
    }
    // The contract: nothing is shown, nothing is spawned, nothing is written -
    // so this may run on the developer's machine with a tray already up.
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
      '-File', trayScriptPath(), '-SelfTest',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /selftest ok/);
    assert.equal((r.stderr || '').trim(), '');
  });

  test('-SelfTest proves the PowerShell copy of the redaction rule works', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows-only');
      return;
    }
    // Get-Redacted is a hand-copy of log-file.js TOKEN_PATTERNS into another
    // language - exactly the kind of duplicate that rots without anyone noticing.
    // It is the only thing between url.txt and a log that keeps a live
    // credential for months, so it gets checked against a real run.
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
      '-File', trayScriptPath(), '-SelfTest',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    const line = r.stdout.split(/\r?\n/).find((l) => l.startsWith('redaction:'));
    assert.ok(line, `no redaction line in: ${r.stdout}`);
    assert.match(line, /\?<token redacted>/);
    assert.match(line, /cm_token=<redacted>/);
    assert.equal(/[0-9a-f]{64}/.test(line), false, 'a 64-hex run survived redaction');
    // And the same input through the JS implementation agrees.
    const sample = `http://127.0.0.1:47321/?t=${'a'.repeat(64)} cookie cm_token=${'b'.repeat(64)}`;
    assert.equal(line.slice('redaction: '.length), redactSecrets(sample));
  });

  test('-SelfTest needs no -Port: it never touches one', (t) => {
    if (process.platform !== 'win32') {
      t.skip('Windows-only');
      return;
    }
    // Guards the rule that a bare run does NOT default to the real port and
    // quietly start a server on it.
    const r = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
      '-File', trayScriptPath(), '-Port', '0',
    ], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
    assert.equal(r.status, 2, 'a run with no usable port must refuse');
    assert.match(r.stderr, /-Port between 1 and 65535/);
  });
});

describe('two tray hosts on one port', () => {
  test('the mutex loser exits 0 and leaves the winner\'s tray.pid alone', (t) => {
    if (process.platform !== 'win32') {
      t.skip('named mutexes and WinForms are Windows-only');
      return;
    }
    // The bug this pins down: the loser used to run Remove-PidFile in its
    // finally block and delete the RUNNING instance's tray.pid, after which
    // tray-stop could no longer find it and the icon was unreachable.
    //
    // Port 48140 is arbitrary and never bound by the test itself - the winner's
    // server will try to bind it and that is fine; everything is killed below.
    const port = 48140;
    const dir = path.join(tmp.dir, 'two-hosts');
    fs.mkdirSync(dir, { recursive: true });
    const pidFile = path.join(dir, 'tray.pid');
    const args = (extra = []) => [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-STA',
      '-File', trayScriptPath(), '-Port', String(port),
      '-Node', process.execPath, '-Cli', CLI,
      '-LogFile', path.join(dir, 'serve.log'), '-MonitorDir', dir,
      ...extra,
    ];

    let winner = null;
    try {
      winner = spawn('powershell.exe', args(), { stdio: 'ignore', windowsHide: true });
      // Wait for the winner to claim the file rather than sleeping blindly.
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline && !fs.existsSync(pidFile)) {
        spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},250)'], { timeout: 5000 });
      }
      assert.ok(fs.existsSync(pidFile), 'the first host never wrote tray.pid');
      const first = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(first.trayPid > 0);
      assert.equal(first.port, port);
      assert.ok(first.trayName, 'the pid file must carry an identity, not just a number');
      assert.ok(first.trayStartedAt);

      // The second one must lose the mutex, exit 0, and touch nothing.
      const loser = spawnSync('powershell.exe', args(), { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      assert.equal(loser.status, 0, `loser stderr: ${loser.stderr}`);
      assert.ok(fs.existsSync(pidFile), 'the loser DELETED the winner\'s tray.pid');
      const after = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      assert.equal(after.trayPid, first.trayPid, 'the winner\'s record was overwritten');
      assert.match(fs.readFileSync(path.join(dir, 'serve.log'), 'utf8'),
        /already holds port 48140 - exiting quietly/);
    } finally {
      // Nothing may survive this test, whatever failed above.
      const info = (() => {
        try { return JSON.parse(fs.readFileSync(pidFile, 'utf8')); } catch { return null; }
      })();
      for (const pid of [info && info.trayPid, info && info.serverPid, winner && winner.pid]) {
        if (Number.isInteger(pid) && pid > 0) {
          spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
        }
      }
    }
  });
});

/* ------------------------------- the CLI --------------------------------- */

describe('cli.js tray --dry-run', () => {
  /** Run the CLI inside a temp monitor dir. Nothing is started. */
  function runCli(label, extra) {
    const dir = path.join(tmp.dir, label);
    fs.mkdirSync(dir, { recursive: true });
    const env = { ...process.env, CLAUDE_MONITOR_DIR: dir, CLAUDE_CONFIG_DIR: dir };
    delete env.CLAUDE_MONITOR_PORT;
    return {
      dir,
      out: execFileSync(process.execPath, [CLI, ...extra], { env, encoding: 'utf8', windowsHide: true }),
    };
  }

  test('it prints the whole plan and starts nothing', () => {
    const { dir, out } = runCli('dry', ['tray', '--port', '48123', '--dry-run']);
    assert.match(out, /DRY RUN - nothing started/);
    assert.match(out, /port\s+: 48123/);
    assert.match(out, /would run\s+: wscript\.exe/);
    // The command the launcher runs is the thing worth reading before trusting.
    assert.match(out, /powershell\.exe -NoProfile .*-STA -WindowStyle Hidden/);
    assert.match(out, /-Port 48123/);
    // Nothing was written, not even the launcher it describes.
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('the dry run names the tray script, and says whether it is there', () => {
    const { out } = runCli('dry2', ['tray', '--port', '48124', '--dry-run']);
    assert.match(out, /tray script : .*claude-monitor-tray\.ps1 \(present\)/);
  });

  test('--json carries the same plan', () => {
    const { out } = runCli('dryjson', ['tray', '--port', '48125', '--dry-run', '--json']);
    const j = JSON.parse(out);
    assert.equal(j.dryRun, true);
    assert.equal(j.spawned, false);
    assert.equal(j.port, 48125);
    assert.equal(j.file, 'wscript.exe');
    assert.ok(j.trayPidFile.endsWith('tray.pid'));
    assert.ok(j.innerCommand.includes('-Port 48125'));
  });

  test('tray-stop with nothing running still asks, then reports nothing found', () => {
    // --port is given ON PURPOSE. With no tray.pid, tray-stop falls back to the
    // default port and signals THAT port's stop event - which is the right
    // product behaviour and exactly what must not happen from a test run: it
    // would shut down the developer's own tray mid-`npm test`.
    const { dir, out } = runCli('stop-none', ['tray-stop', '--port', '48132']);
    assert.match(out, /no tray host recorded/);
    assert.match(out, /nothing recorded/);
    assert.match(out, /no tray host was listening for the stop event on port 48132/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('tray-stop --dry-run reports a recorded tray without touching it', () => {
    const dir = path.join(tmp.dir, 'stop-dry');
    fs.mkdirSync(dir, { recursive: true });
    const pidFile = path.join(dir, 'tray.pid');
    fs.writeFileSync(pidFile, JSON.stringify({ trayPid: 999999, serverPid: 999998, port: 48126 }));
    const env = { ...process.env, CLAUDE_MONITOR_DIR: dir, CLAUDE_CONFIG_DIR: dir };
    delete env.CLAUDE_MONITOR_PORT;
    const out = execFileSync(process.execPath, [CLI, 'tray-stop', '--dry-run'],
      { env, encoding: 'utf8', windowsHide: true });
    assert.match(out, /DRY RUN - nothing signalled, nothing killed/);
    assert.match(out, /tray pid\s+: 999999/);
    assert.match(out, /port\s+: 48126/, 'the port comes from the pid file, not the default');
    assert.ok(fs.existsSync(pidFile), 'a dry run removes nothing');
  });

  test('install-autostart --dry-run says the tray is on and shows the command', () => {
    const { dir, out } = runCli('inst', ['install-autostart', '--port', '48127', '--dry-run']);
    assert.match(out, /tray\s+: ON/);
    assert.match(out, /-File ""[^"]*claude-monitor-tray\.ps1""/);
    assert.match(out, /a CRASHED SERVER IS RESTARTED by the tray host/);
    assert.match(out, /"\^" overflow/);
    assert.deepEqual(fs.readdirSync(dir), [], 'a dry run writes nothing');
  });

  test('--no-tray goes back to the direct command, with the old caveat', () => {
    const { out } = runCli('inst-notray', ['install-autostart', '--port', '48128', '--no-tray', '--dry-run']);
    assert.match(out, /tray\s+: OFF \(--no-tray\)/);
    assert.match(out, /serve --persist-token --port 48128/);
    assert.equal(out.includes('claude-monitor-tray.ps1'), false);
    assert.match(out, /Task Scheduler does NOT restart a crashed process/);
  });

  test('autostart-status has a tray line and stays read-only', () => {
    const { dir, out } = runCli('status', ['autostart-status']);
    assert.match(out, /^tray\s+: stopped \(no tray\.pid\)/m);
    assert.match(out, /^tray\.pid\s+: .*tray\.pid \(missing\)/m);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('autostart-status calls a pid file naming a dead process stale', () => {
    const dir = path.join(tmp.dir, 'status-stale');
    fs.mkdirSync(dir, { recursive: true });
    // 999999 is above Windows' PID range, so it can never be a live process.
    fs.writeFileSync(path.join(dir, 'tray.pid'), JSON.stringify({
      trayPid: 999999, trayName: 'powershell', trayStartedAt: '2026-09-04T00:00:00.000Z', port: 48129,
    }));
    const env = { ...process.env, CLAUDE_MONITOR_DIR: dir, CLAUDE_CONFIG_DIR: dir };
    delete env.CLAUDE_MONITOR_PORT;
    const out = execFileSync(process.execPath, [CLI, 'autostart-status'],
      { env, encoding: 'utf8', windowsHide: true });
    assert.match(out, /^tray\s+: stale tray\.pid \(pid 999999 gone\)/m);
  });

  test('autostart-status redacts the entry URL, and --show-url opts back in', () => {
    const dir = path.join(tmp.dir, 'status-url');
    fs.mkdirSync(dir, { recursive: true });
    const token = 'c'.repeat(64);
    fs.writeFileSync(path.join(dir, 'url.txt'), `http://127.0.0.1:48130/?t=${token}\n`);
    const env = { ...process.env, CLAUDE_MONITOR_DIR: dir, CLAUDE_CONFIG_DIR: dir };
    delete env.CLAUDE_MONITOR_PORT;
    const run = (extra) => execFileSync(process.execPath, [CLI, 'autostart-status', ...extra],
      { env, encoding: 'utf8', windowsHide: true });

    const plain = run([]);
    assert.match(plain, /last url    : http:\/\/127\.0\.0\.1:48130\/\?t=<redacted>/);
    assert.equal(plain.includes(token), false, 'the token reached stdout by default');
    assert.match(plain, /--show-url to see it/);

    const shown = run(['--show-url']);
    assert.ok(shown.includes(token), '--show-url must print the real URL');
  });

  test('autostart-status shouts when the launcher points at a missing file', () => {
    const dir = path.join(tmp.dir, 'status-moved');
    fs.mkdirSync(dir, { recursive: true });
    const gone = path.join(dir, 'moved-away', 'claude-monitor-tray.ps1');
    fs.writeFileSync(path.join(dir, 'autostart.json'), JSON.stringify({
      version: 1, tray: true, trayScript: gone, node: process.execPath, cli: CLI,
    }));
    const env = { ...process.env, CLAUDE_MONITOR_DIR: dir, CLAUDE_CONFIG_DIR: dir };
    delete env.CLAUDE_MONITOR_PORT;
    const out = execFileSync(process.execPath, [CLI, 'autostart-status'],
      { env, encoding: 'utf8', windowsHide: true });
    assert.match(out, /LAUNCHER POINTS AT A MISSING FILE/);
    assert.match(out, /trayScript: .*claude-monitor-tray\.ps1 \(MISSING\)/);
    assert.match(out, /the logon task will appear to succeed and start nothing/);
  });

  test('with no sidecar, autostart-status says the check is unavailable', () => {
    const { out } = runCli('status-nosidecar', ['autostart-status']);
    assert.match(out, /launcher pts: \(no autostart\.json - re-run install-autostart/);
  });

  test('a healthy sidecar reports every path present', () => {
    const dir = path.join(tmp.dir, 'status-ok');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'autostart.json'), JSON.stringify({
      version: 1, tray: true, trayScript: trayScriptPath(), node: process.execPath, cli: CLI,
    }));
    const env = { ...process.env, CLAUDE_MONITOR_DIR: dir, CLAUDE_CONFIG_DIR: dir };
    delete env.CLAUDE_MONITOR_PORT;
    const out = execFileSync(process.execPath, [CLI, 'autostart-status'],
      { env, encoding: 'utf8', windowsHide: true });
    assert.match(out, /launcher pts: every path it names still exists/);
  });

  test('tray-stop refuses to touch a pid file whose pid was reused', () => {
    // pid 4 is the Windows System process: it exists, it is not powershell, and
    // it is the most emphatic possible "do not kill this".
    const dir = path.join(tmp.dir, 'stop-reused');
    fs.mkdirSync(dir, { recursive: true });
    const pidFile = path.join(dir, 'tray.pid');
    fs.writeFileSync(pidFile, JSON.stringify({
      trayPid: 4, trayName: 'powershell', trayStartedAt: '2020-01-01T00:00:00.000Z',
      serverPid: 4, serverName: 'node', serverStartedAt: '2020-01-01T00:00:00.000Z',
      port: 48131,
    }));
    const env = { ...process.env, CLAUDE_MONITOR_DIR: dir, CLAUDE_CONFIG_DIR: dir };
    delete env.CLAUDE_MONITOR_PORT;
    const out = execFileSync(process.execPath, [CLI, 'tray-stop'],
      { env, encoding: 'utf8', windowsHide: true });
    assert.match(out, /NOTHING was signalled and NOTHING was killed/);
    assert.match(out, /tray pid   : 4 - /);
    assert.equal(fs.existsSync(pidFile), false, 'the stale record should be cleared');
  });

  test('uninstall-autostart --dry-run accounts for the sidecar too', () => {
    const { dir, out } = runCli('uninst', ['uninstall-autostart', '--dry-run']);
    assert.match(out, /sidecar   : .*autostart\.json \(missing\)/);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('the usage text documents both commands', () => {
    const out = execFileSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', windowsHide: true });
    assert.match(out, /^\s+tray \[--port N\] \[--no-wait\] \[--dry-run\]/m);
    assert.match(out, /^\s+tray-stop \[--dry-run\]/m);
    assert.match(out, /--no-tray/);
  });
});
