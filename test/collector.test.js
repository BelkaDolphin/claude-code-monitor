/**
 * Collector tests. Everything points at a temp directory - no real Claude Code
 * data is read, and fs.watch is off so the assertions are about the polling
 * path (the one that has to work on Windows).
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeTmpDir, appendJsonl } from './helpers.js';
import { Collector } from '../src/collector.js';
import { derivePhase, reduce, MAX_ARCHIVED_SESSIONS } from '../src/state.js';
import { normalizeEvent } from '../src/hooks-ingest.js';
import { UsageCollector } from '../src/usage.js';
import { localDateKey } from '../src/paths.js';

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const MIN = 60 * 1000;

function dirs(root) {
  const events = path.join(root, 'events');
  const statusline = path.join(root, 'statusline');
  const sessions = path.join(root, 'sessions');
  const projects = path.join(root, 'projects');
  for (const d of [events, statusline, sessions, projects]) fs.mkdirSync(d, { recursive: true });
  return { events, statusline, sessions, projects };
}

function makeCollector(root, extra = {}) {
  const d = dirs(root);
  return new Collector({
    eventsDir: d.events,
    statuslineDir: d.statusline,
    sessionsDir: d.sessions,
    projectsRoot: d.projects,
    watch: false,
    readTranscripts: false,
    debounceMs: 5,
    ...extra,
  });
}

function hookLine(name, extra = {}) {
  return {
    receivedAt: new Date().toISOString(),
    hookEventName: name,
    hook_event_name: name,
    session_id: SID,
    cwd: 'D:\\tmp\\proj',
    ...extra,
  };
}

/** Wait for one 'change' emit, or reject after ms. */
function waitForChange(collector, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      collector.off('change', onChange);
      reject(new Error('timed out waiting for change'));
    }, ms);
    function onChange() {
      clearTimeout(t);
      collector.off('change', onChange);
      resolve();
    }
    collector.on('change', onChange);
  });
}

describe('collector: hook ingestion', () => {
  let tmp;
  let collector;

  before(() => { tmp = makeTmpDir('cm-collector'); });
  after(() => { if (collector) collector.stop(); tmp.cleanup(); });

  test('picks up appended events and emits change', async () => {
    collector = makeCollector(tmp.dir);
    const day = path.join(tmp.dir, 'events', `${localDateKey(new Date())}.jsonl`);
    await collector.start();

    const changed = waitForChange(collector);
    appendJsonl(day, [hookLine('SessionStart'), hookLine('UserPromptSubmit')]);
    collector.pollHooks();
    await changed;

    const snap = collector.snapshot();
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0].sessionId, SID);
    assert.equal(snap.sessions[0].phase, 'busy');
    assert.equal(snap.sessions[0].phaseSource, 'hooks');
    assert.equal(snap.stats.hookEvents, 2);
  });

  test('a second poll with nothing new does not re-read', () => {
    const before = collector.stats().hookEvents;
    assert.equal(collector.pollHooks(), false);
    assert.equal(collector.stats().hookEvents, before);
  });

  test('a corrupt line is counted and the good ones still land', async () => {
    const day = path.join(tmp.dir, 'events', `${localDateKey(new Date())}.jsonl`);
    const changed = waitForChange(collector);
    fs.appendFileSync(day, '{not json at all\n', 'utf8');
    appendJsonl(day, [hookLine('PreToolUse', { tool_name: 'Bash', tool_use_id: 'x1' })]);
    collector.pollHooks();
    await changed;

    assert.equal(collector.stats().hookParseFailures, 1);
    assert.equal(collector.snapshot().sessions[0].currentTool.name, 'Bash');
    assert.ok(collector.stats().errorCount >= 1);
  });

  test('an unknown hook event is recorded, not fatal', () => {
    const day = path.join(tmp.dir, 'events', `${localDateKey(new Date())}.jsonl`);
    appendJsonl(day, [hookLine('WorktreeCreate')]);
    collector.pollHooks();
    assert.equal(collector.stats().unknownEvents.WorktreeCreate, 1);
    assert.equal(collector.snapshot().sessions[0].lastEventName, 'WorktreeCreate');
  });
});

describe('collector: day rollover', () => {
  let tmp;
  let collector;

  before(() => { tmp = makeTmpDir('cm-rollover'); });
  after(() => { if (collector) collector.stop(); tmp.cleanup(); });

  test('reads yesterday too when it starts just after midnight', async () => {
    const d = dirs(tmp.dir);
    const now = new Date(2026, 8, 3, 0, 30, 0); // 00:30 local
    const yesterday = new Date(2026, 8, 2, 23, 59, 0);
    appendJsonl(path.join(d.events, `${localDateKey(yesterday)}.jsonl`), [
      { ...hookLine('SessionStart'), receivedAt: yesterday.toISOString() },
    ]);

    collector = makeCollector(tmp.dir, { now: () => now });
    await collector.start();
    const snap = collector.snapshot();
    assert.equal(snap.sessions.length, 1);
    assert.equal(snap.sessions[0].phase, 'idle');
    assert.deepEqual(collector.stats().activeDates, ['2026-09-02', '2026-09-03']);
  });

  test('crossing midnight starts reading the new day file', async () => {
    const d = dirs(tmp.dir);
    let now = new Date(2026, 8, 3, 23, 59, 30);
    const c = makeCollector(tmp.dir, { now: () => now });
    appendJsonl(path.join(d.events, `${localDateKey(now)}.jsonl`), [
      { ...hookLine('UserPromptSubmit'), receivedAt: now.toISOString() },
    ]);
    await c.start();
    try {
      assert.equal(c.snapshot().sessions[0].phase, 'busy');

      now = new Date(2026, 8, 4, 0, 0, 30);
      appendJsonl(path.join(d.events, `${localDateKey(now)}.jsonl`), [
        { ...hookLine('Stop'), receivedAt: now.toISOString() },
      ]);
      assert.equal(c.pollHooks(), true);
      assert.equal(c.snapshot().sessions[0].phase, 'idle');
      assert.ok(c.stats().activeDates.includes('2026-09-04'));
    } finally {
      c.stop();
    }
  });

  test('the day that just ended is still read after the roll, not dropped', async () => {
    // The regression: activeDates is a Set, so the old trim walked INSERTION
    // order. A start at 00:30 primes [today, yesterday] in that order, so the
    // next rollover deleted the day that had just ended and kept the one
    // before it - and it deleted BEFORE reading, so the last events written
    // just before midnight were lost for good.
    const tmp2 = makeTmpDir('cm-roll2');
    const d = dirs(tmp2.dir);
    let now = new Date(2026, 8, 3, 0, 30, 0); // start at 00:30 on the 3rd
    const c = makeCollector(tmp2.dir, { now: () => now });
    const file = (date) => path.join(d.events, `${localDateKey(date)}.jsonl`);
    // Something on the 2nd (so it is primed) and on the 3rd.
    appendJsonl(file(new Date(2026, 8, 2, 23, 0)), [
      { ...hookLine('SessionStart'), receivedAt: new Date(2026, 8, 2, 23, 0).toISOString() },
    ]);
    await c.start();
    try {
      assert.deepEqual(c.stats().activeDates, ['2026-09-02', '2026-09-03']);
      appendJsonl(file(new Date(2026, 8, 3, 12, 0)), [
        { ...hookLine('UserPromptSubmit'), receivedAt: new Date(2026, 8, 3, 12, 0).toISOString() },
      ]);
      now = new Date(2026, 8, 3, 12, 0, 1);
      c.pollHooks();
      assert.equal(c.snapshot().sessions[0].phase, 'busy');

      // 23:59:59.800 on the 3rd, written to the 3rd's file, and the clock has
      // already crossed into the 4th when the next tick runs.
      const last = new Date(2026, 8, 3, 23, 59, 59, 800);
      appendJsonl(file(last), [{ ...hookLine('SessionEnd'), receivedAt: last.toISOString(), reason: 'clear' }]);
      now = new Date(2026, 8, 4, 0, 0, 0, 200);
      c.pollHooks();

      assert.equal(c.snapshot().sessions[0].phase, 'ended',
        'the SessionEnd written in the last second of the old day was lost');
      assert.deepEqual(c.stats().activeDates, ['2026-09-03', '2026-09-04'],
        'the day that just ended must survive the trim; the older one goes');
    } finally {
      c.stop();
      tmp2.cleanup();
    }
  });
});

describe('collector: events retention', () => {
  let tmp;

  before(() => { tmp = makeTmpDir('cm-keep'); });
  after(() => tmp.cleanup());

  /** Write `n` day files ending today, plus one file that is not a day file. */
  function seedDays(dir, now, n) {
    const names = [];
    for (let i = 0; i < n; i++) {
      const d = new Date(now.getTime() - i * 24 * 3600 * 1000);
      const name = `${localDateKey(d)}.jsonl`;
      fs.writeFileSync(path.join(dir, name), '{"receivedAt":"x"}\n', 'utf8');
      names.push(name);
    }
    return names;
  }

  test('day files past the window are deleted at startup, and only day files', async () => {
    const root = path.join(tmp.dir, 'prune');
    const d = dirs(root);
    const now = new Date(2026, 8, 30, 10, 0, 0);
    seedDays(d.events, now, 40);
    // Anything that is not exactly YYYY-MM-DD.jsonl is none of our business.
    for (const other of ['notes.txt', '2026-09-01.jsonl.bak', 'offsets.json']) {
      fs.writeFileSync(path.join(d.events, other), 'keep me', 'utf8');
    }
    const c = makeCollector(root, { now: () => now, eventsKeepDays: 30 });
    await c.start();
    try {
      const left = fs.readdirSync(d.events).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
      assert.equal(left.length, 30, 'exactly the window is kept');
      assert.equal(left.includes('2026-09-30.jsonl'), true, 'today is kept');
      assert.equal(left.includes('2026-09-01.jsonl'), true, 'the 30th-newest day is kept');
      assert.equal(left.includes('2026-08-31.jsonl'), false, 'the day past the window is gone');
      assert.equal(c.stats().eventFilesDeleted, 10);
      assert.equal(c.stats().eventsKeepDays, 30);
      for (const other of ['notes.txt', '2026-09-01.jsonl.bak', 'offsets.json']) {
        assert.equal(fs.existsSync(path.join(d.events, other)), true, `${other} was deleted`);
      }
    } finally {
      c.stop();
    }
  });

  test('crossing midnight prunes again, and 0 turns the whole thing off', async () => {
    const root = path.join(tmp.dir, 'roll');
    const d = dirs(root);
    let now = new Date(2026, 8, 30, 23, 59, 0);
    seedDays(d.events, now, 5);
    const c = makeCollector(root, { now: () => now, eventsKeepDays: 3 });
    await c.start();
    try {
      assert.equal(c.stats().eventFilesDeleted, 2);
      now = new Date(2026, 9, 1, 0, 0, 30);
      c.pollHooks();
      // The window moved with the clock: 09-28 was the oldest kept, now it goes.
      assert.equal(fs.existsSync(path.join(d.events, '2026-09-28.jsonl')), false);
      assert.equal(fs.existsSync(path.join(d.events, '2026-09-30.jsonl')), true);
      assert.equal(c.stats().eventFilesDeleted, 3);
    } finally {
      c.stop();
    }

    const root2 = path.join(tmp.dir, 'off');
    const d2 = dirs(root2);
    seedDays(d2.events, new Date(2026, 8, 30, 10, 0), 40);
    const c2 = makeCollector(root2, { now: () => new Date(2026, 8, 30, 10, 0), eventsKeepDays: 0 });
    await c2.start();
    try {
      assert.equal(fs.readdirSync(d2.events).length, 40, '--events-keep-days 0 deletes nothing');
      assert.equal(c2.stats().eventFilesDeleted, 0);
    } finally {
      c2.stop();
    }
  });
});

describe('collector: resilience', () => {
  let tmp;

  before(() => { tmp = makeTmpDir('cm-resil'); });
  after(() => { tmp.cleanup(); });

  test("a 'change' listener that throws does not take the collector down", async () => {
    // The debounced emit runs from a setTimeout, which has no catch site above
    // it: server.js listens with `sse.broadcast('snapshot', ...)`, so a throw
    // in the broadcast used to become an uncaughtException. Everything the
    // collector emits now goes through safeTick.
    const root = path.join(tmp.dir, 'throwing-listener');
    const d = dirs(root);
    const c = makeCollector(root, { debounceMs: 0 });
    let calls = 0;
    c.on('change', () => { calls += 1; throw new Error('listener exploded'); });
    await c.start();
    try {
      assert.ok(calls >= 1, 'the listener ran');
      const after = c.counters.tickErrors;
      assert.ok(after >= 1, 'the failure was counted, not swallowed silently');
      assert.ok(c.recentErrors.some((e) => e.where === 'tick:emit-change'));

      // ...and the collector keeps working: a new event still lands in state.
      appendJsonl(path.join(d.events, `${localDateKey(new Date())}.jsonl`), [hookLine('UserPromptSubmit')]);
      assert.equal(c.pollHooks(), true);
      assert.equal(c.snapshot().sessions[0].phase, 'busy');
      assert.ok(c.counters.tickErrors > after, 'the second emit was guarded too');
    } finally {
      c.stop();
    }
  });

  test('a missing events directory is not an error, just nothing to read', async () => {
    const root = path.join(tmp.dir, 'nowhere');
    const c = new Collector({
      eventsDir: path.join(root, 'events'),
      statuslineDir: path.join(root, 'statusline'),
      sessionsDir: path.join(root, 'sessions'),
      projectsRoot: path.join(root, 'projects'),
      watch: false,
      readTranscripts: false,
      debounceMs: 0,
    });
    await c.start();
    try {
      assert.deepEqual(c.snapshot().sessions, []);
      assert.equal(c.snapshot().ok, true);
    } finally {
      c.stop();
    }
  });

  test('statusline sidecars merge into the matching session', async () => {
    const d = dirs(tmp.dir);
    fs.writeFileSync(
      path.join(d.statusline, `${SID}.json`),
      JSON.stringify({
        capturedAt: '2026-09-02T14:35:09.268Z',
        session_id: SID,
        model: { display_name: 'Fable 5.1' },
        context_window: { used_percentage: 16 },
        cost: { total_cost_usd: 1.5 },
        rate_limits: { five_hour: { used_percentage: 34, resets_at: Math.floor(Date.now() / 1000) + 3600 } },
      }),
      'utf8',
    );
    appendJsonl(path.join(d.events, `${localDateKey(new Date())}.jsonl`), [hookLine('SessionStart')]);

    const c = makeCollector(tmp.dir);
    await c.start();
    try {
      const s = c.snapshot().sessions[0];
      assert.equal(s.model, 'Fable 5.1');
      assert.equal(s.contextPct, 16);
      assert.equal(s.costUsd, 1.5);
      assert.equal(s.rateLimits.five_hour.used_percentage, 34);
      assert.equal(derivePhase({ hookPhase: s.hookPhase, alive: s.alive }).phase, 'idle');
    } finally {
      c.stop();
    }
  });

  test('a broken sidecar file is skipped without stopping the others', async () => {
    const d = dirs(tmp.dir);
    fs.writeFileSync(path.join(d.statusline, 'broken.json'), '{{{', 'utf8');
    const c = makeCollector(tmp.dir);
    await c.start();
    try {
      assert.equal(c.pollStatusline(), false);
      assert.equal(c.snapshot().sessions[0].model, 'Fable 5.1');
    } finally {
      c.stop();
    }
  });

  test('stop() clears every timer and watcher', async () => {
    const c = makeCollector(tmp.dir, { watch: true });
    await c.start();
    c.stop();
    assert.equal(c.timers.length, 0);
    assert.equal(c.watchers.length, 0);
    assert.equal(c.running, false);
  });
});

describe('collector: debounce', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('cm-debounce'); });
  after(() => { tmp.cleanup(); });

  test('a burst of writes produces one change', async () => {
    const d = dirs(tmp.dir);
    const c = makeCollector(tmp.dir, { debounceMs: 60 });
    await c.start();
    try {
      let changes = 0;
      c.on('change', () => { changes++; });
      const day = path.join(d.events, `${localDateKey(new Date())}.jsonl`);
      for (let i = 0; i < 5; i++) {
        appendJsonl(day, [hookLine('PreToolUse', { tool_name: 'Bash', tool_use_id: `t${i}` })]);
        c.pollHooks();
      }
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(changes, 1, `expected one coalesced change, got ${changes}`);
    } finally {
      c.stop();
    }
  });
});

describe('collector: memory does not grow without bound', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('cm-prune'); });
  after(() => { tmp.cleanup(); });

  /** Fill state with more archived sessions than the cap allows. */
  function seedArchived(c, n) {
    for (let i = 0; i < n; i++) {
      const id = `old${String(i).padStart(3, '0')}`;
      c.state = reduce(c.state, normalizeEvent({
        hookEventName: 'SessionEnd',
        session_id: id,
        reason: 'clear',
        receivedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      })).state;
      c.usage.set(id, new UsageCollector());
    }
  }

  test('pruning happens on the sessions path too, not only on hook events', async () => {
    const d = dirs(tmp.dir);
    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    try {
      // Appears only AFTER the priming poll, so the next poll is the first to
      // see it. Uses our own PID so sessions.js reports it as alive.
      fs.writeFileSync(
        path.join(d.sessions, `${process.pid}.json`),
        JSON.stringify({
          pid: process.pid, sessionId: 'from-sessions', cwd: 'D:\\x', status: 'busy',
        }),
        'utf8',
      );
      seedArchived(c, MAX_ARCHIVED_SESSIONS + 8);
      // Only the seeded archived ones so far - the sessions file is unread.
      assert.equal(Object.keys(c.state.sessions).length, MAX_ARCHIVED_SESSIONS + 8);
      assert.equal(c.usage.size, MAX_ARCHIVED_SESSIONS + 8);

      // No hook fires here at all - only the sessions poller moves.
      const changed = await c.pollSessions(false);
      assert.equal(changed, true, 'the sessions poll should have reported a change');

      const ids = Object.keys(c.state.sessions);
      assert.equal(ids.length, MAX_ARCHIVED_SESSIONS + 1, `kept ${ids.length}`);
      assert.ok(ids.includes('from-sessions'), 'the session known only from sessions/ survived');
      assert.equal(ids.includes('old000'), false, 'the oldest archived session was dropped');
      assert.equal(c.usage.size, MAX_ARCHIVED_SESSIONS,
        'usage collectors for dropped sessions were released');
    } finally {
      c.stop();
    }
  });

  test('a statusline-only change also triggers the prune', async () => {
    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    try {
      seedArchived(c, MAX_ARCHIVED_SESSIONS + 3);
      const before = Object.keys(c.state.sessions).length;
      c.markChanged();
      assert.ok(Object.keys(c.state.sessions).length < before);
      assert.ok(Object.keys(c.state.sessions).length <= MAX_ARCHIVED_SESSIONS + 1);
    } finally {
      c.stop();
    }
  });

  test('prune keeps live sessions no matter how old they are', async () => {
    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    try {
      c.state = reduce(c.state, normalizeEvent({
        hookEventName: 'UserPromptSubmit',
        session_id: 'ancient-but-live',
        receivedAt: '1999-01-01T00:00:00.000Z',
      })).state;
      seedArchived(c, MAX_ARCHIVED_SESSIONS + 5);
      c.prune();
      assert.ok(c.state.sessions['ancient-but-live'], 'the live session survived');
      assert.equal(derivePhase(c.state.sessions['ancient-but-live']).phase, 'busy');
    } finally {
      c.stop();
    }
  });
});

describe('collector: a throwing poller cannot kill the process', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('cm-crash'); });
  after(() => { tmp.cleanup(); });

  test('safeTick records a synchronous throw instead of letting it escape', async () => {
    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    try {
      const before = c.errorCount();
      const out = c.safeTick('boom', () => { throw new Error('exploded'); });
      assert.equal(out, false);
      assert.equal(c.errorCount(), before + 1);
      assert.equal(c.stats().tickErrors, 1);
      const last = c.stats().recentErrors.pop();
      assert.equal(last.where, 'tick:boom');
      assert.match(last.message, /exploded/);
    } finally {
      c.stop();
    }
  });

  test('safeTick catches a rejected promise from an async poller', async () => {
    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    try {
      const out = await c.safeTick('async-boom', () => Promise.reject(new Error('later')));
      assert.equal(out, false);
      assert.equal(c.stats().tickErrors, 1);
      assert.match(c.stats().recentErrors.pop().where, /async-boom/);
    } finally {
      c.stop();
    }
  });

  test('a poller that throws on every tick keeps the process alive', async () => {
    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    let uncaught = 0;
    const onUncaught = () => { uncaught++; };
    process.on('uncaughtException', onUncaught);
    try {
      // Stub the real poller the way a corrupt state or a bad path would break it.
      c.pollStatusline = () => { throw new TypeError('cannot read properties of null'); };
      for (let i = 0; i < 5; i++) c.safeTick('statusline', () => c.pollStatusline());
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(uncaught, 0, 'nothing escaped to the process');
      assert.equal(c.stats().tickErrors, 5);
      assert.ok(c.errorCount() >= 5);
      // The collector still answers, which is the whole point.
      assert.equal(c.snapshot().ok, true);
    } finally {
      process.off('uncaughtException', onUncaught);
      c.stop();
    }
  });

  test('a malformed event cannot stop the rest of the day file', async () => {
    const d = dirs(tmp.dir);
    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    try {
      const day = path.join(d.events, `${localDateKey(new Date())}.jsonl`);
      appendJsonl(day, [hookLine('SessionStart'), hookLine('UserPromptSubmit')]);
      assert.equal(c.pollHooks(), true);
      assert.equal(c.snapshot().sessions[0].phase, 'busy');
      assert.equal(c.errorCount(), 0);
    } finally {
      c.stop();
    }
  });
});

describe('collector: file-level bookkeeping is released', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('cm-files'); });
  after(() => { tmp.cleanup(); });

  test('prune releases tail offsets, index entries and usage collectors', async () => {
    const d = dirs(tmp.dir);
    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    try {
      // Give each archived session a transcript we have actually tailed.
      const seeded = [];
      for (let i = 0; i < MAX_ARCHIVED_SESSIONS + 6; i++) {
        const id = `s${String(i).padStart(3, '0')}`;
        const file = path.join(d.projects, `${id}.jsonl`);
        fs.writeFileSync(file, `${JSON.stringify({ type: 'ai-title', aiTitle: id })}\n`, 'utf8');
        c.transcriptTail.read(file);
        c.state = reduce(c.state, normalizeEvent({
          hookEventName: 'SessionEnd',
          session_id: id,
          reason: 'clear',
          transcript_path: file,
          receivedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
        })).state;
        c.usage.set(id, new UsageCollector());
        c.indexBySession.set(id, { sessionId: id, jsonlPath: file, subagents: [] });
        seeded.push(id);
      }
      const tailsBefore = c.transcriptTail.states.size;
      assert.equal(tailsBefore, seeded.length);

      assert.equal(c.prune(), true);

      assert.ok(c.transcriptTail.states.size < tailsBefore,
        `tail offsets should shrink (was ${tailsBefore}, now ${c.transcriptTail.states.size})`);
      assert.equal(c.transcriptTail.states.size, MAX_ARCHIVED_SESSIONS);
      assert.equal(c.indexBySession.size, MAX_ARCHIVED_SESSIONS);
      assert.equal(c.usage.size, MAX_ARCHIVED_SESSIONS);
      assert.equal(c.stats().tailedFiles, MAX_ARCHIVED_SESSIONS);
    } finally {
      c.stop();
    }
  });

  test('a transcript deleted by Claude Code stops being tracked', async () => {
    const d = dirs(tmp.dir);
    const proj = path.join(d.projects, 'D--proj');
    fs.mkdirSync(proj, { recursive: true });
    const keep = path.join(proj, '11111111-1111-1111-1111-111111111111.jsonl');
    const doomed = path.join(proj, '22222222-2222-2222-2222-222222222222.jsonl');
    fs.writeFileSync(keep, '{"type":"ai-title","aiTitle":"keep"}\n', 'utf8');
    fs.writeFileSync(doomed, '{"type":"ai-title","aiTitle":"doomed"}\n', 'utf8');

    const c = makeCollector(tmp.dir, { debounceMs: 0, readTranscripts: true });
    await c.start();
    try {
      c.transcriptTail.read(keep);
      c.transcriptTail.read(doomed);
      assert.equal(c.transcriptTail.states.size, 2);
      assert.equal(c.indexedFiles.size, 2);

      // Claude Code prunes transcripts older than ~30 days on its own schedule.
      fs.rmSync(doomed);
      c.pollIndex();

      assert.equal(c.indexedFiles.size, 1);
      assert.equal(c.transcriptTail.states.size, 1,
        'the offset for the deleted transcript was released');
      assert.equal(c.transcriptTail.states.has(path.resolve(keep)), true);
    } finally {
      c.stop();
    }
  });
});

describe('collector: ghosts and agent identity (browser review 2026-09-03)', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('cm-ghost'); });
  after(() => { tmp.cleanup(); });

  const MIN = 60 * 1000;

  test('sweep() drops a ghost agent out of agentsRunning and counts it', async () => {
    const d = dirs(tmp.dir);
    const day = path.join(d.events, `${localDateKey(new Date())}.jsonl`);
    // Recent, so the sweep start() runs leaves it alone; the sweep below then
    // looks at it from the future.
    const t0 = Date.now() - 1 * MIN;
    // The measured shape: one PreToolUse, one PostToolUse 17 minutes later,
    // no SubagentStart, no SubagentStop, no meta.json.
    appendJsonl(day, [
      { ...hookLine('PreToolUse'), agent_id: 'a458ad0670a1f500e', tool_name: 'Bash', tool_use_id: 'g1', receivedAt: new Date(t0).toISOString() },
      { ...hookLine('PostToolUse'), agent_id: 'a458ad0670a1f500e', tool_name: 'Bash', tool_use_id: 'g1', receivedAt: new Date(t0 + 30 * 1000).toISOString() },
    ]);

    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    try {
      assert.equal(c.snapshot().counts.agentsRunning, 1, 'it starts out looking alive');

      assert.equal(c.sweep(Date.now() + 60 * MIN), true);
      const snap = c.snapshot();
      assert.equal(snap.counts.agentsRunning, 0);
      assert.equal(snap.sessions[0].agents[0].status, 'stale');
      assert.equal(snap.sessions[0].agents[0].statusSource, 'inferred');
      assert.equal(c.stats().agentsStale, 1);
      // Inference is not an ingest failure.
      assert.equal(c.stats().errorCount, 0);
    } finally {
      c.stop();
    }
  });

  test('start() sweeps once so a stale ghost is never shown as live', async () => {
    const tmp2 = makeTmpDir('cm-ghost2');
    try {
      const d = dirs(tmp2.dir);
      const day = path.join(d.events, `${localDateKey(new Date())}.jsonl`);
      appendJsonl(day, [
        { ...hookLine('PreToolUse'), agent_id: 'old', tool_name: 'Bash', tool_use_id: 'x', receivedAt: new Date(Date.now() - 90 * MIN).toISOString() },
      ]);
      const c = makeCollector(tmp2.dir, { debounceMs: 0 });
      await c.start();
      try {
        assert.equal(c.snapshot().counts.agentsRunning, 0, 'the first snapshot is already clean');
      } finally {
        c.stop();
      }
    } finally {
      tmp2.cleanup();
    }
  });

  test('the thresholds are configurable', async () => {
    const tmp3 = makeTmpDir('cm-ghost3');
    try {
      const d = dirs(tmp3.dir);
      const day = path.join(d.events, `${localDateKey(new Date())}.jsonl`);
      appendJsonl(day, [
        { ...hookLine('PreToolUse'), agent_id: 'slow', tool_name: 'Bash', tool_use_id: 'x', receivedAt: new Date(Date.now() - 20 * MIN).toISOString() },
      ]);
      const c = makeCollector(tmp3.dir, { debounceMs: 0, agentStaleMs: 4 * 60 * MIN, toolTimeoutMs: 4 * 60 * MIN });
      await c.start();
      try {
        assert.equal(c.snapshot().counts.agentsRunning, 1, 'a generous threshold keeps it running');
        assert.equal(c.stats().toolTimeouts, 0);
      } finally {
        c.stop();
      }
    } finally {
      tmp3.cleanup();
    }
  });

  test('meta.json fills in the description, type and model of a live agent', async () => {
    const tmp4 = makeTmpDir('cm-meta');
    try {
      const d = dirs(tmp4.dir);
      const sessionId = '33333333-3333-3333-3333-333333333333';
      const proj = path.join(d.projects, 'D--proj');
      const subs = path.join(proj, sessionId, 'subagents');
      fs.mkdirSync(subs, { recursive: true });
      fs.writeFileSync(path.join(proj, `${sessionId}.jsonl`), '{"type":"ai-title","aiTitle":"Proj"}\n', 'utf8');
      fs.writeFileSync(path.join(subs, 'agent-ag1.jsonl'), '', 'utf8');
      fs.writeFileSync(
        path.join(subs, 'agent-ag1.meta.json'),
        JSON.stringify({
          agentType: 'general-purpose',
          description: 'Implement M2 server and Live view',
          spawnDepth: 1,
          model: 'opus',
        }),
        'utf8',
      );

      const day = path.join(d.events, `${localDateKey(new Date())}.jsonl`);
      appendJsonl(day, [
        { ...hookLine('SubagentStart'), session_id: sessionId, agent_id: 'ag1' },
      ]);

      const c = makeCollector(tmp4.dir, { debounceMs: 0, readTranscripts: true });
      await c.start();
      try {
        const agent = c.snapshot().sessions[0].agents[0];
        assert.equal(agent.description, 'Implement M2 server and Live view');
        assert.equal(agent.agentType, 'general-purpose');
        assert.equal(agent.model, 'opus');
        assert.equal(agent.modelSource, 'meta');
        assert.equal(agent.label, 'Implement M2 server and Live view（general-purpose）');
        // The agent transcript is fresh, so it is not swept away.
        assert.equal(c.snapshot().counts.agentsRunning, 1);
      } finally {
        c.stop();
      }
    } finally {
      tmp4.cleanup();
    }
  });

  test("without a model in meta.json the agent's own transcript supplies one", async () => {
    const tmp5 = makeTmpDir('cm-model');
    try {
      const d = dirs(tmp5.dir);
      const sessionId = '44444444-4444-4444-4444-444444444444';
      const proj = path.join(d.projects, 'D--proj');
      const subs = path.join(proj, sessionId, 'subagents');
      fs.mkdirSync(subs, { recursive: true });
      fs.writeFileSync(path.join(proj, `${sessionId}.jsonl`), '', 'utf8');
      // Real depth-2 metas have no `model` (measured: 1 of 7 here).
      fs.writeFileSync(
        path.join(subs, 'agent-ag2.meta.json'),
        JSON.stringify({ agentType: 'feature-dev:code-reviewer', description: 'Review M2 code', spawnDepth: 2 }),
        'utf8',
      );
      fs.writeFileSync(
        path.join(subs, 'agent-ag2.jsonl'),
        `${JSON.stringify({
          type: 'assistant',
          uuid: 'u1',
          timestamp: new Date().toISOString(),
          sessionId,
          message: { id: 'm1', role: 'assistant', model: 'claude-sonnet-5', content: [], usage: { input_tokens: 1 } },
        })}\n`,
        'utf8',
      );

      const day = path.join(d.events, `${localDateKey(new Date())}.jsonl`);
      appendJsonl(day, [{ ...hookLine('SubagentStart'), session_id: sessionId, agent_id: 'ag2' }]);

      const c = makeCollector(tmp5.dir, { debounceMs: 0, readTranscripts: true });
      await c.start();
      try {
        const agent = c.snapshot().sessions[0].agents[0];
        assert.equal(agent.model, 'claude-sonnet-5');
        assert.equal(agent.modelSource, 'transcript');
        assert.equal(agent.label, 'Review M2 code（feature-dev:code-reviewer）');
      } finally {
        c.stop();
      }
    } finally {
      tmp5.cleanup();
    }
  });

  test('a prompt updates lastPrompt and never the title', async () => {
    const tmp6 = makeTmpDir('cm-title');
    try {
      const d = dirs(tmp6.dir);
      const day = path.join(d.events, `${localDateKey(new Date())}.jsonl`);
      appendJsonl(day, [
        hookLine('SessionStart'),
        { ...hookLine('UserPromptSubmit'), prompt: '[Image #1]' },
      ]);
      const c = makeCollector(tmp6.dir, { debounceMs: 0 });
      await c.start();
      try {
        const s = c.snapshot().sessions[0];
        assert.equal(s.title, 'proj', 'the cwd basename, not the prompt');
        assert.equal(s.lastPrompt, '[Image #1]');
      } finally {
        c.stop();
      }
    } finally {
      tmp6.cleanup();
    }
  });
});

/**
 * The header said 「3 稼働」with one session running (2026-09-06).
 *
 * End to end through the real collector: the statusline directory keeps a file
 * per session forever, and applyStatusline mints a record for each one. Only
 * the session hooks actually vouch for may be counted.
 */
describe('collector: only sessions with evidence are live', () => {
  let tmp;
  const OLD_A = 'b5824c60-6421-43c7-848c-1095bc09436d';
  const OLD_B = 'ea1b82f5-5a07-4d1d-9920-479d8cece715';

  before(() => { tmp = makeTmpDir('cm-live'); });
  after(() => { tmp.cleanup(); });

  const sidecar = (dir, sessionId) => fs.writeFileSync(
    path.join(dir, `${sessionId}.json`),
    JSON.stringify({
      capturedAt: '2026-09-03T14:39:00.000Z',
      session_id: sessionId,
      model: { display_name: 'Fable 5.1' },
      context_window: { used_percentage: 16 },
    }),
    'utf8',
  );

  test('one hooks-busy session plus two sidecar-only ones counts as 1 live', async () => {
    const d = dirs(tmp.dir);
    sidecar(d.statusline, OLD_A);
    sidecar(d.statusline, OLD_B);
    appendJsonl(path.join(d.events, `${localDateKey(new Date())}.jsonl`), [
      hookLine('SessionStart'),
      hookLine('UserPromptSubmit'),
    ]);

    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    try {
      const snap = c.snapshot();
      assert.equal(snap.counts.total, 3, 'the old records still exist');
      assert.equal(snap.counts.live, 1, 'only the one hooks vouch for');
      assert.equal(snap.counts.busy, 1);

      const byId = Object.fromEntries(snap.sessions.map((s) => [s.sessionId, s]));
      assert.equal(byId[SID].phase, 'busy');
      assert.equal(byId[SID].phaseSource, 'hooks');
      for (const id of [OLD_A, OLD_B]) {
        assert.equal(byId[id].phase, 'unknown', id);
        assert.equal(byId[id].phaseSource, 'none', id);
        assert.equal(byId[id].model, 'Fable 5.1', 'the sidecar data is still carried');
      }
    } finally {
      c.stop();
    }
  });
});

/**
 * A session killed mid-turn: hooks stop, no SessionEnd ever arrives, and the
 * day file is still inside the replay window so the record survives.
 */
describe('collector: a session whose SessionEnd never came', () => {
  let tmp;

  before(() => { tmp = makeTmpDir('cm-sess-stale'); });
  after(() => { tmp.cleanup(); });

  test('it goes stale on the sweep and any later event brings it back', async () => {
    const d = dirs(tmp.dir);
    const day = path.join(d.events, `${localDateKey(new Date())}.jsonl`);
    appendJsonl(day, [
      { ...hookLine('UserPromptSubmit'), receivedAt: new Date(Date.now() - 45 * MIN).toISOString() },
    ]);

    const c = makeCollector(tmp.dir, { debounceMs: 0 });
    await c.start();
    try {
      // start() sweeps once, so the crash is already reflected.
      const s = c.snapshot().sessions[0];
      assert.equal(s.phase, 'stale');
      assert.equal(s.phaseSource, 'inferred');
      assert.equal(s.staleReason, 'no hook event for 30 min, PID unknown');
      assert.equal(c.snapshot().counts.live, 0);
      assert.equal(c.stats().sessionsStale, 1);

      appendJsonl(day, [hookLine('UserPromptSubmit')]);
      assert.equal(c.pollHooks(), true);
      assert.equal(c.snapshot().sessions[0].phase, 'busy');
      assert.equal(c.snapshot().counts.live, 1);
    } finally {
      c.stop();
    }
  });

  test('a fresh event inside the window is left alone', async () => {
    const tmp2 = makeTmpDir('cm-sess-fresh');
    try {
      const d = dirs(tmp2.dir);
      appendJsonl(path.join(d.events, `${localDateKey(new Date())}.jsonl`), [
        { ...hookLine('UserPromptSubmit'), receivedAt: new Date(Date.now() - 5 * MIN).toISOString() },
      ]);
      const c = makeCollector(tmp2.dir, { debounceMs: 0 });
      await c.start();
      try {
        assert.equal(c.snapshot().sessions[0].phase, 'busy');
        assert.equal(c.stats().sessionsStale, 0);
      } finally {
        c.stop();
      }
    } finally {
      tmp2.cleanup();
    }
  });

  test('a transcript still growing keeps a silent session busy', async () => {
    const tmp3 = makeTmpDir('cm-sess-file');
    try {
      const d = dirs(tmp3.dir);
      const proj = path.join(d.projects, 'D--proj');
      fs.mkdirSync(proj, { recursive: true });
      // Written now, so its mtime is inside the window even though hooks are not.
      fs.writeFileSync(path.join(proj, `${SID}.jsonl`), '{"type":"ai-title","aiTitle":"Proj"}\n', 'utf8');

      appendJsonl(path.join(d.events, `${localDateKey(new Date())}.jsonl`), [
        { ...hookLine('UserPromptSubmit'), receivedAt: new Date(Date.now() - 45 * MIN).toISOString() },
      ]);
      const c = makeCollector(tmp3.dir, { debounceMs: 0, readTranscripts: true });
      await c.start();
      try {
        assert.equal(c.snapshot().sessions[0].phase, 'busy', 'the file moved, so work is happening');
        assert.equal(c.stats().sessionsStale, 0);
      } finally {
        c.stop();
      }
    } finally {
      tmp3.cleanup();
    }
  });

  test('a live PID is never swept, however long hooks have been silent', async () => {
    const tmp4 = makeTmpDir('cm-sess-pid');
    try {
      const d = dirs(tmp4.dir);
      fs.writeFileSync(
        path.join(d.sessions, `${process.pid}.json`),
        // No startedAt/procStart: the PID-reuse check needs one to compare against
        // and would otherwise call this very process "reused" and mark it dead.
        JSON.stringify({ pid: process.pid, sessionId: SID, status: 'busy' }),
        'utf8',
      );
      appendJsonl(path.join(d.events, `${localDateKey(new Date())}.jsonl`), [
        { ...hookLine('UserPromptSubmit'), receivedAt: new Date(Date.now() - 90 * MIN).toISOString() },
      ]);
      const c = makeCollector(tmp4.dir, { debounceMs: 0 });
      await c.start();
      try {
        const s = c.snapshot().sessions[0];
        assert.equal(s.alive, true, 'this very process is the pid');
        assert.equal(s.phase, 'busy');
        assert.equal(c.stats().sessionsStale, 0);
        assert.equal(c.snapshot().counts.live, 1);
      } finally {
        c.stop();
      }
    } finally {
      tmp4.cleanup();
    }
  });
});
