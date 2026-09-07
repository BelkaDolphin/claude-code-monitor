/**
 * The CLI as it is actually run: spawned, with the token-bearing commands.
 *
 * `serve` is started at logon by a launcher that always passes --log-file, so
 * every hidden run appends to <monitorDir>/serve.log. That file survives
 * restarts, keeps a rotated generation and is readable by anything that can
 * read the profile directory - so the one thing it must never contain is the
 * live bearer token the dashboard is protected by. `rotate-token` is the other
 * half: it is run bare, long after serve chose a port, and the URL it writes
 * has to name that port rather than the default.
 *
 * Isolation: CLAUDE_MONITOR_DIR and CLAUDE_CONFIG_DIR both point into a temp
 * dir and the port is 0 (an ephemeral one the OS picks), so nothing here reads
 * or writes the real ~/.claude-monitor and nothing binds the user's port.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { makeTmpDir } from './helpers.js';
import { parseArgs, boolFlag, pathFlag, countFlag, FLAGS, flagsNamedIn, usageText } from '../src/cli.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli.js');
const ENTRY_URL = /http:\/\/127\.0\.0\.1:(\d+)\/\?t=([0-9a-f]{64})/;

let tmp;
before(() => { tmp = makeTmpDir('cm-cli-serve'); });
after(() => { if (tmp) tmp.cleanup(); });

/** The environment that keeps a run inside its own temp dir. */
function envFor(monitor, claude) {
  const env = { ...process.env, CLAUDE_MONITOR_DIR: monitor, CLAUDE_CONFIG_DIR: claude };
  // Never inherit a port choice from the shell running the tests.
  delete env.CLAUDE_MONITOR_PORT;
  return env;
}

/**
 * Spawn `serve` and hand back a handle: `ready` resolves once it has printed
 * everything it prints, `stop()` kills it and resolves when it is gone.
 *
 * Waiting for the LAST line rather than the first keeps the kill from racing
 * the output: a killed process loses whatever its pipes had not flushed, which
 * would fail these tests for a reason that has nothing to do with what they are
 * checking.
 *
 * @param {{label: string, json?: boolean, persist?: boolean, port?: number|string, log?: boolean}} opts
 */
function startServe(opts) {
  const dir = path.join(tmp.dir, opts.label);
  const monitor = path.join(dir, 'monitor');
  const claude = path.join(dir, 'claude');
  const logFile = path.join(dir, 'logs', 'serve.log');
  fs.mkdirSync(monitor, { recursive: true });
  fs.mkdirSync(claude, { recursive: true });

  const args = [CLI, 'serve', '--port', String(opts.port ?? 0)];
  if (opts.persist !== false) args.push('--persist-token');
  if (opts.log !== false) args.push('--log-file', logFile);
  if (opts.json) args.push('--json');

  const child = spawn(process.execPath, args, {
    env: envFor(monitor, claude), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '';
  let stderr = '';
  let done = false;

  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`serve printed no url in 30s.\nstdout: ${stdout}\nstderr: ${stderr}`));
    }, 30000);
    const check = () => {
      if (done) return;
      if (!ENTRY_URL.test(stdout)) return;
      if (opts.json !== true && !stderr.includes('Ctrl+C to stop.')) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr });
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => { stdout += c; check(); });
    child.stderr.on('data', (c) => { stderr += c; check(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    // A server that dies on its own should fail here and now, with its output,
    // rather than 30 seconds later with nothing to look at.
    child.on('exit', (code, signal) => {
      if (done) return;
      clearTimeout(timer);
      reject(new Error(`serve exited early (code ${code}, signal ${signal}).\nstdout: ${stdout}\nstderr: ${stderr}`));
    });
  });

  const stop = () => new Promise((resolve) => {
    done = true;
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => resolve());
    child.kill();
  });

  return { dir, monitor, claude, logFile, ready, stop };
}

/**
 * Start `serve`, let it announce itself, stop it, then read what it left on
 * disk. The log is read only after the child is gone: it holds the fd open, and
 * on Windows the temp dir cannot be removed while it does.
 * @param {{label: string, json?: boolean, persist?: boolean}} opts
 */
async function serveOnce(opts) {
  const run = startServe(opts);
  const { stdout, stderr } = await run.ready;
  await run.stop();
  return {
    dir: run.dir,
    monitor: run.monitor,
    logFile: run.logFile,
    stdout,
    stderr,
    log: readText(run.logFile),
    urlFile: readText(path.join(run.monitor, 'url.txt')),
  };
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

describe('serve --log-file never records the token', () => {
  test('the plain output shows the URL on the console and not in the log', async () => {
    const r = await serveOnce({ label: 'plain' });
    const m = ENTRY_URL.exec(r.stdout);
    assert.ok(m, `no url on stdout: ${r.stdout}`);
    const token = m[2];

    assert.ok(r.log.length > 0, 'the log was written at all');
    assert.equal(r.log.includes(token), false, `the live token is in the log:\n${r.log}`);
    assert.equal(r.log.includes('?t='), false, `an entry URL is in the log:\n${r.log}`);
    assert.ok(r.log.includes('?<token redacted>'), `no redacted url in the log:\n${r.log}`);

    // ...while everything else a hidden instance needs is still there. This is
    // the whole reason the tee exists.
    assert.ok(r.log.includes('claude-monitor serving on 127.0.0.1:'), r.log);
    assert.ok(r.stderr.includes('claude-monitor serving on 127.0.0.1:'), r.stderr);

    // url.txt is the supported on-disk copy, and it is in the temp dir - the
    // real ~/.claude-monitor was never touched.
    assert.ok(r.urlFile.includes(token), 'url.txt still carries the bookmarkable url');
    assert.ok(r.urlFile.startsWith('http://127.0.0.1:'));
  });

  test('--json puts the url on stdout and a redacted copy in the log', async () => {
    const r = await serveOnce({ label: 'json', json: true });
    const m = ENTRY_URL.exec(r.stdout);
    assert.ok(m, `no url on stdout: ${r.stdout}`);
    const payload = JSON.parse(r.stdout.trim().split('\n').find((l) => l.startsWith('{')));
    assert.equal(payload.ok, true);
    assert.equal(payload.url, m[0]);
    assert.notEqual(payload.port, 47321, 'the test never binds the real port');

    assert.equal(r.log.includes(m[2]), false, `the live token is in the log:\n${r.log}`);
    assert.equal(r.log.includes('?t='), false, `an entry URL is in the log:\n${r.log}`);
    assert.ok(r.log.includes('"ok":true'), `the payload itself is still logged:\n${JSON.stringify(r.log)}`);
  });
});

describe('a serve that cannot have the port changes nothing', () => {
  test('the loser leaves the running server its token and its bookmark', async () => {
    const first = startServe({ label: 'busy' });
    const { stdout } = await first.ready;
    try {
      const port = Number(ENTRY_URL.exec(stdout)[1]);
      const tokenFile = path.join(first.monitor, 'token');
      const urlFile = path.join(first.monitor, 'url.txt');
      const before = { token: fs.readFileSync(tokenFile), url: fs.readFileSync(urlFile) };

      // --rotate-token makes the old ordering unmistakably destructive: it
      // replaced the secret of the server that is actually serving, and only
      // then discovered the port was taken. No --log-file either, so a run that
      // touches nothing really does touch nothing.
      const second = spawnSync(
        process.execPath,
        [CLI, 'serve', '--port', String(port), '--persist-token', '--rotate-token'],
        { env: envFor(first.monitor, first.claude), encoding: 'utf8', windowsHide: true },
      );

      assert.equal(second.status, 1, `stdout: ${second.stdout}\nstderr: ${second.stderr}`);
      assert.match(second.stderr, /already in use/);
      assert.deepEqual(fs.readFileSync(tokenFile), before.token, 'the running server keeps its token');
      assert.deepEqual(fs.readFileSync(urlFile), before.url, 'and the bookmark still points at it');
      assert.deepEqual(
        fs.readdirSync(first.monitor).sort(), ['token', 'url.txt'],
        'and nothing else was created',
      );
    } finally {
      await first.stop();
    }
  });

  test('a run with no persisted token leaves no URL on disk', async () => {
    // A per-process token dies with the process, so url.txt would be a file
    // that looks like a way in, is not one, and that rotate-token would then
    // read a port out of.
    const r = await serveOnce({ label: 'ephemeral', persist: false });
    assert.match(r.stdout, ENTRY_URL, 'the console still shows the one-off URL');
    assert.equal(fs.existsSync(path.join(r.monitor, 'url.txt')), false, 'no dead URL on disk');
    assert.equal(fs.existsSync(path.join(r.monitor, 'token')), false, 'and no stored token');
    assert.match(r.stderr, /token: per-process/);
  });
});

/**
 * Run a command that exits by itself, isolated to its own monitor dir.
 *
 * `seedUrl` stands in for a previous persistent serve, which writes url.txt and
 * the token file together; `seedToken: false` seeds only url.txt, the leftover
 * shape that must not be trusted.
 * @param {{label: string, args: string[], seedUrl?: string, seedToken?: boolean}} opts
 */
function runCli(opts) {
  const monitor = path.join(tmp.dir, opts.label, 'monitor');
  fs.mkdirSync(monitor, { recursive: true });
  if (opts.seedUrl) {
    fs.writeFileSync(path.join(monitor, 'url.txt'), `${opts.seedUrl}\n`, 'utf8');
    if (opts.seedToken !== false) fs.writeFileSync(path.join(monitor, 'token'), `${'0'.repeat(64)}\n`, 'utf8');
  }
  const env = { ...process.env, CLAUDE_MONITOR_DIR: monitor, CLAUDE_CONFIG_DIR: path.join(tmp.dir, opts.label, 'claude') };
  delete env.CLAUDE_MONITOR_PORT;
  const stdout = execFileSync(process.execPath, [CLI, ...opts.args], { env, encoding: 'utf8', windowsHide: true });
  return { monitor, stdout, urlFile: readText(path.join(monitor, 'url.txt')) };
}

describe('rotate-token names the port the server was started on', () => {
  test('the port comes from the url the last serve wrote', () => {
    // The failure this prevents: serve was started with --port 48123, rotate is
    // run bare, and the new url.txt silently points at 47321 - a URL that
    // connects to nothing and looks like the rotation broke the dashboard.
    const r = runCli({
      label: 'rotate-recorded',
      args: ['rotate-token', '--json'],
      seedUrl: `http://127.0.0.1:48123/?t=${'0'.repeat(64)}`,
    });
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.port, 48123);
    assert.equal(payload.portGuessed, false);
    assert.ok(payload.portSource.endsWith('url.txt'), payload.portSource);
    assert.match(payload.url, /^http:\/\/127\.0\.0\.1:48123\/\?t=[0-9a-f]{64}$/);
    assert.equal(r.urlFile.trim(), payload.url, 'url.txt was rewritten with the same port');
    assert.equal(r.urlFile.includes('0'.repeat(64)), false, 'the old token is gone');
  });

  test('an explicit --port still wins over the recorded one', () => {
    const r = runCli({
      label: 'rotate-flag',
      args: ['rotate-token', '--json', '--port', '49000'],
      seedUrl: `http://127.0.0.1:48123/?t=${'0'.repeat(64)}`,
    });
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.port, 49000);
    assert.equal(payload.portSource, '--port');
    assert.equal(payload.portGuessed, false);
  });

  test('with nothing to go on it says so instead of guessing quietly', () => {
    const r = runCli({ label: 'rotate-blind', args: ['rotate-token', '--json'] });
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.port, 47321, 'the documented default');
    assert.equal(payload.portSource, 'default');
    assert.equal(payload.portGuessed, true);
  });

  test('the human-readable form carries the warning, not just the flag', () => {
    const r = runCli({ label: 'rotate-blind-text', args: ['rotate-token'] });
    assert.match(r.stdout, /WARNING: no port was given/);
    assert.match(r.stdout, /re-run with the same --port N/);
    assert.match(r.stdout, /port 47321 \(from default\)/);
    // The one thing rotation cannot do, said plainly.
    assert.match(r.stdout, /ALREADY RUNNING still holds the previous token in memory/);
  });

  test('a recorded port produces no warning', () => {
    const r = runCli({
      label: 'rotate-quiet',
      args: ['rotate-token'],
      seedUrl: `http://127.0.0.1:48123/?t=${'0'.repeat(64)}`,
    });
    assert.equal(r.stdout.includes('WARNING'), false, r.stdout);
    assert.match(r.stdout, /port 48123 \(from /);
  });

  test('a url.txt with no token file beside it is a leftover, not evidence', () => {
    // serve writes the two together and only for a persisted token, so this
    // shape can only come from a build that wrote url.txt for a per-process
    // token - whose port was real but whose URL never was.
    const r = runCli({
      label: 'rotate-stale',
      args: ['rotate-token', '--json'],
      seedUrl: `http://127.0.0.1:48123/?t=${'0'.repeat(64)}`,
      seedToken: false,
    });
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.port, 47321);
    assert.equal(payload.portSource, 'default');
    assert.equal(payload.portGuessed, true);
  });
});

describe('the flags that decide whether there is a log at all', () => {
  const fallback = 'C:\\fallback\\serve.log';

  test('--log-file with a path resolves it', () => {
    const args = parseArgs(['serve', '--log-file', 'out.log']);
    assert.equal(pathFlag(args, 'log-file', fallback), path.resolve('out.log'));
  });

  test('--log-file as the LAST argument means the default path', () => {
    // parseArgs sees no value after it, so the flag is `true`. Dropping the log
    // here would leave a hidden instance with no console AND no file.
    const args = parseArgs(['serve', '--log-file']);
    assert.equal(args.flags['log-file'], true);
    assert.equal(pathFlag(args, 'log-file', fallback), fallback);
  });

  test('--log-file= with nothing after it means the default path too', () => {
    const args = parseArgs(['serve', '--log-file=']);
    assert.equal(args.flags['log-file'], '');
    assert.equal(pathFlag(args, 'log-file', fallback), fallback);
  });

  test('--log-file followed by another flag does not swallow it', () => {
    const args = parseArgs(['serve', '--log-file', '--json']);
    assert.equal(pathFlag(args, 'log-file', fallback), fallback);
    assert.equal(args.flags.json, true, 'the next flag is still parsed');
  });

  test('no --log-file at all means no log', () => {
    assert.equal(pathFlag(parseArgs(['serve']), 'log-file', fallback), null);
  });

  test('boolFlag accepts the bare and the =true/=false forms', () => {
    // The SPACED form is deliberately gone. A switch that swallowed the token
    // after it is what turned `install-hooks --dry-run foo` into a real write:
    // `dry-run` became "foo", the `=== true` test failed, and settings.json was
    // rewritten. Switches no longer consume anything, so `--open false` is
    // `--open` plus a positional argument. `--open=false` still says false.
    assert.equal(boolFlag(parseArgs(['serve', '--open']), 'open'), true);
    assert.equal(boolFlag(parseArgs(['serve', '--open=true']), 'open'), true);
    assert.equal(boolFlag(parseArgs(['serve', '--open=false']), 'open'), false);
    assert.equal(boolFlag(parseArgs(['serve']), 'open'), false);

    const spaced = parseArgs(['serve', '--open', 'false']);
    assert.equal(boolFlag(spaced, 'open'), true, 'the switch is set');
    assert.deepEqual(spaced._, ['serve', 'false'], 'and the word after it is untouched');
  });

  test('countFlag takes only non-negative whole numbers, and 0 is a real answer', () => {
    const f = (argv) => countFlag(parseArgs(argv), 'events-keep-days', 30);
    assert.equal(f(['serve', '--events-keep-days', '7']), 7);
    assert.equal(f(['serve', '--events-keep-days=7']), 7);
    assert.equal(f(['serve', '--events-keep-days', '0']), 0, '0 means "keep everything"');
    assert.equal(f(['serve']), 30);
    // A typo must not silently become a retention policy of its own.
    assert.equal(f(['serve', '--events-keep-days']), 30, 'a bare flag falls back');
    assert.equal(f(['serve', '--events-keep-days', 'seven']), 30);
    assert.equal(f(['serve', '--events-keep-days', '-3']), 30);
    assert.equal(f(['serve', '--events-keep-days', '7.9']), 7);
  });

  test('a bare --token-file still means "persist, at the default path"', () => {
    // serve treats a named token file as implying --persist-token, so the bare
    // form must not read as "no token file".
    const args = parseArgs(['serve', '--token-file']);
    assert.equal(pathFlag(args, 'token-file', 'C:\\fallback\\token'), 'C:\\fallback\\token');
  });
});

/**
 * `sessions` gained START and END. The fixture is one synthesized
 * sessions/<pid>.json under a temp CLAUDE_CONFIG_DIR - the real ~/.claude is
 * never read, and the pid is one nothing is expected to own.
 */
describe('sessions: the START and END columns', () => {
  const SID = 'aaaaaaaa-1111-2222-3333-444444444444';

  test('the table names both, and --json says where each value came from', () => {
    const dir = path.join(tmp.dir, 'sessions-cols');
    const claude = path.join(dir, 'claude');
    const monitor = path.join(dir, 'monitor');
    fs.mkdirSync(path.join(claude, 'sessions'), { recursive: true });
    fs.mkdirSync(monitor, { recursive: true });
    const startedAt = Date.UTC(2026, 8, 1, 3, 0, 0);
    fs.writeFileSync(
      path.join(claude, 'sessions', '4242.json'),
      JSON.stringify({
        pid: 4242, sessionId: SID, cwd: 'D:\test', startedAt,
        status: 'idle', name: 'fixture', updatedAt: startedAt, statusUpdatedAt: startedAt,
      }),
      'utf8',
    );

    const run = (extra) => execFileSync(process.execPath, [CLI, 'sessions', ...extra], {
      env: envFor(monitor, claude), encoding: 'utf8', windowsHide: true,
    });

    const text = run([]);
    assert.match(text, /\bSTART\b/);
    assert.match(text, /\bEND\b/);
    assert.match(text, /\[times: local /, 'the timezone note the other time tables print');

    // --utc is the convention `list`, `tools` and `events` already follow.
    const utc = run(['--utc']);
    assert.match(utc, /START \(UTC\)/);
    assert.match(utc, /END \(UTC\)/);
    assert.match(utc, /2026-09-01 03:00:00/);

    const json = JSON.parse(run(['--json']));
    assert.equal(json.times.length, 1);
    assert.equal(json.times[0].sessionId, SID);
    assert.equal(json.times[0].startedAt, new Date(startedAt).toISOString());
    assert.equal(json.times[0].startedAtSource, 'sessions');
    assert.equal(json.times[0].endedAt, null, 'no SessionEnd hook was ever seen');
    assert.equal(json.times[0].endedAtSource, null);
    assert.equal(json.times[0].durationMs, null);
  });
});

/**
 * The argument parser used to hand the token after a flag to whatever flag came
 * before it, with no idea which flags take a value and no opinion at all about
 * a flag it had never heard of. Three consequences, all reproduced below.
 */
describe('flags: a switch does not eat the word after it', () => {
  /** A temp ~/.claude with a settings.json we can watch for writes. */
  function claudeDirWith(label, settings) {
    const dir = path.join(tmp.dir, label);
    const claude = path.join(dir, 'claude');
    const monitor = path.join(dir, 'monitor');
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(monitor, { recursive: true });
    const file = path.join(claude, 'settings.json');
    if (settings !== undefined) fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    return { claude, monitor, file };
  }

  /** Run the CLI and hand back everything, exit code included. */
  function run(argv, env) {
    return spawnSync(process.execPath, [CLI, ...argv], {
      env, encoding: 'utf8', windowsHide: true,
    });
  }

  test('install-hooks --dry-run foo stays a dry run and writes NOTHING', () => {
    // The finding: `dry-run` became the string "foo", the `=== true` test for a
    // dry run failed, and install-hooks WROTE ~/.claude/settings.json. On the
    // reviewer's own machine, against their real settings.
    const { claude, monitor, file } = claudeDirWith('dryrun-foo', { permissions: { allow: [] } });
    const before = fs.readFileSync(file, 'utf8');
    const r = run(['install-hooks', '--dry-run', 'foo'], envFor(monitor, claude));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN - nothing written/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'settings.json is untouched');
    assert.deepEqual(fs.readdirSync(claude), ['settings.json'], 'and no backup was taken either');
  });

  test('a misspelled flag is refused with exit 2 instead of being ignored', () => {
    // `install-autostart --dry-runn` used to parse as a flag nobody reads,
    // leaving dryRun false: it registered a real scheduled task.
    const { claude, monitor } = claudeDirWith('typo');
    const r = run(['install-autostart', '--dry-runn'], envFor(monitor, claude));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown flag --dry-runn/);
    assert.match(r.stderr, /Usage: node src\/cli\.js/, 'and it prints the usage');
  });

  test('a typo does not swallow the argument that followed it', () => {
    const parsed = parseArgs(['tools', '--errrors', 'ea1b82f5']);
    assert.deepEqual(parsed.errors, ['unknown flag --errrors']);
    assert.deepEqual(parsed._, ['tools', 'ea1b82f5'], 'the session id is still there');
  });

  test('usage --json <id> is still a session lookup, not the all-time total', () => {
    // `--json` took the session id, `usage` was left with no argument, and the
    // daily aggregate across every transcript came back looking like an answer.
    const { claude, monitor } = claudeDirWith('usage-json');
    const r = run(['usage', '--json', 'deadbeef'], envFor(monitor, claude));
    assert.equal(r.status, 1, 'it looked the session up and did not find it');
    assert.match(r.stderr, /no session matches "deadbeef"/);
    assert.equal(r.stdout.trim(), '', 'nothing that could be mistaken for a total');
  });

  test('a value flag with no value is an error, not a silent default', () => {
    for (const argv of [['list', '--days'], ['serve', '--port'], ['events', '--date']]) {
      const parsed = parseArgs(argv);
      assert.equal(parsed.errors.length, 1, argv.join(' '));
      assert.match(parsed.errors[0], /needs a value/);
    }
  });

  test('--switch=anything-else is refused rather than read as false', () => {
    const parsed = parseArgs(['install-hooks', '--dry-run=yes']);
    assert.equal(parsed.errors.length, 1);
    assert.match(parsed.errors[0], /--dry-run is a switch and takes no value/);
  });

  test('the flag table and the usage text name exactly the same flags', () => {
    // The point of the table is that it is the ONE place a flag is declared.
    // A flag in only one of the two is a flag somebody will type and be told
    // does not exist, or one that works and is documented nowhere.
    const documented = flagsNamedIn(usageText());
    const declared = new Set(Object.keys(FLAGS));
    assert.deepEqual(
      [...documented].filter((f) => !declared.has(f)), [],
      'documented in --help but not accepted by the parser',
    );
    assert.deepEqual(
      [...declared].filter((f) => !documented.has(f)), [],
      'accepted by the parser but absent from --help',
    );
  });

  test('a switch is stored as a real boolean, never the STRING "false"', () => {
    // Most commands read `args.flags.json` directly rather than through
    // boolFlag, and the string "false" is truthy.
    assert.equal(parseArgs(['sessions', '--json=false']).flags.json, false);
    assert.equal(parseArgs(['sessions', '--json=true']).flags.json, true);
    assert.equal(parseArgs(['sessions', '--json']).flags.json, true);
  });

  test('every declared kind is one of the three', () => {
    for (const [name, kind] of Object.entries(FLAGS)) {
      assert.ok(['bool', 'value', 'optional'].includes(kind), `${name}: ${kind}`);
    }
  });
});

describe('--port has to be a port', () => {
  function run(argv) {
    const dir = path.join(tmp.dir, 'portflag');
    const claude = path.join(dir, 'claude');
    const monitor = path.join(dir, 'monitor');
    fs.mkdirSync(claude, { recursive: true });
    fs.mkdirSync(monitor, { recursive: true });
    return spawnSync(process.execPath, [CLI, ...argv], {
      env: envFor(monitor, claude), encoding: 'utf8', windowsHide: true,
    });
  }

  test('install-autostart --port 70000 is refused instead of registering 47321', () => {
    // resolvePort used to round a bad value off to the default, so this
    // registered a logon task on a port the user never asked for and had no
    // way to notice - --dry-run included, which is what they would check.
    const r = run(['install-autostart', '--port', '70000', '--dry-run']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--port must be a whole number 0\.\.65535/);
    assert.doesNotMatch(r.stdout, /47321/);
  });

  test('a non-numeric port is refused the same way', () => {
    const r = run(['tray', '--port', 'eighty', '--dry-run']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--port must be a whole number/);
  });

  test('a good port still gets through', () => {
    const r = run(['tray', '--port', '50000', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /port\s+: 50000/);
  });
});
