/*
 * claude/monitor - notification settings and the quota-threshold rule.
 *
 * A classic script (not a module) loaded before app.js, exposed as
 * window.CMNotifyRules. It holds the two pieces of notification logic that are
 * pure functions of their arguments, so node:test can load this file with
 * node:vm and check them without a browser:
 *
 *   - parse / normalize / defaults for the persisted settings object
 *   - evaluateQuota(): "did a rate-limit window just cross its threshold?"
 *
 * Everything that touches the DOM, localStorage or the Notification API stays
 * in app.js. Nothing here reads a global.
 *
 * Same hard rules as app.js (4.8): no innerHTML, no eval, no external
 * resource. This file only does arithmetic and object copying.
 */

(function (root) {
  'use strict';

  /** Bumped when the shape below changes; an unknown version resets to defaults. */
  var SETTINGS_VERSION = 1;

  /**
   * The notification kinds the user can switch off. The first four mirror
   * NOTIFY_TYPES in src/state.js (hook-sourced notifications); `turn_complete`
   * is client-side only - it comes from lastEventName === 'Stop', not from a
   * notification record.
   */
  var KINDS = [
    'permission_prompt',
    'idle_prompt',
    'agent_needs_input',
    'agent_completed',
    'turn_complete'
  ];

  /**
   * Rate-limit windows we can alert on. `spend_limit` is deliberately absent:
   * it is a money cap, not a usage window, and it has no resets_at we could
   * use to re-arm.
   */
  var QUOTA_WINDOWS = ['five_hour', 'seven_day'];

  var DEFAULT_THRESHOLD = 80;

  function hasOwn(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /**
   * A percentage threshold is an integer 1..100. Anything else - 0, 101, 80.5,
   * "80", null - is not "clamped to something close", it is rejected and the
   * default comes back. A silently clamped 0 would mean "notify always", which
   * is the opposite of what typing 0 suggests.
   */
  function normalizeThreshold(v) {
    if (typeof v !== 'number' || !isFinite(v)) return DEFAULT_THRESHOLD;
    if (Math.floor(v) !== v) return DEFAULT_THRESHOLD;
    if (v < 1 || v > 100) return DEFAULT_THRESHOLD;
    return v;
  }

  /** Same rule, for a string straight out of an <input type="number">. */
  function parseThreshold(text) {
    var s = String(text === null || text === undefined ? '' : text).trim();
    if (!/^\d{1,3}$/.test(s)) return null;
    var n = Number(s);
    return n >= 1 && n <= 100 ? n : null;
  }

  function bool(v, fallback) {
    return typeof v === 'boolean' ? v : fallback;
  }

  /**
   * The defaults are chosen to reproduce the behaviour the page had before
   * settings existed: notifications off until the user turns them on, every
   * kind on once they do, and silence while the tab is in front of the user.
   */
  function defaults() {
    var s = { v: SETTINGS_VERSION, enabled: false, kinds: {}, quota: {}, quietWhenFocused: true };
    for (var i = 0; i < KINDS.length; i++) s.kinds[KINDS[i]] = true;
    for (var j = 0; j < QUOTA_WINDOWS.length; j++) {
      s.quota[QUOTA_WINDOWS[j]] = { on: true, threshold: DEFAULT_THRESHOLD };
    }
    return s;
  }

  /**
   * Coerce anything into a valid settings object. Unknown keys are dropped,
   * missing or malformed ones take the default. This never throws and never
   * returns a partially filled object, so every caller can read
   * settings.kinds.<kind> without a guard.
   */
  function normalize(raw) {
    var out = defaults();
    if (!isObject(raw)) return out;
    out.enabled = bool(raw.enabled, out.enabled);
    out.quietWhenFocused = bool(raw.quietWhenFocused, out.quietWhenFocused);
    if (isObject(raw.kinds)) {
      for (var i = 0; i < KINDS.length; i++) {
        var k = KINDS[i];
        if (hasOwn(raw.kinds, k)) out.kinds[k] = bool(raw.kinds[k], true);
      }
    }
    if (isObject(raw.quota)) {
      for (var j = 0; j < QUOTA_WINDOWS.length; j++) {
        var w = QUOTA_WINDOWS[j];
        var q = raw.quota[w];
        if (!isObject(q)) continue;
        out.quota[w].on = bool(q.on, true);
        out.quota[w].threshold = normalizeThreshold(q.threshold);
      }
    }
    return out;
  }

  /**
   * Read the stored settings, migrating the pre-settings key on the way.
   *
   * @param {string|null} rawJson   localStorage['cm.notify.settings']
   * @param {string|null} legacy    localStorage['cm.notify.enabled'] ('1'/'0')
   * @returns {{settings: object, migrated: boolean}} `migrated` is true when
   *   the caller should write the result back (nothing was stored, the JSON was
   *   corrupt, or it carried a version we do not know). The caller may then
   *   drop the legacy key.
   */
  function parse(rawJson, legacy) {
    var parsed = null;
    if (typeof rawJson === 'string' && rawJson !== '') {
      try {
        parsed = JSON.parse(rawJson);
      } catch (e) {
        parsed = null;
      }
    }
    if (isObject(parsed) && parsed.v === SETTINGS_VERSION) {
      return { settings: normalize(parsed), migrated: false };
    }
    // Nothing usable in the new key: fall back to defaults, then let the old
    // on/off switch survive the upgrade. '0' and anything else mean "off",
    // which is also the default, so only '1' has to be handled.
    var s = defaults();
    if (legacy === '1') s.enabled = true;
    return { settings: s, migrated: true };
  }

  /**
   * Should a rate-limit window raise a notification right now?
   *
   * The arm state is the whole memory of this rule: per window we remember the
   * `resets_at` we saw, the threshold that was in force, and whether we already
   * fired for that combination. Firing sets `fired`; it is cleared - the window
   * is re-armed - when
   *
   *   - `resets_at` changes (the window rolled over, so the count restarted),
   *   - usage drops back below the threshold, or
   *   - the user moves the threshold (a new question deserves a new answer).
   *
   * A window that is simply MISSING from this snapshot keeps its state
   * untouched. rate_limits only exist while a statusline sidecar is fresh
   * (known constraint 4/5), so they blink out routinely; dropping the state
   * there would re-notify on every reconnect.
   *
   * @param {object|null} limits  session.rateLimits from the freshest capture
   * @param {object} armed        previous arm state (this function never mutates it)
   * @param {object} settings     normalized settings
   * @param {boolean} prime       first snapshot: record the state, announce nothing
   * @returns {{armed: object, fire: Array<object>}}
   */
  function evaluateQuota(limits, armed, settings, prime) {
    var prev = isObject(armed) ? armed : {};
    var next = {};
    var fire = [];
    var cfgAll = isObject(settings) && isObject(settings.quota) ? settings.quota : {};

    for (var i = 0; i < QUOTA_WINDOWS.length; i++) {
      var w = QUOTA_WINDOWS[i];
      var cfg = isObject(cfgAll[w]) ? cfgAll[w] : null;
      // Switched off: forget the state, so switching it back on re-arms rather
      // than resuming a decision made under the old setting.
      if (!cfg || cfg.on !== true) continue;
      var threshold = normalizeThreshold(cfg.threshold);

      var win = isObject(limits) && isObject(limits[w]) ? limits[w] : null;
      var pct = win && typeof win.used_percentage === 'number' && isFinite(win.used_percentage)
        ? win.used_percentage
        : null;
      if (pct === null) {
        // No reading this time round: carry the memory forward unchanged.
        if (hasOwn(prev, w)) next[w] = prev[w];
        continue;
      }

      var resetsAt = win.resets_at === undefined || win.resets_at === null
        ? ''
        : String(win.resets_at);
      var was = isObject(prev[w]) ? prev[w] : null;
      var fired = false;
      if (was && was.resetsAt === resetsAt && was.threshold === threshold) fired = was.fired === true;

      var over = pct >= threshold;
      if (!over) {
        fired = false;
      } else if (!fired) {
        if (!prime) fire.push({ window: w, pct: pct, threshold: threshold, resetsAt: win.resets_at });
        fired = true;
      }
      next[w] = { resetsAt: resetsAt, threshold: threshold, fired: fired };
    }
    return { armed: next, fire: fire };
  }

  root.CMNotifyRules = {
    SETTINGS_VERSION: SETTINGS_VERSION,
    KINDS: KINDS,
    QUOTA_WINDOWS: QUOTA_WINDOWS,
    DEFAULT_THRESHOLD: DEFAULT_THRESHOLD,
    defaults: defaults,
    normalize: normalize,
    normalizeThreshold: normalizeThreshold,
    parseThreshold: parseThreshold,
    parse: parse,
    evaluateQuota: evaluateQuota
  };
})(typeof window !== 'undefined' ? window : this);
