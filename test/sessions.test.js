import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  readLiveSessions, isPidAlive, filetimeToEpochMs,
  linuxBootTimeSec, parseProcStatStartTicks, linuxTicksToEpochMs, procStartToEpochMs,
  resetReuseVerdicts, PID_START_SLACK_MS,
} from '../src/sessions.js';
import { makeTmpDir } from './helpers.js';

/** epoch ms -> the FILETIME string Claude Code writes on Windows. */
function filetimeOf(ms) {
  return String((BigInt(Math.round(ms)) + 11644473600000n) * 10000n);
}

/** A probe that always answers with these pid -> {startMs, ticks} rows. */
function fakeProbe(rows) {
  return async () => new Map(rows);
}

function writeSession(dir, name, json) {
  fs.writeFileSync(path.join(dir, name), JSON.stringify(json), 'utf8');
}

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
    writeSession(tmp.dir, `${process.pid}.json`, {
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
    });
    writeSession(tmp.dir, '2147483646.json', {
      pid: 2147483646, sessionId: 'dead-session', status: 'busy', updatedAt: 1,
    });

    const { sessions, skippedKeyFiles } = await readLiveSessions({
      dir: tmp.dir, checkProcStart: false, platform: 'win32',
    });
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
      writeSession(dir2.dir, '222.json', { pid: 222, sessionId: 'ok' });
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
      writeSession(dir3.dir, '4242.json', { sessionId: 's' });
      const { sessions } = await readLiveSessions({ dir: dir3.dir, checkProcStart: false });
      assert.equal(sessions[0].pid, 4242);
    } finally {
      dir3.cleanup();
    }
  });
});

describe('Linux procStart (ticks since boot)', () => {
  test('linuxBootTimeSec parses btime and never caches', () => {
    const text = 'cpu  1 2 3 4\nintr 5\nctxt 6\nbtime 1788930197\nprocesses 7\n';
    assert.equal(linuxBootTimeSec(text), 1788930197);
    assert.equal(linuxBootTimeSec('cpu 1 2 3\n'), null);
    // btime moves when the clock is stepped (NTP, WSL2 waking from sleep), so
    // a second call must read the new value, and a null must not stick.
    assert.equal(linuxBootTimeSec('btime 1788930497\n'), 1788930497);
    const live = linuxBootTimeSec();
    if (process.platform === 'linux') {
      assert.ok(Number.isInteger(live) && live > 0, 'real /proc/stat has a btime');
    } else {
      assert.equal(live, null, 'no /proc/stat here');
    }
    assert.equal(linuxBootTimeSec('btime 1788930197\n'), 1788930197, 'not poisoned by the null');
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
    // No btime handed in means no answer - it is never re-read behind the caller.
    assert.equal(linuxTicksToEpochMs('254037'), null);
    assert.equal(linuxTicksToEpochMs('134328265116630248x', 1788930197), null);
    assert.equal(linuxTicksToEpochMs('-5', 1788930197), null);
  });

  test('procStartToEpochMs dispatches on platform and is null elsewhere', () => {
    assert.equal(procStartToEpochMs('134328265116630248', 'win32'), filetimeToEpochMs('134328265116630248'));
    assert.equal(procStartToEpochMs('254037', 'linux', 1788930197), Date.parse('2026-09-09T05:45:37.370Z'));
    assert.equal(procStartToEpochMs('254037', 'linux'), null, 'no btime, no guess');
    assert.equal(procStartToEpochMs('254037', 'darwin'), null);
    assert.equal(procStartToEpochMs(null, 'linux', 1788930197), null);
  });

  test('a stale file from a previous boot is flagged as pid-reused (Linux only)', { skip: process.platform !== 'linux' }, async () => {
    const tmp = makeTmpDir('sessions-linux');
    try {
      // pid 1 is always alive and was born at boot (starttime ~0 ticks), but
      // this file claims a session that started months ago on it. Its tick
      // value (small) may well land within slack of pid 1's actual ticks - the
      // bug this guards against - so the boot-crossing check must catch it.
      writeSession(tmp.dir, '1.json', {
        pid: 1, sessionId: 'old-boot', status: 'busy', procStart: '3594',
        startedAt: Date.parse('2026-05-06T01:39:04.132Z'), updatedAt: 1,
      });
      // Ourselves: file written from the real /proc values -> not reused.
      const statLine = fs.readFileSync(`/proc/${process.pid}/stat`, 'utf8');
      writeSession(tmp.dir, `${process.pid}.json`, {
        pid: process.pid, sessionId: 'me', status: 'busy',
        procStart: String(parseProcStatStartTicks(statLine)),
        startedAt: Date.now(), updatedAt: 2,
      });
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
      writeSession(tmp.dir, '1.json', {
        pid: 1, sessionId: 'new-on-pid-1', status: 'busy', procStart: '0',
        startedAt: Date.now(), updatedAt: 3,
      });
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

describe('PID reuse verdicts (injected probe)', () => {
  const NOW = Date.parse('2026-09-09T12:00:00.000Z');
  const BTIME = 1788930197; // seconds; the boot this machine is pretending to be in

  test('a verdict survives the ticks that do not re-check', async () => {
    resetReuseVerdicts();
    const tmp = makeTmpDir('verdict-sticky');
    try {
      writeSession(tmp.dir, 'a.json', {
        pid: process.pid, sessionId: 'reused', status: 'busy',
        procStart: filetimeOf(NOW), startedAt: NOW, updatedAt: 1,
      });
      // The process actually sitting on that pid started three hours earlier.
      const probe = fakeProbe([[process.pid, { startMs: NOW - 3 * 3600_000, ticks: null }]]);
      const first = await readLiveSessions({ dir: tmp.dir, platform: 'win32', probe });
      assert.equal(first.sessions[0].pidReused, true);
      assert.equal(first.sessions[0].alive, false);
      assert.equal(first.sessions[0].aliveSource, 'pid-reused');
      assert.equal(first.sessions[0].procStartActualMs, NOW - 3 * 3600_000);

      // A cheap tick: kill(0) says alive, but the remembered verdict wins.
      const cheap = await readLiveSessions({ dir: tmp.dir, platform: 'win32', checkProcStart: false });
      assert.equal(cheap.sessions[0].pidReused, true);
      assert.equal(cheap.sessions[0].alive, false);
      assert.equal(cheap.sessions[0].aliveSource, 'pid-reused');
    } finally {
      resetReuseVerdicts();
      tmp.cleanup();
    }
  });

  test('a probe that reads nothing keeps the previous verdict', async () => {
    resetReuseVerdicts();
    const tmp = makeTmpDir('verdict-probe-fail');
    try {
      writeSession(tmp.dir, 'a.json', {
        pid: process.pid, sessionId: 'reused', status: 'busy',
        procStart: filetimeOf(NOW), startedAt: NOW, updatedAt: 1,
      });
      const mismatch = fakeProbe([[process.pid, { startMs: NOW - 3 * 3600_000, ticks: null }]]);
      const first = await readLiveSessions({ dir: tmp.dir, platform: 'win32', probe: mismatch });
      assert.equal(first.sessions[0].pidReused, true);

      // Same check, but this time the start time is unreadable (permissions, a
      // PowerShell timeout). Falling back to kill(0) here would resurrect it.
      const blind = fakeProbe([]);
      const second = await readLiveSessions({ dir: tmp.dir, platform: 'win32', probe: blind });
      assert.equal(second.sessions[0].pidReused, true);
      assert.equal(second.sessions[0].alive, false);
      assert.equal(second.sessions[0].aliveSource, 'pid-reused');
    } finally {
      resetReuseVerdicts();
      tmp.cleanup();
    }
  });

  test('a verdict is forgotten once the session leaves the listing', async () => {
    resetReuseVerdicts();
    const tmp = makeTmpDir('verdict-sweep');
    try {
      const body = {
        pid: process.pid, sessionId: 'reused', status: 'busy',
        procStart: filetimeOf(NOW), startedAt: NOW, updatedAt: 1,
      };
      writeSession(tmp.dir, 'a.json', body);
      const mismatch = fakeProbe([[process.pid, { startMs: NOW - 3 * 3600_000, ticks: null }]]);
      const first = await readLiveSessions({ dir: tmp.dir, platform: 'win32', probe: mismatch });
      assert.equal(first.sessions[0].pidReused, true);

      // The session ends and Claude Code removes the file. Reading the now
      // empty directory must sweep the key it left behind.
      fs.unlinkSync(path.join(tmp.dir, 'a.json'));
      const empty = await readLiveSessions({ dir: tmp.dir, platform: 'win32', checkProcStart: false });
      assert.equal(empty.sessions.length, 0);

      // The very same file comes back (same key). Without the sweep it would
      // still be reported dead on every cheap tick.
      writeSession(tmp.dir, 'a.json', body);
      const back = await readLiveSessions({ dir: tmp.dir, platform: 'win32', checkProcStart: false });
      assert.equal(back.sessions[0].pidReused, null);
      assert.equal(back.sessions[0].alive, true);
      assert.equal(back.sessions[0].aliveSource, 'kill0');
    } finally {
      resetReuseVerdicts();
      tmp.cleanup();
    }
  });

  test('win32: procStart decides, startedAt is only the fallback', async () => {
    resetReuseVerdicts();
    const tmp = makeTmpDir('verdict-win32');
    try {
      // All three describe the same live pid; only their own records differ.
      writeSession(tmp.dir, 'match.json', {
        pid: process.pid, sessionId: 'procstart-matches', status: 'busy',
        procStart: filetimeOf(NOW), startedAt: NOW - 5 * 60_000, updatedAt: 3,
      });
      writeSession(tmp.dir, 'no-procstart-off.json', {
        pid: process.pid, sessionId: 'startedat-off', status: 'busy',
        startedAt: NOW - 5 * 60_000, updatedAt: 2,
      });
      writeSession(tmp.dir, 'no-procstart-ok.json', {
        pid: process.pid, sessionId: 'startedat-ok', status: 'busy',
        startedAt: NOW - 10_000, updatedAt: 1,
      });
      const probe = fakeProbe([[process.pid, { startMs: NOW, ticks: null }]]);
      const { sessions } = await readLiveSessions({ dir: tmp.dir, platform: 'win32', probe });
      const by = (id) => sessions.find((s) => s.sessionId === id);

      // --resume and a slow start move startedAt legitimately; procStart says
      // this is the same process, so a 5 minute gap must not sink it.
      assert.equal(by('procstart-matches').pidReused, false);
      assert.equal(by('procstart-matches').alive, true);
      // No procStart: startedAt is all we have, and 5 minutes is too far.
      assert.equal(by('startedat-off').pidReused, true);
      assert.equal(by('startedat-off').alive, false);
      assert.equal(by('startedat-ok').pidReused, false);
      assert.ok(5 * 60_000 > PID_START_SLACK_MS && 10_000 < PID_START_SLACK_MS);
    } finally {
      resetReuseVerdicts();
      tmp.cleanup();
    }
  });

  test('linux: ticks are compared to ticks, so a clock step changes nothing', async () => {
    resetReuseVerdicts();
    const tmp = makeTmpDir('verdict-linux-ticks');
    try {
      const ticks = 254037;
      writeSession(tmp.dir, 'a.json', {
        pid: process.pid, sessionId: 'same-process', status: 'busy',
        procStart: String(ticks), startedAt: (BTIME + ticks / 100) * 1000, updatedAt: 1,
      });
      const probe = fakeProbe([[process.pid, {
        startMs: linuxTicksToEpochMs(ticks, BTIME), ticks,
      }]]);
      // btime has moved 5 minutes since the file was written (NTP, or WSL2
      // resyncing after sleep). The tick comparison must not notice.
      const stepped = await readLiveSessions({
        dir: tmp.dir, platform: 'linux', btimeSec: BTIME + 300, probe,
      });
      assert.equal(stepped.sessions[0].pidReused, false);
      assert.equal(stepped.sessions[0].alive, true);

      // A different process on the same pid: more than 6000 ticks (60 s) apart.
      resetReuseVerdicts();
      const other = fakeProbe([[process.pid, {
        startMs: linuxTicksToEpochMs(ticks + 6001, BTIME), ticks: ticks + 6001,
      }]]);
      const reused = await readLiveSessions({
        dir: tmp.dir, platform: 'linux', btimeSec: BTIME, probe: other,
      });
      assert.equal(reused.sessions[0].pidReused, true);
      assert.equal(reused.sessions[0].alive, false);
      assert.equal(reused.sessions[0].aliveSource, 'pid-reused');
    } finally {
      resetReuseVerdicts();
      tmp.cleanup();
    }
  });

  test('linux: a session that began before this boot is reused, ticks or not', async () => {
    const ticks = 254037;
    const probe = fakeProbe([[process.pid, {
      startMs: linuxTicksToEpochMs(ticks, BTIME), ticks,
    }]]);
    const read = async (startedAt) => {
      resetReuseVerdicts();
      const tmp = makeTmpDir('verdict-linux-boot');
      try {
        writeSession(tmp.dir, 'a.json', {
          pid: process.pid, sessionId: 'across-boot', status: 'busy',
          procStart: String(ticks), startedAt, updatedAt: 1,
        });
        const { sessions } = await readLiveSessions({
          dir: tmp.dir, platform: 'linux', btimeSec: BTIME, probe,
        });
        return sessions[0];
      } finally {
        resetReuseVerdicts();
        tmp.cleanup();
      }
    };

    // Ticks agree by coincidence, but the session predates the boot.
    const old = await read(BTIME * 1000 - 20 * 60_000);
    assert.equal(old.pidReused, true);
    assert.equal(old.alive, false);
    assert.equal(old.aliveSource, 'pid-reused');

    // Only 5 minutes before btime: within the slack a clock step can explain.
    const fresh = await read(BTIME * 1000 - 5 * 60_000);
    assert.equal(fresh.pidReused, false);
    assert.equal(fresh.alive, true);
  });
});
