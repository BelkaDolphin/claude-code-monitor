/**
 * public/notify-rules.js is a CLASSIC script (window.CMNotifyRules), not an ES
 * module, so it cannot be imported from this package (type: module). It is
 * loaded here the same way the browser does - as a script evaluated against a
 * global - using node:vm, which keeps ONE copy of the rules for both the page
 * and the tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.resolve(HERE, '..', 'public', 'notify-rules.js'), 'utf8');

/*
 * Evaluated in THIS realm, not a fresh vm context: the rules return plain
 * objects and arrays, and deepStrictEqual compares prototypes, so a sandbox
 * realm would make every deepEqual below fail for a reason that has nothing to
 * do with the rules. node --test gives each test file its own process, so the
 * one global this defines cannot reach another file.
 */
function load() {
  vm.runInThisContext(SRC, { filename: 'notify-rules.js' });
  assert.ok(globalThis.CMNotifyRules, 'the script did not export CMNotifyRules');
  return globalThis.CMNotifyRules;
}

const R = load();

describe('defaults', () => {
  test('reproduce the behaviour the page had before settings existed', () => {
    const d = R.defaults();
    assert.equal(d.v, 1);
    assert.equal(d.enabled, false);
    assert.equal(d.quietWhenFocused, true);
    for (const k of R.KINDS) assert.equal(d.kinds[k], true, `${k} should default to on`);
    for (const w of R.QUOTA_WINDOWS) {
      assert.deepEqual(d.quota[w], { on: true, threshold: 80 });
    }
  });

  test('the five kinds are the four server types plus turn_complete', () => {
    assert.deepEqual(R.KINDS, [
      'permission_prompt', 'idle_prompt', 'agent_needs_input', 'agent_completed', 'turn_complete',
    ]);
  });

  test('spend_limit is not an alertable window', () => {
    assert.deepEqual(R.QUOTA_WINDOWS, ['five_hour', 'seven_day']);
  });

  test('each call returns a fresh object', () => {
    const a = R.defaults();
    a.kinds.idle_prompt = false;
    a.quota.five_hour.threshold = 1;
    const b = R.defaults();
    assert.equal(b.kinds.idle_prompt, true);
    assert.equal(b.quota.five_hour.threshold, 80);
  });
});

describe('normalizeThreshold', () => {
  test('accepts integers 1..100', () => {
    for (const n of [1, 50, 80, 100]) assert.equal(R.normalizeThreshold(n), n);
  });

  test('rejects 0, 101, negatives, fractions and non-numbers', () => {
    for (const bad of [0, -1, 101, 1000, 80.5, '80', null, undefined, NaN, Infinity, {}, []]) {
      assert.equal(R.normalizeThreshold(bad), 80, `${String(bad)} should fall back`);
    }
  });
});

describe('parseThreshold (raw <input type=number> text)', () => {
  test('accepts a plain integer in range', () => {
    assert.equal(R.parseThreshold('1'), 1);
    assert.equal(R.parseThreshold(' 95 '), 95);
    assert.equal(R.parseThreshold('100'), 100);
    assert.equal(R.parseThreshold(100), 100);
  });

  test('rejects empty, 0, out of range and anything non-numeric', () => {
    for (const bad of ['', '   ', '0', '000', '101', '999', '-5', '80.5', '8e1', 'abc', null, undefined]) {
      assert.equal(R.parseThreshold(bad), null, `${String(bad)} should be rejected`);
    }
  });
});

describe('normalize', () => {
  test('a non-object is just the defaults', () => {
    for (const bad of [null, undefined, 1, 'x', [], true]) {
      assert.deepEqual(R.normalize(bad), R.defaults());
    }
  });

  test('keeps the fields it knows and drops the ones it does not', () => {
    const out = R.normalize({
      v: 1,
      enabled: true,
      quietWhenFocused: false,
      kinds: { idle_prompt: false, nonsense: true },
      quota: { five_hour: { on: false, threshold: 45 }, nonsense: { on: true } },
      extra: 'ignored',
    });
    assert.equal(out.enabled, true);
    assert.equal(out.quietWhenFocused, false);
    assert.equal(out.kinds.idle_prompt, false);
    assert.equal(out.kinds.permission_prompt, true, 'an unmentioned kind stays on');
    assert.equal(out.kinds.nonsense, undefined);
    assert.deepEqual(out.quota.five_hour, { on: false, threshold: 45 });
    assert.deepEqual(out.quota.seven_day, { on: true, threshold: 80 });
    assert.equal(out.quota.nonsense, undefined);
    assert.equal(out.extra, undefined);
  });

  test('a wrong TYPE on a known field falls back, it does not throw', () => {
    const out = R.normalize({
      v: 1,
      enabled: 'yes',
      quietWhenFocused: 0,
      kinds: 'all',
      quota: { five_hour: { on: 'no', threshold: 0 } },
    });
    assert.equal(out.enabled, false);
    assert.equal(out.quietWhenFocused, true);
    assert.equal(out.kinds.agent_completed, true);
    assert.deepEqual(out.quota.five_hour, { on: true, threshold: 80 });
  });
});

describe('parse / migration', () => {
  test('nothing stored: defaults, and the caller is told to write them', () => {
    const got = R.parse(null, null);
    assert.deepEqual(got.settings, R.defaults());
    assert.equal(got.migrated, true);
  });

  test("the legacy cm.notify.enabled='1' becomes enabled:true", () => {
    const got = R.parse(null, '1');
    assert.equal(got.settings.enabled, true);
    assert.equal(got.migrated, true);
    // Everything else is still the default, so the migration cannot invent
    // a preference the user never expressed.
    assert.equal(got.settings.quietWhenFocused, true);
    assert.equal(got.settings.quota.seven_day.threshold, 80);
  });

  test("legacy '0' (and any other value) stays off", () => {
    for (const v of ['0', '', 'true', 'yes', null]) {
      assert.equal(R.parse(null, v).settings.enabled, false, `legacy ${String(v)}`);
    }
  });

  test('a valid stored object is used as-is and needs no rewrite', () => {
    const stored = JSON.stringify({
      v: 1, enabled: true, kinds: { turn_complete: false }, quota: {}, quietWhenFocused: false,
    });
    // The legacy key is IGNORED once the new key is valid: the new one wins.
    const got = R.parse(stored, '0');
    assert.equal(got.migrated, false);
    assert.equal(got.settings.enabled, true);
    assert.equal(got.settings.kinds.turn_complete, false);
    assert.equal(got.settings.quietWhenFocused, false);
  });

  test('corrupt JSON, a non-object and an unknown version all reset silently', () => {
    for (const raw of ['{', 'not json', '[]', 'null', '"x"', '3', JSON.stringify({ v: 2, enabled: true })]) {
      const got = R.parse(raw, null);
      assert.deepEqual(got.settings, R.defaults(), `raw=${raw}`);
      assert.equal(got.migrated, true, `raw=${raw} should be rewritten`);
    }
  });

  test('a v1 object with no version-bearing legacy still keeps the legacy switch on reset', () => {
    const got = R.parse('{"v":9}', '1');
    assert.equal(got.settings.enabled, true);
    assert.equal(got.migrated, true);
  });

  test('the round trip through JSON survives', () => {
    const first = R.parse(null, '1').settings;
    first.quota.five_hour.threshold = 42;
    first.kinds.agent_completed = false;
    const back = R.parse(JSON.stringify(first), null);
    assert.equal(back.migrated, false);
    assert.deepEqual(back.settings, first);
  });
});

/** Shorthand for one rate_limits capture. */
function limits(five, seven) {
  const out = {};
  if (five) out.five_hour = five;
  if (seven) out.seven_day = seven;
  return out;
}

describe('evaluateQuota', () => {
  const on = () => R.defaults();

  test('crossing the threshold fires exactly once', () => {
    const s = on();
    let st = {};
    let r = R.evaluateQuota(limits({ used_percentage: 12, resets_at: 100 }), st, s, false);
    assert.deepEqual(r.fire, []);
    st = r.armed;

    r = R.evaluateQuota(limits({ used_percentage: 80, resets_at: 100 }), st, s, false);
    assert.equal(r.fire.length, 1);
    assert.equal(r.fire[0].window, 'five_hour');
    assert.equal(r.fire[0].threshold, 80);
    assert.equal(r.fire[0].pct, 80);
    assert.equal(r.fire[0].resetsAt, 100);
    st = r.armed;

    // Still over: silence.
    for (const pct of [81, 92, 100]) {
      r = R.evaluateQuota(limits({ used_percentage: pct, resets_at: 100 }), st, s, false);
      assert.deepEqual(r.fire, [], `pct=${pct} re-fired`);
      st = r.armed;
    }
  });

  test('dropping back under the threshold re-arms', () => {
    const s = on();
    let st = R.evaluateQuota(limits({ used_percentage: 85, resets_at: 1 }), {}, s, false).armed;
    st = R.evaluateQuota(limits({ used_percentage: 70, resets_at: 1 }), st, s, false).armed;
    assert.equal(st.five_hour.fired, false);
    const r = R.evaluateQuota(limits({ used_percentage: 90, resets_at: 1 }), st, s, false);
    assert.equal(r.fire.length, 1);
  });

  test('a new resets_at (the window rolled over) re-arms even while still over', () => {
    const s = on();
    const st = R.evaluateQuota(limits({ used_percentage: 95, resets_at: 1 }), {}, s, false).armed;
    // Same high percentage, different window: this is a NEW window, so it is
    // a new crossing and the user has to hear about it.
    const r = R.evaluateQuota(limits({ used_percentage: 95, resets_at: 2 }), st, s, false);
    assert.equal(r.fire.length, 1);
    assert.equal(r.armed.five_hour.resetsAt, '2');
  });

  test('moving the threshold re-arms', () => {
    const s = on();
    const st = R.evaluateQuota(limits({ used_percentage: 85, resets_at: 1 }), {}, s, false).armed;
    assert.deepEqual(R.evaluateQuota(limits({ used_percentage: 85, resets_at: 1 }), st, s, false).fire, []);
    s.quota.five_hour.threshold = 60;
    const r = R.evaluateQuota(limits({ used_percentage: 85, resets_at: 1 }), st, s, false);
    assert.equal(r.fire.length, 1);
    assert.equal(r.fire[0].threshold, 60);
  });

  test('raising the threshold above the current usage just re-arms, it does not fire', () => {
    const s = on();
    const st = R.evaluateQuota(limits({ used_percentage: 85, resets_at: 1 }), {}, s, false).armed;
    s.quota.five_hour.threshold = 90;
    const r = R.evaluateQuota(limits({ used_percentage: 85, resets_at: 1 }), st, s, false);
    assert.deepEqual(r.fire, []);
    assert.equal(r.armed.five_hour.fired, false);
  });

  test('prime records the state and announces nothing', () => {
    const s = on();
    const r = R.evaluateQuota(limits({ used_percentage: 99, resets_at: 1 }), {}, s, true);
    assert.deepEqual(r.fire, []);
    assert.equal(r.armed.five_hour.fired, true, 'already over at connect: treated as handled');
    // ...and it stays quiet afterwards, because nothing crossed while we watched.
    assert.deepEqual(R.evaluateQuota(limits({ used_percentage: 99, resets_at: 1 }), r.armed, s, false).fire, []);
  });

  test('prime under the threshold leaves it armed', () => {
    const s = on();
    const r = R.evaluateQuota(limits({ used_percentage: 10, resets_at: 1 }), {}, s, true);
    assert.equal(r.armed.five_hour.fired, false);
    assert.equal(R.evaluateQuota(limits({ used_percentage: 88, resets_at: 1 }), r.armed, s, false).fire.length, 1);
  });

  test('off means no state and no notification', () => {
    const s = on();
    s.quota.five_hour.on = false;
    const r = R.evaluateQuota(limits({ used_percentage: 99, resets_at: 1 }), {}, s, false);
    assert.deepEqual(r.fire, []);
    assert.equal(r.armed.five_hour, undefined, 'a disabled window keeps no arm state');
  });

  test('switching a window back on re-arms rather than resuming', () => {
    const s = on();
    let st = R.evaluateQuota(limits({ used_percentage: 99, resets_at: 1 }), {}, s, false).armed;
    assert.equal(st.five_hour.fired, true);
    s.quota.five_hour.on = false;
    st = R.evaluateQuota(limits({ used_percentage: 99, resets_at: 1 }), st, s, false).armed;
    s.quota.five_hour.on = true;
    const r = R.evaluateQuota(limits({ used_percentage: 99, resets_at: 1 }), st, s, false);
    assert.equal(r.fire.length, 1);
  });

  test('both windows are independent', () => {
    const s = on();
    s.quota.seven_day.threshold = 50;
    const r = R.evaluateQuota(
      limits({ used_percentage: 90, resets_at: 1 }, { used_percentage: 55, resets_at: 9 }), {}, s, false,
    );
    assert.deepEqual(r.fire.map((f) => f.window), ['five_hour', 'seven_day']);
    assert.equal(r.fire[1].threshold, 50);
  });

  test('a window missing from this snapshot keeps its memory (rate_limits blink out)', () => {
    const s = on();
    const st = R.evaluateQuota(limits({ used_percentage: 95, resets_at: 1 }), {}, s, false).armed;
    // No rate_limits at all for a while - the sidecar went stale.
    let r = R.evaluateQuota(null, st, s, false);
    assert.deepEqual(r.fire, []);
    assert.deepEqual(r.armed.five_hour, st.five_hour);
    r = R.evaluateQuota({}, r.armed, s, false);
    assert.deepEqual(r.armed.five_hour, st.five_hour);
    // When it comes back unchanged, it must NOT announce itself again.
    r = R.evaluateQuota(limits({ used_percentage: 95, resets_at: 1 }), r.armed, s, false);
    assert.deepEqual(r.fire, []);
  });

  test('a non-numeric used_percentage is no reading, not zero', () => {
    const s = on();
    const st = R.evaluateQuota(limits({ used_percentage: 95, resets_at: 1 }), {}, s, false).armed;
    for (const bad of ['95', null, undefined, NaN, Infinity]) {
      const r = R.evaluateQuota(limits({ used_percentage: bad, resets_at: 1 }), st, s, false);
      assert.deepEqual(r.fire, [], `${String(bad)} fired`);
      assert.equal(r.armed.five_hour.fired, true, `${String(bad)} cleared the arm state`);
    }
  });

  test('a missing resets_at is still a stable key', () => {
    const s = on();
    const r1 = R.evaluateQuota({ five_hour: { used_percentage: 95 } }, {}, s, false);
    assert.equal(r1.fire.length, 1);
    const r2 = R.evaluateQuota({ five_hour: { used_percentage: 96 } }, r1.armed, s, false);
    assert.deepEqual(r2.fire, []);
  });

  test('spend_limit is ignored even when it is the only window over', () => {
    const s = on();
    const r = R.evaluateQuota({ spend_limit: { used_percentage: 100, resets_at: 1 } }, {}, s, false);
    assert.deepEqual(r.fire, []);
    assert.deepEqual(r.armed, {});
  });

  test('the previous arm state is never mutated', () => {
    const s = on();
    const st = R.evaluateQuota(limits({ used_percentage: 10, resets_at: 1 }), {}, s, false).armed;
    const before = JSON.stringify(st);
    R.evaluateQuota(limits({ used_percentage: 99, resets_at: 5 }), st, s, false);
    assert.equal(JSON.stringify(st), before);
  });

  test('garbage arguments do not throw', () => {
    for (const bad of [null, undefined, 'x', 3, []]) {
      assert.doesNotThrow(() => R.evaluateQuota(bad, bad, bad, false));
      assert.deepEqual(R.evaluateQuota(bad, bad, bad, false).fire, []);
    }
  });

  test('a threshold of 100 fires only at 100', () => {
    const s = on();
    s.quota.five_hour.threshold = 100;
    let st = R.evaluateQuota(limits({ used_percentage: 99.9, resets_at: 1 }), {}, s, false).armed;
    assert.equal(st.five_hour.fired, false);
    const r = R.evaluateQuota(limits({ used_percentage: 100, resets_at: 1 }), st, s, false);
    assert.equal(r.fire.length, 1);
  });
});

describe('the shipped rules file obeys the front-end rules', () => {
  test('no forbidden DOM sink and no external reference', () => {
    for (const re of [
      /\.innerHTML/, /\.outerHTML/, /\.insertAdjacentHTML\s*\(/,
      /document\.write\s*\(/, /\beval\s*\(/, /new\s+Function\s*\(/,
      /https?:\/\//,
    ]) {
      assert.equal(re.test(SRC), false, `notify-rules.js uses ${re}`);
    }
  });

  test('it touches no browser global of its own', () => {
    // The only `window.` in the file is the header comment naming the export;
    // the code itself never reaches into a browser global.
    assert.equal(/window\s*\.(?!CMNotifyRules)/.test(SRC), false, 'notify-rules.js reaches into window');
    assert.equal(/getItem|setItem|document\s*\.|new\s+Notification/.test(SRC), false);
  });
});
