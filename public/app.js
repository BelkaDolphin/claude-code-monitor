/*
 * claude/monitor - Live view client.
 *
 * Hard rules this file follows (they are also enforced by the CSP the server
 * sends): no innerHTML / outerHTML / insertAdjacentHTML / document.write, no
 * eval, no inline event handler attributes, no external resources. Every node
 * is built with createElement + textContent + classList + dataset.
 *
 * DOM updates are diffed by sessionId: a card is created once and then patched
 * in place, so scroll position, text selection and <details> state survive a
 * snapshot arriving every quarter second.
 */

'use strict';

(function () {
  /* ------------------------------ constants ------------------------------ */

  var PHASE_LABEL = {
    unknown: '不明',
    idle: '待機',
    busy: '実行中',
    waiting_permission: '許可待ち',
    waiting_input: '入力待ち',
    compacting: '圧縮中',
    stale: '停止推定',
    ended: '終了',
    dead: '停止'
  };

  /**
   * Mirror of state.isLive (src/state.js). Kept in step by hand because the
   * page is plain ES5 with no bundler; the rule is three lines and the server
   * ships the two fields it needs (phase, phaseSource) on every session.
   *
   * Liveness is POSITIVE evidence, not "not finished": a session known only
   * from its statusline sidecar arrives as phase 'unknown' / phaseSource
   * 'none' and belongs in the archive, not next to the running one.
   */
  function isLiveSession(s) {
    if (!s) return false;
    if (s.phase === 'ended' || s.phase === 'dead' || s.phase === 'stale') return false;
    if (s.alive === true) return true;
    return s.phaseSource === 'hooks' || s.phaseSource === 'sessions';
  }

  var NOTIFICATION_LABEL = {
    permission_prompt: '許可の確認',
    idle_prompt: '入力待ち',
    agent_needs_input: 'エージェントが入力待ち',
    agent_completed: 'エージェント完了',
    auth_success: '認証成功',
    elicitation_dialog: '入力ダイアログ',
    quota_auto_resume_fired: '枠の自動再開',
    quota_auto_resume_stale: '枠の自動再開(期限切れ)',
    quota_auto_resume_disabled: '枠の自動再開(無効)'
  };

  var NOTIFY_TYPES = ['permission_prompt', 'idle_prompt', 'agent_needs_input', 'agent_completed'];
  var ATTENTION_TYPES = { permission_prompt: 1, idle_prompt: 1, agent_needs_input: 1 };
  var GAUGE_LABEL = { five_hour: '5h', seven_day: '7d', spend_limit: 'spend' };

  /*
   * Model display names. Table-driven on purpose: an id we do not recognise is
   * shown verbatim rather than mangled by a clever rule.
   *
   * Two shapes reach us for the SAME agent, depending on which source won:
   * the alias meta.json records ("opus") and the full id a transcript carries
   * ("claude-opus-5"). Rendering them differently made one tree show "Opus"
   * and "Opus 5" side by side as if they were different models.
   *
   * So the table maps BOTH shapes to the FAMILY name only. Going the other way
   * - promoting "opus" to "Opus 5" - would be a fabrication: the alias does not
   * say which version it resolved to, and an old meta.json may well have meant
   * a previous one.
   */
  var MODEL_LABEL = {
    opus: 'Opus',
    sonnet: 'Sonnet',
    haiku: 'Haiku',
    fable: 'Fable',
    'claude-opus-5': 'Opus',
    'claude-sonnet-5': 'Sonnet',
    'claude-fable-5': 'Fable',
    'claude-haiku-4-5': 'Haiku',
    'claude-opus-4-5': 'Opus',
    'claude-sonnet-4-5': 'Sonnet',
    /* Measured in the real transcripts on 2026-09-06 (M4). Kept in step with
       MODEL_SERIES in src/usage-view.js, which is the server-side twin. */
    'claude-fable-5-1': 'Fable',
    'claude-opus-4-7': 'Opus'
  };

  /*
   * Subagent status marks, shared by the Live cards and the Tree. One table so
   * the two views can never drift apart. Every mark also gets a `title` with
   * the Japanese name - a glyph alone is not an explanation, and `?` and `~`
   * both mean "we are guessing", which has to be readable on hover.
   */
  var AGENT_MARK = {
    running: '▶',
    completed: '✓',
    stale: '?',
    error: '✗',
    'async-unknown': '~'
  };

  var AGENT_STATUS_LABEL = {
    running: '実行中',
    completed: '完了',
    stale: '終了と推定',
    error: 'エラー',
    'async-unknown': '完了不明'
  };
  var NOTIFY_DEDUPE_MS = 5000;
  var STORE_KEY = 'cm.notify.settings';
  /** The pre-settings on/off switch ('1'/'0'). Read once, then migrated away. */
  var LEGACY_STORE_KEY = 'cm.notify.enabled';

  /**
   * The pure part of the notification logic, loaded by /notify-rules.js as a
   * classic script before this one (see 9. 通知設定). Kept in a variable so a
   * failed load degrades to "no notifications" instead of a ReferenceError on
   * every snapshot.
   */
  var RULES = typeof window.CMNotifyRules === 'object' ? window.CMNotifyRules : null;

  /* -------------------------------- state -------------------------------- */

  var snapshot = null;
  /** sessionId -> {root, parts} */
  var cards = new Map();
  var es = null;
  var backoff = 1000;
  var reconnectTimer = null;
  var firstSnapshotSeen = false;
  /** dedupe key -> last fired ms */
  var lastNotified = new Map();
  /** sessionId -> last notification id we already reacted to */
  var seenNotification = new Map();
  /** sessionId -> lastEventAt we already reacted to */
  var seenStop = new Map();
  /** Persisted notification settings; see notify-rules.js for the shape. */
  var notifySettings = RULES ? RULES.defaults() : fallbackSettings();
  /** rate-limit window -> {resetsAt, threshold, fired}. Owned by notify-rules.js. */
  var quotaArmed = {};
  /** Which tab is showing. The tree only refreshes while it is the one on screen. */
  var currentView = 'live';

  /* ------------------------------- helpers ------------------------------- */

  function $(id) { return document.getElementById(id); }

  function el(tag, className, text) {
    var n = document.createElement(tag);
    if (className) n.className = className;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function setText(node, value) {
    var s = value === null || value === undefined ? '' : String(value);
    if (node.textContent !== s) node.textContent = s;
  }

  function readStore() {
    try { return window.localStorage.getItem(STORE_KEY); } catch (e) { return null; }
  }
  function writeStore(v) {
    try { window.localStorage.setItem(STORE_KEY, v); } catch (e) { /* private mode */ }
  }
  function readLegacyStore() {
    try { return window.localStorage.getItem(LEGACY_STORE_KEY); } catch (e) { return null; }
  }
  function dropLegacyStore() {
    try { window.localStorage.removeItem(LEGACY_STORE_KEY); } catch (e) { /* private mode */ }
  }

  /**
   * Only reached when /notify-rules.js did not load. Everything off is the safe
   * answer: a monitor that cannot tell which kinds the user wants must not
   * decide for them.
   */
  function fallbackSettings() {
    return { v: 0, enabled: false, kinds: {}, quota: {}, quietWhenFocused: true };
  }

  function parseMs(iso) {
    if (!iso) return NaN;
    var t = Date.parse(iso);
    return isNaN(t) ? NaN : t;
  }

  /** "12s" / "4m 03s" / "2h 07m" - stable width, no jitter. */
  function since(iso, now) {
    var t = parseMs(iso);
    if (isNaN(t)) return '-';
    var sec = Math.max(0, Math.round((now - t) / 1000));
    if (sec < 60) return sec + 's';
    var m = Math.floor(sec / 60);
    if (m < 60) return m + 'm ' + pad(sec % 60) + 's';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ' + pad(m % 60) + 'm';
    return Math.floor(h / 24) + 'd ' + pad(h % 24) + 'h';
  }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  /** Local wall clock, always - the server writes ISO/UTC, the human reads local. */
  function clock(iso) {
    var t = parseMs(iso);
    if (isNaN(t)) return '-';
    var d = new Date(t);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function clockSec(iso) {
    var t = parseMs(iso);
    if (isNaN(t)) return '-';
    var d = new Date(t);
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /**
   * Local HH:MM, with the date in front whenever it is not today.
   *
   * The convention M2 settled on for the rate-limit reset, applied to every
   * absolute time the UI shows: a bare "06:00" on a row from three days ago
   * reads as this morning, which is not a small error - it is the wrong day.
   */
  function dayClockOfDate(d) {
    if (isNaN(d.getTime())) return '';
    var time = pad(d.getHours()) + ':' + pad(d.getMinutes());
    var now = new Date();
    var sameDay = d.getFullYear() === now.getFullYear()
      && d.getMonth() === now.getMonth()
      && d.getDate() === now.getDate();
    if (sameDay) return time;
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + time;
  }

  /** dayClockOfDate for an ISO string; '' when there is nothing to show. */
  function dayClock(iso) {
    var t = parseMs(iso);
    if (isNaN(t)) return '';
    return dayClockOfDate(new Date(t));
  }

  /**
   * epoch SECONDS (rate_limits.resets_at) -> local time.
   * The 7d window resets days away, so a bare "06:00" reads as this morning
   * and badly understates the wait. The date is included whenever it is not
   * today - which also covers a 5h window that crosses midnight.
   */
  function clockFromEpochSec(sec) {
    if (typeof sec !== 'number' || !isFinite(sec)) return null;
    var d = new Date(sec * 1000);
    if (isNaN(d.getTime())) return null;
    return dayClockOfDate(d);
  }

  /**
   * Family name for a model id or alias; unknown ids are shown as they came.
   * `modelLabel('opus') === modelLabel('claude-opus-5')` is the point.
   */
  function modelLabel(id) {
    if (typeof id !== 'string' || !id) return '';
    var key = id.toLowerCase();
    if (MODEL_LABEL[key]) return MODEL_LABEL[key];
    // Strip a trailing release date (claude-haiku-4-5-20251001) and retry.
    var undated = key.replace(/-\d{8}$/, '');
    if (MODEL_LABEL[undated]) return MODEL_LABEL[undated];
    return id;
  }

  /** One line, at most 80 characters. Newlines become spaces. */
  function trim80(text) {
    if (typeof text !== 'string') return '';
    var flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > 80 ? flat.slice(0, 80) + '…' : flat;
  }

  /**
   * 1234 -> "1.2k", 264000000 -> "264M". One decimal below 10 of a unit, none
   * above, so a column of these lines up.
   *
   * The carry matters: toFixed rounds, and 999800 rounds to "1000" in k, which
   * is a unit that does not exist. When the ROUNDED mantissa reaches 1000 we
   * move up instead ("1.0M"). G exists because the 30-day total is already at
   * 973M and the next machine over will pass 1e9.
   */
  function compact(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '-';
    if (n < 1000) return String(n);
    var units = ['k', 'M', 'G'];
    var i = 0;
    var m = n / 1000;
    while (m >= 1000 && i < units.length - 1) { m = m / 1000; i++; }
    var digits = m < 10 ? 1 : 0;
    if (Number(m.toFixed(digits)) >= 1000 && i < units.length - 1) {
      m = m / 1000;
      i++;
      digits = m < 10 ? 1 : 0;
    }
    return m.toFixed(digits) + units[i];
  }

  /* ---------------------------- connection UI ---------------------------- */

  function setConnection(kind, text) {
    var dot = $('conn-dot');
    if (dot) dot.dataset.conn = kind;
    setText($('conn-text'), text);
  }

  function connect() {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (es) { try { es.close(); } catch (e) { /* ignore */ } }
    setConnection('connecting', firstSnapshotSeen ? '再接続中' : '接続中');
    try {
      es = new EventSource('/api/stream');
    } catch (e) {
      scheduleReconnect();
      return;
    }
    es.addEventListener('open', function () {
      backoff = 1000;
      setConnection('open', 'SSE 接続');
    });
    es.addEventListener('snapshot', function (ev) {
      var data = null;
      try { data = JSON.parse(ev.data); } catch (e) { return; }
      backoff = 1000;
      setConnection('open', 'SSE 接続');
      // JSON.parse was already guarded; render() was not. A throw here escapes
      // into the EventSource callback, where nothing catches it: the stream
      // stays open, every later snapshot throws in the same place, and the
      // page silently freezes on stale data - the failure the dashboard exists
      // to make impossible. Say so in the connection line instead.
      try {
        render(data);
      } catch (e) {
        setConnection('down', '描画エラー - 再読み込みしてください');
      }
    });
    es.addEventListener('error', function () {
      // EventSource retries on its own, but a 503 (too many clients) closes it
      // for good, so drive the reconnect ourselves with a backoff.
      setConnection('down', '切断 - 再接続を待っている');
      if (es && es.readyState === 2) scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    var wait = backoff;
    backoff = Math.min(backoff * 2, 30000);
    setConnection('down', '切断 - ' + Math.round(wait / 1000) + '秒後に再接続');
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, wait);
  }

  /* ------------------------------- rendering ------------------------------ */

  function render(data) {
    snapshot = data;
    // Claimed BEFORE anything that can throw. This used to be set at the very
    // end, so one bad render left it false forever: every later snapshot would
    // re-prime the notification baseline and never fire a notification again.
    var first = !firstSnapshotSeen;
    firstSnapshotSeen = true;
    var counts = data.counts || {};
    setText($('stat-live'), counts.live == null ? '-' : counts.live);
    var waitingCount = counts.waiting || 0;
    setText($('stat-waiting'), counts.waiting == null ? '-' : counts.waiting);
    // Same amber as the card badge, and only when there is something to do.
    $('stat-waiting-wrap').classList.toggle('stat--alert', waitingCount > 0);
    setText($('stat-agents'), counts.agentsRunning == null ? '-' : counts.agentsRunning);

    var errors = data.stats && typeof data.stats.errorCount === 'number' ? data.stats.errorCount : 0;
    setText($('stat-errors'), errors);
    var errWrap = $('stat-errors-wrap');
    errWrap.classList.toggle('stat--bad', errors > 0);

    document.title = (waitingCount > 0 ? '(' + waitingCount + ') ' : '') + 'claude/monitor';

    var limits = renderQuota(data.sessions || []);
    renderCards(data.sessions || []);
    renderFooter(data);
    tick();

    // The first snapshot only records where things stand. Announcing it would
    // mean a burst of notifications every time the tab reconnects.
    if (first) primeNotifications(data.sessions || []);
    else fireNotifications(data.sessions || []);
    fireQuotaNotifications(limits, first);

    onSnapshotForTree();
    onSnapshotForUsage();
  }

  function renderFooter(data) {
    var src = data.sources || {};
    setText($('foot-src'), 'events: ' + (src.eventsDir || '-'));
    var st = data.stats || {};
    setText($('foot-rev'),
      'rev ' + (data.revision || 0) +
      ' · hooks ' + (st.hookEvents || 0) +
      ' · セッション ' + (st.sessionsTracked || 0) +
      ' · 更新 ' + clockSec(data.generatedAt));
  }

  /* --------------------------------- quota -------------------------------- */

  var gauges = new Map();

  /**
   * rate_limits are account-wide, so the freshest capture across all sessions
   * wins - exactly what statusline-sidecar.latestRateLimits() does server-side
   * for the CLI.
   */
  function freshestRateLimits(sessions) {
    var best = null;
    var bestAt = -Infinity;
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      if (!s.rateLimits || !Object.keys(s.rateLimits).length) continue;
      var at = parseMs(s.statuslineAt);
      if (isNaN(at)) at = 0;
      if (at >= bestAt) { bestAt = at; best = s; }
    }
    return best;
  }

  /**
   * Draws the ribbon and RETURNS the rate_limits it drew, so the threshold
   * notifications can use the same "freshest capture" decision instead of
   * re-deriving one that could disagree with what the user sees.
   * @returns {object|null}
   */
  function renderQuota(sessions) {
    var src = freshestRateLimits(sessions);
    var rows = $('quota-rows');
    var empty = $('quota-empty');
    if (!src) {
      empty.hidden = false;
      while (rows.firstChild) rows.removeChild(rows.firstChild);
      gauges.clear();
      return null;
    }
    empty.hidden = true;
    var keys = ['five_hour', 'seven_day', 'spend_limit'];
    var wanted = [];
    for (var i = 0; i < keys.length; i++) {
      if (src.rateLimits[keys[i]]) wanted.push(keys[i]);
    }
    // Drop gauges for windows that expired.
    gauges.forEach(function (g, k) {
      if (wanted.indexOf(k) === -1) {
        if (g.root.parentNode) g.root.parentNode.removeChild(g.root);
        gauges.delete(k);
      }
    });
    for (var j = 0; j < wanted.length; j++) {
      var key = wanted[j];
      var w = src.rateLimits[key];
      var g = gauges.get(key);
      if (!g) {
        g = buildGauge(key);
        gauges.set(key, g);
        rows.appendChild(g.root);
      }
      var pct = typeof w.used_percentage === 'number' ? w.used_percentage : 0;
      g.root.classList.toggle('gauge--high', pct >= 70 && pct < 90);
      g.root.classList.toggle('gauge--crit', pct >= 90);
      g.fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
      setText(g.pct, Math.floor(pct) + '%');
      var reset = clockFromEpochSec(w.resets_at);
      setText(g.reset, reset ? ' 復帰 ' + reset : '');
    }
    return src.rateLimits;
  }

  function buildGauge(key) {
    var root = el('div', 'gauge');
    root.appendChild(el('span', 'gauge__k', GAUGE_LABEL[key] || key));
    var track = el('div', 'gauge__track');
    var fill = el('div', 'gauge__fill');
    track.appendChild(fill);
    root.appendChild(track);
    var v = el('span', 'gauge__v');
    var pct = el('b');
    var reset = el('span', 'gauge__reset');
    v.appendChild(pct);
    v.appendChild(reset);
    root.appendChild(v);
    return { root: root, fill: fill, pct: pct, reset: reset };
  }

  /* --------------------------------- cards -------------------------------- */

  function renderCards(sessions) {
    var liveHost = $('cards');
    var archHost = $('archive-cards');
    var seen = new Set();
    var liveOrder = [];
    var archOrder = [];

    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      seen.add(s.sessionId);
      var card = cards.get(s.sessionId);
      if (!card) {
        card = buildCard(s.sessionId);
        cards.set(s.sessionId, card);
      }
      patchCard(card, s);
      var archived = !isLiveSession(s);
      card.root.classList.toggle('card--archived', archived);
      (archived ? archOrder : liveOrder).push(card);
    }

    cards.forEach(function (card, id) {
      if (seen.has(id)) return;
      if (card.root.parentNode) card.root.parentNode.removeChild(card.root);
      cards.delete(id);
      forgetSession(id);
    });

    reorder(liveHost, liveOrder);
    reorder(archHost, archOrder);

    $('empty').hidden = liveOrder.length > 0;
    var archive = $('archive');
    archive.hidden = archOrder.length === 0;
    setText($('archive-count'), archOrder.length);
  }

  /** Move nodes into the requested order without recreating any of them. */
  function reorder(host, list) {
    for (var i = 0; i < list.length; i++) {
      var node = list[i].root;
      var current = host.childNodes[i];
      if (current === node) continue;
      host.insertBefore(node, current || null);
    }
    while (host.childNodes.length > list.length) {
      host.removeChild(host.lastChild);
    }
  }

  function buildRow(key) {
    var row = el('div', 'row');
    row.appendChild(el('span', 'row__k', key));
    var v = el('div', 'row__v');
    row.appendChild(v);
    return { row: row, v: v };
  }

  function buildCard(sessionId) {
    var root = el('article', 'card');
    root.dataset.session = sessionId;

    var top = el('div', 'card__top');
    var title = el('h2', 'card__title');
    var badge = el('span', 'badge');
    var badgeText = el('span');
    var badgeGuess = el('span', 'badge__guess');
    badge.appendChild(badgeText);
    badge.appendChild(badgeGuess);
    var sinceEl = el('span', 'card__since');
    var spanEl = el('span', 'card__span');
    var treeBtn = el('button', 'btn btn--sm card__tree', 'Tree');
    treeBtn.type = 'button';
    treeBtn.addEventListener('click', function () { showTreeFor(sessionId); });
    top.appendChild(title);
    top.appendChild(badge);
    top.appendChild(sinceEl);
    top.appendChild(spanEl);
    top.appendChild(treeBtn);
    root.appendChild(top);

    var meta = el('div', 'card__meta');
    var cwd = el('span', 'cwd');
    var pid = el('span');
    var model = el('span');
    var ctx = el('span');
    var cost = el('span');
    meta.appendChild(cwd);
    meta.appendChild(pid);
    meta.appendChild(model);
    meta.appendChild(ctx);
    meta.appendChild(cost);
    root.appendChild(meta);

    var toolRow = buildRow('TOOL');
    var tool = el('div', 'tool');
    var toolName = el('span');
    var toolTime = el('span', 'tool__t');
    var toolAgent = el('span', 'tool__agent');
    tool.appendChild(toolName);
    tool.appendChild(toolTime);
    tool.appendChild(toolAgent);
    toolRow.v.appendChild(tool);
    root.appendChild(toolRow.row);

    var agentRow = buildRow('AGENTS');
    var agents = el('div', 'agents');
    agentRow.v.appendChild(agents);
    root.appendChild(agentRow.row);

    var noteRow = buildRow('通知');
    var notes = el('div', 'notes');
    noteRow.v.appendChild(notes);
    root.appendChild(noteRow.row);

    var promptRow = buildRow('最新プロンプト');
    var prompt = el('div', 'prompt');
    promptRow.v.appendChild(prompt);
    root.appendChild(promptRow.row);

    var tokRow = buildRow('TOKENS');
    var tok = el('div', 'tok');
    tokRow.v.appendChild(tok);
    root.appendChild(tokRow.row);

    return {
      root: root,
      title: title,
      badge: badge,
      badgeText: badgeText,
      badgeGuess: badgeGuess,
      since: sinceEl,
      span: spanEl,
      treeBtn: treeBtn,
      cwd: cwd,
      pid: pid,
      model: model,
      ctx: ctx,
      cost: cost,
      toolRow: toolRow.row,
      tool: tool,
      toolName: toolName,
      toolTime: toolTime,
      toolAgent: toolAgent,
      agentRow: agentRow.row,
      agents: agents,
      agentNodes: new Map(),
      promptRow: promptRow.row,
      prompt: prompt,
      noteRow: noteRow.row,
      notes: notes,
      tokRow: tokRow.row,
      tok: tok,
      data: null
    };
  }

  function patchCard(card, s) {
    card.data = s;
    card.root.dataset.phase = s.phase;
    var attn = s.phase === 'waiting_permission' || s.phase === 'waiting_input';
    card.root.classList.toggle('card--attn', attn);

    setText(card.title, s.title || s.sessionId.slice(0, 8));
    card.badge.dataset.phase = s.phase;
    setText(card.badgeText, PHASE_LABEL[s.phase] || s.phase);
    setText(card.badgeGuess, s.phaseSource === 'sessions' ? '推定' : '');
    if (s.endedReason) setText(card.badgeGuess, s.endedReason);

    // "12s 前" says how long ago the last event was, never when the session
    // began. A card that has been idle since yesterday needs both.
    var startTxt = dayClock(s.startedAt);
    var endTxt = dayClock(s.endedAt);
    setText(card.span, startTxt ? ('開始 ' + startTxt + (endTxt ? ' – 終了 ' + endTxt : '')) : '');

    setText(card.cwd, s.cwd || '(cwd 不明)');
    setText(card.pid, s.pid ? 'pid ' + s.pid + (s.pidReused ? ' (再利用?)' : '') : '');
    setText(card.model, s.model || '');
    setText(card.ctx, typeof s.contextPct === 'number' ? 'ctx ' + Math.floor(s.contextPct) + '%' : '');
    setText(card.cost, typeof s.costUsd === 'number' ? '$' + s.costUsd.toFixed(2) : '');

    // current tool
    if (s.currentTool) {
      card.toolRow.hidden = false;
      card.tool.classList.remove('tool--none');
      setText(card.toolName, s.currentTool.name || '(tool)');
      setText(card.toolAgent, s.currentTool.agentId ? '@' + s.currentTool.agentId.slice(0, 8) : '');
    } else if (s.phase === 'busy') {
      card.toolRow.hidden = false;
      card.tool.classList.add('tool--none');
      setText(card.toolName, 'ツールなし（応答生成中）');
      setText(card.toolTime, '');
      setText(card.toolAgent, '');
    } else {
      card.toolRow.hidden = true;
    }

    patchAgents(card, s.agents || []);
    patchNotes(card, s.notifications || []);

    // The prompt is NEVER the title: it changes every turn, and an
    // attachment-only message would rename the card to "Image #1".
    var promptText = s.lastPrompt ? trim80(s.lastPrompt) : '';
    card.promptRow.hidden = !promptText;
    setText(card.prompt, promptText);

    var t = s.tokens;
    if (t && typeof t.total === 'number') {
      card.tokRow.hidden = false;
      while (card.tok.firstChild) card.tok.removeChild(card.tok.firstChild);
      card.tok.appendChild(pair('合計', compact(t.total)));
      card.tok.appendChild(pair('in', compact(t.input)));
      card.tok.appendChild(pair('out', compact(t.output)));
      card.tok.appendChild(pair('cache作', compact(t.cacheCreate)));
      card.tok.appendChild(pair('cache読', compact(t.cacheRead)));
      card.tok.appendChild(pair('msg', compact(t.messages)));
    } else {
      card.tokRow.hidden = true;
    }
  }

  function pair(label, value) {
    var span = el('span');
    span.appendChild(document.createTextNode(label + ' '));
    span.appendChild(el('b', null, value));
    return span;
  }

  function patchAgents(card, agents) {
    var running = [];
    for (var i = 0; i < agents.length; i++) {
      // Completed agents stay visible for a short while so a finished burst is
      // still readable; older ones drop off.
      if (agents[i].status === 'running') running.push(agents[i]);
    }
    var recentDone = agents.filter(function (a) { return a.status !== 'running'; }).slice(-3);
    var show = running.concat(recentDone);

    card.agentRow.hidden = show.length === 0;
    var seen = new Set();
    var order = [];
    for (var j = 0; j < show.length; j++) {
      var a = show[j];
      seen.add(a.agentId);
      var node = card.agentNodes.get(a.agentId);
      if (!node) {
        node = buildAgent();
        card.agentNodes.set(a.agentId, node);
      }
      node.data = a;
      node.root.classList.toggle('agent--done', a.status === 'completed');
      // "stale" is our inference, not something a hook told us, so it gets its
      // own mark and says so in words rather than borrowing the done tick.
      node.root.classList.toggle('agent--stale', a.status === 'stale');
      setText(node.mark, AGENT_MARK[a.status] || '·');
      node.mark.setAttribute('title', AGENT_STATUS_LABEL[a.status] || a.status);
      setText(node.type, a.label || a.agentId.slice(0, 8));
      setText(node.model, a.model ? modelLabel(a.model) : '');
      setText(node.n, a.tools ? a.tools + ' tools' : '');
      setText(node.note, a.status === 'stale' ? '終了と推定' : '');
      order.push(node);
    }
    card.agentNodes.forEach(function (node, id) {
      if (seen.has(id)) return;
      if (node.root.parentNode) node.root.parentNode.removeChild(node.root);
      card.agentNodes.delete(id);
    });
    reorder(card.agents, order);
  }

  function buildAgent() {
    var root = el('div', 'agent');
    var mark = el('span', 'agent__mark');
    var type = el('span', 'agent__type');
    var model = el('span', 'agent__model');
    var d = el('span', 'agent__d');
    var n = el('span', 'agent__n');
    var note = el('span', 'agent__note');
    root.appendChild(mark);
    root.appendChild(type);
    root.appendChild(model);
    root.appendChild(d);
    root.appendChild(n);
    root.appendChild(note);
    return { root: root, mark: mark, type: type, model: model, d: d, n: n, note: note, data: null };
  }

  function patchNotes(card, notifications) {
    var recent = notifications.slice(-3).reverse();
    card.noteRow.hidden = recent.length === 0;
    while (card.notes.firstChild) card.notes.removeChild(card.notes.firstChild);
    for (var i = 0; i < recent.length; i++) {
      var n = recent[i];
      var row = el('div', 'note');
      if (ATTENTION_TYPES[n.type]) row.classList.add('note--attn');
      row.appendChild(el('span', 'note__t', NOTIFICATION_LABEL[n.type] || n.type));
      row.appendChild(el('span', 'note__m', n.message || ''));
      row.appendChild(el('span', 'note__at', clock(n.at)));
      card.notes.appendChild(row);
    }
  }

  /* -------------------------- one-second ticking -------------------------- */

  function tick() {
    var now = Date.now();
    tickTree(now);
    tree.rows.forEach(function (row, id) {
      for (var i = 0; i < tree.sessions.length; i++) {
        if (tree.sessions[i].sessionId !== id) continue;
        var m = tree.sessions[i].modified;
        setText(row.when, m ? since(m, now) + ' 前' : '-');
      }
    });
    cards.forEach(function (card) {
      var s = card.data;
      if (!s) return;
      setText(card.since, s.lastEventAt ? since(s.lastEventAt, now) + ' 前' : '-');
      if (s.currentTool && s.currentTool.since) {
        setText(card.toolTime, since(s.currentTool.since, now));
      }
      card.agentNodes.forEach(function (node) {
        var a = node.data;
        if (!a) return;
        var end = a.status === 'running' ? now : parseMs(a.endedAt) || now;
        setText(node.d, a.startedAt ? since(a.startedAt, end) : '');
      });
    });
  }

  /* ----------------------------- notifications ---------------------------- */

  /**
   * Drop the notification bookkeeping for a session the server no longer
   * reports. Without this the three Maps below grow for as long as the tab
   * stays open - slowly, but without any bound.
   */
  function forgetSession(sessionId) {
    seenNotification.delete(sessionId);
    seenStop.delete(sessionId);
    var prefix = sessionId + ':';
    lastNotified.forEach(function (at, key) {
      if (key.indexOf(prefix) === 0) lastNotified.delete(key);
    });
  }

  function primeNotifications(sessions) {
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var last = s.notifications && s.notifications.length
        ? s.notifications[s.notifications.length - 1].id
        : null;
      seenNotification.set(s.sessionId, last);
      seenStop.set(s.sessionId, s.lastEventAt || null);
    }
  }

  /**
   * Load the stored settings, migrating the old on/off key on the way. Called
   * once from boot(), before anything can fire.
   */
  function loadNotifySettings() {
    if (!RULES) return;
    var got = RULES.parse(readStore(), readLegacyStore());
    notifySettings = got.settings;
    // Nothing stored, or stored under the old key / a broken shape: write the
    // normalized answer back now, so the next load takes the fast path.
    if (got.migrated) saveNotifySettings();
  }

  function saveNotifySettings() {
    if (!RULES) return;
    try {
      writeStore(JSON.stringify(notifySettings));
    } catch (e) { /* nothing sane to do; the in-memory settings still apply */ }
    dropLegacyStore();
  }

  function kindEnabled(kind) {
    return notifySettings.kinds[kind] === true;
  }

  function canNotify() {
    if (!notifySettings.enabled) return false;
    if (typeof window.Notification === 'undefined') return false;
    if (window.Notification.permission !== 'granted') return false;
    // The user is already looking at the dashboard - do not talk over them.
    if (notifySettings.quietWhenFocused
        && document.visibilityState === 'visible' && document.hasFocus()) return false;
    return true;
  }

  function notify(key, title, body) {
    if (!canNotify()) return;
    var now = Date.now();
    var last = lastNotified.get(key);
    // Same session, same kind, within 5s: one notification is enough.
    if (last && now - last < NOTIFY_DEDUPE_MS) return;
    lastNotified.set(key, now);
    try {
      var n = new window.Notification(title, { body: body || '', tag: key, silent: false });
      n.onclick = function () {
        try { window.focus(); } catch (e) { /* ignore */ }
        n.close();
      };
    } catch (e) { /* browser refused; nothing to do */ }
  }

  function fireNotifications(sessions) {
    for (var i = 0; i < sessions.length; i++) {
      var s = sessions[i];
      var name = s.title || s.sessionId.slice(0, 8);

      var list = s.notifications || [];
      var lastSeen = seenNotification.get(s.sessionId);
      var startIndex = 0;
      if (lastSeen) {
        for (var j = list.length - 1; j >= 0; j--) {
          if (list[j].id === lastSeen) { startIndex = j + 1; break; }
        }
      } else if (!seenNotification.has(s.sessionId)) {
        // A session that appeared after we connected: announce what it says.
        startIndex = Math.max(0, list.length - 1);
      }
      for (var k = startIndex; k < list.length; k++) {
        var n = list[k];
        if (NOTIFY_TYPES.indexOf(n.type) === -1) continue;
        // The bookkeeping below still advances: a kind the user switched off is
        // "handled", not "pending until they switch it back on".
        if (!kindEnabled(n.type)) continue;
        notify(s.sessionId + ':' + n.type, name + ' — ' + (NOTIFICATION_LABEL[n.type] || n.type), n.message || '');
      }
      seenNotification.set(s.sessionId, list.length ? list[list.length - 1].id : lastSeen || null);

      if (s.lastEventName === 'Stop' && s.lastEventAt && seenStop.get(s.sessionId) !== s.lastEventAt) {
        if (seenStop.has(s.sessionId) && kindEnabled('turn_complete')) {
          notify(s.sessionId + ':stop', name + ' — ターン完了', s.cwd || '');
        }
        seenStop.set(s.sessionId, s.lastEventAt);
      } else if (!seenStop.has(s.sessionId)) {
        seenStop.set(s.sessionId, s.lastEventAt || null);
      }
    }
  }

  /**
   * Rate-limit threshold alerts. The decision - and the whole memory of which
   * window already fired - lives in notify-rules.js; this only turns the
   * verdict into a Notification.
   */
  function fireQuotaNotifications(limits, prime) {
    if (!RULES) return;
    var out = RULES.evaluateQuota(limits, quotaArmed, notifySettings, prime === true);
    quotaArmed = out.armed;
    for (var i = 0; i < out.fire.length; i++) {
      var f = out.fire[i];
      var label = GAUGE_LABEL[f.window] || f.window;
      var reset = clockFromEpochSec(f.resetsAt);
      notify(
        'quota:' + f.window,
        '利用枠 ' + label + ' が ' + f.threshold + '% を超えた',
        Math.floor(f.pct) + '% 使用' + (reset ? ' · 復帰 ' + reset : '')
      );
    }
  }

  function refreshNotifyButtons() {
    var permBtn = $('notify-permission');
    var toggle = $('notify-toggle');
    var supported = typeof window.Notification !== 'undefined';
    if (!supported) {
      permBtn.hidden = true;
      toggle.disabled = true;
      setText(toggle, '通知 非対応');
      setText($('notify-panel-state'), 'このブラウザは通知に対応していない');
      return;
    }
    var perm = window.Notification.permission;
    permBtn.hidden = perm !== 'default';
    setText(toggle, notifySettings.enabled ? '通知 ON' : '通知 OFF');
    toggle.setAttribute('aria-pressed', notifySettings.enabled ? 'true' : 'false');
    if (perm === 'denied') {
      setText(toggle, '通知 ブロック中');
      toggle.disabled = true;
    }
    setText($('notify-panel-state'), notifyStateText(perm));
  }

  /** One line under the panel saying why nothing would be shown right now. */
  function notifyStateText(perm) {
    if (!RULES) return '設定モジュールが読み込めていない';
    if (perm === 'denied') return 'ブラウザが通知をブロックしている（サイト設定で解除する）';
    if (perm === 'default') return 'まだ通知を許可していない';
    if (!notifySettings.enabled) return 'マスタースイッチが OFF';
    return '';
  }

  /* --------------------------- notification panel -------------------------- */

  function notifyPanelOpen() {
    return $('notify-panel').hidden === false;
  }

  function setNotifyPanel(open) {
    $('notify-panel').hidden = !open;
    $('notify-settings').setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open) refreshNotifyPanel();
  }

  /** Push the settings INTO the controls. The controls are never the truth. */
  function refreshNotifyPanel() {
    if (!RULES) return;
    var i;
    for (i = 0; i < RULES.KINDS.length; i++) {
      var k = RULES.KINDS[i];
      $('notify-kind-' + k).checked = kindEnabled(k);
    }
    for (i = 0; i < RULES.QUOTA_WINDOWS.length; i++) {
      var w = RULES.QUOTA_WINDOWS[i];
      var q = notifySettings.quota[w];
      $('notify-quota-' + w).checked = q.on === true;
      $('notify-quota-' + w + '-th').value = String(q.threshold);
    }
    $('notify-quiet').checked = notifySettings.quietWhenFocused === true;
    refreshNotifyButtons();
  }

  function bindNotifyPanel() {
    var i;
    if (!RULES) {
      $('notify-settings').disabled = true;
      return;
    }
    for (i = 0; i < RULES.KINDS.length; i++) bindKindBox(RULES.KINDS[i]);
    for (i = 0; i < RULES.QUOTA_WINDOWS.length; i++) bindQuotaRow(RULES.QUOTA_WINDOWS[i]);

    $('notify-quiet').addEventListener('change', function () {
      notifySettings.quietWhenFocused = $('notify-quiet').checked;
      saveNotifySettings();
    });

    $('notify-settings').addEventListener('click', function () {
      setNotifyPanel(!notifyPanelOpen());
    });
    $('notify-close').addEventListener('click', function () {
      setNotifyPanel(false);
      $('notify-settings').focus();
    });
    $('notify-test').addEventListener('click', sendTestNotification);

    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape' || !notifyPanelOpen()) return;
      setNotifyPanel(false);
      $('notify-settings').focus();
    });
    // A click anywhere outside the panel closes it. The opener is excluded so
    // its own click is not counted twice (open, then immediately closed).
    document.addEventListener('click', function (e) {
      if (!notifyPanelOpen()) return;
      if ($('notify-panel').contains(e.target)) return;
      if ($('notify-settings').contains(e.target)) return;
      setNotifyPanel(false);
    });
  }

  /* Each box gets its own closure: `var` in a loop would share one variable. */
  function bindKindBox(kind) {
    var box = $('notify-kind-' + kind);
    box.addEventListener('change', function () {
      notifySettings.kinds[kind] = box.checked;
      saveNotifySettings();
    });
  }

  function bindQuotaRow(win) {
    var box = $('notify-quota-' + win);
    var num = $('notify-quota-' + win + '-th');
    box.addEventListener('change', function () {
      notifySettings.quota[win].on = box.checked;
      saveNotifySettings();
    });
    num.addEventListener('change', function () {
      var n = RULES.parseThreshold(num.value);
      // Refuse silently and put the stored value back: an empty or out-of-range
      // box must never read as a threshold the user did not choose.
      if (n === null) {
        num.value = String(notifySettings.quota[win].threshold);
        return;
      }
      notifySettings.quota[win].threshold = n;
      saveNotifySettings();
    });
  }

  /**
   * The test notification deliberately IGNORES quietWhenFocused: the person who
   * just pressed the button is looking at the tab, and a button that appears to
   * do nothing is worse than a redundant notification.
   */
  function sendTestNotification() {
    if (typeof window.Notification === 'undefined') return;
    if (window.Notification.permission === 'default') {
      var p = window.Notification.requestPermission();
      if (p && typeof p.then === 'function') {
        p.then(function () { refreshNotifyButtons(); showTestNotification(); });
      }
      return;
    }
    showTestNotification();
  }

  function showTestNotification() {
    if (window.Notification.permission !== 'granted') {
      refreshNotifyButtons();
      return;
    }
    try {
      var n = new window.Notification('claude/monitor — テスト', {
        body: '通知はこの見た目で出る',
        tag: 'cm:test'
      });
      n.onclick = function () {
        try { window.focus(); } catch (e) { /* ignore */ }
        n.close();
      };
    } catch (e) { /* browser refused; nothing to do */ }
  }

  /* --------------------------------- tree --------------------------------- */

  /*
   * The Tree view. Three panes: the session list on the left, the nested
   * subagent tree top right, the detail of the selected node under it.
   *
   * The server merges hooks, meta.json and the transcript before we see any of
   * it (src/tree-merge.js), so this file only decides how to SHOW a node - it
   * never re-derives a status.
   *
   * Refresh policy: a live session's tree is re-fetched on every SSE snapshot,
   * debounced to 2s, because parsing a 35MB transcript server-side is not free.
   * A finished session is fetched once and then only on the 更新 button.
   */

  /* Marks and Japanese names live in AGENT_MARK / AGENT_STATUS_LABEL above:
     one table for both views. Why we believe the status. Shown verbatim so an inference never looks like
     a fact. An unknown source falls through as its raw string. */
  var TREE_SOURCE_LABEL = {
    'hooks:SubagentStop': 'SubagentStop フック',
    hooks: 'hooks イベント',
    inferred: '無音からの推定',
    'jsonl:async_launched': 'transcript（起動のみ確認）',
    'jsonl:no-tool-result': 'transcript（tool_result なし）',
    'jsonl:tool-result-status': 'transcript の tool_result',
    'jsonl:tool-result-present': 'transcript の tool_result',
    'jsonl:tool-result-is_error': 'transcript の tool_result（エラー）',
    none: '根拠なし'
  };

  /* Where a resolved value came from. `mtime` is deliberately spelled out as a
     file property: it is the time of the last WRITE, not of the last record,
     and the reader has to be able to tell that from a real end time. */
  var FIELD_SOURCE_LABEL = {
    meta: 'meta.json',
    hooks: 'hooks',
    sessions: '~/.claude/sessions',
    transcript: 'transcript',
    mtime: 'ファイルの更新時刻',
    spawn: '起動した tool_use'
  };

  var TREE_DEBOUNCE_MS = 2000;
  var DEFAULT_OPEN_DEPTH = 2;
  var K_TAB = 'cm.tab';
  var K_TREE_SESSION = 'cm.tree.session';
  var K_TREE_DAYS = 'cm.tree.days';

  var tree = {
    days: 30,
    sessions: [],
    rows: new Map(),
    selected: null,
    data: null,
    /** node id -> the DOM parts for that row */
    els: new Map(),
    /** node id -> the last node object rendered there */
    nodeData: new Map(),
    /** structure fingerprint; the DOM is rebuilt only when this changes */
    signature: '',
    /** node ids the user (or the depth rule) folded shut */
    collapsed: new Set(),
    seeded: false,
    detailId: null,
    detailToolsFor: null,
    treeTimer: null,
    listTimer: null
  };

  function getStore(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }
  function setStore(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { /* private mode */ }
  }

  function apiJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      return r.json();
    });
  }

  /** Local wall clock WITH the date - a tree spans days, unlike a live card. */
  function stamp(iso) {
    var t = parseMs(iso);
    if (isNaN(t)) return '-';
    var d = new Date(t);
    return (d.getMonth() + 1) + '/' + d.getDate() + ' ' +
      pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }

  /** A finished duration: "4m 03s". */
  function span(ms) {
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) return '';
    var sec = Math.round(ms / 1000);
    if (sec < 60) return sec + 's';
    var m = Math.floor(sec / 60);
    if (m < 60) return m + 'm ' + pad(sec % 60) + 's';
    var h = Math.floor(m / 60);
    return h + 'h ' + pad(m % 60) + 'm';
  }

  function bytesLabel(n) {
    if (typeof n !== 'number' || !isFinite(n) || n <= 0) return '';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function sourceLabel(src) {
    if (!src) return '';
    return TREE_SOURCE_LABEL[src] || src;
  }

  function baseNameOf(p) {
    if (typeof p !== 'string' || !p) return '';
    var parts = p.split(/[\\/]+/).filter(Boolean);
    return parts.length ? parts[parts.length - 1] : '';
  }

  /* ------------------------------ session list ---------------------------- */

  function loadSessions() {
    return apiJson('/api/sessions?days=' + tree.days)
      .then(function (d) {
        tree.sessions = (d && d.sessions) || [];
        renderSessionList();
      })
      .catch(function () {
        setText($('tree-side-empty'), 'セッション一覧を取得できなかった');
        $('tree-side-empty').hidden = false;
      });
  }

  function renderSessionList() {
    var host = $('tree-sessions');
    var list = tree.sessions;
    $('tree-side-empty').hidden = list.length > 0;
    if (!list.length) setText($('tree-side-empty'), '該当するセッションが無い');

    var seen = new Set();
    var order = [];
    var now = Date.now();
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      seen.add(s.sessionId);
      var row = tree.rows.get(s.sessionId);
      if (!row) {
        row = buildSessionRow(s.sessionId);
        tree.rows.set(s.sessionId, row);
      }
      patchSessionRow(row, s, now);
      order.push(row);
    }
    tree.rows.forEach(function (row, id) {
      if (seen.has(id)) return;
      if (row.root.parentNode) row.root.parentNode.removeChild(row.root);
      tree.rows.delete(id);
    });
    reorder(host, order);
  }

  function buildSessionRow(sessionId) {
    var li = el('li', 'slist__i');
    var btn = el('button', 'srow');
    btn.type = 'button';
    btn.dataset.session = sessionId;
    var top = el('span', 'srow__top');
    var dot = el('span', 'srow__dot');
    var title = el('span', 'srow__title');
    var badge = el('span', 'srow__badge');
    top.appendChild(dot);
    top.appendChild(title);
    top.appendChild(badge);
    var meta = el('span', 'srow__meta');
    var cwd = el('span', 'srow__cwd');
    var when = el('span', 'srow__when');
    var subs = el('span', 'srow__subs');
    meta.appendChild(cwd);
    meta.appendChild(when);
    meta.appendChild(subs);
    var spanEl = el('span', 'srow__span');
    btn.appendChild(top);
    btn.appendChild(meta);
    btn.appendChild(spanEl);
    li.appendChild(btn);
    btn.addEventListener('click', function () { selectSession(sessionId); });
    return {
      root: li, btn: btn, dot: dot, title: title, badge: badge,
      cwd: cwd, when: when, subs: subs, span: spanEl
    };
  }

  /**
   * "開始 09:12 – 終了 10:04", absolute and local.
   *
   * The relative line above it answers "how long ago"; a row that reads
   * "3d 04h 前" still does not say WHEN, and the day window makes rows that old
   * normal. A live session has no end time by construction (the server sends
   * null), so it says 稼働中 rather than borrowing its last write.
   */
  function sessionSpanText(s) {
    var start = dayClock(s.startedAt);
    if (!start) return '';
    if (s.live) return '開始 ' + start + ' – 稼働中';
    var end = dayClock(s.endedAt);
    return end ? '開始 ' + start + ' – 終了 ' + end : '開始 ' + start;
  }

  function patchSessionRow(row, s, now) {
    row.btn.classList.toggle('srow--live', !!s.live);
    row.btn.classList.toggle('srow--on', tree.selected === s.sessionId);
    row.btn.setAttribute('aria-current', tree.selected === s.sessionId ? 'true' : 'false');
    row.dot.dataset.phase = s.phase || (s.live ? 'unknown' : 'off');
    setText(row.title, s.title || s.sessionId.slice(0, 8));
    setText(row.badge, s.live ? (PHASE_LABEL[s.phase] || s.phase || '稼働') : '');
    setText(row.cwd, baseNameOf(s.cwd) || s.projectDirName || '');
    setText(row.when, s.modified ? since(s.modified, now) + ' 前' : '-');
    setText(row.subs, s.subagentCount ? 'agents ' + s.subagentCount : '');
    setText(row.span, sessionSpanText(s));
  }

  /* -------------------------------- the tree ------------------------------ */

  function selectSession(sessionId) {
    if (tree.selected !== sessionId) {
      tree.selected = sessionId;
      tree.collapsed = new Set();
      tree.seeded = false;
      tree.signature = '';
      tree.detailId = null;
      tree.detailToolsFor = null;
      clearNodes();
      $('tree-detail').hidden = true;
      setStore(K_TREE_SESSION, sessionId);
    }
    renderSessionList();
    loadTree(true);
  }

  function clearNodes() {
    var host = $('tree-nodes');
    while (host.firstChild) host.removeChild(host.firstChild);
    var oh = $('tree-orphan-nodes');
    while (oh.firstChild) oh.removeChild(oh.firstChild);
    tree.els.clear();
    tree.nodeData.clear();
  }

  function loadTree(showPending) {
    var id = tree.selected;
    if (!id) return Promise.resolve();
    if (showPending) setText($('tree-sum'), '読み込み中…');
    return apiJson('/api/tree/' + encodeURIComponent(id))
      .then(function (d) {
        // A slow answer for a session the user already left must not paint.
        if (!d || d.sessionId !== tree.selected) return;
        renderTree(d);
      })
      .catch(function () {
        if (id !== tree.selected) return;
        setText($('tree-sum'), 'ツリーを取得できなかった');
      });
  }

  function renderTree(d) {
    tree.data = d;
    $('tree-empty').hidden = true;
    var root = d.root;
    setText($('tree-title'), root.title || d.sessionId.slice(0, 8));
    setText($('tree-cwd'), root.cwd || '(cwd 不明)');

    var bits = [];
    bits.push('エージェント ' + d.agentCount);
    bits.push('tools ' + root.toolCount);
    bits.push('tokens ' + compact(root.tokens.total));
    if (root.startedAt) bits.push(stamp(root.startedAt) + ' 開始');
    if (root.endedAt) bits.push(stamp(root.endedAt) + ' 終了');
    else if (root.live) bits.push('稼働中');
    if (typeof root.durationMs === 'number' && root.endedAt) bits.push('所要 ' + span(root.durationMs));
    bits.push(bytesLabel(d.parse.bytes) + ' / ' + d.parse.files + ' ファイル');
    bits.push(d.parse.cached ? 'キャッシュ' : '解析 ' + d.parse.parseMs + 'ms');
    if (d.parse.failures) bits.push('parse失敗 ' + d.parse.failures);
    setText($('tree-sum'), bits.join(' · '));

    var walked = walk(root, 0, [], null);
    var orphanWalk = [];
    for (var i = 0; i < d.orphans.length; i++) walk(d.orphans[i], 0, orphanWalk, null);

    if (!tree.seeded) {
      seedCollapsed(walked.concat(orphanWalk));
      tree.seeded = true;
    }

    var sig = walked.concat(orphanWalk).map(function (w) {
      return w.node.id + '@' + w.depth;
    }).join(',');
    if (sig !== tree.signature) {
      tree.signature = sig;
      rebuild(walked, $('tree-nodes'));
      rebuild(orphanWalk, $('tree-orphan-nodes'));
      prunePartsTo(walked.concat(orphanWalk));
    }
    for (var j = 0; j < walked.length; j++) patchNode(walked[j]);
    for (var k = 0; k < orphanWalk.length; k++) patchNode(orphanWalk[k]);

    var orph = $('tree-orphans');
    orph.hidden = d.orphans.length === 0;
    setText($('tree-orphan-count'), d.orphans.length);

    applyCollapse();
    // Only re-pull the tool log when the bytes on disk actually moved, so a
    // 2s live refresh does not rebuild (and scroll-reset) a list that is
    // identical to the one already on screen.
    if (!d.parse.cached) tree.detailToolsFor = null;
    if (tree.detailId) renderDetail(tree.detailId);
    tickTree(Date.now());
  }

  /** Depth-first list of {node, depth, parentId}. */
  function walk(node, depth, out, parentId) {
    out.push({ node: node, depth: depth, parentId: parentId });
    var kids = node.children || [];
    for (var i = 0; i < kids.length; i++) walk(kids[i], depth + 1, out, node.id);
    return out;
  }

  /** Open to DEFAULT_OPEN_DEPTH; anything deeper starts folded. */
  function seedCollapsed(list) {
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      var kids = w.node.children || [];
      if (kids.length && w.depth >= DEFAULT_OPEN_DEPTH) tree.collapsed.add(w.node.id);
    }
  }

  function rebuild(list, host) {
    while (host.firstChild) host.removeChild(host.firstChild);
    if (!list.length) return;
    /** node id -> the <ul> that holds its children */
    var lists = new Map();
    var rootUl = el('ul', 'tnodes');
    host.appendChild(rootUl);
    for (var i = 0; i < list.length; i++) {
      var w = list[i];
      var parts = tree.els.get(w.node.id);
      if (!parts) {
        parts = buildNode(w.node.id);
        tree.els.set(w.node.id, parts);
      }
      var into = w.parentId ? lists.get(w.parentId) : rootUl;
      (into || rootUl).appendChild(parts.li);
      lists.set(w.node.id, parts.ul);
    }
  }

  function prunePartsTo(list) {
    var keep = new Set();
    for (var i = 0; i < list.length; i++) keep.add(list[i].node.id);
    tree.els.forEach(function (parts, id) {
      if (keep.has(id)) return;
      if (parts.li.parentNode) parts.li.parentNode.removeChild(parts.li);
      tree.els.delete(id);
      tree.nodeData.delete(id);
    });
  }

  function buildNode(id) {
    var li = el('li', 'tnode');
    var row = el('div', 'tnode__row');

    var tog = el('button', 'tnode__tog');
    tog.type = 'button';
    tog.setAttribute('aria-expanded', 'true');
    tog.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (tree.collapsed.has(id)) tree.collapsed.delete(id);
      else tree.collapsed.add(id);
      applyCollapse();
    });

    var btn = el('button', 'tnode__btn');
    btn.type = 'button';
    var mark = el('span', 'tnode__mark');
    var label = el('span', 'tnode__label');
    var model = el('span', 'tnode__model');
    var time = el('span', 'tnode__time');
    var tok = el('span', 'tnode__tok');
    var tools = el('span', 'tnode__tools');
    var tool = el('span', 'tnode__tool');
    btn.appendChild(mark);
    btn.appendChild(label);
    btn.appendChild(model);
    btn.appendChild(time);
    btn.appendChild(tok);
    btn.appendChild(tools);
    btn.appendChild(tool);
    btn.addEventListener('click', function () { selectNode(id); });

    row.appendChild(tog);
    row.appendChild(btn);
    li.appendChild(row);
    var ul = el('ul', 'tnodes');
    li.appendChild(ul);
    return {
      li: li, row: row, tog: tog, btn: btn, mark: mark, label: label,
      model: model, time: time, tok: tok, tools: tools, tool: tool, ul: ul
    };
  }

  function patchNode(w) {
    var n = w.node;
    var parts = tree.els.get(n.id);
    if (!parts) return;
    tree.nodeData.set(n.id, n);

    var isSession = n.kind === 'session';
    var status = isSession ? (n.phase || 'session') : n.status;
    parts.li.dataset.status = status;
    parts.btn.dataset.status = status;
    parts.btn.classList.toggle('tnode__btn--on', tree.detailId === n.id);
    parts.btn.classList.toggle('tnode__btn--session', isSession);
    parts.btn.classList.toggle('tnode__btn--hooks', n.origin === 'hooks');

    setText(parts.mark, isSession ? '■' : (AGENT_MARK[n.status] || '·'));
    parts.mark.setAttribute('title', isSession
      ? 'セッション'
      : (AGENT_STATUS_LABEL[n.status] || n.status));
    setText(parts.label, isSession ? (n.title || n.id.slice(0, 8)) : (n.label || n.id.slice(0, 8)));
    // With no description and no agentType the label IS the short id. Set it
    // in the same mono face as the numeric cells so the columns line up
    // instead of drifting with a proportional font.
    parts.label.classList.toggle('tnode__label--id', !isSession && !n.description && !n.agentType);
    setText(parts.model, n.model ? modelLabel(n.model) : '');
    // A bare "0" in the token column reads as a stray number, not as data.
    // Nothing to say means an empty cell.
    setText(parts.tok, n.tokens && n.tokens.total ? compact(n.tokens.total) : '');
    setText(parts.tools, n.toolCount ? n.toolCount + ' tools' : '');
    var ct = n.currentTool;
    setText(parts.tool, ct && ct.name ? ct.name : '');

    var kids = (n.children || []).length;
    parts.tog.hidden = kids === 0;
    parts.tog.setAttribute('aria-label', (n.label || n.title || n.id) + ' の子を開閉');
  }

  function applyCollapse() {
    tree.els.forEach(function (parts, id) {
      var n = tree.nodeData.get(id);
      var kids = n && n.children ? n.children.length : 0;
      var folded = tree.collapsed.has(id);
      parts.ul.hidden = folded || kids === 0;
      if (kids) {
        parts.tog.setAttribute('aria-expanded', folded ? 'false' : 'true');
        setText(parts.tog, folded ? '▸' : '▾');
      } else {
        setText(parts.tog, '');
      }
    });
  }

  /** Live elapsed for anything still running; the fixed duration otherwise. */
  function tickTree(now) {
    tree.els.forEach(function (parts, id) {
      var n = tree.nodeData.get(id);
      if (!n) return;
      if (n.kind === 'session') {
        setText(parts.time, n.startedAt ? since(n.startedAt, parseMs(n.endedAt) || now) : '');
        return;
      }
      if (n.status === 'running' && n.startedAt) setText(parts.time, since(n.startedAt, now));
      else if (typeof n.durationMs === 'number') setText(parts.time, span(n.durationMs));
      else setText(parts.time, '');
    });
  }

  /* ------------------------------ detail panel ---------------------------- */

  function selectNode(id) {
    tree.detailId = id;
    tree.els.forEach(function (parts, nid) {
      parts.btn.classList.toggle('tnode__btn--on', nid === id);
    });
    renderDetail(id);
  }

  function renderDetail(id) {
    var n = tree.nodeData.get(id);
    var panel = $('tree-detail');
    if (!n) { panel.hidden = true; return; }
    panel.hidden = false;
    var isSession = n.kind === 'session';
    setText($('detail-title'), isSession ? (n.title || id) : (n.label || id));

    var rows = [];
    rows.push(['ID', n.id]);
    if (isSession) {
      rows.push(['種別', 'セッション（ルート）']);
      if (n.phase) {
        rows.push(['状態', (PHASE_LABEL[n.phase] || n.phase) +
          (n.phaseSource ? '（' + n.phaseSource + '）' : '')]);
      }
    } else {
      rows.push(['状態', (AGENT_STATUS_LABEL[n.status] || n.status) +
        '  ← ' + sourceLabel(n.statusSource) + (n.statusDetail ? '（' + n.statusDetail + '）' : '')]);
      rows.push(['種類', (n.agentType || '不明') +
        (n.agentTypeSource ? '  ← ' + (FIELD_SOURCE_LABEL[n.agentTypeSource] || n.agentTypeSource) : '')]);
      rows.push(['説明', n.description || '(なし)']);
      rows.push(['深さ', 'spawnDepth ' + n.spawnDepth +
        (n.origin === 'hooks' ? '（hooks のみ。transcript が無い）' : '')]);
    }
    if (n.model) {
      rows.push(['モデル', modelLabel(n.model) +
        (n.modelSource ? '  ← ' + (FIELD_SOURCE_LABEL[n.modelSource] || n.modelSource) : '')]);
    }
    rows.push(['開始', (n.startedAt ? stamp(n.startedAt) : '不明') +
      (n.startedAtSource ? '  ← ' + (FIELD_SOURCE_LABEL[n.startedAtSource] || n.startedAtSource) : '')]);
    // A live root has no end time at all - saying 不明 would suggest we looked
    // for one and failed, when in fact there is nothing to find yet.
    rows.push(['終了', (n.endedAt ? stamp(n.endedAt) : (isSession && n.live ? '稼働中' : '不明')) +
      (n.endedAtSource ? '  ← ' + (FIELD_SOURCE_LABEL[n.endedAtSource] || n.endedAtSource) : '')]);
    if (typeof n.durationMs === 'number') rows.push(['所要', span(n.durationMs)]);
    var t = n.tokens || {};
    rows.push(['トークン', '合計 ' + compact(t.total) + ' / in ' + compact(t.input) +
      ' / out ' + compact(t.output) + ' / cache作 ' + compact(t.cacheCreate) +
      ' / cache読 ' + compact(t.cacheRead) + ' / msg ' + compact(t.messages)]);
    rows.push(['ツール', String(n.toolCount) +
      (n.toolCountSource ? '（' + (FIELD_SOURCE_LABEL[n.toolCountSource] || n.toolCountSource) + '）' : '')]);
    if (n.currentTool && n.currentTool.name) rows.push(['実行中', n.currentTool.name]);
    if (n.lastToolAt) rows.push(['最終ツール', stamp(n.lastToolAt)]);
    if (n.worktreePath) rows.push(['worktree', n.worktreePath]);
    rows.push(['transcript', n.transcriptPath || '(なし)']);

    var host = $('detail-rows');
    while (host.firstChild) host.removeChild(host.firstChild);
    for (var i = 0; i < rows.length; i++) {
      var r = el('div', 'drow');
      r.appendChild(el('span', 'drow__k', rows[i][0]));
      r.appendChild(el('span', 'drow__v', rows[i][1]));
      host.appendChild(r);
    }

    setText($('detail-prompt'), n.promptExcerpt || '(取得できていない)');
    loadDetailTools(n);
  }

  function loadDetailTools(n) {
    if (!tree.selected) return;
    var agent = n.kind === 'session' ? 'main' : n.id;
    var key = tree.selected + ':' + agent;
    var host = $('detail-tools');
    if (tree.detailToolsFor === key) return;
    tree.detailToolsFor = key;
    while (host.firstChild) host.removeChild(host.firstChild);
    host.appendChild(el('p', 'tools__none', '読み込み中…'));
    apiJson('/api/tools/' + encodeURIComponent(tree.selected) +
        '?agent=' + encodeURIComponent(agent) + '&limit=40')
      .then(function (d) {
        if (tree.detailToolsFor !== key) return;
        renderTools(d);
      })
      .catch(function () {
        if (tree.detailToolsFor !== key) return;
        while (host.firstChild) host.removeChild(host.firstChild);
        host.appendChild(el('p', 'tools__none', 'ツールログを取得できなかった'));
      });
  }

  function renderTools(d) {
    var host = $('detail-tools');
    while (host.firstChild) host.removeChild(host.firstChild);
    var calls = (d && d.calls) || [];
    if (!calls.length) {
      host.appendChild(el('p', 'tools__none', 'ツール呼び出しは記録されていない'));
      return;
    }
    for (var i = calls.length - 1; i >= 0; i--) {
      var c = calls[i];
      var row = el('div', 'trow');
      row.dataset.st = c.status;
      row.appendChild(el('span', 'trow__at', c.startedAt ? stamp(c.startedAt) : '-'));
      row.appendChild(el('span', 'trow__n', c.name || '?'));
      row.appendChild(el('span', 'trow__ms',
        typeof c.durationMs === 'number' ? span(c.durationMs) : c.status));
      row.appendChild(el('span', 'trow__in', c.summary || ''));
      host.appendChild(row);
    }
    if (d.total > calls.length) {
      host.appendChild(el('p', 'tools__none',
        '全 ' + d.total + ' 件のうち最新 ' + calls.length + ' 件'));
    }
  }

  /* --------------------------- refresh scheduling -------------------------- */

  /**
   * A snapshot arrived. The session list is cheap to redo; the tree is not, so
   * it is only re-fetched for a session that is actually live, and at most
   * once every TREE_DEBOUNCE_MS.
   */
  function onSnapshotForTree() {
    if (currentView !== 'tree') return;
    if (!tree.listTimer) {
      tree.listTimer = setTimeout(function () {
        tree.listTimer = null;
        // The tab can be left during the 2s wait; a timer armed while it was
        // visible must not fetch after the user moved on.
        if (currentView !== 'tree') return;
        loadSessions();
      }, TREE_DEBOUNCE_MS);
    }
    if (!tree.selected || !isSelectedLive()) return;
    if (tree.treeTimer) return;
    tree.treeTimer = setTimeout(function () {
      tree.treeTimer = null;
      if (currentView !== 'tree') return;
      loadTree(false);
    }, TREE_DEBOUNCE_MS);
  }

  function isSelectedLive() {
    if (tree.data && tree.data.root && tree.data.root.live) return true;
    for (var i = 0; i < tree.sessions.length; i++) {
      if (tree.sessions[i].sessionId === tree.selected) return !!tree.sessions[i].live;
    }
    return false;
  }

  /** Entering the tab: fetch the list, then the remembered session if it is still there. */
  function enterTree() {
    return loadSessions().then(function () {
      if (tree.selected) { renderSessionList(); return; }
      var stored = getStore(K_TREE_SESSION);
      var exists = false;
      for (var i = 0; i < tree.sessions.length; i++) {
        if (tree.sessions[i].sessionId === stored) exists = true;
      }
      if (stored && exists) selectSession(stored);
    });
  }

  function bootTree() {
    var storedDays = Number(getStore(K_TREE_DAYS));
    if (storedDays === 7 || storedDays === 30 || storedDays === 90) tree.days = storedDays;
    var sel = $('tree-days');
    sel.value = String(tree.days);
    sel.addEventListener('change', function () {
      var v = Number(sel.value);
      tree.days = isFinite(v) && v > 0 ? v : 30;
      setStore(K_TREE_DAYS, String(tree.days));
      loadSessions();
    });
    $('tree-reload').addEventListener('click', function () {
      loadSessions();
      if (tree.selected) loadTree(true);
    });
  }

  /* --------------------------------- usage -------------------------------- */

  /*
   * The M4 Usage view.
   *
   * Unlike the tree, one rebuild reads EVERY transcript, so the SSE-driven
   * refresh is debounced ten times harder (10s vs 2s) and, like the tree, only
   * runs while this tab is the one on screen - and re-checks that when the
   * timer fires, not only when it is armed.
   *
   * Model names arrive from the server already folded into series
   * (Opus/Sonnet/Haiku/Fable/other), so there is no second copy of MODEL_LABEL
   * here; the colours are the only per-series thing the client owns.
   */

  var K_USAGE_DAYS = 'cm.usageDays';
  var USAGE_DEBOUNCE_MS = 10000;
  /** Re-entering the tab refetches only when the numbers are older than this. */
  var USAGE_STALE_MS = 30000;
  var USAGE_DAY_CHOICES = [7, 14, 30];
  var USAGE_SERIES = ['Opus', 'Sonnet', 'Haiku', 'Fable', 'other'];
  var USAGE_SERIES_LABEL = { other: 'その他' };
  var USAGE_METRICS = [
    { key: 'input_tokens', label: 'INPUT' },
    { key: 'output_tokens', label: 'OUTPUT' },
    { key: 'cache_creation_input_tokens', label: 'CACHE_CR' },
    { key: 'cache_read_input_tokens', label: 'CACHE_RD' }
  ];
  var USAGE_DELTA_LABEL = {
    input_tokens: 'Δin',
    output_tokens: 'Δout',
    cache_creation_input_tokens: 'Δcc',
    cache_read_input_tokens: 'Δcr'
  };

  var usage = {
    days: 30,
    data: null,
    dataDays: 0,
    loadedAt: 0,
    loading: false,
    cc: null,
    ccLoading: false,
    timer: null,
    /** the tables are rebuilt only when this changes */
    signature: ''
  };

  function clearNode(host) {
    while (host.firstChild) host.removeChild(host.firstChild);
  }

  /** BEM modifier for a series name; anything unknown lands on 'other'. */
  function seriesMod(series) {
    return USAGE_SERIES.indexOf(series) === -1 ? 'other' : String(series).toLowerCase();
  }

  function seriesLabel(series) {
    return USAGE_SERIES_LABEL[series] || series;
  }

  /** Compact text, the exact value on hover, and 0 left blank (M3 rule). */
  function numCell(n) {
    var v = typeof n === 'number' && isFinite(n) ? n : 0;
    var cell = el('td', v ? 'utab--n' : 'utab--zero', v ? compact(v) : '');
    if (v) cell.setAttribute('title', String(v));
    return cell;
  }

  /** A ccusage delta: exact, signed, and 0 is the good case so it is shown. */
  function deltaCell(n) {
    var v = typeof n === 'number' && isFinite(n) ? n : 0;
    return el('td', v === 0 ? 'utab--same' : 'utab--diff', v === 0 ? '0' : (v > 0 ? '+' : '') + v);
  }

  function headRow(host, cols) {
    clearNode(host);
    var tr = document.createElement('tr');
    for (var i = 0; i < cols.length; i++) {
      var th = el('th', cols[i].cls || '', cols[i].label);
      th.setAttribute('scope', 'col');
      if (cols[i].title) th.setAttribute('title', cols[i].title);
      tr.appendChild(th);
    }
    host.appendChild(tr);
  }

  function metricCols() {
    var cols = [];
    for (var i = 0; i < USAGE_METRICS.length; i++) cols.push({ label: USAGE_METRICS[i].label });
    return cols;
  }

  /* ------------------------------- fetching ------------------------------- */

  function loadUsage() {
    if (usage.loading) return Promise.resolve();
    usage.loading = true;
    setText($('usage-state'), '読み込んでいる');
    var want = usage.days;
    return apiJson('/api/usage?days=' + want)
      .then(function (d) {
        usage.loading = false;
        if (!d || !d.ok) throw new Error('not ok');
        usage.data = d;
        usage.dataDays = want;
        usage.loadedAt = Date.now();
        // A different window makes the comparison on screen answer a different
        // question; drop it rather than show it against the new dates.
        if (usage.cc && usage.cc.since !== d.since) usage.cc = null;
        renderUsage();
      })
      .catch(function () {
        usage.loading = false;
        setText($('usage-state'), '使用量を取得できなかった');
      });
  }

  function loadCcusage() {
    if (usage.ccLoading) return;
    usage.ccLoading = true;
    setText($('usage-ccfoot'), 'ccusage を実行している');
    apiJson('/api/usage/ccusage?days=' + usage.days)
      .then(function (d) {
        usage.ccLoading = false;
        if (!d || !d.ok) {
          usage.cc = null;
          if (d && d.notInstalled) {
            // The server never downloads ccusage (npx --no), so "not there" is
            // an instruction, not an error. The version comes from the server:
            // it is pinned in src/ccusage.js and must not be copied here.
            var spec = 'ccusage' + (d.ccusageVersion ? '@' + d.ccusageVersion : '');
            setText($('usage-ccfoot'), 'ccusage が見つからない。npm i -g ' + spec + ' を実行してから再度押す');
            return;
          }
          setText($('usage-ccfoot'), 'ccusage と突合できなかった（' + ((d && d.error) || 'ccusage unavailable') + '）');
          return;
        }
        usage.cc = d;
        usage.signature = '';
        renderUsage();
      })
      .catch(function () {
        usage.ccLoading = false;
        setText($('usage-ccfoot'), 'ccusage と突合できなかった');
      });
  }

  /* ------------------------------- rendering ------------------------------ */

  function usageSignature(d) {
    var parts = [d.since, d.until, String(d.totals ? d.totals.totalTokens : 0)];
    var i;
    for (i = 0; i < d.days.length; i++) {
      var r = d.days[i];
      parts.push(r.date + ':' + r.totals.totalTokens + ':' + r.msgs + ':' + r.source + (r.partial ? ':p' : ''));
    }
    for (i = 0; i < d.sessions.length; i++) {
      parts.push(d.sessions[i].sessionId + ':' + d.sessions[i].totalTokens);
    }
    parts.push(usage.cc && usage.cc.ok ? 'cc:' + usage.cc.fetchedAt : 'cc:-');
    return parts.join('|');
  }

  function renderUsage() {
    var d = usage.data;
    if (!d) return;
    setText($('usage-state'), d.since + ' 〜 ' + d.until + ' · 更新 ' + clockSec(d.generatedAt));
    var st = d.stats || {};
    var cache = st.cache || {};
    setText($('usage-foot'),
      'ファイル ' + (st.scannedFiles || 0) + '/' + (st.foundFiles || 0) +
      ' · 行 ' + (st.scannedLines || 0) +
      ' · メッセージ ' + (st.uniqueMessages || 0) +
      ' · パース失敗 ' + (st.parseFailures || 0) +
      ' · cache hit ' + (cache.hits || 0) + ' / miss ' + (cache.misses || 0) +
      ' · ' + (st.buildMs || 0) + ' ms');
    renderCcFoot();

    var sig = usageSignature(d);
    if (sig === usage.signature) return;
    usage.signature = sig;

    renderUsageTiles(d);
    renderUsageLegend();
    renderUsageDaily(d);
    renderUsageModels(d);
    renderUsageSessions(d);
  }

  function renderCcFoot() {
    var cc = usage.cc;
    if (!cc || !cc.ok) return;
    var t = cc.totals || {};
    var cost = t.totalCost || 0;
    var delta = t.delta ? t.delta.totalTokens : 0;
    setText($('usage-ccfoot'),
      'ccusage 集計時刻 ' + clockSec(cc.fetchedAt) + (cc.cached ? '（cached）' : '') +
      ' · ccusage コスト合計 $' + cost.toFixed(2) +
      ' · 合計差分 ' + delta + ' トークン（当日は進行中なので差が出るのが正常）');
  }

  function renderUsageTiles(d) {
    var host = $('usage-tiles');
    clearNode(host);
    var t = d.totals || {};
    var tiles = [
      ['メッセージ', t.count, ''],
      ['INPUT', t.input_tokens, ''],
      ['OUTPUT', t.output_tokens, ''],
      ['CACHE 作成', t.cache_creation_input_tokens, ''],
      ['CACHE 読取', t.cache_read_input_tokens, ''],
      ['合計', t.totalTokens, 'utile--total']
    ];
    for (var i = 0; i < tiles.length; i++) {
      var box = el('div', tiles[i][2] ? 'utile ' + tiles[i][2] : 'utile');
      box.appendChild(el('p', 'utile__k', tiles[i][0]));
      var v = el('p', 'utile__v', compact(tiles[i][1]));
      v.setAttribute('title', String(tiles[i][1] || 0));
      box.appendChild(v);
      host.appendChild(box);
    }
  }

  function renderUsageLegend() {
    var host = $('usage-legend');
    clearNode(host);
    for (var i = 0; i < USAGE_SERIES.length; i++) {
      var s = USAGE_SERIES[i];
      var item = el('span', 'uleg uleg--' + seriesMod(s));
      item.appendChild(el('span', 'uleg__chip'));
      item.appendChild(el('span', 'uleg__n', seriesLabel(s)));
      host.appendChild(item);
    }
  }

  /** The stacked bar: outer width scales to the biggest day, segments to the day. */
  function usageBar(row, max) {
    var track = el('div', 'gauge__track usage__bar');
    var fill = el('div', 'usage__fill');
    var total = row.totals.totalTokens || 0;
    fill.style.setProperty('width', (max > 0 ? (total / max) * 100 : 0) + '%');
    for (var i = 0; i < USAGE_SERIES.length; i++) {
      var s = USAGE_SERIES[i];
      var t = row.byModel ? row.byModel[s] : null;
      if (!t || !t.totalTokens) continue;
      var seg = el('div', 'useg useg--' + seriesMod(s));
      seg.style.setProperty('width', (total > 0 ? (t.totalTokens / total) * 100 : 0) + '%');
      seg.setAttribute('title', seriesLabel(s) + ' ' + compact(t.totalTokens));
      fill.appendChild(seg);
    }
    track.appendChild(fill);
    return track;
  }

  function renderUsageDaily(d) {
    var rows = d.days || [];
    var cc = usage.cc && usage.cc.ok && usage.cc.since === d.since ? usage.cc : null;
    var ccBy = new Map();
    var i;
    if (cc) {
      for (i = 0; i < cc.rows.length; i++) ccBy.set(cc.rows[i].date, cc.rows[i]);
    }

    var cols = [{ label: '日付', cls: 'utab--l' }, { label: 'MSGS' }]
      .concat(metricCols(), [{ label: '合計' }, { label: 'モデル内訳', cls: 'utab--bar' }]);
    if (cc) {
      for (i = 0; i < USAGE_METRICS.length; i++) {
        cols.push({ label: USAGE_DELTA_LABEL[USAGE_METRICS[i].key], title: '本ツール - ccusage' });
      }
      cols.push({ label: 'ccusage $' });
    }
    headRow($('usage-daily-head'), cols);

    var body = $('usage-daily-body');
    clearNode(body);
    $('usage-daily-empty').hidden = rows.length > 0;

    var max = 0;
    for (i = 0; i < rows.length; i++) max = Math.max(max, rows[i].totals.totalTokens || 0);

    for (i = 0; i < rows.length; i++) {
      var row = rows[i];
      var tr = document.createElement('tr');

      var dcell = el('td', 'utab--l');
      var label = el('span', row.today ? 'utab__today' : '', row.date + (row.today ? ' *' : ''));
      if (row.today) label.setAttribute('title', '当日は進行中。集計はまだ確定していない');
      dcell.appendChild(label);
      if (row.source === 'store') {
        var sb = el('span', 'utab__badge', '保存値');
        sb.setAttribute('title', 'transcript が残っていないので usage/daily.json の保存値を表示している');
        dcell.appendChild(sb);
      }
      if (row.partial) {
        var pb = el('span', 'utab__badge', '一部欠損');
        pb.setAttribute('title', '今回のスキャンが保存値より小さい。transcript が削除されている');
        dcell.appendChild(pb);
      }
      tr.appendChild(dcell);

      tr.appendChild(numCell(row.msgs));
      for (var m = 0; m < USAGE_METRICS.length; m++) {
        tr.appendChild(numCell(row.totals[USAGE_METRICS[m].key]));
      }
      tr.appendChild(numCell(row.totals.totalTokens));

      var barCell = el('td', 'utab--bar');
      barCell.appendChild(usageBar(row, max));
      tr.appendChild(barCell);

      if (cc) {
        var diff = ccBy.get(row.date);
        for (var k = 0; k < USAGE_METRICS.length; k++) {
          tr.appendChild(diff ? deltaCell(diff.delta[USAGE_METRICS[k].key]) : el('td', 'utab--zero', ''));
        }
        tr.appendChild(el('td', 'utab--n',
          diff && typeof diff.totalCost === 'number' ? '$' + diff.totalCost.toFixed(2) : ''));
      }
      body.appendChild(tr);
    }
  }

  function renderUsageModels(d) {
    headRow($('usage-models-head'),
      [{ label: 'モデル', cls: 'utab--l' }, { label: 'MSGS' }]
        .concat(metricCols(), [{ label: '合計' }, { label: '割合' }]));
    var body = $('usage-models-body');
    clearNode(body);
    var total = d.totals ? d.totals.totalTokens : 0;
    for (var i = 0; i < USAGE_SERIES.length; i++) {
      var s = USAGE_SERIES[i];
      var t = d.byModel ? d.byModel[s] : null;
      if (!t) continue;
      var tr = document.createElement('tr');
      var name = el('td', 'utab--l');
      var chip = el('span', 'uleg uleg--' + seriesMod(s));
      chip.appendChild(el('span', 'uleg__chip'));
      chip.appendChild(el('span', 'uleg__n', seriesLabel(s)));
      if (t.ids && t.ids.length) chip.setAttribute('title', t.ids.join(', '));
      name.appendChild(chip);
      tr.appendChild(name);
      tr.appendChild(numCell(t.count));
      for (var m = 0; m < USAGE_METRICS.length; m++) tr.appendChild(numCell(t[USAGE_METRICS[m].key]));
      tr.appendChild(numCell(t.totalTokens));
      tr.appendChild(el('td', 'utab--n',
        total > 0 ? Math.round((t.totalTokens / total) * 100) + '%' : ''));
      body.appendChild(tr);
    }
  }

  function renderUsageSessions(d) {
    headRow($('usage-sessions-head'), [
      { label: 'セッション', cls: 'utab--l' },
      { label: 'cwd', cls: 'utab--l' },
      { label: '開始' },
      { label: 'モデル' },
      { label: 'MSGS' },
      { label: '合計' },
      { label: '推定 (Claude Code)', title: 'Claude Code 自身が status line に出しているセッション全体の推定コスト。期間で切っていない' },
      { label: '' }
    ]);
    var body = $('usage-sessions-body');
    clearNode(body);
    var list = d.sessions || [];
    for (var i = 0; i < list.length; i++) {
      var s = list[i];
      var tr = document.createElement('tr');
      var idCell = el('td', 'utab--l', s.sessionId.slice(0, 8));
      idCell.setAttribute('title', s.sessionId);
      tr.appendChild(idCell);
      var cwdCell = el('td', 'utab--l', s.projectDirName || '');
      if (s.cwd) cwdCell.setAttribute('title', s.cwd);
      tr.appendChild(cwdCell);
      tr.appendChild(el('td', 'utab--n', s.startedAt ? stamp(s.startedAt) : ''));
      tr.appendChild(el('td', 'utab--n', s.model ? seriesLabel(s.model) : ''));
      tr.appendChild(numCell(s.msgs));
      tr.appendChild(numCell(s.totalTokens));
      var costCell = el('td', 'utab--n',
        typeof s.costUsd === 'number' ? '$' + s.costUsd.toFixed(2) : '');
      if (typeof s.costUsd === 'number') costCell.setAttribute('title', '推定 (Claude Code)');
      tr.appendChild(costCell);
      var btnCell = el('td', 'utab--l');
      var btn = el('button', 'utab__btn', 'Tree');
      btn.type = 'button';
      bindTreeJump(btn, s.sessionId);
      btnCell.appendChild(btn);
      tr.appendChild(btnCell);
      body.appendChild(tr);
    }
  }

  /** Same jump the Live card's Tree button makes. */
  function bindTreeJump(btn, sessionId) {
    btn.addEventListener('click', function () { showTreeFor(sessionId); });
  }

  /* --------------------------- refresh scheduling -------------------------- */

  /**
   * A snapshot arrived. A usage rebuild walks every transcript, so it is
   * debounced 10s and only while this tab is visible - re-checked when the
   * timer fires, not only when it was armed (M3 review 8.3).
   */
  function onSnapshotForUsage() {
    if (currentView !== 'usage') return;
    if (usage.timer) return;
    usage.timer = setTimeout(function () {
      usage.timer = null;
      if (currentView !== 'usage') return;
      loadUsage();
    }, USAGE_DEBOUNCE_MS);
  }

  /** Entering the tab: fetch only when what we hold is stale. */
  function enterUsage() {
    var stale = !usage.data
      || usage.dataDays !== usage.days
      || (Date.now() - usage.loadedAt) > USAGE_STALE_MS;
    if (stale) return loadUsage();
    renderUsage();
    return Promise.resolve();
  }

  function bootUsage() {
    var stored = Number(getStore(K_USAGE_DAYS));
    if (USAGE_DAY_CHOICES.indexOf(stored) !== -1) usage.days = stored;
    var sel = $('usage-days');
    sel.value = String(usage.days);
    sel.addEventListener('change', function () {
      var v = Number(sel.value);
      usage.days = USAGE_DAY_CHOICES.indexOf(v) !== -1 ? v : 30;
      setStore(K_USAGE_DAYS, String(usage.days));
      usage.cc = null;
      usage.signature = '';
      setText($('usage-ccfoot'), '');
      loadUsage();
    });
    $('usage-reload').addEventListener('click', function () {
      usage.signature = '';
      loadUsage();
    });
    $('usage-cc').addEventListener('click', loadCcusage);
  }

  /* --------------------------------- tabs --------------------------------- */

  function selectView(name) {
    var views = ['live', 'tree', 'usage'];
    if (views.indexOf(name) === -1) name = 'live';
    currentView = name;
    for (var i = 0; i < views.length; i++) {
      var v = views[i];
      $('view-' + v).hidden = v !== name;
      var tab = $('tab-' + v);
      tab.classList.toggle('tab--on', v === name);
      if (v === name) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    setStore(K_TAB, name);
    if (name === 'tree') enterTree();
    if (name === 'usage') enterUsage();
  }

  /**
   * The "Tree" button on a Live card: switch tab and open that session.
   * selectView('tree') already runs enterTree(), which loads the list; asking
   * for it again here would fire two identical requests on every click.
   * selectSession() sets the selection synchronously, so enterTree()'s
   * continuation sees it and only re-paints the list.
   */
  function showTreeFor(sessionId) {
    selectView('tree');
    selectSession(sessionId);
  }

  /* --------------------------------- boot --------------------------------- */

  function boot() {
    // Before any listener can flip a switch: the stored settings ARE the
    // initial state of every control in the panel.
    loadNotifySettings();

    $('notify-permission').addEventListener('click', function () {
      if (typeof window.Notification === 'undefined') return;
      // requestPermission MUST be called from a user gesture.
      var p = window.Notification.requestPermission();
      if (p && typeof p.then === 'function') {
        p.then(function () {
          notifySettings.enabled = window.Notification.permission === 'granted';
          saveNotifySettings();
          refreshNotifyButtons();
        });
      } else {
        refreshNotifyButtons();
      }
    });

    $('notify-toggle').addEventListener('click', function () {
      notifySettings.enabled = !notifySettings.enabled;
      saveNotifySettings();
      if (notifySettings.enabled && typeof window.Notification !== 'undefined'
          && window.Notification.permission === 'default') {
        var p = window.Notification.requestPermission();
        if (p && typeof p.then === 'function') p.then(refreshNotifyButtons);
      }
      refreshNotifyButtons();
    });

    bindNotifyPanel();

    var tabs = ['live', 'tree', 'usage'];
    tabs.forEach(function (name) {
      $('tab-' + name).addEventListener('click', function () { selectView(name); });
    });

    bootTree();
    bootUsage();
    // Restore the tab last: selectView('tree') starts a fetch, so everything it
    // touches has to be wired up by now.
    selectView(getStore(K_TAB) || 'live');

    refreshNotifyButtons();
    setInterval(tick, 1000);
    connect();

    // A snapshot also arrives on the SSE connect, but fetching once makes the
    // first paint immediate even if the stream is slow to establish.
    fetch('/api/state', { credentials: 'same-origin' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) { if (d && !firstSnapshotSeen) render(d); })
      .catch(function () { /* the stream will deliver it */ });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible' && es && es.readyState === 2) connect();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
