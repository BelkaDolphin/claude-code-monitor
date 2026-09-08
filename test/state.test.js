/**
 * State model tests. Events are built through the real normalizer so the field
 * names stay honest: if hooks-ingest renames something, these fail.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeEvent } from '../src/hooks-ingest.js';
import {
  createState,
  reduce,
  reduceAll,
  applySessions,
  applyStatusline,
  applyTranscript,
  derivePhase,
  buildSnapshot,
  toPublicSession,
  sessionTitle,
  baseName,
  phaseFromSessionsStatus,
  pruneSessions,
  sweepStale,
  isLive,
  SESSION_STALE_MS,
  applyAgentMeta,
  agentLabel,
  isUsefulTitle,
  excerpt,
  MAX_COMPLETED_AGENTS,
  MAX_ARCHIVED_SESSIONS,
} from '../src/state.js';

const SID = 'ea1b82f5-5a07-4d1d-9920-479d8cece715';
let clock = 0;

function ev(hookEventName, extra = {}) {
  clock += 1000;
  return normalizeEvent({
    hookEventName,
    hook_event_name: hookEventName,
    session_id: SID,
    cwd: 'D:\\develop\\Claude監視',
    receivedAt: new Date(Date.UTC(2026, 8, 2, 0, 0, 0) + clock).toISOString(),
    ...extra,
  });
}

function play(events) {
  return reduceAll(createState(), events).state;
}

function phaseAfter(events) {
  const state = play(events);
  return derivePhase(state.sessions[SID]).phase;
}

describe('phase state machine', () => {
  test('starts unknown with no events at all', () => {
    const s = createState();
    assert.equal(derivePhase(s.sessions[SID]).phase, 'unknown');
  });

  test('SessionStart -> idle', () => {
    assert.equal(phaseAfter([ev('SessionStart')]), 'idle');
  });

  test('UserPromptSubmit -> busy', () => {
    assert.equal(phaseAfter([ev('SessionStart'), ev('UserPromptSubmit')]), 'busy');
  });

  test('PreToolUse -> busy and records the current tool', () => {
    const state = play([
      ev('SessionStart'),
      ev('UserPromptSubmit'),
      ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_1' }),
    ]);
    const s = state.sessions[SID];
    assert.equal(derivePhase(s).phase, 'busy');
    assert.equal(s.currentTool.name, 'Bash');
    assert.equal(s.currentTool.toolUseId, 'toolu_1');
    assert.equal(s.currentTool.agentId, null);
    assert.ok(s.currentTool.since);
    assert.equal(s.toolCount, 1);
  });

  test('PostToolUse clears the current tool', () => {
    const state = play([
      ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_1' }),
      ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_1' }),
    ]);
    assert.equal(state.sessions[SID].currentTool, null);
  });

  test('PostToolUseFailure clears it too', () => {
    const state = play([
      ev('PreToolUse', { tool_name: 'Edit', tool_use_id: 'toolu_2' }),
      ev('PostToolUseFailure', { tool_name: 'Edit', tool_use_id: 'toolu_2' }),
    ]);
    assert.equal(state.sessions[SID].currentTool, null);
  });

  test('a PostToolUse for a different tool_use_id leaves the current one alone', () => {
    const state = play([
      ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_1' }),
      ev('PostToolUse', { tool_name: 'Read', tool_use_id: 'toolu_other' }),
    ]);
    assert.equal(state.sessions[SID].currentTool.toolUseId, 'toolu_1');
  });

  test('Notification permission_prompt -> waiting_permission', () => {
    assert.equal(
      phaseAfter([ev('SessionStart'), ev('Notification', { notification_type: 'permission_prompt' })]),
      'waiting_permission',
    );
  });

  test('Notification idle_prompt -> waiting_input', () => {
    assert.equal(
      phaseAfter([ev('SessionStart'), ev('Notification', { notification_type: 'idle_prompt' })]),
      'waiting_input',
    );
  });

  test('Notification agent_needs_input -> waiting_input', () => {
    assert.equal(
      phaseAfter([ev('SessionStart'), ev('Notification', { notification_type: 'agent_needs_input' })]),
      'waiting_input',
    );
  });

  test('Notification agent_completed does not move the phase', () => {
    assert.equal(
      phaseAfter([ev('SessionStart'), ev('Notification', { notification_type: 'agent_completed' })]),
      'idle',
    );
  });

  test('Stop -> idle and clears the tool', () => {
    const state = play([
      ev('UserPromptSubmit'),
      ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 't' }),
      ev('Stop'),
    ]);
    assert.equal(derivePhase(state.sessions[SID]).phase, 'idle');
    assert.equal(state.sessions[SID].currentTool, null);
  });

  test('PreCompact -> compacting, PostCompact restores the previous phase', () => {
    const busy = play([ev('UserPromptSubmit'), ev('PreCompact')]);
    assert.equal(derivePhase(busy.sessions[SID]).phase, 'compacting');
    const back = reduce(busy, ev('PostCompact')).state;
    assert.equal(derivePhase(back.sessions[SID]).phase, 'busy');

    const idle = play([ev('SessionStart'), ev('PreCompact'), ev('PostCompact')]);
    assert.equal(derivePhase(idle.sessions[SID]).phase, 'idle');

    const waiting = play([
      ev('Notification', { notification_type: 'permission_prompt' }),
      ev('PreCompact'),
      ev('PostCompact'),
    ]);
    assert.equal(derivePhase(waiting.sessions[SID]).phase, 'waiting_permission');
  });

  test('a repeated PreCompact does not overwrite the saved phase', () => {
    const state = play([ev('UserPromptSubmit'), ev('PreCompact'), ev('PreCompact'), ev('PostCompact')]);
    assert.equal(derivePhase(state.sessions[SID]).phase, 'busy');
  });

  test('PostCompact with nothing saved falls back to busy', () => {
    assert.equal(phaseAfter([ev('PostCompact')]), 'busy');
  });

  test('SessionEnd -> ended and keeps the reason', () => {
    const state = play([ev('SessionStart'), ev('SessionEnd', { reason: 'prompt_input_exit' })]);
    assert.equal(derivePhase(state.sessions[SID]).phase, 'ended');
    assert.equal(state.sessions[SID].endedReason, 'prompt_input_exit');
  });

  test('the full documented sequence lands where it should', () => {
    const state = play([
      ev('SessionStart'),
      ev('UserPromptSubmit'),
      ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'a' }),
      ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'a' }),
      ev('Notification', { notification_type: 'permission_prompt' }),
      ev('PreToolUse', { tool_name: 'Write', tool_use_id: 'b' }),
      ev('PostToolUse', { tool_name: 'Write', tool_use_id: 'b' }),
      ev('Stop'),
      ev('PreCompact'),
      ev('PostCompact'),
      ev('SessionEnd', { reason: 'clear' }),
    ]);
    const s = state.sessions[SID];
    assert.equal(derivePhase(s).phase, 'ended');
    assert.equal(s.toolCount, 2);
    assert.equal(s.notifications.length, 1);
  });
});

describe('subagents', () => {
  test('SubagentStart registers a running agent', () => {
    const state = play([ev('SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' })]);
    const a = state.sessions[SID].agents.ag1;
    assert.equal(a.status, 'running');
    assert.equal(a.agentType, 'Explore');
    assert.ok(a.startedAt);
    assert.equal(a.tools, 0);
  });

  test('agent-scoped tool events count on the agent, not the main thread', () => {
    const state = play([
      ev('SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' }),
      ev('PreToolUse', { agent_id: 'ag1', agent_type: 'Explore', tool_name: 'Grep', tool_use_id: 'g1' }),
      ev('PreToolUse', { agent_id: 'ag1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'g2' }),
    ]);
    const s = state.sessions[SID];
    assert.equal(s.agents.ag1.tools, 2);
    assert.equal(s.toolCount, 0);
    assert.equal(s.agents.ag1.currentTool.name, 'Read');
  });

  test('an agent tool shows at session level only while the main thread is free', () => {
    const idle = play([
      ev('PreToolUse', { agent_id: 'ag1', tool_name: 'Grep', tool_use_id: 'g1' }),
    ]);
    assert.equal(idle.sessions[SID].currentTool.name, 'Grep');
    assert.equal(idle.sessions[SID].currentTool.agentId, 'ag1');

    const busy = play([
      ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'm1' }),
      ev('PreToolUse', { agent_id: 'ag1', tool_name: 'Grep', tool_use_id: 'g1' }),
    ]);
    assert.equal(busy.sessions[SID].currentTool.name, 'Bash');
  });

  test('SubagentStop completes the agent and keeps agent_transcript_path', () => {
    const state = play([
      ev('SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' }),
      ev('PreToolUse', { agent_id: 'ag1', tool_name: 'Grep', tool_use_id: 'g1' }),
      ev('SubagentStop', {
        agent_id: 'ag1',
        agent_type: 'Explore',
        agent_transcript_path: 'C:\\x\\subagents\\agent-ag1.jsonl',
      }),
    ]);
    const a = state.sessions[SID].agents.ag1;
    assert.equal(a.status, 'completed');
    assert.ok(a.endedAt);
    assert.equal(a.currentTool, null);
    assert.equal(a.agentTranscriptPath, 'C:\\x\\subagents\\agent-ag1.jsonl');
  });

  test('a PostToolUseFailure inside an agent is counted as an agent error', () => {
    const state = play([
      ev('SubagentStart', { agent_id: 'ag1' }),
      ev('PreToolUse', { agent_id: 'ag1', tool_name: 'Bash', tool_use_id: 'x' }),
      ev('PostToolUseFailure', { agent_id: 'ag1', tool_name: 'Bash', tool_use_id: 'x' }),
    ]);
    assert.equal(state.sessions[SID].agents.ag1.errors, 1);
  });

  test('tool events for an agent we never saw start still create it', () => {
    const state = play([ev('PreToolUse', { agent_id: 'ghost', tool_name: 'Bash', tool_use_id: 'z' })]);
    assert.equal(state.sessions[SID].agents.ghost.status, 'running');
    assert.equal(state.sessions[SID].agents.ghost.tools, 1);
  });
});

describe('unbounded growth is capped', () => {
  test('finished subagents are capped, running ones are never dropped', () => {
    const events = [ev('SubagentStart', { agent_id: 'keeper', agent_type: 'Explore' })];
    for (let i = 0; i < MAX_COMPLETED_AGENTS + 12; i++) {
      events.push(ev('SubagentStop', { agent_id: `done${i}` }));
    }
    const s = play(events).sessions[SID];
    const all = Object.values(s.agents);
    assert.equal(all.filter((a) => a.status !== 'running').length, MAX_COMPLETED_AGENTS);
    assert.ok(s.agents.keeper, 'the running agent survived');
    // The oldest finished ones went, the newest stayed.
    assert.equal(s.agents.done0, undefined);
    assert.ok(s.agents[`done${MAX_COMPLETED_AGENTS + 11}`]);
  });

  test('archived sessions are capped, live ones are never dropped', () => {
    let state = createState();
    state = reduce(state, normalizeEvent({
      hookEventName: 'UserPromptSubmit', session_id: 'alive', receivedAt: '2020-01-01T00:00:00.000Z',
    })).state;
    for (let i = 0; i < MAX_ARCHIVED_SESSIONS + 5; i++) {
      state = reduce(state, normalizeEvent({
        hookEventName: 'SessionEnd',
        session_id: `old${String(i).padStart(3, '0')}`,
        reason: 'clear',
        receivedAt: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(),
      })).state;
    }
    const before = Object.keys(state.sessions).length;
    const r = pruneSessions(state);
    assert.equal(r.changed, true);
    const ids = Object.keys(r.state.sessions);
    assert.equal(ids.length, MAX_ARCHIVED_SESSIONS + 1);
    assert.ok(ids.includes('alive'), 'the live session survived even though it is the oldest');
    assert.equal(ids.includes('old000'), false);
    assert.ok(before > ids.length);
  });

  test('pruning below the cap is a no-op', () => {
    const state = play([ev('SessionEnd', { reason: 'clear' })]);
    const r = pruneSessions(state);
    assert.equal(r.changed, false);
    assert.equal(r.state, state);
  });
});

describe('notifications', () => {
  test('keeps type, message and time, newest last, capped at 20', () => {
    const events = [];
    for (let i = 0; i < 25; i++) {
      events.push(ev('Notification', { notification_type: 'idle_prompt', message: `m${i}` }));
    }
    const s = play(events).sessions[SID];
    assert.equal(s.notifications.length, 20);
    assert.equal(s.notifications[19].message, 'm24');
    assert.equal(s.notifications[19].type, 'idle_prompt');
    assert.ok(s.notifications[19].at);
    assert.notEqual(s.notifications[0].id, s.notifications[1].id);
  });

  test('the real payload shape from the events file is understood', () => {
    // Copied field-for-field from a real <monitorDir>/events line.
    const real = normalizeEvent({
      receivedAt: '2026-09-02T14:07:48.502Z',
      hookEventName: 'Notification',
      session_id: SID,
      transcript_path: 'C:\\Users\\x\\.claude\\projects\\p\\s.jsonl',
      cwd: 'D:\\develop\\Claude監視',
      prompt_id: '809cb656-97c2-46e6-857f-dd6ae1a8a7c7',
      hook_event_name: 'Notification',
      message: 'Claude is waiting for your input',
      notification_type: 'idle_prompt',
    });
    const s = reduce(createState(), real).state.sessions[SID];
    assert.equal(s.notifications[0].message, 'Claude is waiting for your input');
    assert.equal(derivePhase(s).phase, 'waiting_input');
    assert.equal(s.transcriptPath, 'C:\\Users\\x\\.claude\\projects\\p\\s.jsonl');
  });
});

describe('robustness', () => {
  test('unknown event names do not throw and still record lastEvent', () => {
    const state = play([ev('SessionStart'), ev('WorktreeCreate'), ev('TeammateIdle')]);
    const s = state.sessions[SID];
    assert.equal(s.lastEventName, 'TeammateIdle');
    assert.equal(derivePhase(s).phase, 'idle');
  });

  test('missing fields everywhere do not throw', () => {
    let state = createState();
    for (const bad of [null, undefined, 42, 'x', {}, { event: 'Stop' }, { sessionId: '' }]) {
      state = reduce(state, bad).state;
    }
    assert.deepEqual(Object.keys(state.sessions), []);
    const partial = reduce(state, { sessionId: SID, event: 'PreToolUse' }).state;
    assert.equal(partial.sessions[SID].currentTool.name, '(tool)');
  });

  test('an event with no sessionId is ignored and reports no change', () => {
    const r = reduce(createState(), normalizeEvent({ hookEventName: 'Stop' }));
    assert.equal(r.changed, false);
  });

  test('reduce does not mutate the state it was given', () => {
    const before = play([ev('SessionStart')]);
    const snapshotJson = JSON.stringify(before);
    reduce(before, ev('UserPromptSubmit'));
    assert.equal(JSON.stringify(before), snapshotJson);
  });

  test('every event that touches a session reports changed', () => {
    let state = createState();
    for (const name of ['SessionStart', 'UserPromptSubmit', 'Stop']) {
      const r = reduce(state, ev(name));
      assert.equal(r.changed, true, name);
      state = r.state;
    }
  });
});

describe('liveness beats everything', () => {
  test('a dead PID forces phase dead even when hooks said busy', () => {
    const busy = play([ev('UserPromptSubmit')]);
    const dead = applySessions(busy, [{ sessionId: SID, pid: 4242, alive: false, status: 'busy' }]).state;
    const p = derivePhase(dead.sessions[SID]);
    assert.equal(p.phase, 'dead');
    assert.equal(p.phaseSource, 'pid');
  });

  test('an alive PID leaves the hook phase in charge', () => {
    const busy = play([ev('UserPromptSubmit')]);
    const alive = applySessions(busy, [{ sessionId: SID, pid: 1, alive: true, status: 'idle' }]).state;
    const p = derivePhase(alive.sessions[SID]);
    assert.equal(p.phase, 'busy');
    assert.equal(p.phaseSource, 'hooks');
  });

  test('no hook at all falls back to the sessions status, flagged as such', () => {
    const state = applySessions(createState(), [
      { sessionId: 'other', pid: 7, alive: true, status: 'busy', cwd: 'D:\\x' },
    ]).state;
    const p = derivePhase(state.sessions.other);
    assert.equal(p.phase, 'busy');
    assert.equal(p.phaseSource, 'sessions');
  });

  test('unknown sessions status maps to unknown, not to a guess', () => {
    assert.equal(phaseFromSessionsStatus('teleporting'), 'unknown');
    assert.equal(phaseFromSessionsStatus(null), 'unknown');
    assert.equal(phaseFromSessionsStatus('busy'), 'busy');
    assert.equal(phaseFromSessionsStatus('idle'), 'idle');
  });

  test('a session that vanishes from the listing is marked dead', () => {
    const alive = applySessions(createState(), [{ sessionId: SID, pid: 1, alive: true, status: 'busy' }]).state;
    assert.equal(derivePhase(alive.sessions[SID]).phase, 'busy');
    const gone = applySessions(alive, []).state;
    assert.equal(derivePhase(gone.sessions[SID]).phase, 'dead');
    assert.equal(gone.sessions[SID].aliveSource, 'sessions-file-gone');
  });

  test('applying the same listing twice reports no change', () => {
    const list = [{ sessionId: SID, pid: 1, alive: true, status: 'busy' }];
    const first = applySessions(createState(), list);
    assert.equal(first.changed, true);
    const second = applySessions(first.state, list);
    assert.equal(second.changed, false);
  });
});

describe('statusline and transcript merge', () => {
  test('statusline fills model, ctx, cost and rate limits', () => {
    const state = applyStatusline(createState(), [{
      sessionId: SID,
      capturedAt: '2026-09-02T14:35:09.268Z',
      model: 'Fable 5.1',
      contextUsedPct: 16,
      costUsd: 36.68,
      rateLimits: { five_hour: { used_percentage: 34, resets_at: 1788365400, resetsAtIso: 'x' } },
      cwd: 'D:\\develop\\Claude監視',
    }]).state;
    const s = state.sessions[SID];
    assert.equal(s.model, 'Fable 5.1');
    assert.equal(s.contextPct, 16);
    assert.equal(s.rateLimits.five_hour.used_percentage, 34);
    assert.equal(s.statuslineAt, '2026-09-02T14:35:09.268Z');
  });

  test('re-applying the same sidecar reports no change', () => {
    const entry = { sessionId: SID, model: 'm', contextUsedPct: 1, costUsd: 2, rateLimits: {}, capturedAt: 'z' };
    const first = applyStatusline(createState(), [entry]);
    const second = applyStatusline(first.state, [entry]);
    assert.equal(second.changed, false);
  });

  test('the ai-title wins over the cwd for the display title', () => {
    let state = play([ev('SessionStart')]);
    assert.equal(sessionTitle(state.sessions[SID]), 'Claude監視');
    state = applyTranscript(state, SID, { aiTitle: 'Claude Code監視システム' }).state;
    assert.equal(sessionTitle(state.sessions[SID]), 'Claude Code監視システム');
  });

  test('baseName handles both separators and empty input', () => {
    assert.equal(baseName('D:\\develop\\Claude監視'), 'Claude監視');
    assert.equal(baseName('/home/u/proj/'), 'proj');
    assert.equal(baseName(''), null);
    assert.equal(baseName(null), null);
  });
});

describe('snapshot', () => {
  test('sorts attention first and counts what the header shows', () => {
    let state = createState();
    state = reduce(state, normalizeEvent({ hookEventName: 'UserPromptSubmit', session_id: 'busy1', receivedAt: '2026-09-02T00:00:01.000Z' })).state;
    state = reduce(state, normalizeEvent({ hookEventName: 'SessionStart', session_id: 'idle1', receivedAt: '2026-09-02T00:00:02.000Z' })).state;
    state = reduce(state, normalizeEvent({ hookEventName: 'Notification', session_id: 'wait1', notification_type: 'permission_prompt', receivedAt: '2026-09-02T00:00:03.000Z' })).state;
    state = reduce(state, normalizeEvent({ hookEventName: 'SessionEnd', session_id: 'done1', reason: 'clear', receivedAt: '2026-09-02T00:00:04.000Z' })).state;

    const snap = buildSnapshot(state, { stats: { errorCount: 3 } });
    assert.equal(snap.sessions[0].sessionId, 'wait1');
    assert.equal(snap.sessions[snap.sessions.length - 1].sessionId, 'done1');
    assert.equal(snap.counts.total, 4);
    assert.equal(snap.counts.live, 3);
    assert.equal(snap.counts.waiting, 1);
    assert.equal(snap.counts.busy, 1);
    assert.equal(snap.stats.errorCount, 3);
  });

  test('is JSON-serialisable and carries agents as an array', () => {
    const state = play([
      ev('SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' }),
      ev('SubagentStart', { agent_id: 'ag2', agent_type: 'Plan' }),
      ev('SubagentStop', { agent_id: 'ag2' }),
    ]);
    const snap = JSON.parse(JSON.stringify(buildSnapshot(state)));
    const s = snap.sessions[0];
    assert.ok(Array.isArray(s.agents));
    assert.equal(s.agents.length, 2);
    assert.equal(s.activeAgents, 1);
    assert.equal(snap.counts.agentsRunning, 1);
  });
});

describe('ghost agents (browser review 2026-09-03)', () => {
  const T0 = Date.UTC(2026, 8, 2, 14, 39, 42);
  const at = (ms) => new Date(T0 + ms).toISOString();
  const MIN = 60 * 1000;

  /** The exact shape measured for agent a458ad0670a1f500e. */
  function ghost() {
    return play([
      ev('PreToolUse', { agent_id: 'a458ad0670a1f500e', tool_name: 'Bash', tool_use_id: 'g1', receivedAt: at(0) }),
      ev('PostToolUse', { agent_id: 'a458ad0670a1f500e', tool_name: 'Bash', tool_use_id: 'g1', receivedAt: at(17 * MIN) }),
    ]);
  }

  test('an agent with no SubagentStop goes stale and leaves agentsRunning', () => {
    const before = ghost();
    assert.equal(buildSnapshot(before).counts.agentsRunning, 1);

    const r = sweepStale(before, { now: T0 + 40 * MIN });
    assert.equal(r.changed, true);
    assert.equal(r.agentsStale, 1);

    const snap = buildSnapshot(r.state);
    assert.equal(snap.counts.agentsRunning, 0, 'the ghost is no longer counted as running');
    const a = snap.sessions[0].agents[0];
    assert.equal(a.status, 'stale');
    assert.equal(a.statusSource, 'inferred', 'the UI must be able to say this is a guess');
    assert.ok(a.staleAt);
    assert.equal(a.staleReason, 'silent');
  });

  test('it stays running while it is still inside the quiet window', () => {
    const r = sweepStale(ghost(), { now: T0 + 20 * MIN });
    assert.equal(r.agentsStale, 0);
    assert.equal(buildSnapshot(r.state).counts.agentsRunning, 1);
  });

  test('a fresh agent transcript keeps it alive even when hooks went silent', () => {
    const now = T0 + 40 * MIN;
    const withFile = sweepStale(ghost(), {
      now,
      agentFileMtimes: () => now - 1 * MIN,
    });
    assert.equal(withFile.agentsStale, 0, 'a live transcript outranks hook silence');

    const idleFile = sweepStale(ghost(), { now, agentFileMtimes: () => now - 30 * MIN });
    assert.equal(idleFile.agentsStale, 1);
    assert.equal(
      buildSnapshot(idleFile.state).sessions[0].agents[0].staleReason,
      'silent+transcript-idle',
    );
  });

  test('a late SubagentStop promotes stale to completed', () => {
    const stale = sweepStale(ghost(), { now: T0 + 40 * MIN }).state;
    assert.equal(stale.sessions[SID].agents.a458ad0670a1f500e.status, 'stale');

    const stopped = reduce(stale, ev('SubagentStop', {
      agent_id: 'a458ad0670a1f500e',
      receivedAt: at(45 * MIN),
    })).state;
    const a = stopped.sessions[SID].agents.a458ad0670a1f500e;
    assert.equal(a.status, 'completed');
    assert.equal(a.statusSource, 'hooks');
    assert.equal(a.staleAt, null);
  });

  test('any later hook event revives a stale agent', () => {
    const stale = sweepStale(ghost(), { now: T0 + 40 * MIN }).state;
    const revived = reduce(stale, ev('PreToolUse', {
      agent_id: 'a458ad0670a1f500e',
      tool_name: 'Read',
      tool_use_id: 'g2',
      receivedAt: at(45 * MIN),
    })).state;
    const a = revived.sessions[SID].agents.a458ad0670a1f500e;
    assert.equal(a.status, 'running');
    assert.equal(a.statusSource, 'hooks');
    assert.equal(buildSnapshot(revived).counts.agentsRunning, 1);
  });

  test('a tool whose PostToolUse never arrives is released and counted', () => {
    const stuck = play([ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'x', receivedAt: at(0) })]);
    assert.ok(stuck.sessions[SID].currentTool);

    const inside = sweepStale(stuck, { now: T0 + 10 * MIN });
    assert.equal(inside.toolTimeouts, 0, 'a 10 minute tool is still plausible');

    const outside = sweepStale(stuck, { now: T0 + 20 * MIN });
    assert.equal(outside.toolTimeouts, 1);
    assert.equal(outside.state.sessions[SID].currentTool, null);
  });

  test('the 17-minute real tool run is why the timeout must be configurable', () => {
    const stuck = play([ev('PreToolUse', { tool_name: 'Bash', tool_use_id: 'x', receivedAt: at(0) })]);
    // Measured: a458ad0670a1f500e ran one tool for 17m12s and it DID finish.
    const generous = sweepStale(stuck, { now: T0 + 18 * MIN, toolTimeoutMs: 30 * MIN });
    assert.equal(generous.toolTimeouts, 0);
    assert.ok(generous.state.sessions[SID].currentTool);
  });

  test('a finished session takes its agents with it immediately', () => {
    const ended = reduce(ghost(), ev('SessionEnd', { reason: 'clear', receivedAt: at(18 * MIN) })).state;
    const r = sweepStale(ended, { now: T0 + 18 * MIN + 1000 });
    assert.equal(r.agentsStale, 1);
    assert.equal(r.state.sessions[SID].agents.a458ad0670a1f500e.staleReason, 'session-over');
  });

  test('sweeping twice does not double count or re-report a change', () => {
    const once = sweepStale(ghost(), { now: T0 + 40 * MIN });
    const twice = sweepStale(once.state, { now: T0 + 41 * MIN });
    assert.equal(twice.changed, false);
    assert.equal(twice.agentsStale, 0);
  });
});

describe('agent identity and model (browser review 2026-09-03)', () => {
  test('meta.json supplies the description, type and short model name', () => {
    let state = play([ev('SubagentStart', { agent_id: 'a25952fdd8897146a' })]);
    // Copied from a real subagents/agent-<id>.meta.json.
    state = applyAgentMeta(state, SID, [{
      agentId: 'a25952fdd8897146a',
      agentType: 'general-purpose',
      description: 'Implement the server and Live view',
      model: 'opus',
      modelSource: 'meta',
    }]).state;
    const a = buildSnapshot(state).sessions[0].agents[0];
    assert.equal(a.description, 'Implement the server and Live view');
    assert.equal(a.agentType, 'general-purpose');
    assert.equal(a.model, 'opus');
    assert.equal(a.modelSource, 'meta');
    assert.equal(a.label, 'Implement the server and Live view（general-purpose）');
  });

  test('with no meta.json the transcript model is used instead', () => {
    let state = play([ev('SubagentStart', { agent_id: 'a68ec5b2f7810110a', agent_type: 'feature-dev:code-reviewer' })]);
    state = applyAgentMeta(state, SID, [{
      agentId: 'a68ec5b2f7810110a',
      model: 'claude-sonnet-5',
      modelSource: 'transcript',
    }]).state;
    const a = buildSnapshot(state).sessions[0].agents[0];
    assert.equal(a.model, 'claude-sonnet-5');
    assert.equal(a.modelSource, 'transcript');
    assert.equal(a.label, 'feature-dev:code-reviewer');
  });

  test('meta.json outranks the transcript, and never the other way round', () => {
    let state = play([ev('SubagentStart', { agent_id: 'ag' })]);
    state = applyAgentMeta(state, SID, [{ agentId: 'ag', model: 'claude-opus-5', modelSource: 'transcript' }]).state;
    state = applyAgentMeta(state, SID, [{ agentId: 'ag', model: 'sonnet', modelSource: 'meta' }]).state;
    assert.equal(state.sessions[SID].agents.ag.model, 'sonnet');

    const after = applyAgentMeta(state, SID, [{ agentId: 'ag', model: 'claude-opus-5', modelSource: 'transcript' }]);
    assert.equal(after.changed, false, 'a transcript model must not overwrite meta.json');
    assert.equal(after.state.sessions[SID].agents.ag.model, 'sonnet');
  });

  test('meta for an agent we never saw is ignored, not invented', () => {
    const state = play([ev('SessionStart')]);
    const r = applyAgentMeta(state, SID, [{ agentId: 'never-seen', agentType: 'x', description: 'y' }]);
    assert.equal(r.changed, false);
    assert.deepEqual(Object.keys(r.state.sessions[SID].agents), []);
  });

  test('the label degrades gracefully', () => {
    assert.equal(agentLabel({ agentId: 'abcdefgh1234', agentType: '', description: '' }), 'abcdefgh');
    assert.equal(agentLabel({ agentId: 'x', agentType: 'Explore' }), 'Explore');
    assert.equal(agentLabel({ agentId: 'x', description: 'find the bug' }), 'find the bug');
  });
});

describe('session title stability (browser review 2026-09-03)', () => {
  test('a prompt never becomes the title, it becomes lastPrompt', () => {
    let state = play([ev('SessionStart')]);
    assert.equal(sessionTitle(state.sessions[SID]), 'Claude監視');

    state = reduce(state, ev('UserPromptSubmit', { prompt: '[Image #1]' })).state;
    assert.equal(sessionTitle(state.sessions[SID]), 'Claude監視', 'the title did not follow the prompt');
    assert.equal(state.sessions[SID].lastPrompt, '[Image #1]');
    assert.ok(state.sessions[SID].lastPromptAt);

    state = reduce(state, ev('UserPromptSubmit', { prompt: 'これを直して' })).state;
    assert.equal(sessionTitle(state.sessions[SID]), 'Claude監視');
    assert.equal(state.sessions[SID].lastPrompt, 'これを直して');
  });

  test('a placeholder ai-title is refused so a good one survives', () => {
    let state = play([ev('SessionStart')]);
    state = applyTranscript(state, SID, { aiTitle: 'Claude Code監視システム' }).state;
    assert.equal(sessionTitle(state.sessions[SID]), 'Claude Code監視システム');

    // Measured: sending an image made Claude Code rewrite ai-title to "Image #1".
    const after = applyTranscript(state, SID, { aiTitle: 'Image #1' });
    assert.equal(after.changed, false);
    assert.equal(sessionTitle(after.state.sessions[SID]), 'Claude Code監視システム');
  });

  test('with no usable ai-title the cwd basename is used', () => {
    let state = play([ev('SessionStart')]);
    state = applyTranscript(state, SID, { aiTitle: '[Image #2]' }).state;
    assert.equal(sessionTitle(state.sessions[SID]), 'Claude監視');
  });

  test('isUsefulTitle rejects only placeholders', () => {
    for (const bad of ['Image #1', '[Image #1]', 'image #12', 'Screenshot', '[Attachment]', '   ', '', null, 7]) {
      assert.equal(isUsefulTitle(bad), false, String(bad));
    }
    for (const good of ['Claude Code監視システム', 'Image processing pipeline', 'fix the image loader']) {
      assert.equal(isUsefulTitle(good), true, good);
    }
  });

  test('isUsefulTitle is linear, not quadratic, on a hostile title', () => {
    // The pattern used to end `\s*#?\d*\s*\]?$`, which puts two nullable
    // whitespace runs next to each other: on a long non-matching string the
    // engine tried every way of splitting the spaces between them. Measured at
    // 265ms for 16k characters, and the input is a title read out of a
    // transcript file, so it is not ours to trust.
    const hostile = `image${' '.repeat(200000)}x`;
    const t0 = performance.now();
    const verdict = isUsefulTitle(hostile);
    const ms = performance.now() - t0;
    assert.equal(verdict, true, 'it is not a placeholder, so it is a usable title');
    assert.ok(ms < 50, `isUsefulTitle took ${ms.toFixed(1)}ms on 200k characters`);

    // The same shape at a length the pattern actually runs on: still linear.
    const t1 = performance.now();
    assert.equal(isUsefulTitle(`[  screenshot${'\t'.repeat(150)}z`), true);
    assert.ok(performance.now() - t1 < 50);
  });

  test('a long title is useful by definition, but padding does not smuggle one through', () => {
    assert.equal(isUsefulTitle('a'.repeat(5000)), true);
    // Trimming happens first, so whitespace padding cannot push a placeholder
    // past the length cap.
    assert.equal(isUsefulTitle(`  Image #1${' '.repeat(500)}`), false);
  });

  test('excerpt flattens newlines and caps the length', () => {
    assert.equal(excerpt('a\n\n  b\tc'), 'a b c');
    assert.equal(excerpt(''), null);
    assert.equal(excerpt(null), null);
    const long = excerpt('x'.repeat(500));
    assert.equal(long.length, 201);
    assert.ok(long.endsWith('…'));
  });
});

/**
 * Start and end times. These are the two facts the whole "when did this run"
 * feature rests on, and both have a rule that is easy to get backwards:
 * the FIRST source to name a start wins (a resume must not move it), and an
 * end time is a claim that must be withdrawn the moment the session speaks.
 */
describe('session start and end times', () => {
  test('SessionStart records the start and says it came from hooks', () => {
    const start = ev('SessionStart');
    const s = play([start]).sessions[SID];
    assert.equal(s.startedAt, start.receivedAt);
    assert.equal(s.startedAtSource, 'hooks');
  });

  test('a resumed session keeps its ORIGINAL start time', () => {
    const first = ev('SessionStart');
    const second = ev('SessionStart');
    assert.notEqual(first.receivedAt, second.receivedAt);
    assert.equal(play([first, second]).sessions[SID].startedAt, first.receivedAt);
  });

  test('SessionEnd records the end time and its source', () => {
    const end = ev('SessionEnd', { reason: 'clear' });
    const s = play([ev('SessionStart'), end]).sessions[SID];
    assert.equal(s.endedAt, end.receivedAt);
    assert.equal(s.endedAtSource, 'hooks');
  });

  test('a prompt after SessionEnd withdraws the end time - the session is alive again', () => {
    const s = play([ev('SessionStart'), ev('SessionEnd', { reason: 'clear' }), ev('UserPromptSubmit')])
      .sessions[SID];
    assert.equal(s.endedAt, null);
    assert.equal(s.endedAtSource, null);
    assert.equal(derivePhase(s).phase, 'busy');
  });

  test('a fresh SessionStart after SessionEnd also withdraws the end time', () => {
    const s = play([ev('SessionStart'), ev('SessionEnd', { reason: 'clear' }), ev('SessionStart')])
      .sessions[SID];
    assert.equal(s.endedAt, null);
    assert.equal(s.endedAtSource, null);
  });

  test('sessions/<pid>.json fills the start when no hook has, labelled `sessions`', () => {
    const ms = Date.UTC(2026, 8, 2, 1, 0, 0);
    const state = applySessions(createState(), [{ sessionId: SID, pid: 7, startedAt: ms }]).state;
    assert.equal(state.sessions[SID].startedAtSource, 'sessions');
    assert.equal(toPublicSession(state.sessions[SID]).startedAt, new Date(ms).toISOString());
  });

  test('a sessions listing never overwrites a start a hook already recorded', () => {
    const start = ev('SessionStart');
    let state = play([start]);
    state = applySessions(state, [{ sessionId: SID, pid: 7, startedAt: Date.UTC(2001, 0, 1) }]).state;
    assert.equal(state.sessions[SID].startedAt, start.receivedAt);
    assert.equal(state.sessions[SID].startedAtSource, 'hooks');
  });

  test('the wire carries both times as ISO strings, whatever shape they arrived in', () => {
    const ms = Date.UTC(2026, 8, 2, 1, 0, 0);
    let state = applySessions(createState(), [{ sessionId: SID, pid: 7, startedAt: ms }]).state;
    const end = ev('SessionEnd', { reason: 'other' });
    state = reduce(state, end).state;
    const pub = toPublicSession(state.sessions[SID]);
    assert.equal(typeof pub.startedAt, 'string');
    assert.equal(pub.startedAt, new Date(ms).toISOString());
    assert.equal(pub.startedAtSource, 'sessions');
    assert.equal(pub.endedAt, end.receivedAt);
    assert.equal(pub.endedAtSource, 'hooks');
  });

  test('a session that never ended has no end time on the wire', () => {
    const pub = toPublicSession(play([ev('SessionStart'), ev('UserPromptSubmit')]).sessions[SID]);
    assert.equal(pub.endedAt, null);
    assert.equal(pub.endedAtSource, null);
  });
});

/**
 * 「3 稼働」with one session running (2026-09-06).
 *
 * ~/.claude-monitor/statusline/ is never pruned, so applyStatusline mints a
 * session record for every file in it - five of them here, from 9/2 and 9/3.
 * The old rule counted anything that was not 'ended'/'dead' as live, so four
 * long-finished sessions were in the header, in the card list, and in the tree
 * list with 稼働中 where an end time belonged.
 */
describe('liveness needs positive evidence', () => {
  const OLD = 'b5824c60-6421-43c7-848c-1095bc09436d';

  /** Exactly what readSidecars hands applyStatusline for an old file. */
  const sidecar = (sessionId) => ({
    sessionId,
    model: 'Fable 5.1',
    contextUsedPct: 16,
    costUsd: 1.5,
    rateLimits: {},
    capturedAt: '2026-09-03T14:39:00.000Z',
    cwd: 'D:\\develop\\old',
  });

  test('a sidecar-only session is unknown, and unknown is not live', () => {
    const state = applyStatusline(createState(), [sidecar(OLD)]).state;
    const s = state.sessions[OLD];
    assert.ok(s, 'the record still exists - the model/cost have nowhere else to live');
    const { phase, phaseSource } = derivePhase(s);
    assert.equal(phase, 'unknown', 'the UI can still say 不明');
    assert.equal(phaseSource, 'none');
    assert.equal(isLive(s), false, 'no hook, no PID, no sessions file: no evidence');
  });

  test('counts.live ignores it, and so does the wire shape it is measured on', () => {
    let state = play([ev('UserPromptSubmit')]);
    state = applyStatusline(state, [sidecar(OLD)]).state;

    const snap = buildSnapshot(state);
    assert.equal(snap.counts.total, 2);
    assert.equal(snap.counts.live, 1, 'only the session with hook events');
    assert.equal(snap.counts.busy, 1);

    // isLive must give the same answer on the public shape, because tree-view
    // and tree-merge only ever see that one.
    const pub = snap.sessions.map((s) => [s.sessionId, isLive(s)]);
    assert.deepEqual(Object.fromEntries(pub), { [SID]: true, [OLD]: false });
  });

  test('a live PID is evidence on its own, with no hook event at all', () => {
    const state = applySessions(createState(), [{ sessionId: OLD, pid: 54232, alive: true }]).state;
    assert.equal(derivePhase(state.sessions[OLD]).phase, 'unknown');
    assert.equal(isLive(state.sessions[OLD]), true);
    assert.equal(buildSnapshot(state).counts.live, 1);
  });

  test('a sessions/<pid>.json status is evidence too', () => {
    // applySessions writes `alive: ls.alive === true`, so a listing with no
    // liveness at all is a DEAD pid, not an unknown one - hence alive here.
    const state = applySessions(createState(), [{ sessionId: OLD, pid: 1, alive: true, status: 'busy' }]).state;
    assert.equal(derivePhase(state.sessions[OLD]).phaseSource, 'sessions');
    assert.equal(isLive(state.sessions[OLD]), true);
    assert.equal(buildSnapshot(state).counts.busy, 1);

    // The rule itself, with no PID in play at all.
    assert.equal(isLive({ sessionId: OLD, alive: null, hookPhase: null, sessionsStatus: 'busy' }), true);
    assert.equal(isLive({ sessionId: OLD, alive: null, hookPhase: null, sessionsStatus: null }), false);
  });

  test('an archived session is still archived', () => {
    const ended = play([ev('SessionStart'), ev('SessionEnd', { reason: 'clear' })]);
    assert.equal(isLive(ended.sessions[SID]), false);
    assert.equal(buildSnapshot(ended).counts.live, 0);
  });

  test('a subagent event is enough on its own: the session IS working', () => {
    const state = play([ev('SubagentStart', { agent_id: 'ag1', agent_type: 'Explore' })]);
    assert.equal(derivePhase(state.sessions[SID]).phase, 'busy');
    assert.equal(isLive(state.sessions[SID]), true);
  });
});

/**
 * The other half of the same bug: a session whose SessionEnd never came.
 * Measured: ea1b82f5's last event is a PostToolUse at 2026-09-02T23:59:50 and
 * it read "busy" for four days.
 */
describe('session stale sweep', () => {
  const T0 = Date.UTC(2026, 8, 2, 23, 59, 50);
  const MIN = 60 * 1000;
  const at = (ms) => new Date(T0 + ms).toISOString();

  /** Killed mid-turn: a prompt, a tool that finished, then nothing. */
  const crashed = () => play([
    ev('UserPromptSubmit', { receivedAt: at(-2 * MIN) }),
    ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 't1', receivedAt: at(0) }),
  ]);

  test('the default window is 30 minutes', () => {
    assert.equal(SESSION_STALE_MS, 30 * MIN);
  });

  test('inside the window it is still busy - a long tool is not a crash', () => {
    const r = sweepStale(crashed(), { now: T0 + 29 * MIN });
    assert.equal(r.sessionsStale, 0);
    assert.equal(buildSnapshot(r.state).counts.live, 1);
  });

  test('past it the session goes stale, is not live, and says it is a guess', () => {
    const before = crashed();
    assert.equal(buildSnapshot(before).counts.live, 1);

    const r = sweepStale(before, { now: T0 + 40 * MIN });
    assert.equal(r.changed, true);
    assert.equal(r.sessionsStale, 1);

    const snap = buildSnapshot(r.state);
    const s = snap.sessions[0];
    assert.equal(s.phase, 'stale');
    assert.equal(s.phaseSource, 'inferred', 'the UI must be able to say this is inference');
    assert.equal(s.staleReason, 'no hook event for 30 min, PID unknown');
    assert.ok(s.staleAt);
    assert.equal(snap.counts.live, 0);
    assert.equal(snap.counts.busy, 0);
  });

  test('a live PID is never swept - the process is right there', () => {
    const alive = applySessions(crashed(), [{ sessionId: SID, pid: 54232, alive: true }]).state;
    const r = sweepStale(alive, { now: T0 + 10 * 60 * MIN });
    assert.equal(r.sessionsStale, 0);
    assert.equal(buildSnapshot(r.state).sessions[0].phase, 'busy');
  });

  test('a transcript that is still growing outranks hook silence', () => {
    const now = T0 + 40 * MIN;
    const fresh = sweepStale(crashed(), { now, sessionFileMtimes: () => now - 1 * MIN });
    assert.equal(fresh.sessionsStale, 0, 'the file moved, so something is running');

    const idle = sweepStale(crashed(), { now, sessionFileMtimes: () => now - 45 * MIN });
    assert.equal(idle.sessionsStale, 1);

    // A Map keyed by sessionId works the same way the agent lookup does.
    const viaMap = sweepStale(crashed(), { now, sessionFileMtimes: new Map([[SID, now - 1 * MIN]]) });
    assert.equal(viaMap.sessionsStale, 0);
  });

  test('the window is injectable, like the agent and tool ones', () => {
    const r = sweepStale(crashed(), { now: T0 + 40 * MIN, sessionStaleMs: 4 * 60 * MIN });
    assert.equal(r.sessionsStale, 0);
    const tight = sweepStale(crashed(), { now: T0 + 6 * MIN, sessionStaleMs: 5 * MIN });
    assert.equal(tight.sessionsStale, 1);
    assert.equal(tight.state.sessions[SID].staleReason, 'no hook event for 5 min, PID unknown');
  });

  test('any later hook event revives it, back to the phase it had', () => {
    const stale = sweepStale(crashed(), { now: T0 + 40 * MIN }).state;
    assert.equal(stale.sessions[SID].hookPhase, 'stale');

    const revived = reduce(stale, ev('PostToolUse', {
      tool_name: 'Bash', tool_use_id: 't2', receivedAt: at(45 * MIN),
    })).state;
    const s = revived.sessions[SID];
    assert.equal(s.hookPhase, 'busy', 'the phase it held before the sweep');
    assert.equal(s.staleAt, null);
    assert.equal(s.staleReason, null);
    assert.equal(derivePhase(s).phaseSource, 'hooks', 'no longer an inference');
    assert.equal(buildSnapshot(revived).counts.live, 1);
  });

  test('a SessionEnd after the sweep still ends it properly', () => {
    const stale = sweepStale(crashed(), { now: T0 + 40 * MIN }).state;
    const ended = reduce(stale, ev('SessionEnd', { reason: 'clear', receivedAt: at(45 * MIN) })).state;
    assert.equal(derivePhase(ended.sessions[SID]).phase, 'ended');
    assert.equal(ended.sessions[SID].endedAt, at(45 * MIN));
  });

  test('an ended session is left alone - it is already over', () => {
    const ended = reduce(crashed(), ev('SessionEnd', { reason: 'clear', receivedAt: at(1 * MIN) })).state;
    const r = sweepStale(ended, { now: T0 + 10 * 60 * MIN });
    assert.equal(r.sessionsStale, 0);
    assert.equal(derivePhase(r.state.sessions[SID]).phase, 'ended', 'ended stays ended, never stale');
  });

  /** Answered its last prompt, then the window was closed: a Stop, then nothing. */
  const abandoned = () => play([ev('SessionStart', { receivedAt: at(-1 * MIN) }), ev('Stop', { receivedAt: at(0) })]);

  test('an idle session is swept too: isLive counts it, so it cannot stay forever', () => {
    const before = abandoned();
    assert.equal(buildSnapshot(before).counts.live, 1, 'a hooks-sourced idle is live');

    const early = sweepStale(before, { now: T0 + 29 * MIN });
    assert.equal(early.sessionsStale, 0, 'inside the window it is just idle');

    const r = sweepStale(before, { now: T0 + 10 * 60 * MIN });
    assert.equal(r.sessionsStale, 1);
    const s = buildSnapshot(r.state).sessions[0];
    assert.equal(s.phase, 'stale');
    assert.equal(s.phaseSource, 'inferred');
    assert.equal(s.staleReason, 'idle with no hook event for 30 min, PID unknown');
    assert.equal(buildSnapshot(r.state).counts.live, 0);
  });

  test('an idle session with a live PID is never swept - the window is open', () => {
    const alive = applySessions(abandoned(), [{ sessionId: SID, pid: 54232, alive: true }]).state;
    const r = sweepStale(alive, { now: T0 + 10 * 60 * MIN });
    assert.equal(r.sessionsStale, 0);
    assert.equal(buildSnapshot(r.state).sessions[0].phase, 'idle');
  });

  test('an idle session whose transcript still moves is not swept', () => {
    const now = T0 + 40 * MIN;
    const r = sweepStale(abandoned(), { now, sessionFileMtimes: () => now - 1 * MIN });
    assert.equal(r.sessionsStale, 0);
  });

  test('a swept idle session comes back as idle on the next hook event', () => {
    const stale = sweepStale(abandoned(), { now: T0 + 40 * MIN }).state;
    assert.equal(stale.sessions[SID].hookPhase, 'stale');
    const revived = reduce(stale, ev('UserPromptSubmit', { prompt: 'hi', receivedAt: at(45 * MIN) })).state;
    // UserPromptSubmit moves it to busy on its own; what matters is that stale is gone.
    const s = revived.sessions[SID];
    assert.notEqual(s.hookPhase, 'stale');
    assert.equal(s.staleAt, null);
    assert.equal(buildSnapshot(revived).counts.live, 1);
  });

  test('waiting_permission is swept too - nobody is there to answer it', () => {
    const waiting = play([ev('Notification', { notification_type: 'permission_prompt', receivedAt: at(0) })]);
    const r = sweepStale(waiting, { now: T0 + 40 * MIN });
    assert.equal(r.sessionsStale, 1);
    assert.equal(buildSnapshot(r.state).counts.waiting, 0);
  });

  test('sweeping twice does not double count or re-report a change', () => {
    const once = sweepStale(crashed(), { now: T0 + 40 * MIN });
    const twice = sweepStale(once.state, { now: T0 + 41 * MIN });
    assert.equal(twice.changed, false);
    assert.equal(twice.sessionsStale, 0);
  });

  test('a stale session sorts below unknown and above ended', () => {
    let state = sweepStale(crashed(), { now: T0 + 40 * MIN }).state;
    state = applyStatusline(state, [{ sessionId: 'sidecar-only', capturedAt: at(0) }]).state;
    state = reduce(state, normalizeEvent({
      hookEventName: 'SessionEnd', session_id: 'done', reason: 'clear', receivedAt: at(0),
    })).state;
    const order = buildSnapshot(state).sessions.map((s) => s.phase);
    assert.deepEqual(order, ['unknown', 'stale', 'ended']);
  });
});
