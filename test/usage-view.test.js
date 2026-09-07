/**
 * M4: the Usage view's I/O layer.
 *
 * Every fixture is synthesized in a temp directory: the projects root, the
 * statusline sidecars and the persistence store are all injected, so nothing
 * under ~/.claude or ~/.claude-monitor is read or written. ccusage is never
 * spawned - the runner is injected too.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { makeTmpDir, writeJsonl, appendJsonl, assistantRec } from './helpers.js';
import { localDateKey, writeFileAtomic } from '../src/paths.js';
import {
  CCUSAGE_ERROR,
  CcusageCache,
  DEFAULT_SESSION_LIMIT,
  SERIES,
  STORE_VERSION,
  UsageFileCache,
  UsageStore,
  buildCcusageComparison,
  buildUsageView,
  fileFingerprint,
  listTranscripts,
  modelSeries,
  windowOf,
} from '../src/usage-view.js';
import { CCUSAGE_VERSION } from '../src/ccusage.js';

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const SID2 = 'bbbbbbbb-2222-3333-4444-555555555555';
const A1 = 'a1111111111111111';

/** Local noon, `back` days before the fixed NOW. Never near a midnight edge. */
const NOW = new Date(2026, 8, 5, 12, 0, 0).getTime();

function dayIso(back, sec = 0) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - back);
  d.setHours(9, 0, sec, 0);
  return d.toISOString();
}

function dayKey(back) {
  const d = new Date(NOW);
  d.setDate(d.getDate() - back);
  return localDateKey(d);
}

/** assistantRec with the model forced (it lives on message.model). */
function rec(o, model) {
  const r = assistantRec(o);
  if (model) r.message.model = model;
  return r;
}

let tmp;
let projectsRoot;
let monitorRoot;
let statuslineRoot;
let sessionDir;
let mainFile;
let subFile;

function paths() {
  return { projectsRoot, monitorDir: monitorRoot, statuslineDir: statuslineRoot };
}

/** buildUsageView with every root pointed at the temp tree. */
function view(opts = {}) {
  return buildUsageView({ now: NOW, ...paths(), ...opts });
}

function storeFile() {
  return path.join(monitorRoot, 'usage', 'daily.json');
}

function readStore() {
  return JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
}

/** One stored day, in exactly the shape a build produces (sealed totals). */
function storeDay(n) {
  return {
    msgs: 1,
    totals: {
      input_tokens: 0,
      output_tokens: n,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      count: 1,
      totalTokens: n,
    },
    byModel: {},
    updatedAt: '2026-09-05T00:00:00.000Z',
  };
}

function writeFixture() {
  const projDir = path.join(projectsRoot, 'D--tmp-usage');
  sessionDir = path.join(projDir, SID);
  fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });

  // main transcript: today and two days back, two models
  mainFile = writeJsonl(path.join(projDir, `${SID}.jsonl`), [
    rec({ messageId: 'm-today', timestamp: dayIso(0, 1), usage: { input_tokens: 10, output_tokens: 100 }, sessionId: SID }),
    rec({ messageId: 'm-d2', timestamp: dayIso(2, 1), usage: { input_tokens: 5, output_tokens: 50 }, sessionId: SID }),
    rec({ messageId: 'm-sonnet', timestamp: dayIso(2, 2), usage: { output_tokens: 7 }, sessionId: SID }, 'claude-sonnet-5'),
    // The shared message: the parent holds an EARLY streaming snapshot.
    rec({ messageId: 'shared', timestamp: dayIso(2, 3), usage: { output_tokens: 3 }, sessionId: SID }),
  ]);

  // subagent transcript: the same message.id, later and complete
  subFile = writeJsonl(path.join(sessionDir, 'subagents', `agent-${A1}.jsonl`), [
    rec({
      messageId: 'shared',
      timestamp: dayIso(2, 4),
      usage: { output_tokens: 5174 },
      sessionId: SID,
      agentId: A1,
      isSidechain: true,
    }),
    rec({ messageId: 'sub-own', timestamp: dayIso(2, 5), usage: { output_tokens: 9 }, sessionId: SID, agentId: A1, isSidechain: true }),
  ]);

  // a second, smaller session on another day
  writeJsonl(path.join(projDir, `${SID2}.jsonl`), [
    rec({ messageId: 's2-a', timestamp: dayIso(1, 1), usage: { output_tokens: 20 }, sessionId: SID2 }, 'claude-haiku-4-5'),
  ]);
}

before(() => {
  tmp = makeTmpDir('cm-usage-view');
  projectsRoot = path.join(tmp.dir, 'projects');
  monitorRoot = path.join(tmp.dir, 'monitor');
  statuslineRoot = path.join(monitorRoot, 'statusline');
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(statuslineRoot, { recursive: true });
  writeFixture();
});

after(() => tmp && tmp.cleanup());

/** A store that no earlier test left behind. */
beforeEach(() => {
  try {
    fs.rmSync(path.join(monitorRoot, 'usage'), { recursive: true, force: true });
  } catch { /* ignore */ }
});

describe('modelSeries', () => {
  test('folds both the alias and the full id onto one family name', () => {
    assert.equal(modelSeries('opus'), 'Opus');
    assert.equal(modelSeries('claude-opus-5'), 'Opus');
    assert.equal(modelSeries('claude-sonnet-4-5'), 'Sonnet');
    assert.equal(modelSeries('claude-haiku-4-5'), 'Haiku');
    assert.equal(modelSeries('claude-fable-5'), 'Fable');
  });

  test('a trailing release date is stripped before the lookup', () => {
    assert.equal(modelSeries('claude-haiku-4-5-20251001'), 'Haiku');
  });

  test('anything unknown, empty or absent lands on the one catch-all bucket', () => {
    assert.equal(modelSeries('some-future-model'), 'other');
    assert.equal(modelSeries(''), 'other');
    assert.equal(modelSeries(null), 'other');
    assert.equal(modelSeries(undefined), 'other');
    assert.ok(SERIES.includes('other'));
  });
});

describe('windowOf', () => {
  test('N days ending today, in LOCAL calendar days, inclusive', () => {
    const w = windowOf(7, NOW);
    assert.equal(w.until, dayKey(0));
    assert.equal(w.today, dayKey(0));
    assert.equal(w.since, dayKey(6), '7 days means today plus the six before it');
    assert.equal(new Date(w.sinceMs).getHours(), 0, 'the window starts at local midnight');
  });

  test('one day is just today', () => {
    const w = windowOf(1, NOW);
    assert.equal(w.since, w.until);
  });
});

describe('the per-file cache', () => {
  test('the first build misses every file, the second hits every file', () => {
    const cache = new UsageFileCache();
    const a = view({ cache });
    assert.equal(a.stats.cache.hits, 0);
    assert.equal(a.stats.cache.misses, a.stats.scannedFiles);
    assert.ok(a.stats.scannedFiles >= 3);

    const b = view({ cache });
    assert.equal(b.stats.cache.misses, 0, 'nothing changed, so nothing was re-parsed');
    assert.equal(b.stats.cache.hits, b.stats.scannedFiles);
    assert.equal(b.totals.totalTokens, a.totals.totalTokens, 'a cached build is the same build');
    assert.deepEqual(b.byModel, a.byModel);
  });

  test('the fingerprint is size:mtimeMs and moves when either does', () => {
    const [f] = listTranscripts(projectsRoot);
    const fp = fileFingerprint(f);
    assert.match(fp, /^\d+:\d+$/);
    assert.notEqual(fileFingerprint({ ...f, size: f.size + 1 }), fp);
    assert.notEqual(fileFingerprint({ ...f, mtimeMs: f.mtimeMs + 1000 }), fp);
  });

  test('CROSS-FILE dedupe stays exact when one file is cached and the other changed', () => {
    // This is the reason the cache holds per-file MESSAGE MAPS and not per-file
    // totals: `shared` lives in both transcripts, and the later copy wins.
    const cache = new UsageFileCache();
    const before = view({ cache });
    // parent 3 + sub 5174 would be 5177 if the two files were summed.
    assert.equal(before.totals.output_tokens, 100 + 50 + 7 + 5174 + 9 + 20);

    // Only the subagent file changes: a newer, larger snapshot of `shared`.
    appendJsonl(subFile, [
      rec({ messageId: 'shared', timestamp: dayIso(2, 9), usage: { output_tokens: 6000 }, sessionId: SID, agentId: A1, isSidechain: true }),
    ]);
    const after = view({ cache });
    assert.equal(after.stats.cache.misses, 1, 'only the file that moved is re-parsed');
    assert.ok(after.stats.cache.hits >= 2, 'the untouched files came from the cache');
    assert.equal(after.totals.output_tokens, 100 + 50 + 7 + 6000 + 9 + 20,
      'the cached parent map must still lose to the newer sidechain record');
    assert.equal(after.stats.uniqueMessages, before.stats.uniqueMessages,
      'a newer snapshot of a known id is not a new message');
  });

  test('a file that disappears is evicted from the cache and from the totals', () => {
    const cache = new UsageFileCache();
    const doomed = path.join(projectsRoot, 'D--tmp-usage', 'cccccccc-3333-4444-5555-666666666666.jsonl');
    writeJsonl(doomed, [
      rec({ messageId: 'doomed', timestamp: dayIso(1, 7), usage: { output_tokens: 777 }, sessionId: 'doomed-session' }),
    ]);
    const withIt = view({ cache });
    assert.ok(withIt.totals.output_tokens >= 777);
    const sizeWithIt = cache.size;

    fs.rmSync(doomed);
    const without = view({ cache });
    assert.equal(cache.size, sizeWithIt - 1, 'the vanished file no longer occupies the cache');
    assert.equal(without.totals.output_tokens, withIt.totals.output_tokens - 777);
    assert.equal(without.days.some((d) => d.date === dayKey(1) && d.source === 'store'), true,
      'the day survives in the store even though its transcript is gone');
  });

  test('a file whose mtime predates the window is not opened at all', () => {
    const cache = new UsageFileCache();
    const old = path.join(projectsRoot, 'D--tmp-usage', 'dddddddd-4444-5555-6666-777777777777.jsonl');
    writeJsonl(old, [
      rec({ messageId: 'ancient', timestamp: dayIso(80, 1), usage: { output_tokens: 1 }, sessionId: 'ancient' }),
    ]);
    const past = new Date(NOW - 80 * 24 * 3600 * 1000);
    fs.utimesSync(old, past, past);
    const d = view({ cache, days: 7 });
    assert.ok(d.stats.foundFiles > d.stats.scannedFiles, 'the old file was found but skipped');
    fs.rmSync(old);
  });
});

describe('the day window', () => {
  test('only local days inside the window are returned, newest first', () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    assert.equal(d.since, dayKey(2));
    assert.equal(d.until, dayKey(0));
    const dates = d.days.map((r) => r.date);
    assert.deepEqual(dates, [dayKey(0), dayKey(1), dayKey(2)]);
    assert.equal(d.days[0].today, true);
    assert.equal(d.days[1].today, false);
  });

  test('a narrower window drops the older days from the totals too', () => {
    const wide = view({ days: 5, cache: new UsageFileCache() });
    const narrow = view({ days: 1, cache: new UsageFileCache() });
    assert.equal(narrow.days.length, 1);
    assert.equal(narrow.totals.output_tokens, 100, 'only today is left');
    assert.ok(wide.totals.output_tokens > narrow.totals.output_tokens);
  });

  test('every day adds up: byModel of a day equals that day, and the days equal the period', () => {
    const d = view({ days: 7, cache: new UsageFileCache() });
    let sum = 0;
    for (const row of d.days) {
      const perModel = Object.values(row.byModel).reduce((n, v) => n + v.totalTokens, 0);
      assert.equal(perModel, row.totals.totalTokens, `${row.date} model split does not add up`);
      sum += row.totals.totalTokens;
    }
    assert.equal(sum, d.totals.totalTokens);
    const byModelSum = Object.values(d.byModel).reduce((n, v) => n + v.totalTokens, 0);
    assert.equal(byModelSum, d.totals.totalTokens);
  });

  test('models are reported as series, with the raw ids kept alongside', () => {
    const d = view({ days: 7, cache: new UsageFileCache() });
    assert.ok(d.byModel.Opus, 'expected an Opus bucket');
    assert.ok(d.byModel.Sonnet);
    assert.ok(d.byModel.Haiku);
    assert.deepEqual(d.byModel.Sonnet.ids, ['claude-sonnet-5']);
    assert.deepEqual(d.byModel.Opus.ids, ['claude-opus-5']);
  });
});

describe('sessions', () => {
  test('biggest first, capped, with cwd and the dominant series', () => {
    const d = view({ days: 7, cache: new UsageFileCache() });
    assert.ok(d.sessions.length >= 2);
    assert.ok(d.sessions.length <= DEFAULT_SESSION_LIMIT);
    assert.equal(d.sessions[0].sessionId, SID);
    assert.ok(d.sessions[0].totalTokens > d.sessions[1].totalTokens);
    assert.equal(d.sessions[0].model, 'Opus');
    assert.equal(d.sessions[0].cwd, 'D:\\test');
    assert.equal(d.sessions[0].projectDirName, 'test');
    assert.ok(d.sessions[0].startedAt, 'the earliest counted record is the start');
    assert.equal(d.sessions[1].model, 'Haiku');
  });

  test('the limit is honoured', () => {
    const d = view({ days: 7, cache: new UsageFileCache(), sessionLimit: 1 });
    assert.equal(d.sessions.length, 1);
    assert.equal(d.sessionCount >= 2, true, 'the count is of ALL sessions, not of the page');
  });

  test('cost comes from the statusline sidecar and is null when there is none', () => {
    fs.writeFileSync(path.join(statuslineRoot, `${SID}.json`), JSON.stringify({
      session_id: SID,
      cost: { total_cost_usd: 1.25 },
      model: { display_name: 'Opus' },
    }), 'utf8');
    const d = view({ days: 7, cache: new UsageFileCache() });
    assert.equal(d.sessions[0].costUsd, 1.25);
    assert.equal(d.sessions.find((s) => s.sessionId === SID2).costUsd, null);
    fs.rmSync(path.join(statuslineRoot, `${SID}.json`));
  });

  test('a missing statusline directory is not an error', () => {
    const d = view({ days: 7, cache: new UsageFileCache(), statuslineDir: path.join(tmp.dir, 'nope') });
    assert.equal(d.ok, true);
    assert.equal(d.sessions[0].costUsd, null);
  });

  /* ---- which model is "the session's" model (review G) ---- */

  /**
   * A session driven from Fable that farms work out to Opus subagents is the
   * common shape here, and the subagents move an order of magnitude more
   * tokens. Counting them made the column say "Opus" for a session the user
   * never once talked to Opus in.
   */
  function modelFixture(label, rootModel, subModel) {
    const root = path.join(tmp.dir, `models-${label}`);
    const sid = `${label.repeat(8)}-1111-2222-3333-888888888888`;
    const proj = path.join(root, 'D--tmp-models');
    fs.mkdirSync(path.join(proj, sid, 'subagents'), { recursive: true });
    const rootRec = rec({ messageId: `${label}-root`, timestamp: dayIso(0, 21), usage: { output_tokens: 40 }, sessionId: sid }, rootModel);
    if (!rootModel) delete rootRec.message.model;
    writeJsonl(path.join(proj, `${sid}.jsonl`), [rootRec]);
    writeJsonl(path.join(proj, sid, 'subagents', `agent-${A1}.jsonl`), [
      rec({ messageId: `${label}-s1`, timestamp: dayIso(0, 22), usage: { output_tokens: 5000 }, sessionId: sid, agentId: A1, isSidechain: true }, subModel),
      rec({ messageId: `${label}-s2`, timestamp: dayIso(0, 23), usage: { output_tokens: 5000 }, sessionId: sid, agentId: A1, isSidechain: true }, subModel),
      rec({ messageId: `${label}-s3`, timestamp: dayIso(0, 24), usage: { output_tokens: 5000 }, sessionId: sid, agentId: A1, isSidechain: true }, subModel),
    ]);
    const d = buildUsageView({
      now: NOW,
      days: 7,
      projectsRoot: root,
      monitorDir: path.join(tmp.dir, `models-store-${label}`),
      statuslineDir: statuslineRoot,
      cache: new UsageFileCache(),
    });
    return d;
  }

  test('the model column is the ROOT transcript, not the biggest subagent', () => {
    const d = modelFixture('a', 'claude-fable-5-1', 'claude-opus-5');
    assert.equal(d.sessions.length, 1);
    assert.equal(d.sessions[0].model, 'Fable', 'the human was talking to Fable');
    // The subagents are still counted everywhere else - only the label changed.
    assert.equal(d.sessions[0].totalTokens, 15040);
    assert.equal(d.byModel.Opus.totalTokens, 15000);
    assert.equal(d.byModel.Fable.totalTokens, 40);
  });

  test('a root with no model at all falls back to the most-used series', () => {
    const d = modelFixture('b', null, 'claude-sonnet-5');
    assert.equal(d.sessions[0].model, 'Sonnet');
  });
});

describe('the persistence store', () => {
  test('a build writes <monitorDir>/usage/daily.json with version 1', () => {
    const d = view({ days: 7, cache: new UsageFileCache() });
    const raw = readStore();
    assert.equal(raw.version, STORE_VERSION);
    assert.equal(raw.days[dayKey(0)].totals.totalTokens, d.days[0].totals.totalTokens);
    assert.ok(raw.days[dayKey(0)].updatedAt);
    assert.ok(raw.days[dayKey(0)].byModel.Opus);
  });

  test('the write is atomic: no .tmp file is left behind', () => {
    view({ days: 7, cache: new UsageFileCache() });
    const files = fs.readdirSync(path.join(monitorRoot, 'usage'));
    assert.deepEqual(files, ['daily.json']);
  });

  test('nothing is written when nothing changed', () => {
    const cache = new UsageFileCache();
    const store = new UsageStore({ dir: monitorRoot });
    view({ days: 7, cache, store });
    assert.equal(store.stats().writes, 1);
    view({ days: 7, cache, store });
    assert.equal(store.stats().writes, 1, 'the second identical build must not rewrite the store');
  });

  test('a stored day with no transcript left is returned with source "store"', () => {
    const gone = dayKey(20);
    writeFileAtomic(storeFile(), JSON.stringify({
      version: 1,
      days: {
        [gone]: {
          msgs: 4,
          totals: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, count: 4, totalTokens: 10 },
          byModel: { Opus: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4, count: 4, totalTokens: 10 } },
          updatedAt: '2026-08-16T00:00:00.000Z',
        },
      },
    }));
    const d = view({ days: 30, cache: new UsageFileCache() });
    const row = d.days.find((r) => r.date === gone);
    assert.ok(row, 'the stored day must still be shown');
    assert.equal(row.source, 'store');
    assert.equal(row.partial, false);
    assert.equal(row.totals.totalTokens, 10);
    assert.equal(row.msgs, 4);
    assert.ok(d.days.some((r) => r.source === 'live'), 'live days are still live');
  });

  test('a live day SMALLER than the stored one is served from the store and flagged partial', () => {
    const today = dayKey(0);
    const cache = new UsageFileCache();
    const first = view({ days: 7, cache });
    const real = first.days[0].totals.totalTokens;

    // Pretend we once measured ten times as much for today (files were pruned).
    const raw = readStore();
    // totalTokens is recomputed from the four metrics on load, so the metrics
    // are what has to say "ten times as much", not the total.
    raw.days[today].totals = {
      input_tokens: 0,
      output_tokens: real * 10,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      count: 99,
      totalTokens: real * 10,
    };
    raw.days[today].msgs = 99;
    writeFileAtomic(storeFile(), JSON.stringify(raw));

    const d = view({ days: 7, cache: new UsageFileCache() });
    const row = d.days.find((r) => r.date === today);
    assert.equal(row.source, 'store');
    assert.equal(row.partial, true);
    assert.equal(row.totals.totalTokens, real * 10);
    assert.equal(row.msgs, 99);
    // ... and the shrunken scan must not have overwritten the bigger record.
    assert.equal(readStore().days[today].totals.totalTokens, real * 10);
  });

  test('a live day LARGER than the stored one wins and is written back', () => {
    const today = dayKey(0);
    writeFileAtomic(storeFile(), JSON.stringify({
      version: 1,
      days: {
        [today]: {
          msgs: 1,
          totals: { input_tokens: 0, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, count: 1, totalTokens: 1 },
          byModel: {},
          updatedAt: '2026-09-05T00:00:00.000Z',
        },
      },
    }));
    const d = view({ days: 7, cache: new UsageFileCache() });
    const row = d.days.find((r) => r.date === today);
    assert.equal(row.source, 'live');
    assert.equal(row.partial, false);
    assert.equal(row.totals.totalTokens, 110);
    assert.equal(readStore().days[today].totals.totalTokens, 110);
  });

  test('a corrupt store is reported once and then ignored', () => {
    fs.mkdirSync(path.join(monitorRoot, 'usage'), { recursive: true });
    fs.writeFileSync(storeFile(), '{ this is not json', 'utf8');
    const seen = [];
    const d = view({ days: 7, cache: new UsageFileCache(), onError: (where, err) => seen.push([where, String(err)]) });
    assert.equal(d.ok, true, 'a broken store must never break the view');
    assert.equal(d.stats.store.corrupt, true);
    assert.ok(seen.some(([w]) => w === 'usage:store-read'), `expected an onError, got ${JSON.stringify(seen)}`);
    // ... and it is replaced by a good one.
    assert.equal(readStore().version, STORE_VERSION);
  });

  test('a store with the wrong version, or junk days, is treated as absent', () => {
    writeFileAtomic(storeFile(), JSON.stringify({ version: 99, days: { 'not-a-date': 1 } }));
    const store = new UsageStore({ dir: monitorRoot });
    const loaded = store.load();
    assert.equal(loaded.corrupt, true);
    assert.deepEqual(loaded.days, {});
  });

  test('a store day whose shape is wrong is dropped, the rest survives', () => {
    const good = dayKey(9);
    writeFileAtomic(storeFile(), JSON.stringify({
      version: 1,
      days: {
        'garbage-key': { msgs: 1, totals: {} },
        '20260101': { msgs: 1, totals: {} },
        '2026-08-27T00:00:00Z': { msgs: 1, totals: {} },
        [good]: { msgs: 2, totals: { output_tokens: 42 }, byModel: { Opus: 'nope' } },
      },
    }));
    const loaded = new UsageStore({ dir: monitorRoot }).load();
    assert.deepEqual(Object.keys(loaded.days), [good]);
    assert.equal(loaded.days[good].totals.output_tokens, 42);
    assert.equal(loaded.days[good].totals.totalTokens, 42);
    assert.deepEqual(loaded.days[good].byModel, {}, 'a non-object model bucket is dropped, not kept');
  });

  test('an absent store is not an error and is not reported as corrupt', () => {
    const store = new UsageStore({ dir: path.join(tmp.dir, 'never-written') });
    const loaded = store.load();
    assert.equal(loaded.present, false);
    assert.equal(loaded.corrupt, false);
    assert.deepEqual(loaded.days, {});
  });

  test('a store that cannot be written is reported, not thrown', () => {
    const seen = [];
    // A directory where the file should be: rename() cannot land on it.
    const dir = path.join(tmp.dir, 'blocked');
    fs.mkdirSync(path.join(dir, 'usage', 'daily.json'), { recursive: true });
    const store = new UsageStore({ dir, onError: (where, err) => seen.push([where, String(err)]) });
    assert.equal(store.save({}), false);
    assert.ok(seen.some(([w]) => w === 'usage:store-write'));
  });

  /* ---- two writers on one monitorDir (review B) ---- */

  test('a second writer that landed between load and save is not clobbered', () => {
    const store = new UsageStore({ dir: monitorRoot });
    // What WE measured, some hundreds of ms ago.
    const mine = { [dayKey(0)]: storeDay(500), [dayKey(1)]: storeDay(100) };
    // What the OTHER server wrote while we were walking the transcripts: a date
    // we never saw, and one of ours with a bigger number.
    writeFileAtomic(storeFile(), JSON.stringify({
      version: STORE_VERSION,
      days: { [dayKey(1)]: storeDay(900), [dayKey(9)]: storeDay(700) },
    }));

    assert.equal(store.save(mine), true);
    const raw = readStore();
    assert.deepEqual(Object.keys(raw.days).sort(), [dayKey(9), dayKey(1), dayKey(0)].sort(),
      'the date only the other writer knew about must survive');
    assert.equal(raw.days[dayKey(0)].totals.totalTokens, 500, 'ours, which they never had');
    assert.equal(raw.days[dayKey(1)].totals.totalTokens, 900, 'theirs was larger: no value goes backwards');
    assert.equal(raw.days[dayKey(9)].totals.totalTokens, 700, 'theirs, untouched');
  });

  test('the merge is monotonic, so a stale writer cannot lower a day', () => {
    const store = new UsageStore({ dir: monitorRoot });
    assert.equal(store.save({ [dayKey(0)]: storeDay(1000) }), true);
    // A slower process finishing with an older, smaller measurement.
    assert.equal(store.save({ [dayKey(0)]: storeDay(400) }), true);
    assert.equal(readStore().days[dayKey(0)].totals.totalTokens, 1000);
  });

  test('two builds sharing one monitorDir keep both sets of days', () => {
    // Two projects roots = two servers looking at different transcripts; they
    // are told to write the same store, as two `serve` processes would.
    const rootA = path.join(tmp.dir, 'race-a');
    const rootB = path.join(tmp.dir, 'race-b');
    const sidA = 'eeeeeeee-1111-2222-3333-666666666666';
    const sidB = 'ffffffff-1111-2222-3333-777777777777';
    fs.mkdirSync(path.join(rootA, 'p'), { recursive: true });
    fs.mkdirSync(path.join(rootB, 'p'), { recursive: true });
    writeJsonl(path.join(rootA, 'p', `${sidA}.jsonl`), [
      rec({ messageId: 'ra', timestamp: dayIso(0, 11), usage: { output_tokens: 31 }, sessionId: sidA }),
    ]);
    writeJsonl(path.join(rootB, 'p', `${sidB}.jsonl`), [
      rec({ messageId: 'rb', timestamp: dayIso(3, 11), usage: { output_tokens: 41 }, sessionId: sidB }),
    ]);
    const common = { now: NOW, days: 7, monitorDir: monitorRoot, statuslineDir: statuslineRoot };
    // B reads the store FIRST (it is empty), then A finishes and writes, then B
    // writes what it decided from the stale read. Without the re-merge in
    // save(), B's write erases A's day entirely.
    const real = new UsageStore({ dir: monitorRoot });
    const staleB = real.load();
    buildUsageView({ ...common, projectsRoot: rootA, cache: new UsageFileCache() });
    buildUsageView({
      ...common,
      projectsRoot: rootB,
      cache: new UsageFileCache(),
      store: { load: () => staleB, save: (d) => real.save(d), stats: () => real.stats() },
    });

    const raw = readStore();
    assert.equal(raw.days[dayKey(0)].totals.output_tokens, 31, "A's day survived B's write");
    assert.equal(raw.days[dayKey(3)].totals.output_tokens, 41, "B's day is there too");
  });
});

describe('a projects root that is not there', () => {
  test('answers with an empty, well-formed view', () => {
    const d = buildUsageView({
      now: NOW,
      projectsRoot: path.join(tmp.dir, 'no-such-projects'),
      monitorDir: path.join(tmp.dir, 'no-such-monitor'),
      statuslineDir: path.join(tmp.dir, 'no-such-statusline'),
      cache: new UsageFileCache(),
    });
    assert.equal(d.ok, true);
    assert.deepEqual(d.days, []);
    assert.equal(d.totals.totalTokens, 0);
    assert.deepEqual(d.sessions, []);
    assert.equal(d.stats.scannedFiles, 0);
  });
});

/* --------------------------------- ccusage -------------------------------- */

function ccOk(rows) {
  return async () => ({ ok: true, data: { daily: rows }, error: null });
}

describe('ccusage comparison', () => {
  test('deltas are ours minus theirs, per metric', async () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    const today = dayKey(0);
    const runner = ccOk([
      { period: today, agent: 'all', inputTokens: 10, outputTokens: 90, cacheCreationTokens: 0, cacheReadTokens: 0, totalCost: 0.5, modelsUsed: ['claude-opus-5'] },
      // a per-agent row that must be ignored
      { period: today, agent: 'general-purpose', inputTokens: 999, outputTokens: 999 },
    ]);
    const cmp = await buildCcusageComparison({ view: d, cache: new CcusageCache({ runner }) });
    assert.equal(cmp.ok, true);
    assert.equal(cmp.cached, false);
    const row = cmp.rows.find((r) => r.date === today);
    assert.equal(row.ours.output_tokens, 100);
    assert.equal(row.ccusage.output_tokens, 90);
    assert.equal(row.delta.output_tokens, 10);
    assert.equal(row.delta.input_tokens, 0);
    assert.equal(row.match, false);
    assert.equal(row.totalCost, 0.5);
    assert.deepEqual(row.modelsUsed, ['claude-opus-5']);
    assert.equal(cmp.totals.totalCost, 0.5);
    assert.equal(cmp.totals.delta.output_tokens, cmp.totals.ours.output_tokens - cmp.totals.ccusage.output_tokens);
  });

  test('an exact agreement reads match:true', async () => {
    const d = view({ days: 1, cache: new UsageFileCache() });
    const t = d.days[0].totals;
    const runner = ccOk([{
      period: dayKey(0),
      inputTokens: t.input_tokens,
      outputTokens: t.output_tokens,
      cacheCreationTokens: t.cache_creation_input_tokens,
      cacheReadTokens: t.cache_read_input_tokens,
      totalCost: 0,
    }]);
    const cmp = await buildCcusageComparison({ view: d, cache: new CcusageCache({ runner }) });
    assert.equal(cmp.rows[0].match, true);
    assert.equal(cmp.rows[0].delta.totalTokens, 0);
  });

  test('a date only ccusage knows about still gets a row', async () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    const runner = ccOk([{ period: dayKey(1), outputTokens: 5 }]);
    const cmp = await buildCcusageComparison({ view: d, cache: new CcusageCache({ runner }) });
    const row = cmp.rows.find((r) => r.date === dayKey(1));
    assert.equal(row.ccusage.output_tokens, 5);
    assert.ok(cmp.rows.every((r) => r.date >= cmp.since && r.date <= cmp.until));
  });

  test('a failed run answers with ONE fixed string and reports the detail', async () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    const seen = [];
    const runner = async () => ({ ok: false, data: null, error: 'exit code 1: npm ERR! 404 ccusage@latest' });
    const cmp = await buildCcusageComparison({
      view: d,
      cache: new CcusageCache({ runner }),
      onError: (where, err) => seen.push([where, String(err)]),
    });
    assert.deepEqual(cmp, { ok: false, error: CCUSAGE_ERROR, notInstalled: false, ccusageVersion: CCUSAGE_VERSION });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'usage:ccusage');
    assert.match(seen[0][1], /npm ERR/, 'the detail goes to onError, never to the browser');
  });

  test('"ccusage is not installed" is distinguishable from every other failure', async () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    const seen = [];
    const runner = async () => ({
      ok: false,
      data: null,
      notInstalled: true,
      error: 'ccusage@20.0.20 is not installed (npx refused to download it)',
    });
    const cmp = await buildCcusageComparison({
      view: d,
      cache: new CcusageCache({ runner }),
      onError: (where, err) => seen.push([where, String(err)]),
    });
    // Same fixed string as any other failure - the flag is what differs, and
    // the version the user must install comes from the server, not the page.
    assert.deepEqual(cmp, { ok: false, error: CCUSAGE_ERROR, notInstalled: true, ccusageVersion: CCUSAGE_VERSION });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'usage:ccusage');
  });

  test('a not-installed run is not cached: the button can retry after an install', async () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    let runs = 0;
    const runner = async () => {
      runs += 1;
      return runs === 1
        ? { ok: false, data: null, notInstalled: true, error: 'not installed' }
        : { ok: true, data: { daily: [] }, error: null, notInstalled: false };
    };
    const cache = new CcusageCache({ runner });
    assert.equal((await buildCcusageComparison({ view: d, cache })).notInstalled, true);
    assert.equal((await buildCcusageComparison({ view: d, cache })).ok, true);
    assert.equal(runs, 2);
  });

  test('a timeout is just another failure to the browser', async () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    const seen = [];
    let passed = null;
    const runner = async (o) => {
      passed = o;
      return { ok: false, data: null, error: `timed out after ${o.timeoutMs}ms` };
    };
    const cmp = await buildCcusageComparison({
      view: d,
      cache: new CcusageCache({ runner, timeoutMs: 60_000 }),
      onError: (where, err) => seen.push(String(err)),
    });
    assert.equal(passed.timeoutMs, 60_000, 'the 60s budget reaches the runner');
    assert.deepEqual(cmp, { ok: false, error: CCUSAGE_ERROR, notInstalled: false, ccusageVersion: CCUSAGE_VERSION });
    assert.match(seen[0], /timed out after 60000ms/);
  });

  test('a runner that throws does not escape', async () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    const runner = async () => { throw new Error('spawn EINVAL'); };
    const cmp = await buildCcusageComparison({ view: d, cache: new CcusageCache({ runner }) });
    assert.deepEqual(cmp, { ok: false, error: CCUSAGE_ERROR, notInstalled: false, ccusageVersion: CCUSAGE_VERSION });
  });

  test('a second call inside the TTL does not run ccusage again', async () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    let runs = 0;
    const runner = async () => { runs += 1; return { ok: true, data: { daily: [] }, error: null }; };
    const cache = new CcusageCache({ runner });
    const first = await buildCcusageComparison({ view: d, cache });
    const second = await buildCcusageComparison({ view: d, cache });
    assert.equal(runs, 1);
    assert.equal(first.cached, false);
    assert.equal(second.cached, true);
    assert.equal(second.fetchedAt, first.fetchedAt);
  });

  test('the cache expires after its TTL', async () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    let runs = 0;
    let clock = 1_000_000;
    const runner = async () => { runs += 1; return { ok: true, data: { daily: [] }, error: null }; };
    const cache = new CcusageCache({ runner, ttlMs: 1000, now: () => clock });
    await cache.daily('2026-09-01', '2026-09-05');
    clock += 500;
    await cache.daily('2026-09-01', '2026-09-05');
    assert.equal(runs, 1);
    clock += 1000;
    await cache.daily('2026-09-01', '2026-09-05');
    assert.equal(runs, 2);
    assert.equal(d.ok, true);
  });

  test('a different window is a different cache key', async () => {
    let runs = 0;
    const runner = async () => { runs += 1; return { ok: true, data: { daily: [] }, error: null }; };
    const cache = new CcusageCache({ runner });
    await cache.daily('2026-09-01', '2026-09-05');
    await cache.daily('2026-08-01', '2026-09-05');
    assert.equal(runs, 2);
  });

  test('a failure is NOT cached, so the button can retry', async () => {
    let runs = 0;
    const runner = async () => { runs += 1; return { ok: false, data: null, error: 'boom' }; };
    const cache = new CcusageCache({ runner });
    await cache.daily('2026-09-01', '2026-09-05');
    await cache.daily('2026-09-01', '2026-09-05');
    assert.equal(runs, 2);
  });

  test('concurrent callers share ONE run (single flight)', async () => {
    let runs = 0;
    let release;
    const gate = new Promise((r) => { release = r; });
    const runner = async () => {
      runs += 1;
      await gate;
      return { ok: true, data: { daily: [] }, error: null };
    };
    const cache = new CcusageCache({ runner });
    const a = cache.daily('2026-09-01', '2026-09-05');
    const b = cache.daily('2026-09-01', '2026-09-05');
    const c = cache.daily('2026-09-01', '2026-09-05');
    assert.equal(cache.stats().inflight, 1);
    release();
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.equal(runs, 1, 'three simultaneous callers must not start three npx downloads');
    assert.equal(ra.fetchedAt, rb.fetchedAt);
    assert.equal(rb.fetchedAt, rc.fetchedAt);
    assert.equal(cache.stats().inflight, 0);
  });

  test('anything that is not YYYY-MM-DD never reaches ccusage argv', async () => {
    let runs = 0;
    const runner = async () => { runs += 1; return { ok: true, data: { daily: [] }, error: null }; };
    const cache = new CcusageCache({ runner });
    for (const bad of ['2026-9-1', '2026-09-05 --help', '', null, undefined, '../etc']) {
      const seen = [];
      const cmp = await buildCcusageComparison({
        view: { since: bad, until: '2026-09-05', days: [], today: '2026-09-05' },
        cache,
        onError: (w, e) => seen.push([w, String(e)]),
      });
      assert.deepEqual(cmp, { ok: false, error: CCUSAGE_ERROR, notInstalled: false, ccusageVersion: CCUSAGE_VERSION }, `accepted ${JSON.stringify(bad)}`);
      assert.equal(seen.length, 1);
    }
    assert.equal(runs, 0, 'the runner was never reached');
  });

  test('a ccusage row with an unparsable date is dropped, not shown', async () => {
    const d = view({ days: 3, cache: new UsageFileCache() });
    const runner = ccOk([{ period: 'yesterday', outputTokens: 5 }, { outputTokens: 3 }]);
    const cmp = await buildCcusageComparison({ view: d, cache: new CcusageCache({ runner }) });
    assert.ok(cmp.rows.every((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date)));
  });
});
