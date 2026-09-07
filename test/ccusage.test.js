/**
 * src/ccusage.js - the timeout path.
 *
 * The only thing worth testing here without the network is what happens when
 * the run does NOT come back. On Windows we spawn `cmd.exe`, which spawns
 * `npx.cmd`, which spawns `node.exe`; `child.kill()` reaches only the cmd.exe
 * at the top and leaves the node grandchild running forever. So the fixture is
 * exactly that shape - a cmd.exe whose child is a node that prints its own pid
 * and then never exits - and the assertion is that the pid is gone afterwards.
 *
 * Nothing here downloads anything: the command is injected.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeTmpDir } from './helpers.js';
import {
  CCUSAGE_SPEC,
  CCUSAGE_VERSION,
  ccusageCommand,
  isNotInstalled,
  parseCcusageJson,
  runCcusage,
  SAFE_ARG,
} from '../src/ccusage.js';

const WIN = process.platform === 'win32';

let tmp;
let script;

const SLEEPER_SRC = 'process.stdout.write(String(process.pid) + "\\n");\nsetInterval(function () {}, 1000);\n';

before(() => {
  tmp = makeTmpDir('cm-ccusage');
  script = path.join(tmp.dir, 'sleeper.js');
  // Prints its pid, flushes it, then holds the event loop open past any
  // timeout this test uses.
  fs.writeFileSync(script, SLEEPER_SRC, 'utf8');
});

after(() => {
  if (tmp) tmp.cleanup();
});

/**
 * Run `scriptFile` with node, no shell in between.
 *
 * runCcusage() spawns an injected command with windowsVerbatimArguments on
 * Windows, and that flag applies to `file` too: it is prepended to the command
 * line unquoted. So `file` must be a name without a space (`process.execPath`
 * is usually `C:\Program Files\nodejs\node.exe`, which would arrive as two
 * arguments) and the script path has to carry its own quotes - otherwise a
 * fixture under `C:\Users\John Smith\AppData\Local\Temp\...` is split at the
 * space and never runs. Off Windows nothing is verbatim and execPath is exact.
 */
function nodeCommand(scriptFile) {
  return WIN
    ? { file: 'node', args: [`"${scriptFile}"`] }
    : { file: process.execPath, args: [scriptFile] };
}

/**
 * The same two-level shape production uses, minus npx: only the timeout test
 * needs a cmd.exe above the node, so it is the only place that keeps one.
 * `node` stays unquoted on purpose - `cmd /s /c` strips the outermost quotes
 * when the string both starts and ends with one.
 */
function sleeperCommand() {
  return WIN
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `node "${script}"`] }
    : { file: process.execPath, args: [script] };
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** taskkill is asynchronous; give it a moment rather than assuming. */
async function waitGone(pid, ms = 3000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return !alive(pid);
}

describe('the command line: pinned, and never a download', () => {
  test('both platforms pass --no and the pinned version, and neither passes -y or @latest', () => {
    const args = ['daily', '--json', '--since', '2026-09-01'];
    const win = ccusageCommand(args, 'win32');
    const posix = ccusageCommand(args, 'linux');

    // Windows goes through cmd.exe because npx is a .cmd shim.
    assert.equal(win.file, 'cmd.exe');
    assert.equal(win.verbatim, true);
    const cmdline = win.args[win.args.length - 1];
    assert.equal(cmdline, `npx --no ${CCUSAGE_SPEC} daily --json --since 2026-09-01`);

    assert.equal(posix.file, 'npx');
    assert.equal(posix.verbatim, false);
    assert.deepEqual(posix.args, ['--no', CCUSAGE_SPEC, ...args]);

    for (const line of [cmdline, posix.args.join(' ')]) {
      assert.match(line, /(^| )--no( |$)/, 'npx must be told not to install');
      assert.equal(/(^| )-y( |$)/.test(line), false, '-y would download without asking');
      assert.equal(/@latest/.test(line), false, 'the version must be pinned');
      assert.ok(line.includes(`ccusage@${CCUSAGE_VERSION}`));
    }
  });

  test('the version lives in exactly one place', () => {
    assert.match(CCUSAGE_VERSION, /^\d+\.\d+\.\d+$/);
    assert.equal(CCUSAGE_SPEC, `ccusage@${CCUSAGE_VERSION}`);
  });

  test('every SAFE_ARG-legal argument survives the join unquoted', () => {
    const { args } = ccusageCommand(['blocks', '--json', '--active'], 'win32');
    assert.equal(/["'^&|<>]/.test(args[args.length - 1]), false, 'nothing needing escaping got in');
  });
});

describe('runCcusage: ccusage is not installed', () => {
  /** npx's real refusal, verbatim from npm 11.6.2 on Windows. */
  const REFUSAL = `npm error npx canceled due to missing packages and no YES option: ["${CCUSAGE_SPEC}"]`;

  /** A command that prints `text` on stderr and exits with `code`. */
  function failingCommand(text, code) {
    const file = path.join(tmp.dir, `fail-${code}-${text.length}.js`);
    fs.writeFileSync(file, `process.stderr.write(${JSON.stringify(text)});\nprocess.exit(${code});\n`, 'utf8');
    return nodeCommand(file);
  }

  test('the npx refusal is reported as notInstalled, not as a bare exit code', async () => {
    const res = await runCcusage([], { timeoutMs: 20000, command: failingCommand(REFUSAL, 1) });
    assert.equal(res.ok, false);
    assert.equal(res.notInstalled, true);
    assert.equal(res.timedOut, false);
    assert.match(res.error, /is not installed/);
    assert.match(res.error, new RegExp(CCUSAGE_VERSION.replace(/\./g, '\\.')));
  });

  test('any other failure is NOT notInstalled', async () => {
    const res = await runCcusage([], { timeoutMs: 20000, command: failingCommand('boom', 3) });
    assert.equal(res.ok, false);
    assert.equal(res.notInstalled, false);
    assert.equal(res.error, 'exit code 3');
  });

  test('a success is never notInstalled, and neither is a rejected argument', async () => {
    const quick = path.join(tmp.dir, 'ok.js');
    fs.writeFileSync(quick, 'process.stdout.write("{}");\n', 'utf8');
    const command = nodeCommand(quick);
    const ok = await runCcusage([], { timeoutMs: 20000, command });
    assert.equal(ok.ok, true);
    assert.equal(ok.notInstalled, false);

    const unsafe = await runCcusage(['&& calc'], { timeoutMs: 500, command });
    assert.equal(unsafe.notInstalled, false);
  });

  test('the detector matches the message itself, not our own wording', () => {
    assert.equal(isNotInstalled(REFUSAL), true);
    assert.equal(isNotInstalled('npm ERR! npx canceled due to missing packages'), true);
    assert.equal(isNotInstalled('npm error code E404'), false);
    assert.equal(isNotInstalled(''), false);
    assert.equal(isNotInstalled(undefined), false);
  });
});

describe('runCcusage: a run that never returns', () => {
  test('times out with the fixed error and takes the whole process tree with it', async () => {
    const t0 = Date.now();
    const res = await runCcusage([], { timeoutMs: 500, command: sleeperCommand() });
    const elapsed = Date.now() - t0;

    assert.equal(res.ok, false);
    assert.equal(res.timedOut, true);
    assert.equal(res.error, 'timed out after 500ms');
    assert.ok(elapsed < 20000, `it should not have waited ${elapsed}ms`);

    const pid = Number(String(res.stdout).trim().split(/\s+/)[0]);
    assert.ok(Number.isInteger(pid) && pid > 0, `expected a pid on stdout, got ${JSON.stringify(res.stdout)}`);

    if (!WIN) {
      // Off Windows the child IS node - there is no grandchild to orphan, and
      // taskkill does not exist. child.kill() is the whole story.
      assert.ok(await waitGone(pid), 'the child should be gone');
      return;
    }
    // The regression: before taskkill /T /F this pid stayed alive forever,
    // because the thing killed was the cmd.exe above it.
    assert.ok(await waitGone(pid), `the node grandchild ${pid} survived the timeout`);
  });

  test('a run that finishes inside the timeout is not reported as timed out', async () => {
    const quick = path.join(tmp.dir, 'quick.js');
    fs.writeFileSync(quick, 'process.stdout.write("{\\"ok\\":1}");\n', 'utf8');
    const res = await runCcusage([], { timeoutMs: 20000, command: nodeCommand(quick) });
    assert.equal(res.timedOut, false);
    assert.equal(res.ok, true);
    assert.equal(res.code, 0);
    assert.deepEqual(parseCcusageJson(res.stdout), { ok: 1 });
  });

  /*
   * The regression: the fixtures used to interpolate the script path into a
   * `cmd.exe /c node <path>` string with no quotes. Every developer whose
   * Windows account name contains a space - `C:\Users\John Smith\AppData\...` -
   * saw these tests fail with "Cannot find module 'C:\Users\John'". Nothing
   * about ccusage depends on the path shape, so the fixture directory is the
   * thing under test here.
   */
  test('a fixture under a path containing a space still runs', async () => {
    const spaced = makeTmpDir('cm ccusage space');
    try {
      assert.ok(spaced.dir.includes(' '), 'the temp dir must actually contain a space');
      const quick = path.join(spaced.dir, 'spaced ok.js');
      fs.writeFileSync(quick, 'process.stdout.write("{\\"spaced\\":1}");\n', 'utf8');
      const res = await runCcusage([], { timeoutMs: 20000, command: nodeCommand(quick) });
      assert.equal(res.ok, true, `stderr: ${res.stderr}`);
      assert.equal(res.code, 0);
      assert.deepEqual(parseCcusageJson(res.stdout), { spaced: 1 });

      // ...and the two-level cmd.exe shape the timeout path needs, too.
      const sleeper = path.join(spaced.dir, 'spaced sleeper.js');
      fs.writeFileSync(sleeper, SLEEPER_SRC, 'utf8');
      const command = WIN
        ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `node "${sleeper}"`] }
        : { file: process.execPath, args: [sleeper] };
      const slow = await runCcusage([], { timeoutMs: 1000, command });
      assert.equal(slow.timedOut, true);
      const pid = Number(String(slow.stdout).trim().split(/\s+/)[0]);
      assert.ok(Number.isInteger(pid) && pid > 0,
        `the fixture never started; stdout=${JSON.stringify(slow.stdout)} stderr=${JSON.stringify(slow.stderr)}`);
      assert.ok(await waitGone(pid), `the child ${pid} survived the timeout`);
    } finally {
      spaced.cleanup();
    }
  });

  test('an unsafe argument is refused before anything is spawned', async () => {
    const res = await runCcusage(['daily', '--json', '&& calc'], { timeoutMs: 500, command: sleeperCommand() });
    assert.equal(res.ok, false);
    assert.equal(res.timedOut, false);
    assert.match(res.error, /unsafe ccusage argument/);
    assert.equal(res.stdout, '', 'nothing ran');
    assert.equal(SAFE_ARG.test('2026-09-06'), true);
    assert.equal(SAFE_ARG.test('&& calc'), false);
  });
});
