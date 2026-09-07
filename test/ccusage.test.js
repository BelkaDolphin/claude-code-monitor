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
import { runCcusage, SAFE_ARG, parseCcusageJson } from '../src/ccusage.js';

const WIN = process.platform === 'win32';

let tmp;
let script;

before(() => {
  tmp = makeTmpDir('cm-ccusage');
  script = path.join(tmp.dir, 'sleeper.js');
  // Prints its pid, flushes it, then holds the event loop open past any
  // timeout this test uses. No quotes in the command line, so cmd.exe cannot
  // mangle it.
  fs.writeFileSync(script, 'process.stdout.write(String(process.pid) + "\\n");\nsetInterval(function () {}, 1000);\n', 'utf8');
});

after(() => {
  if (tmp) tmp.cleanup();
});

/** The same two-level shape production uses, minus npx. */
function sleeperCommand() {
  return WIN
    ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `node ${script}`] }
    : { file: 'node', args: [script] };
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
    const command = WIN
      ? { file: 'cmd.exe', args: ['/d', '/s', '/c', `node ${quick}`] }
      : { file: 'node', args: [quick] };
    const res = await runCcusage([], { timeoutMs: 20000, command });
    assert.equal(res.timedOut, false);
    assert.equal(res.ok, true);
    assert.equal(res.code, 0);
    assert.deepEqual(parseCcusageJson(res.stdout), { ok: 1 });
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
