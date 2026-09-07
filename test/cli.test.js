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
import { parseArgs, boolFlag, pathFlag } from '../src/cli.js';

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

  test('boolFlag accepts the bare, the =true and the spaced forms only', () => {
    assert.equal(boolFlag(parseArgs(['serve', '--open']), 'open'), true);
    assert.equal(boolFlag(parseArgs(['serve', '--open=true']), 'open'), true);
    assert.equal(boolFlag(parseArgs(['serve', '--open', 'true']), 'open'), true);
    assert.equal(boolFlag(parseArgs(['serve', '--open=false']), 'open'), false);
    assert.equal(boolFlag(parseArgs(['serve', '--open', 'false']), 'open'), false);
    assert.equal(boolFlag(parseArgs(['serve']), 'open'), false);
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
