/**
 * The Windows logon task and its launcher.
 *
 * NOTHING here talks to the real Task Scheduler: every schtasks call goes
 * through an injected runner, and the launcher is written into a temp dir. The
 * one thing that cannot be unit-tested is whether Windows accepts the argv we
 * build - that was verified by running the generated .vbs by hand (see
 * docs/m3-verification.md); registration itself is the user's call.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeTmpDir } from './helpers.js';
import {
  TASK_NAME,
  vbsQuote,
  launcherCommand,
  buildLauncherVbs,
  toUtf16LeBom,
  taskArguments,
  buildTaskXml,
  escapeXml,
  currentUserSid,
  whoamiPath,
  createTaskArgs,
  deleteTaskArgs,
  queryTaskArgs,
  displayCommand,
  planAutostart,
  installAutostart,
  uninstallAutostart,
  autostartStatus,
  parseTaskXml,
  decodeConsole,
  cliPath,
} from '../src/autostart.js';

const NODE = 'C:\\Program Files\\nodejs\\node.exe';
const CLI = 'D:\\develop\\Claude監視\\src\\cli.js';
const LOG = 'C:\\Users\\alice\\.claude-monitor\\serve.log';
const VBS_NO_SPACE = 'C:\\Users\\alice\\.claude-monitor\\autostart.vbs';
const VBS_WITH_SPACE = 'C:\\My Files\\.claude-monitor\\autostart.vbs';

let tmp;
before(() => { tmp = makeTmpDir('cm-autostart'); });
after(() => { if (tmp) tmp.cleanup(); });

/** A schtasks stand-in. Records every call; returns whatever the test wants. */
function fakeRunner(reply = {}) {
  const calls = [];
  const run = (file, args) => {
    calls.push({ file, args });
    const r = typeof reply === 'function' ? reply(file, args) : reply;
    return { status: r.status ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error ?? null };
  };
  run.calls = calls;
  return run;
}

describe('the VBS launcher', () => {
  test('doubles the quotes so a path with a space survives', () => {
    assert.equal(vbsQuote('C:\\Program Files\\nodejs\\node.exe'), '""C:\\Program Files\\nodejs\\node.exe""');
  });

  test('refuses a path that could break out of the string literal', () => {
    assert.throws(() => vbsQuote('C:\\a"b'), /containing a quote/);
    assert.throws(() => vbsQuote('C:\\a\nb'), /containing a newline/);
    assert.throws(() => vbsQuote('C:\\a\rb'), /containing a newline/);
  });

  // The DIRECT command, which `--no-tray` selects. The tray host is the default
  // now and has its own suite in test/tray.test.js.
  test('--no-tray quotes node, the cli and the log, and asks for a stored token', () => {
    const cmd = launcherCommand({ node: NODE, cli: CLI, port: 47321, logFile: LOG, tray: false });
    assert.equal(
      cmd,
      '""C:\\Program Files\\nodejs\\node.exe"" ""D:\\develop\\Claude監視\\src\\cli.js"" ' +
      'serve --persist-token --port 47321 --log-file ""C:\\Users\\alice\\.claude-monitor\\serve.log""',
    );
  });

  test('it does NOT pass --open: a hidden instance must not launch a browser', () => {
    const vbs = buildLauncherVbs({ node: NODE, cli: CLI, port: 47321, logFile: LOG });
    assert.equal(vbs.includes('--open'), false);
  });

  test('the script hides the window and does not wait', () => {
    const vbs = buildLauncherVbs({ node: NODE, cli: CLI, port: 47321, logFile: LOG });
    assert.match(vbs, /Set sh = CreateObject\("WScript\.Shell"\)/);
    // 0 = hidden, False = fire and forget. Both matter: a visible window at
    // logon is the whole problem, and waiting would keep the task "running".
    assert.match(vbs, /sh\.Run cmd, 0, False/);
    assert.match(vbs, /^Option Explicit$/m);
  });

  test('every line ends CRLF - it is a Windows Script Host file', () => {
    const vbs = buildLauncherVbs({ node: NODE, cli: CLI, port: 1, logFile: LOG });
    const lines = vbs.split('\r\n');
    assert.ok(lines.length > 5);
    // No bare LF anywhere.
    assert.equal(/[^\r]\n/.test(vbs), false);
  });

  test('the port lands in the direct command', () => {
    const vbs = buildLauncherVbs({ node: NODE, cli: CLI, port: 48000, logFile: LOG, tray: false });
    assert.ok(vbs.includes('--port 48000'));
  });
});

describe('UTF-16LE with BOM', () => {
  test('the BOM is there and the text round-trips', () => {
    const vbs = buildLauncherVbs({ node: NODE, cli: CLI, port: 47321, logFile: LOG });
    const buf = toUtf16LeBom(vbs);
    assert.equal(buf[0], 0xff);
    assert.equal(buf[1], 0xfe);
    assert.equal(buf.subarray(2).toString('utf16le'), vbs);
    assert.equal(buf.length, 2 + vbs.length * 2, 'two bytes per BMP code unit');
  });

  test('the Japanese path survives - this is the whole reason for the encoding', () => {
    // Decoded as ANSI (what wscript does without a BOM) this path would point
    // at a directory that does not exist, and the task would silently do nothing.
    const buf = toUtf16LeBom(buildLauncherVbs({ node: NODE, cli: CLI, port: 1, logFile: LOG }));
    const back = buf.subarray(2).toString('utf16le');
    assert.ok(back.includes('Claude監視'));
    assert.equal(back.includes('Claude??'), false);
  });

  test('what is written to disk is byte-identical to what was planned', () => {
    const launcher = path.join(tmp.dir, 'write-check', 'autostart.vbs');
    const runner = fakeRunner({ status: 0, stdout: 'SUCCESS' });
    const res = installAutostart({ launcher, node: NODE, port: 47321, logFile: LOG, run: runner });
    assert.equal(res.launcherWritten, true);
    const onDisk = fs.readFileSync(launcher);
    assert.deepEqual(onDisk, toUtf16LeBom(res.vbs));
    assert.equal(onDisk[0], 0xff);
    assert.equal(onDisk[1], 0xfe);
  });
});

describe('the schtasks argv', () => {
  const XML = 'C:\\Users\\alice\\.claude-monitor\\autostart.xml';

  test('registers from an XML file, NOT with /SC ONLOGON', () => {
    // Measured non-elevated on this machine: `/SC ONLOGON` exits 1 with
    // "access denied", because an ONLOGON trigger with no user attached fires
    // for every user and creating one is an administrative act. There is no
    // schtasks flag that narrows it (/RU sets who it runs AS), so the XML form
    // is the only one that can express a per-user logon task without elevation.
    const args = createTaskArgs({ xmlFile: XML });
    assert.deepEqual(args, ['/Create', '/TN', 'claude-monitor', '/XML', XML, '/F']);
    assert.equal(args.includes('/SC'), false);
    assert.equal(args.includes('/TR'), false);
    assert.equal(args.includes('/RL'), false);
  });

  test('the action arguments quote the launcher path', () => {
    assert.equal(taskArguments(VBS_NO_SPACE), `"${VBS_NO_SPACE}"`);
    assert.equal(taskArguments(VBS_WITH_SPACE), `"${VBS_WITH_SPACE}"`);
    // Real quotes, never pre-escaped: Task Scheduler hands the decoded string
    // to CreateProcess, so a backslash-quote here would reach wscript literally.
    assert.equal(taskArguments(VBS_WITH_SPACE).includes('\\"'), false);
  });

  test('a launcher path that could break out of the command line is refused', () => {
    // Same rule as the VBS literal: a quote here would close ours and turn the
    // rest of the path into further arguments, once per logon forever. XML
    // escaping would hide it rather than fix it, so it is refused first.
    assert.throws(() => taskArguments('C:\\a"b\\autostart.vbs'), /containing a quote/);
    assert.throws(() => taskArguments('C:\\a\nb\\autostart.vbs'), /containing a newline/);
    assert.throws(() => taskArguments('C:\\a\rb\\autostart.vbs'), /containing a newline/);
    assert.throws(() => buildTaskXml({ launcher: 'C:\\a"b.vbs' }), /containing a quote/);
  });

  test('delete and query only ever name our own task', () => {
    assert.deepEqual(deleteTaskArgs(), ['/Delete', '/TN', TASK_NAME, '/F']);
    assert.deepEqual(queryTaskArgs(), ['/Query', '/TN', TASK_NAME, '/XML', 'ONE']);
  });

  test('the displayed line is copy-pasteable', () => {
    const spaced = 'C:\\My Files\\.claude-monitor\\autostart.xml';
    assert.equal(
      displayCommand(createTaskArgs({ xmlFile: spaced })),
      `schtasks /Create /TN claude-monitor /XML "${spaced}" /F`,
    );
    const line = displayCommand(createTaskArgs({ xmlFile: XML }));
    assert.equal(line.includes('"'), false, 'a path with no space needs no quoting');
  });
});

describe('the task XML', () => {
  const opts = { launcher: VBS_NO_SPACE, userId: 'MYPC\\alice', principalId: 'S-1-5-21-1-2-3-1001' };

  test('the trigger is per-user - the one element that avoids needing admin', () => {
    const xml = buildTaskXml(opts);
    assert.match(xml, /<LogonTrigger>\s*<Enabled>true<\/Enabled>\s*<UserId>MYPC\\alice<\/UserId>/);
  });

  test('the trigger is delayed so the notification area exists first', () => {
    assert.match(buildTaskXml(opts), /<Delay>PT10S<\/Delay>/);
  });

  test('ExecutionTimeLimit is PT0S - the default would kill the tray after 72h', () => {
    // The single most important setting here: a supervisor the scheduler stops
    // every third day is worse than none.
    assert.match(buildTaskXml(opts), /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  });

  test('the settings that keep it running are all present', () => {
    const xml = buildTaskXml(opts);
    assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
    assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/);
    assert.match(xml, /<StopIfGoingOnBatteries>false<\/StopIfGoingOnBatteries>/);
    assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  });

  test('the principal runs unelevated with an interactive token', () => {
    const xml = buildTaskXml(opts);
    assert.match(xml, /<UserId>S-1-5-21-1-2-3-1001<\/UserId>/);
    assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
    assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/);
  });

  test('the action runs wscript on the quoted launcher', () => {
    const xml = buildTaskXml({ ...opts, launcher: VBS_WITH_SPACE });
    assert.match(xml, /<Command>wscript\.exe<\/Command>/);
    assert.match(xml, /<Arguments>&quot;C:\\My Files\\\.claude-monitor\\autostart\.vbs&quot;<\/Arguments>/);
  });

  test('it declares UTF-16 and carries a description', () => {
    const xml = buildTaskXml(opts);
    assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-16"?>'));
    assert.match(xml, /<Description>claude-monitor tray host/);
  });

  test('elements are in schema order - the scheduler rejects them otherwise', () => {
    const xml = buildTaskXml(opts);
    const at = (tag) => xml.indexOf(`<${tag}`);
    assert.ok(at('RegistrationInfo') < at('Triggers'));
    assert.ok(at('Triggers') < at('Principals'));
    assert.ok(at('Principals') < at('Settings'));
    assert.ok(at('Settings') < at('Actions'));
    // Within the trigger: Enabled, then UserId, then Delay.
    assert.ok(xml.indexOf('<Enabled>') < xml.indexOf('<UserId>'));
    assert.ok(xml.indexOf('<UserId>') < xml.indexOf('<Delay>'));
  });

  test('a Japanese path survives - UTF-16 has no trouble with it', () => {
    const xml = buildTaskXml({ ...opts, launcher: 'D:\\develop\\Claude監視\\autostart.vbs' });
    assert.ok(xml.includes('D:\\develop\\Claude監視\\autostart.vbs'));
    const bytes = toUtf16LeBom(xml);
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
    assert.ok(bytes.subarray(2).toString('utf16le').includes('Claude監視'));
  });

  test('every interpolated value is XML-escaped', () => {
    assert.equal(escapeXml('a & b < c > d " e'), 'a &amp; b &lt; c &gt; d &quot; e');
    // A domain or account name is user-controlled enough to matter.
    const xml = buildTaskXml({ ...opts, userId: 'DOM&AIN\\a<b>' });
    assert.match(xml, /<UserId>DOM&amp;AIN\\a&lt;b&gt;<\/UserId>/);
    assert.equal(xml.includes('DOM&AIN'), false);
  });

  test('the SID is read from whoami, with the account name as the fallback', () => {
    const ok = { status: 0, stdout: '"mypc\\alice","S-1-5-21-9-8-7-1001"\r\n' };
    assert.equal(currentUserSid({ run: () => ok }), 'S-1-5-21-9-8-7-1001');
    // Git for Windows ships an MSYS `whoami` that does not understand /user and
    // exits 1 - observed here. A failure must fall back, not throw.
    assert.equal(currentUserSid({ run: () => ({ status: 1, stdout: '', stderr: 'extra operand' }) }), null);
    assert.equal(currentUserSid({ run: () => { throw new Error('nope'); } }), null);
  });

  test('with no SID the principal falls back to DOMAIN\\user', () => {
    const xml = buildTaskXml({ launcher: VBS_NO_SPACE, userId: 'DESKTOP\\bob', principalId: '' });
    // Both UserId elements are then the account name, which the scheduler also
    // accepts; installAutostart says which form it used.
    assert.equal((xml.match(/<UserId>DESKTOP\\bob<\/UserId>/g) || []).length, 2);
  });

  test('whoami is resolved out of System32, not off PATH', () => {
    const p = whoamiPath();
    assert.match(p, /whoami\.exe$/);
    if (process.platform === 'win32') assert.ok(path.isAbsolute(p), 'a bare name would find Git\'s MSYS whoami');
  });
});

describe('planAutostart', () => {
  test('resolves node, the cli and the defaults without touching disk', () => {
    const plan = planAutostart({ port: 47399, launcher: path.join(tmp.dir, 'plan.vbs') });
    assert.equal(plan.taskName, TASK_NAME);
    assert.equal(plan.port, 47399);
    assert.equal(plan.node, process.execPath, 'the absolute node.exe, resolved at install time');
    assert.equal(plan.cli, cliPath());
    assert.ok(path.isAbsolute(plan.cli));
    assert.equal(fs.existsSync(plan.cli), true, 'the cli path it will run actually exists');
    assert.equal(plan.vbsEncoding, 'UTF-16LE with BOM');
    assert.equal(plan.vbsBytes, toUtf16LeBom(plan.vbs).length);
    assert.equal(plan.schtasks.file, 'schtasks');
    assert.equal(fs.existsSync(plan.launcher), false, 'planning writes nothing');
  });

  test('the default port is the one serve uses', () => {
    assert.equal(planAutostart({ launcher: path.join(tmp.dir, 'p2.vbs') }).port, 47321);
  });
});

describe('install (dry run vs real)', () => {
  test('a dry run writes nothing and runs nothing', () => {
    const launcher = path.join(tmp.dir, 'dry', 'autostart.vbs');
    const runner = fakeRunner();
    const res = installAutostart({ launcher, dryRun: true, run: runner, node: NODE, logFile: LOG });
    assert.equal(res.dryRun, true);
    assert.equal(res.launcherWritten, false);
    assert.equal(res.schtasksRun, false);
    assert.equal(runner.calls.length, 0, 'schtasks was not invoked');
    assert.equal(fs.existsSync(launcher), false);
    // ...but it still shows exactly what it WOULD do.
    assert.ok(res.schtasks.display.startsWith('schtasks /Create /TN claude-monitor'));
    assert.ok(res.vbs.includes('sh.Run cmd, 0, False'));
  });

  test('a real install writes the launcher then registers the task, in that order', () => {
    const launcher = path.join(tmp.dir, 'real', 'autostart.vbs');
    const runner = fakeRunner((file, args) => {
      // The launcher must already exist by the time schtasks is called;
      // registering a task that points at nothing is worse than not registering.
      assert.equal(fs.existsSync(launcher), true, 'launcher written before schtasks');
      assert.equal(args[0], '/Create');
      return { status: 0, stdout: 'SUCCESS: ...' };
    });
    const res = installAutostart({ launcher, run: runner, node: NODE, logFile: LOG, port: 47321 });
    assert.equal(res.launcherWritten, true);
    assert.equal(res.schtasksRun, true);
    assert.equal(res.ok, true);
    assert.equal(res.code, 0);
    assert.equal(runner.calls.length, 1);
  });

  test('a real install writes the XML and the sidecar BESIDE the launcher', () => {
    // Not beside monitorDir(). Redirecting the launcher is how these tests stay
    // out of the user's real ~/.claude-monitor, and all three files have to
    // follow it - otherwise `npm test` writes into the profile directory.
    const dir = path.join(tmp.dir, 'beside');
    const launcher = path.join(dir, 'autostart.vbs');
    const res = installAutostart({
      launcher, run: fakeRunner({ status: 0 }), node: NODE, logFile: LOG, principalId: 'S-1-5-21-1-2-3-1001',
    });
    assert.equal(res.xmlFile, path.join(dir, 'autostart.xml'));
    assert.equal(res.launcherInfoFile, path.join(dir, 'autostart.json'));
    assert.equal(res.xmlWritten, true);
    assert.equal(res.launcherInfoWritten, true);
    assert.deepEqual(fs.readdirSync(dir).sort(), ['autostart.json', 'autostart.vbs', 'autostart.xml']);
    // The XML on disk is UTF-16LE with a BOM, matching its own declaration.
    const bytes = fs.readFileSync(res.xmlFile);
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xfe]);
    assert.ok(bytes.subarray(2).toString('utf16le').startsWith('<?xml version="1.0" encoding="UTF-16"?>'));
  });

  test('a dry run writes neither the XML nor the sidecar', () => {
    const dir = path.join(tmp.dir, 'dry-all');
    const res = installAutostart({
      launcher: path.join(dir, 'autostart.vbs'), dryRun: true,
      run: fakeRunner(), node: NODE, logFile: LOG, principalId: 'S-1-5-21-1-2-3-1001',
    });
    assert.equal(res.xmlWritten, false);
    assert.equal(res.launcherInfoWritten, false);
    assert.equal(fs.existsSync(dir), false, 'a dry run does not even create the directory');
    // But it shows the XML it would have written.
    assert.match(res.xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/);
  });

  test('uninstall removes the XML along with the launcher and the sidecar', () => {
    const dir = path.join(tmp.dir, 'uninst-all');
    const launcher = path.join(dir, 'autostart.vbs');
    installAutostart({
      launcher, run: fakeRunner({ status: 0 }), node: NODE, logFile: LOG, principalId: 'S-1-5-21-1-2-3-1001',
    });
    const res = uninstallAutostart({
      launcher,
      launcherInfo: path.join(dir, 'autostart.json'),
      xmlFile: path.join(dir, 'autostart.xml'),
      run: fakeRunner({ status: 0 }),
    });
    assert.equal(res.launcherRemoved, true);
    assert.equal(res.launcherInfoRemoved, true);
    assert.equal(res.xmlRemoved, true);
    assert.deepEqual(fs.readdirSync(dir), []);
  });

  test('a schtasks failure is reported, not swallowed', () => {
    const launcher = path.join(tmp.dir, 'fails', 'autostart.vbs');
    const runner = fakeRunner({ status: 1, stderr: 'ERROR: Access is denied.' });
    const res = installAutostart({ launcher, run: runner, node: NODE, logFile: LOG });
    assert.equal(res.ok, false);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /Access is denied/);
  });
});

describe('uninstall', () => {
  test('a dry run reports the delete command and removes nothing', () => {
    const launcher = path.join(tmp.dir, 'uninst.vbs');
    fs.writeFileSync(launcher, 'x');
    const runner = fakeRunner();
    const res = uninstallAutostart({ launcher, dryRun: true, run: runner });
    assert.equal(res.dryRun, true);
    assert.equal(res.launcherRemoved, false);
    assert.equal(runner.calls.length, 0);
    assert.equal(fs.existsSync(launcher), true);
    assert.equal(res.schtasks.display, `schtasks /Delete /TN ${TASK_NAME} /F`);
  });

  test('a real uninstall deletes the task and the launcher', () => {
    const launcher = path.join(tmp.dir, 'uninst-real.vbs');
    fs.writeFileSync(launcher, 'x');
    const runner = fakeRunner({ status: 0, stdout: 'SUCCESS' });
    const res = uninstallAutostart({ launcher, run: runner });
    assert.deepEqual(runner.calls[0].args, ['/Delete', '/TN', TASK_NAME, '/F']);
    assert.equal(res.launcherRemoved, true);
    assert.equal(fs.existsSync(launcher), false);
  });

  test('a dry run reports whether the launcher is actually there', () => {
    // The CLI prints "(would be removed)" off this flag; promising to remove a
    // file that does not exist reads as "it exists" to anyone following along.
    const present = path.join(tmp.dir, 'uninst-present.vbs');
    fs.writeFileSync(present, 'x');
    assert.equal(uninstallAutostart({ launcher: present, dryRun: true, run: fakeRunner() }).launcherExists, true);
    const absent = path.join(tmp.dir, 'uninst-never-existed.vbs');
    assert.equal(uninstallAutostart({ launcher: absent, dryRun: true, run: fakeRunner() }).launcherExists, false);
    assert.equal(fs.existsSync(present), true, 'a dry run still removes nothing');
  });

  test('"there was no such task" is not an error worth shouting about', () => {
    const launcher = path.join(tmp.dir, 'uninst-none.vbs');
    const runner = fakeRunner({ status: 1, stderr: 'ERROR: The system cannot find the file specified.' });
    const res = uninstallAutostart({ launcher, run: runner });
    assert.equal(res.ok, false);
    assert.equal(res.launcherRemoved, false, 'nothing to remove');
    assert.match(res.stderr, /cannot find/);
  });
});

describe('status', () => {
  const TASK_XML = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>MYPC\\alice</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>MYPC\\alice</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>C:\\Users\\alice\\.claude-monitor\\autostart.vbs</Arguments>
    </Exec>
  </Actions>
</Task>`;

  test('reads the facts out of the task XML', () => {
    const runner = fakeRunner((file, args) =>
      (args.includes('/XML') ? { status: 0, stdout: TASK_XML } : { status: 0, stdout: 'raw list output' }));
    const st = autostartStatus({ run: runner });
    assert.equal(st.installed, true);
    assert.equal(st.onLogon, true);
    assert.equal(st.enabled, true);
    assert.equal(st.command, 'wscript.exe');
    assert.equal(st.arguments, 'C:\\Users\\alice\\.claude-monitor\\autostart.vbs');
    assert.equal(st.runLevel, 'LeastPrivilege');
    assert.equal(st.raw, 'raw list output');
  });

  test('XML, not the localised list output', () => {
    // /FO LIST field names come back in Japanese on this machine, so parsing
    // them would work in one locale and silently return nothing in another.
    const runner = fakeRunner({ status: 0, stdout: TASK_XML });
    autostartStatus({ run: runner });
    assert.ok(runner.calls[0].args.includes('/XML'));
  });

  test('a missing task is "not installed", with the reason kept', () => {
    const runner = fakeRunner({ status: 1, stderr: 'ERROR: The system cannot find the file specified.' });
    const st = autostartStatus({ run: runner });
    assert.equal(st.installed, false);
    assert.equal(st.onLogon, false);
    assert.equal(st.command, null);
    assert.match(st.queryError, /cannot find/);
    assert.equal(runner.calls.length, 1, 'no point asking for details of a task that is not there');
  });

  test('it never writes or changes anything', () => {
    const runner = fakeRunner({ status: 0, stdout: TASK_XML });
    autostartStatus({ run: runner });
    for (const call of runner.calls) {
      assert.equal(call.args[0], '/Query', `status ran ${call.args[0]}`);
    }
  });

  test('parseTaskXml survives junk instead of throwing', () => {
    for (const junk of ['', 'not xml at all', '<Task>', null, undefined]) {
      const r = parseTaskXml(junk);
      assert.equal(r.command, null);
      assert.equal(r.onLogon, false);
    }
  });

  test('XML entities in a path are decoded', () => {
    const r = parseTaskXml('<Arguments>C:\\a &amp; b\\x.vbs</Arguments>');
    assert.equal(r.arguments, 'C:\\a & b\\x.vbs');
  });
});

describe('console decoding', () => {
  test('plain ASCII and UTF-8 pass straight through', () => {
    assert.equal(decodeConsole(Buffer.from('SUCCESS: done', 'utf8')), 'SUCCESS: done');
    assert.equal(decodeConsole(Buffer.from('監視 ok', 'utf8')), '監視 ok');
  });

  test('a CP932 error message is read, not turned into replacement characters', () => {
    // What schtasks actually prints on this machine when the task is absent.
    const cp932 = Buffer.from([
      0x83, 0x47, 0x83, 0x89, 0x81, 0x5b, 0x3a, 0x20, // エラー:
      0x4f, 0x4b,
    ]);
    const text = decodeConsole(cp932);
    assert.ok(text.startsWith('エラー'), JSON.stringify(text));
    assert.equal(text.includes('\uFFFD'), false);
  });

  test('a UTF-16LE BOM is honoured', () => {
    const buf = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('hi 監視', 'utf16le')]);
    assert.equal(decodeConsole(buf), 'hi 監視');
  });

  test('empty input is an empty string', () => {
    assert.equal(decodeConsole(Buffer.alloc(0)), '');
    assert.equal(decodeConsole(null), '');
  });
});
