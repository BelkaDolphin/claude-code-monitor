import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HooksIngest, normalizeEvent, foldState, listEventDates, TRACKED_EVENTS } from '../src/hooks-ingest.js';
import { readSidecars, latestRateLimits, extractRateLimits } from '../src/statusline-sidecar.js';
import { renderStatusLine } from '../hooks/statusline.js';
import { makeTmpDir, writeJsonl } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(ROOT, 'hooks', 'monitor-hook.js');
const STATUSLINE = path.join(ROOT, 'hooks', 'statusline.js');

/** Run a hook script with the given stdin, isolated to `dir`. */
function runScript(script, stdin, dir) {
  return execFileSync(process.execPath, [script], {
    input: stdin,
    env: { ...process.env, CLAUDE_MONITOR_DIR: dir },
    encoding: 'utf8',
  });
}

describe('monitor-hook.js', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('hookw'); });
  after(() => tmp.cleanup());

  test('appends one line per event and exits 0 silently', () => {
    const out = runScript(HOOK, JSON.stringify({
      session_id: 'S1', hook_event_name: 'SessionStart', cwd: 'D:\\develop\\Claude監視', permission_mode: 'default',
    }), tmp.dir);
    assert.equal(out, '', 'the hook prints nothing (stdout can be injected into the conversation)');

    runScript(HOOK, JSON.stringify({
      session_id: 'S1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'toolu_1',
    }), tmp.dir);

    const dates = listEventDates(path.join(tmp.dir, 'events'));
    assert.equal(dates.length, 1);
    const lines = fs.readFileSync(path.join(tmp.dir, 'events', `${dates[0]}.jsonl`), 'utf8').trim().split('\n');
    assert.equal(lines.length, 2);
    const first = JSON.parse(lines[0]);
    assert.equal(first.hookEventName, 'SessionStart');
    assert.equal(first.session_id, 'S1');
    assert.equal(first.cwd, 'D:\\develop\\Claude監視');
    assert.ok(first.receivedAt, 'receivedAt is stamped');
  });

  test('invalid stdin is recorded as a parse error, never a crash', () => {
    const dir2 = makeTmpDir('hookw2');
    try {
      runScript(HOOK, '{not json', dir2.dir); // must not throw
      const dates = listEventDates(path.join(dir2.dir, 'events'));
      const line = JSON.parse(fs.readFileSync(path.join(dir2.dir, 'events', `${dates[0]}.jsonl`), 'utf8').trim());
      assert.equal(line.parseError, true);
      assert.equal(line.hookEventName, null);
    } finally {
      dir2.cleanup();
    }
  });
});

describe('statusline.js', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('sl'); });
  after(() => tmp.cleanup());

  test('writes the sidecar and prints exactly one line', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    const payload = {
      session_id: 'SLSESS',
      model: { id: 'claude-opus-5', display_name: 'Opus' },
      context_window: { used_percentage: 8 },
      cost: { total_cost_usd: 0.01234 },
      rate_limits: { five_hour: { used_percentage: 23.5, resets_at: future } },
    };
    const out = runScript(STATUSLINE, JSON.stringify(payload), tmp.dir);
    assert.equal(out.split('\n').filter(Boolean).length, 1, 'exactly one line');
    assert.match(out, /^Opus \| ctx 8% \| 5h 23% \(resets \d\d:\d\d\)/);

    const file = path.join(tmp.dir, 'statusline', 'SLSESS.json');
    assert.ok(fs.existsSync(file));
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(saved.session_id, 'SLSESS');
    assert.equal(saved.rate_limits.five_hour.used_percentage, 23.5);
    assert.ok(saved.capturedAt);
  });

  test('no rate_limits -> that part is simply omitted', () => {
    const out = runScript(STATUSLINE, JSON.stringify({
      session_id: 'NORL', model: { display_name: 'Sonnet' }, context_window: { used_percentage: 42 },
    }), tmp.dir);
    assert.equal(out.trim(), 'Sonnet | ctx 42%');
  });
});

describe('a relative CLAUDE_MONITOR_DIR resolves against HOME, not cwd', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('relmon'); });
  after(() => tmp.cleanup());

  /**
   * Run a script with its own HOME and its own cwd, the way the two sides of
   * the system really differ: the server is started from wherever the user (or
   * the logon task) ran it, while Claude Code starts the hook with the PROJECT
   * as cwd. A cwd-relative value therefore split the two apart and the
   * dashboard stayed empty forever with nothing to show for it.
   */
  function runIn(script, stdin, { home, cwd, monitor }) {
    return execFileSync(process.execPath, [script], {
      input: stdin,
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_MONITOR_DIR: monitor },
      encoding: 'utf8',
    });
  }

  test('src/paths.js resolves it under the home directory', () => {
    const home = path.join(tmp.dir, 'home1');
    const cwd = path.join(tmp.dir, 'someproject');
    for (const d of [home, cwd]) fs.mkdirSync(d, { recursive: true });
    const probe = path.join(tmp.dir, 'probe.mjs');
    fs.writeFileSync(probe,
      "import os from 'node:os';\n"
      + 'import { monitorDir } from ' + JSON.stringify(pathToFileURL(path.join(ROOT, 'src', 'paths.js')).href) + ';\n'
      + 'process.stdout.write(JSON.stringify({ dir: monitorDir(), home: os.homedir(), cwd: process.cwd() }));\n',
      'utf8');
    const out = JSON.parse(runIn(probe, '', { home, cwd, monitor: 'rel-monitor' }));
    assert.equal(out.dir, path.join(out.home, 'rel-monitor'));
    assert.equal(out.dir.startsWith(path.resolve(out.cwd) + path.sep), false,
      'a relative value must not follow the process that happens to be running');
  });

  test('the hook writes where the server will look', () => {
    const home = path.join(tmp.dir, 'home2');
    const cwd = path.join(tmp.dir, 'project2');
    for (const d of [home, cwd]) fs.mkdirSync(d, { recursive: true });
    runIn(HOOK, JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'REL1' }),
      { home, cwd, monitor: 'rel-monitor' });
    const events = path.join(home, 'rel-monitor', 'events');
    const dates = listEventDates(events);
    assert.equal(dates.length, 1, 'the event landed under HOME/rel-monitor');
    const line = JSON.parse(fs.readFileSync(path.join(events, `${dates[0]}.jsonl`), 'utf8').trim());
    assert.equal(line.session_id, 'REL1');
    assert.equal(fs.existsSync(path.join(cwd, 'rel-monitor')), false, 'nothing was written next to cwd');
  });

  test('the statusline script agrees with both of them', () => {
    const home = path.join(tmp.dir, 'home3');
    const cwd = path.join(tmp.dir, 'project3');
    for (const d of [home, cwd]) fs.mkdirSync(d, { recursive: true });
    runIn(STATUSLINE, JSON.stringify({ session_id: 'REL2', model: { display_name: 'Opus' } }),
      { home, cwd, monitor: 'rel-monitor' });
    assert.equal(fs.existsSync(path.join(home, 'rel-monitor', 'statusline', 'REL2.json')), true);
    assert.equal(fs.existsSync(path.join(cwd, 'rel-monitor')), false);
  });

  test('an absolute value is still taken literally', () => {
    const home = path.join(tmp.dir, 'home4');
    const abs = path.join(tmp.dir, 'absolute-monitor');
    for (const d of [home, abs]) fs.mkdirSync(d, { recursive: true });
    runIn(HOOK, JSON.stringify({ hook_event_name: 'Stop', session_id: 'REL3' }),
      { home, cwd: tmp.dir, monitor: abs });
    assert.equal(listEventDates(path.join(abs, 'events')).length, 1);
    assert.equal(fs.existsSync(path.join(home, 'absolute-monitor')), false);
  });
});

describe('renderStatusLine', () => {
  const now = 1_800_000_000;

  test('matches the documented example format', () => {
    const line = renderStatusLine({
      model: { display_name: 'Opus' },
      context_window: { used_percentage: 8 },
      rate_limits: {
        five_hour: { used_percentage: 23.5, resets_at: now + 3600 },
        seven_day: { used_percentage: 41.2, resets_at: now + 86400 },
      },
    }, now);
    assert.match(line, /^Opus \| ctx 8% \| 5h 23% \(resets \d\d:\d\d\) \| 7d 41%$/);
  });

  test('percentages are truncated, not rounded (23.5 -> 23%)', () => {
    const line = renderStatusLine({ rate_limits: { five_hour: { used_percentage: 23.9, resets_at: now + 10 } } }, now);
    assert.match(line, /5h 23%/);
  });

  test('a window whose resets_at has passed is dropped', () => {
    const line = renderStatusLine({
      model: { display_name: 'Opus' },
      rate_limits: { five_hour: { used_percentage: 99, resets_at: now - 1 } },
    }, now);
    assert.equal(line, 'Opus');
  });

  test('spend_limit is shown when present', () => {
    const line = renderStatusLine({ rate_limits: { spend_limit: { used_percentage: 62.8, resets_at: now + 100 } } }, now);
    assert.equal(line, 'spend 62%');
  });

  test('empty / null payloads produce an empty line without throwing', () => {
    assert.equal(renderStatusLine({}, now), '');
    assert.equal(renderStatusLine(null, now), '');
    assert.equal(renderStatusLine({ context_window: { used_percentage: null } }, now), '');
  });
});

describe('statusline sidecar reader', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('slread'); });
  after(() => tmp.cleanup());

  test('extractRateLimits drops stale windows and non-numeric values', () => {
    const now = 1000;
    const out = extractRateLimits({
      five_hour: { used_percentage: 10, resets_at: 2000 },
      seven_day: { used_percentage: 20, resets_at: 500 },   // already reset
      spend_limit: { used_percentage: 'oops', resets_at: 2000 },
    }, now);
    assert.deepEqual(Object.keys(out), ['five_hour']);
    assert.equal(out.five_hour.used_percentage, 10);
    assert.equal(out.five_hour.resetsAtIso, new Date(2000 * 1000).toISOString());
  });

  test('missing directory is reported, not thrown', () => {
    const r = latestRateLimits({ dir: path.join(tmp.dir, 'nope') });
    assert.equal(r.available, false);
    assert.equal(r.present, false);
    assert.match(r.unavailableReason, /statusLine hook not installed/);
  });

  test('reads captured payloads and merges the freshest windows', () => {
    const dir = path.join(tmp.dir, 'statusline');
    fs.mkdirSync(dir, { recursive: true });
    const future = 9_000_000_000;
    fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({
      session_id: 'a', capturedAt: '2026-09-01T00:00:00.000Z',
      model: { display_name: 'Opus' }, context_window: { used_percentage: 5 },
      rate_limits: { five_hour: { used_percentage: 11, resets_at: future } },
    }), 'utf8');
    const { entries } = readSidecars({ dir });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].model, 'Opus');
    assert.equal(entries[0].contextUsedPct, 5);

    const r = latestRateLimits({ dir });
    assert.equal(r.available, true);
    assert.equal(r.rateLimits.five_hour.used_percentage, 11);
    assert.equal(r.sourceSessionId, 'a');
  });

  test('a session with no rate_limits reports why', () => {
    const dir = path.join(tmp.dir, 'sl2');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ session_id: 'b' }), 'utf8');
    const r = latestRateLimits({ dir });
    assert.equal(r.available, false);
    assert.match(r.unavailableReason, /API-key auth/);
  });
});

describe('hooks ingest', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('ingest'); });
  after(() => tmp.cleanup());

  test('normalizeEvent lifts the documented fields', () => {
    const ev = normalizeEvent({
      receivedAt: '2026-09-02T00:00:00.000Z',
      hookEventName: 'SubagentStop',
      session_id: 'S', agent_id: 'aX', agent_type: 'Explore',
      agent_transcript_path: 'C:/t.jsonl', last_assistant_message: 'done',
      permission_mode: 'acceptEdits',
    });
    assert.equal(ev.event, 'SubagentStop');
    assert.equal(ev.known, true);
    assert.equal(ev.agentId, 'aX');
    assert.equal(ev.agentTranscriptPath, 'C:/t.jsonl');
    assert.equal(ev.permissionMode, 'acceptEdits');
    assert.ok(Number.isFinite(ev.receivedMs));
  });

  test('an unrecognized hook event is kept but flagged', () => {
    const ev = normalizeEvent({ hookEventName: 'WorktreeCreate', session_id: 'S' });
    assert.equal(ev.known, false);
    assert.equal(ev.event, 'WorktreeCreate');
  });

  test('every event we install a hook for is recognized', () => {
    for (const e of TRACKED_EVENTS) {
      assert.equal(normalizeEvent({ hookEventName: e }).known, true, e);
    }
  });

  test('reads incrementally and tolerates a corrupt line', () => {
    const dir = path.join(tmp.dir, 'events');
    const file = path.join(dir, '2026-09-02.jsonl');
    writeJsonl(file, [
      { receivedAt: '2026-09-02T00:00:00.000Z', hookEventName: 'SessionStart', session_id: 'S' },
      'garbage{',
      { receivedAt: '2026-09-02T00:00:01.000Z', hookEventName: 'UserPromptSubmit', session_id: 'S' },
    ]);
    const ing = new HooksIngest({ dir });
    const first = ing.readDay('2026-09-02');
    assert.equal(first.length, 2);
    assert.equal(ing.parseFailures, 1);

    assert.equal(ing.readDay('2026-09-02').length, 0, 'no new lines -> nothing returned');

    fs.appendFileSync(file, `${JSON.stringify({ receivedAt: '2026-09-02T00:00:02.000Z', hookEventName: 'Stop', session_id: 'S' })}\n`, 'utf8');
    const second = ing.readDay('2026-09-02');
    assert.equal(second.length, 1);
    assert.equal(second[0].event, 'Stop');
  });

  test('foldState derives live session and agent state', () => {
    const evs = [
      { hookEventName: 'SessionStart', session_id: 'S', receivedAt: '2026-09-02T00:00:00.000Z' },
      { hookEventName: 'UserPromptSubmit', session_id: 'S', receivedAt: '2026-09-02T00:00:01.000Z' },
      { hookEventName: 'PreToolUse', session_id: 'S', tool_name: 'Bash', receivedAt: '2026-09-02T00:00:02.000Z' },
    ].map(normalizeEvent);
    let st = foldState(evs);
    assert.equal(st.sessions.get('S').state, 'tool-running');
    assert.equal(st.sessions.get('S').activeTool, 'Bash');

    evs.push(normalizeEvent({ hookEventName: 'PostToolUse', session_id: 'S', tool_name: 'Bash', receivedAt: '2026-09-02T00:00:03.000Z' }));
    evs.push(normalizeEvent({ hookEventName: 'Stop', session_id: 'S', receivedAt: '2026-09-02T00:00:04.000Z' }));
    st = foldState(evs);
    assert.equal(st.sessions.get('S').state, 'idle');
    assert.equal(st.sessions.get('S').activeTool, null);

    evs.push(normalizeEvent({ hookEventName: 'SessionEnd', session_id: 'S', reason: 'prompt_input_exit', receivedAt: '2026-09-02T00:00:05.000Z' }));
    st = foldState(evs);
    assert.equal(st.sessions.get('S').state, 'ended');
    assert.equal(st.sessions.get('S').endedReason, 'prompt_input_exit');
  });

  test('subagent lifecycle produces the stopped-agent set the tree needs', () => {
    const evs = [
      { hookEventName: 'SubagentStart', session_id: 'S', agent_id: 'aA', agent_type: 'Explore', receivedAt: '2026-09-02T00:00:00.000Z' },
      { hookEventName: 'PreToolUse', session_id: 'S', agent_id: 'aA', tool_name: 'Grep', receivedAt: '2026-09-02T00:00:01.000Z' },
      { hookEventName: 'SubagentStop', session_id: 'S', agent_id: 'aA', agent_transcript_path: 'C:/a.jsonl', receivedAt: '2026-09-02T00:00:02.000Z' },
      { hookEventName: 'SubagentStart', session_id: 'S', agent_id: 'aB', receivedAt: '2026-09-02T00:00:03.000Z' },
    ].map(normalizeEvent);
    const st = foldState(evs);
    assert.deepEqual([...st.stoppedAgentIds], ['aA']);
    assert.deepEqual([...st.startedAgentIds].sort(), ['aA', 'aB']);
    assert.equal(st.agents.get('aA').state, 'stopped');
    assert.equal(st.agents.get('aA').transcriptPath, 'C:/a.jsonl');
    assert.equal(st.agents.get('aB').state, 'running');
  });

  test('a notification is surfaced on the session', () => {
    const st = foldState([normalizeEvent({
      hookEventName: 'Notification', session_id: 'S', notification_type: 'permission_prompt', receivedAt: '2026-09-02T00:00:00.000Z',
    })]);
    assert.equal(st.sessions.get('S').pendingNotification, 'permission_prompt');
  });
});
