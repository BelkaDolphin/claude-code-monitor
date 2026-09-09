import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  readLiveSessions, isPidAlive, filetimeToEpochMs,
  linuxBootTimeSec, parseProcStatStartTicks, linuxTicksToEpochMs, procStartToEpochMs,
  resetReuseVerdicts,
} from '../src/sessions.js';
import { makeTmpDir } from './helpers.js';

describe('filetimeToEpochMs', () => {
  test('converts a Windows FILETIME to epoch ms', () => {
    // 1970-01-01T00:00:00Z is exactly 116444736000000000 ticks.
    assert.equal(filetimeToEpochMs('116444736000000000'), 0);
    // One second later.
    assert.equal(filetimeToEpochMs('116444736010000000'), 1000);
  });

  test('the real procStart value lands in a plausible range', () => {
    // Observed on this machine alongside StartTime 2026-09-02 21:41:51 JST.
    const ms = filetimeToEpochMs('134328265116630248');
    const d = new Date(ms);
    assert.equal(d.getUTCFullYear(), 2026);
    assert.equal(d.getUTCMonth(), 8); // September
  });

  test('garbage returns null instead of NaN', () => {
    assert.equal(filetimeToEpochMs('not-a-number'), null);
    assert.equal(filetimeToEpochMs(null), null);
    assert.equal(filetimeToEpochMs('0'), null);
  });
});

describe('isPidAlive', () => {
  test('our own process is alive', () => {
    assert.equal(isPidAlive(process.pid).alive, true);
  });

  test('an impossible pid is not alive', () => {
    assert.equal(isPidAlive(0).alive, false);
    assert.equal(isPidAlive(-1).alive, false);
    // 2^31-2 is a valid integer but will not be in use.
    assert.equal(isPidAlive(2147483646).alive, false);
  });
});

describe('readLiveSessions', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('sessions'); });
  after(() => tmp.cleanup());

  test('reads *.json, ignores *.key, and reports liveness', async () => {
    // Key material must never be opened. If this test ever fails because the
    // file was read, that is a security regression.
    fs.writeFileSync(path.join(tmp.dir, '12345.abcdef.key'), 'SECRET-DO-NOT-READ', 'utf8');
    fs.writeFileSync(path.join(tmp.dir, `${process.pid}.json`), JSON.stringify({
      pid: process.pid,
      sessionId: 'live-session',
      cwd: 'D:\\develop\\Claude監視',
      startedAt: Date.now(),
      procStart: '134328265116630248',
      version: '2.1.258',
      kind: 'interactive',
      entrypoint: 'cli',
      name: 'claude-test',
      status: 'busy',
      updatedAt: Date.now(),
      statusUpdatedAt: Date.now(),
    }), 'utf8');
    fs.writeFileSync(path.join(tmp.dir, '2147483646.json'), JSON.stringify({
      pid: 2147483646, sessionId: 'dead-session', status: 'busy', updatedAt: 1,
    }), 'utf8');

    const { sessions, skippedKeyFiles } = await readLiveSessions({ dir: tmp.dir, checkProcStart: false });
    assert.equal(skippedKeyFiles, 1);
    assert.equal(sessions.length, 2);

    const live = sessions.find((s) => s.sessionId === 'live-session');
    assert.equal(live.alive, true);
    assert.equal(live.status, 'busy');
    assert.equal(live.cwd, 'D:\\develop\\Claude監視', 'Japanese path preserved');
    assert.ok(Number.isFinite(live.procStartMs));

    const dead = sessions.find((s) => s.sessionId === 'dead-session');
    assert.equal(dead.alive, false);
  });

  test('a corrupt session file is skipped, not fatal', async () => {
    const dir2 = makeTmpDir('sessions2');
    try {
      fs.writeFileSync(path.join(dir2.dir, '111.json'), '{ not json', 'utf8');
      fs.writeFileSync(path.join(dir2.dir, '222.json'), JSON.stringify({ pid: 222, sessionId: 'ok' }), 'utf8');
      const { sessions } = await readLiveSessions({ dir: dir2.dir, checkProcStart: false });
      assert.equal(sessions.length, 1);
      assert.equal(sessions[0].sessionId, 'ok');
    } finally {
      dir2.cleanup();
    }
  });

  test('a missing sessions dir yields an empty list', async () => {
    const { sessions } = await readLiveSessions({ dir: path.join(tmp.dir, 'no-such-dir'), checkProcStart: false });
    assert.deepEqual(sessions, []);
  });

  test('pid taken from the filename when the json omits it', async () => {
    const dir3 = makeTmpDir('sessions3');
    try {
      fs.writeFileSync(path.join(dir3.dir, '4242.json'), JSON.stringify({ sessionId: 's' }), 'utf8');
      const { sessions } = await readLiveSessions({ dir: dir3.dir, checkProcStart: false });
      assert.equal(sessions[0].pid, 4242);
    } finally {
      dir3.cleanup();
    }
  });
});

describe('Linux procStart (ticks since boot)', () => {
  test('linuxBootTimeSec parses btime out of /proc/stat text', () => {
    const text = 'cpu  1 2 3 4\nintr 5\nctxt 6\nbtime 1788930197\nprocesses 7\n';
    assert.equal(linuxBootTimeSec(text), 1788930197);
    assert.equal(linuxBootTimeSec('cpu 1 2 3\n'), null);
  });

  test('parseProcStatStartTicks takes field 22 even when comm has spaces and parens', () => {
    // 3 (state) is index 0 after the last ')', so starttime (22) is index 19.
    const tail = 'S 1 420 420 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 254037 1000 5 18446744073709551615';
    assert.equal(parseProcStatStartTicks(`7903 (claude) ${tail}`), 254037);
    assert.equal(parseProcStatStartTicks(`421 (Relay(422)) ${tail}`), 254037);
    assert.equal(parseProcStatStartTicks(`422 (my shell (x)) ${tail}`), 254037);
    assert.equal(parseProcStatStartTicks('garbage'), null);
    assert.equal(parseProcStatStartTicks(null), null);
  });

  test('linuxTicksToEpochMs is btime plus ticks at USER_HZ=100', () => {
    // Measured 2026-09-09: pid 7903 had procStart "254037" and /proc/7903/stat
    // starttime 254037 with btime 1788930197 -> 05:45:37.370Z.
    assert.equal(linuxTicksToEpochMs('254037', 1788930197), Date.parse('2026-09-09T05:45:37.370Z'));
    assert.equal(linuxTicksToEpochMs(254037, 1788930197), Date.parse('2026-09-09T05:45:37.370Z'));
    assert.equal(linuxTicksToEpochMs('254037', null), null);
    assert.equal(linuxTicksToEpochMs('134328265116630248x', 1788930197), null);
    assert.equal(linuxTicksToEpochMs('-5', 1788930197), null);
  });

  test('procStartToEpochMs dispatches on platform and is null elsewhere', () => {
    assert.equal(procStartToEpochMs('134328265116630248', 'win32'), filetimeToEpochMs('134328265116630248'));
    assert.equal(procStartToEpochMs('254037', 'linux', 1788930197), Date.parse('2026-09-09T05:45:37.370Z'));
    assert.equal(procStartToEpochMs('254037', 'darwin'), null);
    assert.equal(procStartToEpochMs(null, 'linux', 1788930197), null);
  });

  test('a stale file from a previous boot is flagged as pid-reused (Linux only)', { skip: process.platform !== 'linux' }, async () => {
    const tmp = makeTmpDir('sessions-linux');
    try {
      // pid 1 is always alive and was born at boot (starttime ~0 ticks), but
      // this file claims a session that started months ago on it. Its tick
      // value (small) may well land within slack of pid 1's actual ticks - the
      // bug this guards against - so startedAt must catch it.
      fs.writeFileSync(path.join(tmp.dir, '1.json'), JSON.stringify({
        pid: 1, sessionId: 'old-boot', status: 'busy', procStart: '3594',
        startedAt: Date.parse('2026-05-06T01:39:04.132Z'), updatedAt: 1,
      }), 'utf8');
      // Ourselves: file written from the real /proc values -> not reused.
      const statLine = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      fs.writeFileSync(path.join(tmp.dir, `${process.pid}.json`), JSON.stringify({
        pid: process.pid, sessionId: 'me', status: 'busy',
        procStart: String(parseProcStatStartTicks(statLine)),
        startedAt: Date.now(), updatedAt: 2,
      }), 'utf8');
      resetReuseVerdicts();
      const { sessions } = await readLiveSessions({ dir: tmp.dir });
      const old = sessions.find((s) => s.sessionId === 'old-boot');
      const me = sessions.find((s) => s.sessionId === 'me');
      assert.equal(old.pidReused, true);
      assert.equal(old.alive, false);
      assert.equal(old.aliveSource, 'pid-reused');
      assert.equal(me.pidReused, false);
      assert.equal(me.alive, true);

      // The collector re-checks start times only every 30th tick. The cheap
      // ticks in between must keep the verdict, not fall back to kill(0).
      const again = await readLiveSessions({ dir: tmp.dir, checkProcStart: false });
      const old2 = again.sessions.find((s) => s.sessionId === 'old-boot');
      const me2 = again.sessions.find((s) => s.sessionId === 'me');
      assert.equal(old2.pidReused, true);
      assert.equal(old2.alive, false);
      assert.equal(old2.aliveSource, 'pid-reused');
      assert.equal(me2.pidReused, false);
      assert.equal(me2.alive, true);

      // A rewritten file (a NEW session that happens to get the same pid) does
      // not inherit the old verdict.
      fs.writeFileSync(path.join(tmp.dir, '1.json'), JSON.stringify({
        pid: 1, sessionId: 'new-on-pid-1', status: 'busy', procStart: '0',
        startedAt: Date.now(), updatedAt: 3,
      }), 'utf8');
      const third = await readLiveSessions({ dir: tmp.dir, checkProcStart: false });
      const fresh = third.sessions.find((s) => s.sessionId === 'new-on-pid-1');
      assert.equal(fresh.pidReused, null);
      assert.equal(fresh.alive, true);
    } finally {
      resetReuseVerdicts();
      tmp.cleanup();
    }
  });
});
