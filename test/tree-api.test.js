/**
 * Tree endpoints and their caches.
 *
 * A real listener on 127.0.0.1 with an ephemeral port, over a SYNTHESIZED
 * projects tree and a synthesized events dir. Nothing under ~/.claude or
 * ~/.claude-monitor is read.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { makeTmpDir, writeJsonl, assistantRec, toolResultRec, toolUseBlock } from './helpers.js';
import { startServer } from '../src/server.js';
import { Collector } from '../src/collector.js';
import { COOKIE_NAME } from '../src/auth.js';
import { localDateKey } from '../src/paths.js';
import { buildSessionIndex } from '../src/session-index.js';
import {
  TreeCache,
  SessionIndexCache,
  HookHistory,
  datesForSpan,
  HOOK_HISTORY_FALLBACK_DAYS,
  HOOK_HISTORY_MAX_DAYS,
  fingerprint,
  clampInt,
  isSessionId,
  isAgentId,
  listSessionsView,
  clampSpan,
  buildTreeView,
  toolLogView,
} from '../src/tree-view.js';

/* Formats measured on real data: a session file is named by a UUID, a subagent
   file by exactly 17 lowercase hex characters (82/82 local agents). */
const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const OTHER_SID = 'bbbbbbbb-2222-3333-4444-555555555555';
/** Its subagent files are deleted mid-test; nothing else may depend on it. */
const DEL_SID = 'cccccccc-3333-4444-5555-666666666666';
const A1 = 'a1111111111111111';
const A2 = 'a2222222222222222';
const A3 = 'a3333333333333333';
const A4 = 'a4444444444444444';
const A5 = 'a5555555555555555';
const GHOST = 'a458ad0670a1f500e';

let tmp;
let handle;
let cookie;
let projectsRoot;
let eventsDir;
let sessionDir;
let delSessionDir;

function get(pathname, { headers = {}, method = 'GET' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: handle.port, path: pathname, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function getJson(pathname, opts) {
  const res = await get(pathname, { headers: { cookie }, ...opts });
  let json = null;
  try {
    json = JSON.parse(res.body);
  } catch { /* not JSON: the test asserting on it will say so */ }
  return { ...res, json };
}

/** The model lives on message.model, which assistantRec fixes; override it. */
function withModel(rec, model) {
  rec.message.model = model;
  return rec;
}

function writeMeta(agentId, meta, dir = sessionDir) {
  fs.writeFileSync(
    path.join(dir, 'subagents', `agent-${agentId}.meta.json`),
    JSON.stringify(meta),
    'utf8',
  );
}

/**
 * A session with a depth-1 async agent (A1) that spawned a depth-2 agent (A2),
 * plus a synchronously-completed agent (A3) whose meta.json has no model.
 */
function writeFixture() {
  const projDir = path.join(projectsRoot, 'D--tmp-treeapi');
  sessionDir = path.join(projDir, SID);
  fs.mkdirSync(path.join(sessionDir, 'subagents'), { recursive: true });

  writeJsonl(path.join(projDir, `${SID}.jsonl`), [
    { type: 'ai-title', aiTitle: 'tree fixture', sessionId: SID },
    assistantRec({
      timestamp: '2026-09-01T00:00:00.000Z',
      cwd: 'D:\\tmp\\treeapi',
      content: [toolUseBlock('toolu_a1', 'Agent', {
        subagent_type: 'general-purpose',
        description: 'first',
        prompt: 'do the first thing',
      })],
    }),
    toolResultRec('toolu_a1', {
      timestamp: '2026-09-01T00:00:01.000Z',
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: A1 },
    }),
    assistantRec({
      timestamp: '2026-09-01T00:10:00.000Z',
      content: [toolUseBlock('toolu_a3', 'Agent', {
        subagent_type: 'feature-dev:code-reviewer',
        description: 'third',
        prompt: 'review it',
      })],
    }),
    toolResultRec('toolu_a3', {
      timestamp: '2026-09-01T00:12:00.000Z',
      toolUseResult: { status: 'completed', agentId: A3 },
    }),
    assistantRec({ timestamp: '2026-09-01T00:20:00.000Z', usage: { output_tokens: 100 } }),
  ]);

  writeJsonl(path.join(sessionDir, 'subagents', `agent-${A1}.jsonl`), [
    assistantRec({
      timestamp: '2026-09-01T00:00:30.000Z',
      isSidechain: true,
      content: [toolUseBlock('toolu_bash', 'Bash', { command: 'npm test' })],
    }),
    toolResultRec('toolu_bash', { timestamp: '2026-09-01T00:00:35.000Z' }),
    assistantRec({
      timestamp: '2026-09-01T00:01:00.000Z',
      isSidechain: true,
      content: [toolUseBlock('toolu_a2', 'Agent', {
        subagent_type: 'Explore',
        description: 'second',
        prompt: 'look around',
      })],
    }),
  ]);
  writeMeta(A1, {
    agentType: 'general-purpose',
    description: 'first',
    toolUseId: 'toolu_a1',
    spawnDepth: 1,
    model: 'opus',
  });

  writeJsonl(path.join(sessionDir, 'subagents', `agent-${A2}.jsonl`), [
    withModel(assistantRec({ timestamp: '2026-09-01T00:01:10.000Z', isSidechain: true }), 'claude-haiku-4-5'),
  ]);
  writeMeta(A2, {
    agentType: 'Explore',
    description: 'second',
    toolUseId: 'toolu_a2',
    parentAgentId: A1,
    spawnDepth: 2,
  });

  writeJsonl(path.join(sessionDir, 'subagents', `agent-${A3}.jsonl`), [
    assistantRec({ timestamp: '2026-09-01T00:10:05.000Z', isSidechain: true }),
    assistantRec({ timestamp: '2026-09-01T00:11:55.000Z', isSidechain: true }),
  ]);
  // Deliberately no `model`: 15 of 82 real metas have none, and the transcript
  // has to fill the gap.
  writeMeta(A3, {
    agentType: 'feature-dev:code-reviewer',
    description: 'third',
    toolUseId: 'toolu_a3',
    spawnDepth: 1,
  });

  // A third session whose subagent files get deleted while the index still
  // lists them - the race architecture 5-13 documents. Kept separate so no
  // other test depends on files that disappear.
  delSessionDir = path.join(projDir, DEL_SID);
  fs.mkdirSync(path.join(delSessionDir, 'subagents'), { recursive: true });
  writeJsonl(path.join(projDir, `${DEL_SID}.jsonl`), [
    assistantRec({
      timestamp: '2026-09-01T01:00:00.000Z',
      cwd: 'D:\tmp\vanish',
      content: [toolUseBlock('toolu_a4', 'Agent', { subagent_type: 'general-purpose', description: 'stays', prompt: 'stay' })],
    }),
    toolResultRec('toolu_a4', {
      timestamp: '2026-09-01T01:00:01.000Z',
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: A4 },
    }),
    assistantRec({
      timestamp: '2026-09-01T01:01:00.000Z',
      content: [toolUseBlock('toolu_a5', 'Agent', { subagent_type: 'general-purpose', description: 'vanishes', prompt: 'go away' })],
    }),
    toolResultRec('toolu_a5', {
      timestamp: '2026-09-01T01:01:01.000Z',
      toolUseResult: { isAsync: true, status: 'async_launched', agentId: A5 },
    }),
  ]);
  for (const [id, desc] of [[A4, 'stays'], [A5, 'vanishes']]) {
    writeJsonl(path.join(delSessionDir, 'subagents', `agent-${id}.jsonl`), [
      assistantRec({ timestamp: '2026-09-01T01:02:00.000Z', isSidechain: true }),
    ]);
    writeMeta(id, {
      agentType: 'general-purpose',
      description: desc,
      toolUseId: id === A4 ? 'toolu_a4' : 'toolu_a5',
      spawnDepth: 1,
      model: 'sonnet',
    }, delSessionDir);
  }

  // A second, much older session so the `days` window has something to drop.
  const oldFile = path.join(projDir, `${OTHER_SID}.jsonl`);
  writeJsonl(oldFile, [assistantRec({ timestamp: '2026-01-01T00:00:00.000Z', cwd: 'D:\\tmp\\old' })]);
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
  fs.utimesSync(oldFile, old, old);
}

function writeEvents() {
  const now = new Date().toISOString();
  writeJsonl(path.join(eventsDir, `${localDateKey(new Date())}.jsonl`), [
    { receivedAt: now, hook_event_name: 'SessionStart', session_id: SID, cwd: 'D:\\tmp\\treeapi' },
    { receivedAt: now, hook_event_name: 'UserPromptSubmit', session_id: SID, prompt: 'go' },
    // A3 finished for real: the only source that can prove it.
    {
      receivedAt: now,
      hook_event_name: 'SubagentStop',
      session_id: SID,
      agent_id: A3,
      agent_type: '',
      agent_transcript_path: path.join(sessionDir, 'subagents', `agent-${A3}.jsonl`),
    },
    // The measured ghost: one tool event, no lifecycle events, no transcript.
    {
      receivedAt: now,
      hook_event_name: 'PreToolUse',
      session_id: SID,
      agent_id: GHOST,
      tool_name: 'Bash',
      tool_use_id: 'toolu_ghost',
    },
    // DEL_SID: finished, but hooks remember the agent whose files we delete.
    { receivedAt: now, hook_event_name: 'SessionStart', session_id: DEL_SID, cwd: 'D:\tmp\vanish' },
    { receivedAt: now, hook_event_name: 'SubagentStop', session_id: DEL_SID, agent_id: A5, agent_type: '' },
    { receivedAt: now, hook_event_name: 'SessionEnd', session_id: DEL_SID, reason: 'clear' },
  ]);
}

before(async () => {
  tmp = makeTmpDir('cm-treeapi');
  projectsRoot = path.join(tmp.dir, 'projects');
  eventsDir = path.join(tmp.dir, 'events');
  for (const d of [projectsRoot, eventsDir, path.join(tmp.dir, 'statusline'), path.join(tmp.dir, 'sessions')]) {
    fs.mkdirSync(d, { recursive: true });
  }
  writeFixture();
  writeEvents();

  const collector = new Collector({
    eventsDir,
    statuslineDir: path.join(tmp.dir, 'statusline'),
    sessionsDir: path.join(tmp.dir, 'sessions'),
    projectsRoot,
    watch: false,
    readTranscripts: false,
    debounceMs: 5,
  });
  await collector.start();

  handle = await startServer({ port: 0, collector });
  cookie = `${COOKIE_NAME}=${handle.token}`;
});

after(async () => {
  if (handle) {
    await handle.close();
    handle.collector.stop();
  }
  if (tmp) tmp.cleanup();
});

/* ------------------------------- validation ------------------------------ */

describe('id validation', () => {
  test('session ids are UUIDs and nothing else', () => {
    assert.equal(isSessionId(SID), true);
    assert.equal(isSessionId('AAAAAAAA-1111-2222-3333-444444444444'), true);
    for (const bad of ['', 'x', SID.slice(0, -1), `${SID}x`, '../../etc', null, 42, `${SID}\n`]) {
      assert.equal(isSessionId(bad), false, `accepted ${String(bad)}`);
    }
  });

  test('agent ids are exactly 17 hex characters', () => {
    assert.equal(isAgentId(A1), true);
    assert.equal(isAgentId(GHOST), true);
    for (const bad of ['', 'a', A1.slice(0, 16), `${A1}0`, 'g1111111111111111', null]) {
      assert.equal(isAgentId(bad), false, `accepted ${String(bad)}`);
    }
  });

  test('clampInt keeps a bad value out of the range entirely', () => {
    assert.equal(clampInt('7', 30, 1, 90), 7);
    assert.equal(clampInt('0', 30, 1, 90), 1);
    assert.equal(clampInt('9999', 30, 1, 90), 90);
    assert.equal(clampInt('abc', 30, 1, 90), 30);
    assert.equal(clampInt(null, 30, 1, 90), 30);
    assert.equal(clampInt('12.9', 30, 1, 90), 12);
  });
});

/* --------------------------------- auth ---------------------------------- */

describe('the new routes are behind the same door as the old ones', () => {
  test('no cookie is 403 on every tree route', async () => {
    for (const p of ['/api/sessions', `/api/tree/${SID}`, `/api/tools/${SID}`]) {
      const res = await get(p);
      assert.equal(res.status, 403, p);
      assert.equal(res.body.trim(), 'forbidden');
    }
  });

  test('a cross-site Origin is refused even with the cookie', async () => {
    const res = await get(`/api/tree/${SID}`, { headers: { cookie, origin: 'http://evil.example' } });
    assert.equal(res.status, 403);
  });

  test('a rebound Host is refused', async () => {
    const res = await get('/api/sessions', { headers: { cookie, host: 'attacker.test' } });
    assert.equal(res.status, 403);
  });

  test('a cross-site Sec-Fetch-Site is refused', async () => {
    const res = await get('/api/sessions', { headers: { cookie, 'sec-fetch-site': 'cross-site' } });
    assert.equal(res.status, 403);
  });

  test('POST is 405 with an Allow header, never a 404', async () => {
    for (const p of ['/api/sessions', `/api/tree/${SID}`, `/api/tools/${SID}`]) {
      const res = await get(p, { method: 'POST', headers: { cookie } });
      assert.equal(res.status, 405, p);
      assert.equal(res.headers.allow, 'GET, HEAD');
    }
  });

  test('HEAD returns the headers a GET would with no body', async () => {
    // Warm the cache first: `parse.cached` flips false->true and that alone
    // changes the body length by one byte.
    await get(`/api/tree/${SID}`, { headers: { cookie } });
    const g = await get(`/api/tree/${SID}`, { headers: { cookie } });
    const h = await get(`/api/tree/${SID}`, { method: 'HEAD', headers: { cookie } });
    assert.equal(h.status, 200);
    assert.equal(h.body, '');
    assert.equal(h.headers['content-type'], g.headers['content-type']);
    assert.ok(Number(h.headers['content-length']) > 0);
  });
});

/* ------------------------------ /api/sessions ---------------------------- */

describe('GET /api/sessions', () => {
  test('lists the sessions on disk with the fields the list needs', async () => {
    const res = await getJson('/api/sessions');
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.equal(res.json.days, 30);
    const row = res.json.sessions.find((s) => s.sessionId === SID);
    assert.ok(row, 'the fixture session is listed');
    assert.equal(row.cwd, 'D:\\tmp\\treeapi');
    assert.equal(row.subagentCount, 3);
    assert.equal(row.live, true);
    assert.equal(row.phase, 'busy');
    assert.ok(row.sizeBytes > 0);
    assert.match(row.modified, /^\d{4}-\d{2}-\d{2}T/);
  });

  test('live sessions come first, then the rest by modified desc', async () => {
    const res = await getJson('/api/sessions?days=90');
    const ids = res.json.sessions.map((s) => s.sessionId);
    assert.equal(ids[0], SID);
    const flags = res.json.sessions.map((s) => s.live);
    assert.deepEqual(flags, [...flags].sort((a, b) => (a === b ? 0 : a ? -1 : 1)));
    const dead = res.json.sessions.filter((s) => !s.live).map((s) => s.modifiedMs);
    assert.deepEqual(dead, [...dead].sort((a, b) => b - a));
  });

  test('the day window drops what is older than it', async () => {
    const wide = await getJson('/api/sessions?days=90');
    const narrow = await getJson('/api/sessions?days=7');
    assert.ok(wide.json.sessions.some((s) => s.sessionId === OTHER_SID));
    assert.equal(narrow.json.sessions.some((s) => s.sessionId === OTHER_SID), false);
    // A live session is never hidden by the window.
    assert.ok(narrow.json.sessions.some((s) => s.sessionId === SID));
  });

  test('days is clamped, not trusted', async () => {
    assert.equal((await getJson('/api/sessions?days=0')).json.days, 1);
    assert.equal((await getJson('/api/sessions?days=100000')).json.days, 90);
    assert.equal((await getJson('/api/sessions?days=nonsense')).json.days, 30);
    assert.equal((await getJson('/api/sessions?days=-5')).json.days, 1);
  });
});

/* -------------------------------- /api/tree ------------------------------ */

describe('GET /api/tree/<sessionId>', () => {
  test('builds the nested tree and merges all three sources', async () => {
    const res = await getJson(`/api/tree/${SID}`);
    assert.equal(res.status, 200);
    const d = res.json;
    assert.equal(d.sessionId, SID);
    assert.equal(d.root.title, 'tree fixture');
    assert.equal(d.root.cwd, 'D:\\tmp\\treeapi');
    assert.equal(d.root.live, true);

    const ids = d.root.children.map((c) => c.id);
    assert.deepEqual(ids, [A1, A3], 'depth-1 agents, in start order');

    const a1 = d.root.children[0];
    assert.equal(a1.label, 'first（general-purpose）');
    assert.equal(a1.model, 'opus');
    assert.equal(a1.modelSource, 'meta');
    assert.equal(a1.children.length, 1);
    assert.equal(a1.children[0].id, A2, 'the depth-2 agent hangs off A1');
    assert.equal(a1.children[0].spawnDepth, 2);
    assert.equal(a1.promptExcerpt, 'do the first thing');

    // A2 has no model in its meta.json, so the transcript has to supply it.
    assert.equal(a1.children[0].model, 'claude-haiku-4-5');
    assert.equal(a1.children[0].modelSource, 'transcript');

    // A3 got a real SubagentStop, whose agent_type is "" and must not win.
    const a3 = d.root.children[1];
    assert.equal(a3.status, 'completed');
    assert.equal(a3.statusSource, 'hooks:SubagentStop');
    assert.equal(a3.agentType, 'feature-dev:code-reviewer');
    assert.ok(a3.endedAt, 'endedAt comes from the SubagentStop');
    assert.equal(a3.endedAtSource, 'hooks');
  });

  test('the hooks-only ghost shows up as an orphan, not as nothing', async () => {
    const d = (await getJson(`/api/tree/${SID}`)).json;
    const ghost = d.orphans.find((o) => o.id === GHOST);
    assert.ok(ghost, 'the ghost agent is reported');
    assert.equal(ghost.origin, 'hooks');
    assert.equal(ghost.transcriptPath, null);
    assert.ok(['running', 'stale'].includes(ghost.status));
    assert.equal(d.hooksOnly >= 1, true);
  });

  test('parse timings and file counts are reported', async () => {
    const d = (await getJson(`/api/tree/${SID}`)).json;
    assert.equal(d.parse.files, 4);
    assert.ok(d.parse.bytes > 0);
    assert.equal(d.parse.failures, 0);
    assert.equal(typeof d.parse.parseMs, 'number');
  });

  test('a malformed id is 404 JSON, never 400 - no oracle', async () => {
    for (const bad of ['not-a-uuid', 'a'.repeat(36), `${SID}extra`, 'zzzzzzzz-1111-2222-3333-444444444444']) {
      const res = await getJson(`/api/tree/${bad}`);
      assert.equal(res.status, 404, bad);
      assert.equal(res.json.ok, false, bad);
      assert.equal(res.json.error, 'not found');
    }
  });

  test('a traversal segment is rejected by routeKey before the route runs', async () => {
    for (const bad of ['..', '%2e%2e', '..%2f..%2fpackage.json']) {
      const res = await get(`/api/tree/${bad}`, { headers: { cookie } });
      assert.equal(res.status, 404, bad);
      assert.equal(res.body.trim(), 'not found');
    }
  });

  test('a well-formed but unknown id is the same 404', async () => {
    const res = await getJson('/api/tree/deadbeef-0000-0000-0000-000000000000');
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'not found');
  });

  test('a traversal in the id never reaches the filesystem', async () => {
    const res = await get('/api/tree/../../package.json', { headers: { cookie } });
    assert.equal(res.status, 404);
    assert.equal(res.body.includes('claude-monitor'), false);
  });
});

/* ------------------------------- /api/tools ------------------------------ */

describe('GET /api/tools/<sessionId>', () => {
  test('returns the whole session log by default', async () => {
    const res = await getJson(`/api/tools/${SID}`);
    assert.equal(res.status, 200);
    assert.equal(res.json.agentId, null);
    assert.ok(res.json.calls.length >= 3);
    assert.equal(res.json.limit, 100);
  });

  test('narrows to one agent', async () => {
    const res = await getJson(`/api/tools/${SID}?agent=${A1}`);
    const names = res.json.calls.map((c) => c.name);
    assert.deepEqual(names, ['Bash', 'Agent']);
    assert.ok(res.json.calls.every((c) => c.agentId === A1));
    assert.ok(res.json.totalAllAgents > res.json.total);
  });

  test('agent=main is the session thread only', async () => {
    const res = await getJson(`/api/tools/${SID}?agent=main`);
    assert.ok(res.json.calls.every((c) => c.agentId === null));
    assert.deepEqual(res.json.calls.map((c) => c.name), ['Agent', 'Agent']);
  });

  test('limit is clamped and returns the TAIL', async () => {
    assert.equal((await getJson(`/api/tools/${SID}?limit=0`)).json.limit, 1);
    assert.equal((await getJson(`/api/tools/${SID}?limit=99999`)).json.limit, 500);
    assert.equal((await getJson(`/api/tools/${SID}?limit=x`)).json.limit, 100);
    const one = await getJson(`/api/tools/${SID}?limit=1`);
    assert.equal(one.json.calls.length, 1);
    const all = await getJson(`/api/tools/${SID}`);
    assert.equal(one.json.calls[0].id, all.json.calls[all.json.calls.length - 1].id);
  });

  test('a malformed agent id is refused the same way a session id is', async () => {
    const res = await getJson(`/api/tools/${SID}?agent=not-an-agent`);
    assert.equal(res.status, 404);
    assert.equal(res.json.error, 'not found');
  });

  test('an unknown session is 404', async () => {
    const res = await getJson('/api/tools/deadbeef-0000-0000-0000-000000000000');
    assert.equal(res.status, 404);
  });
});

/* --------------------------------- caches -------------------------------- */

describe('the parsed-tree cache', () => {
  test('the fingerprint moves when any byte of any transcript does', () => {
    const index = buildSessionIndex({ days: 0, root: projectsRoot, withCwd: false });
    const entry = index.sessions.find((s) => s.sessionId === SID);
    const before = fingerprint(entry);
    assert.equal(fingerprint({ ...entry }), before, 'stable for the same stats');

    const grown = { ...entry, size: entry.size + 1 };
    assert.notEqual(fingerprint(grown), before);

    const touched = { ...entry, mtimeMs: entry.mtimeMs + 1000 };
    assert.notEqual(fingerprint(touched), before);

    const subGrew = {
      ...entry,
      subagents: entry.subagents.map((s, i) => (i === 0 ? { ...s, size: s.size + 1 } : s)),
    };
    assert.notEqual(fingerprint(subGrew), before, 'a subagent append counts too');

    const metaGone = {
      ...entry,
      subagents: entry.subagents.map((s, i) => (i === 0 ? { ...s, metaPath: null } : s)),
    };
    assert.notEqual(fingerprint(metaGone), before, 'a new/removed meta.json counts too');

    // Order of the subagent list must not matter.
    const shuffled = { ...entry, subagents: [...entry.subagents].reverse() };
    assert.equal(fingerprint(shuffled), before);
  });

  test('a hit is served from the cache and a changed mtime is not', () => {
    const idx = new SessionIndexCache({ root: projectsRoot, ttlMs: 0 });
    const cache = new TreeCache();
    const entry = idx.entry(SID);

    const first = cache.parsed(entry);
    assert.equal(first.cached, false);
    assert.equal(cache.misses, 1);

    const second = cache.parsed(entry);
    assert.equal(second.cached, true);
    assert.equal(cache.hits, 1);

    const moved = { ...entry, mtimeMs: entry.mtimeMs + 5000 };
    const third = cache.parsed(moved);
    assert.equal(third.cached, false);
    assert.equal(cache.misses, 2);
  });

  test('it never grows past its LRU bound and drops the oldest first', () => {
    const idx = new SessionIndexCache({ root: projectsRoot, ttlMs: 0 });
    const cache = new TreeCache({ max: 2 });
    const entry = idx.entry(SID);
    for (const id of ['s1', 's2', 's3']) cache.parsed({ ...entry, sessionId: id });
    assert.equal(cache.size, 2);
    assert.equal(cache.entries.has('s1'), false);
    assert.equal(cache.entries.has('s3'), true);
  });

  test('the huge tool_use inputs are dropped before anything is cached', () => {
    const idx = new SessionIndexCache({ root: projectsRoot, ttlMs: 0 });
    const cache = new TreeCache();
    const parsed = cache.parsed(idx.entry(SID));
    assert.equal(parsed.tree.toolUseIndex, null);
    assert.equal(parsed.tree.toolResultIndex, null);
    // ...but what the merge needs survived.
    assert.equal(parsed.spawns.get('toolu_a1').prompt, 'do the first thing');
    assert.ok(parsed.lastToolAt.get(A1));
  });

  test('the tool log is built lazily and then cached', () => {
    const idx = new SessionIndexCache({ root: projectsRoot, ttlMs: 0 });
    const cache = new TreeCache();
    const entry = idx.entry(SID);
    assert.equal(cache.parsed(entry).tree.stats.parseFailures, 0);
    assert.equal(cache.entries.get(SID).toolLog, null, 'not built by parsing alone');
    const first = cache.toolLog(entry);
    assert.equal(first.cached, false);
    assert.equal(cache.toolLog(entry).cached, true);
  });
});

describe('the session index cache', () => {
  test('it rebuilds only after the TTL has passed', () => {
    let now = 1000;
    const idx = new SessionIndexCache({ root: projectsRoot, ttlMs: 100, now: () => now });
    idx.get();
    idx.get();
    assert.equal(idx.builds, 1);
    now += 101;
    idx.get();
    assert.equal(idx.builds, 2);
    idx.get(true);
    assert.equal(idx.builds, 3, 'force skips the TTL');
  });

  test('an unknown id resolves to null rather than throwing', () => {
    const idx = new SessionIndexCache({ root: projectsRoot });
    assert.equal(idx.entry('deadbeef-0000-0000-0000-000000000000'), null);
  });
});

describe('hook history for sessions the collector does not follow', () => {
  test('it folds the events and marks a silent agent stale', () => {
    const hh = new HookHistory({ dir: eventsDir, ttlMs: 0, now: () => Date.now() });
    const s = hh.session(SID);
    assert.ok(s, 'the session is known from its events alone');
    const a3 = s.agents.find((a) => a.agentId === A3);
    assert.equal(a3.status, 'completed');
    assert.equal(a3.statusSource, 'hooks');
    const ghost = s.agents.find((a) => a.agentId === GHOST);
    assert.ok(ghost, 'the ghost is tracked');
  });

  test('a session no event ever mentioned is null, not an empty invention', () => {
    const hh = new HookHistory({ dir: eventsDir, ttlMs: 0 });
    assert.equal(hh.session('deadbeef-0000-0000-0000-000000000000'), null);
  });

  test('a missing events dir is survivable', () => {
    const hh = new HookHistory({ dir: path.join(tmp.dir, 'no-such-dir'), ttlMs: 0 });
    assert.equal(hh.session(SID), null);
    assert.equal(hh.stats().sessions, 0);
  });

  test('the TTL keeps it from re-reading on every request', () => {
    let now = 0;
    const hh = new HookHistory({ dir: eventsDir, ttlMs: 1000, now: () => now });
    hh.refresh();
    hh.refresh();
    assert.equal(hh.refreshes, 1);
    now = 1001;
    hh.refresh();
    assert.equal(hh.refreshes, 2);
  });

  test('it opens only the day files the caller asked for', () => {
    // Nothing bounded this read: at the measured 7MB/day the first /api/tree
    // opened every day file ever written. The caller now names the days.
    const opened = [];
    const hh = new HookHistory({ dir: eventsDir, ttlMs: 0 });
    const realReadDay = hh.ingest.readDay.bind(hh.ingest);
    hh.ingest.readDay = (dateKey) => { opened.push(dateKey); return realReadDay(dateKey); };

    const day = localDateKey(new Date());
    hh.refresh({ dates: [day] });
    assert.deepEqual(opened, [day], 'exactly the one day it was given');

    // A day it has never opened is read even inside the TTL...
    const hh2 = new HookHistory({ dir: eventsDir, ttlMs: 60000, now: () => 0 });
    const seen = [];
    const real2 = hh2.ingest.readDay.bind(hh2.ingest);
    hh2.ingest.readDay = (dateKey) => { seen.push(dateKey); return real2(dateKey); };
    hh2.refresh({ dates: ['2026-01-01'] });
    hh2.refresh({ dates: ['2026-01-01'] });
    assert.deepEqual(seen, ['2026-01-01'], 'a repeat inside the TTL costs nothing');
    hh2.refresh({ dates: ['2026-01-02'] });
    assert.deepEqual(seen, ['2026-01-01', '2026-01-02'], 'a NEW day is read despite the TTL');
    // ...and once the TTL lapses, every day it knows about is re-read.
    const hh3 = new HookHistory({ dir: eventsDir, ttlMs: 0 });
    const seen3 = [];
    const real3 = hh3.ingest.readDay.bind(hh3.ingest);
    hh3.ingest.readDay = (d) => { seen3.push(d); return real3(d); };
    hh3.refresh({ dates: ['2026-01-01'] });
    hh3.refresh({ dates: ['2026-01-02'] });
    assert.deepEqual(seen3, ['2026-01-01', '2026-01-01', '2026-01-02']);
  });

  test('session() with no span falls back to a short window, not the whole directory', () => {
    const opened = [];
    const hh = new HookHistory({ dir: eventsDir, ttlMs: 0 });
    const real = hh.ingest.readDay.bind(hh.ingest);
    hh.ingest.readDay = (d) => { opened.push(d); return real(d); };
    assert.ok(hh.session(SID), 'today is inside the fallback window');
    assert.equal(opened.length, HOOK_HISTORY_FALLBACK_DAYS);
    assert.equal(opened[opened.length - 1], localDateKey(new Date()));
  });
});

describe('datesForSpan', () => {
  const DAY = 24 * 3600 * 1000;
  const now = new Date(2026, 8, 20, 12, 0, 0).getTime();

  test('a span becomes its own days plus one either side', () => {
    const from = new Date(2026, 8, 17, 9, 0, 0).getTime();
    const to = new Date(2026, 8, 18, 9, 0, 0).getTime();
    assert.deepEqual(datesForSpan({ from, to }, now),
      ['2026-09-16', '2026-09-17', '2026-09-18', '2026-09-19']);
  });

  test('ISO strings work as well as epoch ms, and one end is enough', () => {
    const iso = new Date(2026, 8, 19, 8, 0, 0).toISOString();
    assert.deepEqual(datesForSpan({ from: iso, to: null }, now), ['2026-09-18', '2026-09-19', '2026-09-20']);
  });

  test('no span at all is the fallback window ending today', () => {
    const out = datesForSpan(null, now);
    assert.equal(out.length, HOOK_HISTORY_FALLBACK_DAYS);
    assert.equal(out[out.length - 1], '2026-09-20');
  });

  test('a span reaching into the future stops at now, and a huge one is capped', () => {
    const future = datesForSpan({ from: now, to: now + 30 * DAY }, now);
    assert.equal(future[future.length - 1], '2026-09-20', 'nothing was written after now');
    const huge = datesForSpan({ from: now - 400 * DAY, to: now }, now);
    assert.ok(huge.length <= HOOK_HISTORY_MAX_DAYS, `capped, got ${huge.length}`);
    assert.equal(huge[huge.length - 1], '2026-09-20', 'the NEWEST days are the ones kept');
  });
});

/* ------------------------------ resilience ------------------------------- */

describe('a failure inside a tree route does not take the server down', () => {
  test('a throwing cache answers 500 JSON and the next request still works', async () => {
    const errors = [];
    const boom = new TreeCache();
    boom.parsed = () => { throw new Error('synthetic parse failure'); };
    const local = await startServer({
      port: 0,
      collector: handle.collector,
      treeCache: boom,
      indexCache: new SessionIndexCache({ root: projectsRoot }),
      onError: (where, err) => errors.push([where, err.message]),
    });
    try {
      const c = `${COOKIE_NAME}=${local.token}`;
      const res = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: local.port, path: `/api/tree/${SID}`, headers: { cookie: c } },
          (r) => {
            const chunks = [];
            r.on('data', (x) => chunks.push(x));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(res.status, 500);
      assert.deepEqual(JSON.parse(res.body), { ok: false, error: 'internal error' });
      assert.equal(errors.length, 1);
      assert.equal(errors[0][0], 'api:tree');

      // Still listening, still answering.
      const health = await new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: local.port, path: '/api/health', headers: { cookie: c } },
          (r) => {
            const chunks = [];
            r.on('data', (x) => chunks.push(x));
            r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
          },
        );
        req.on('error', reject);
        req.end();
      });
      assert.equal(health.status, 200);
      assert.ok(JSON.parse(health.body).treeCache);
    } finally {
      await local.close();
    }
  });
});

/* ---------------------- the view functions on their own ------------------ */

describe('listSessionsView', () => {
  test('a live session with no transcript yet is still listed, first', () => {
    const rows = listSessionsView({
      index: { sessions: [] },
      snapshot: { sessions: [{ sessionId: SID, title: 'brand new', phase: 'busy', phaseSource: 'hooks', cwd: 'D:\\x', agents: [] }] },
      days: 30,
    });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].live, true);
    assert.equal(rows[0].hasTranscript, false);
    assert.equal(rows[0].title, 'brand new');
  });

  test('an ended session in the snapshot is not counted as live', () => {
    const idx = buildSessionIndex({ days: 0, root: projectsRoot, withCwd: true });
    const rows = listSessionsView({
      index: idx,
      snapshot: { sessions: [{ sessionId: SID, phase: 'ended', phaseSource: 'hooks', agents: [] }] },
      days: 90,
    });
    assert.equal(rows.find((r) => r.sessionId === SID).live, false);
  });

  test('no snapshot at all is survivable', () => {
    const idx = buildSessionIndex({ days: 0, root: projectsRoot, withCwd: true });
    const rows = listSessionsView({ index: idx, snapshot: null, days: 90 });
    assert.ok(rows.length >= 2);
    assert.ok(rows.every((r) => r.live === false));
  });
});

/**
 * START and END on the left-hand list.
 *
 * The index half is synthesized inline rather than read off disk: the point of
 * these is the PRIORITY between four sources, and a fixture that has to produce
 * all four on disk would hide the very thing being pinned.
 */
describe('listSessionsView: when a session ran, and how we know', () => {
  const FIRST = '2026-09-01T00:00:00.000Z';
  const LAST = '2026-09-01T01:00:00.000Z';
  const MTIME = Date.UTC(2026, 8, 1, 2, 0, 0);
  const HOOK_START = '2026-08-31T23:00:00.000Z';
  const HOOK_END = '2026-09-01T01:30:00.000Z';
  const SESSIONS_START = '2026-08-31T22:00:00.000Z';

  const entry = (over = {}) => ({
    sessionId: SID,
    projectPath: 'D:\p',
    projectDirName: 'D--p',
    cwd: 'D:\p',
    firstTs: FIRST,
    lastTs: LAST,
    mtimeMs: MTIME,
    size: 100,
    subagents: [],
    ...over,
  });
  // phaseSource travels with phase in every real snapshot (toPublicSession
  // emits both) and state.isLive reads it, so the fixture must carry it too.
  const snap = (over) => (over === null
    ? null
    : { sessions: [{ sessionId: SID, agents: [], phaseSource: 'hooks', ...over }] });
  const row = (entryOver, sessionOver) =>
    listSessionsView({ index: { sessions: [entry(entryOver)] }, snapshot: snap(sessionOver), days: 0 })[0];

  test('startedAt: hooks > sessions/<pid>.json > transcript', () => {
    const transcript = row({}, null);
    assert.equal(transcript.startedAt, FIRST);
    assert.equal(transcript.startedAtSource, 'transcript');

    const fromSessions = row({}, {
      phase: 'ended', startedAt: SESSIONS_START, startedAtSource: 'sessions',
    });
    assert.equal(fromSessions.startedAt, SESSIONS_START);
    assert.equal(fromSessions.startedAtSource, 'sessions');

    const fromHooks = row({}, { phase: 'ended', startedAt: HOOK_START, startedAtSource: 'hooks' });
    assert.equal(fromHooks.startedAt, HOOK_START);
    assert.equal(fromHooks.startedAtSource, 'hooks');
  });

  test('endedAt: hooks SessionEnd > transcript last record > file mtime', () => {
    const fromMtime = row({ lastTs: null }, null);
    assert.equal(fromMtime.endedAt, new Date(MTIME).toISOString());
    assert.equal(fromMtime.endedAtSource, 'mtime');

    const fromTranscript = row({}, null);
    assert.equal(fromTranscript.endedAt, LAST);
    assert.equal(fromTranscript.endedAtSource, 'transcript');

    const fromHooks = row({}, { phase: 'ended', endedAt: HOOK_END, endedAtSource: 'hooks' });
    assert.equal(fromHooks.endedAt, HOOK_END);
    assert.equal(fromHooks.endedAtSource, 'hooks');
  });

  test('a LIVE session has no end time at all - not its last record, not its mtime', () => {
    for (const phase of ['busy', 'idle', 'waiting_input', 'compacting', 'unknown']) {
      const r = row({}, { phase, phaseSource: 'hooks' });
      assert.equal(r.live, true, phase);
      assert.equal(r.endedAt, null, phase);
      assert.equal(r.endedAtSource, null, phase);
      assert.equal(r.durationMs, null, phase);
    }
  });

  test('a stale endedAt left over from a previous run is not shown while live', () => {
    const r = row({}, { phase: 'busy', endedAt: HOOK_END, endedAtSource: 'hooks' });
    assert.equal(r.endedAt, null);
  });

  test('an ended session gets durationMs from the pair actually shown', () => {
    const r = row({}, { phase: 'ended', startedAt: HOOK_START, startedAtSource: 'hooks' });
    assert.equal(r.startedAt, HOOK_START);
    assert.equal(r.endedAt, LAST);
    assert.equal(r.durationMs, Date.parse(LAST) - Date.parse(HOOK_START));
  });

  test('a live session with no transcript yet still carries its start and no end', () => {
    const rows = listSessionsView({
      index: { sessions: [] },
      snapshot: snap({ phase: 'busy', phaseSource: 'hooks', startedAt: HOOK_START, startedAtSource: 'hooks' }),
      days: 30,
    });
    assert.equal(rows[0].startedAt, HOOK_START);
    assert.equal(rows[0].startedAtSource, 'hooks');
    assert.equal(rows[0].endedAt, null);
    assert.equal(rows[0].endedAtSource, null);
  });

  test('an end before its start is clamped up, keeping both sources', () => {
    // The residual case the min/max scans cannot reach: the start comes from a
    // hooks SessionStart (a RESUME, so later than anything in the file) and the
    // end from the transcript. Measured shape: a 1ms inversion.
    const r = row({ lastTs: '2026-09-02T12:40:55.265Z' }, {
      phase: 'ended',
      startedAt: '2026-09-02T12:40:55.266Z',
      startedAtSource: 'hooks',
    });
    assert.equal(r.startedAt, '2026-09-02T12:40:55.266Z');
    assert.equal(r.startedAtSource, 'hooks');
    assert.equal(r.endedAt, r.startedAt, 'clamped up to the start, not dropped');
    assert.equal(r.endedAtSource, 'transcript', 'the source is still the honest answer');
    assert.equal(r.durationMs, 0, 'never negative, and never null for a pair that exists');
  });

  test('clampSpan on its own', () => {
    assert.deepEqual(clampSpan('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:01.000Z'),
      { endedAt: '2026-09-01T00:00:01.000Z', durationMs: 1000 });
    assert.deepEqual(clampSpan('2026-09-01T00:00:01.000Z', '2026-09-01T00:00:00.000Z'),
      { endedAt: '2026-09-01T00:00:01.000Z', durationMs: 0 });
    assert.deepEqual(clampSpan('2026-09-01T00:00:00.000Z', null), { endedAt: null, durationMs: null });
    assert.deepEqual(clampSpan(null, '2026-09-01T00:00:00.000Z'),
      { endedAt: '2026-09-01T00:00:00.000Z', durationMs: null });
    assert.deepEqual(clampSpan('nonsense', '2026-09-01T00:00:00.000Z'),
      { endedAt: '2026-09-01T00:00:00.000Z', durationMs: null });
  });

  test('nothing to go on at all: both sides are null, not a fabricated time', () => {
    const r = row({ firstTs: null, lastTs: null, mtimeMs: NaN }, null);
    assert.equal(r.startedAt, null);
    assert.equal(r.startedAtSource, null);
    assert.equal(r.endedAt, null);
    assert.equal(r.endedAtSource, null);
    assert.equal(r.durationMs, null);
  });
});

describe('buildTreeView / toolLogView without a server', () => {
  test('they work with no hook evidence at all', () => {
    const idx = new SessionIndexCache({ root: projectsRoot, ttlMs: 0 });
    const cache = new TreeCache();
    const entry = idx.entry(SID);
    const view = buildTreeView({ entry, cache, hookSession: null });
    assert.equal(view.hooksOnly, 0, 'no hooks means no hooks-only agents');
    assert.equal(view.agentCount, 3);
    // Without a SubagentStop the transcript is all we have; A3 was spawned
    // synchronously and its tool_result says completed.
    const a3 = view.root.children.find((c) => c.id === A3);
    assert.equal(a3.status, 'completed');
    assert.equal(a3.statusSource, 'jsonl:tool-result-status');
    // A1 was launched asynchronously: the transcript cannot say whether it ended.
    const a1 = view.root.children.find((c) => c.id === A1);
    assert.equal(a1.status, 'async-unknown');

    const log = toolLogView({ entry, cache, agentId: A2, limit: 10 });
    assert.equal(log.total, 0, 'A2 called no tools');
    assert.deepEqual(log.calls, []);
  });
});

describe('review fix 1: a meta.json written after the index was cached', () => {
  test('the new name shows up without waiting for the index TTL', () => {
    // A long TTL means the cached SessionEntry will NEVER learn about the new
    // file on its own - which is exactly the situation the fix is about.
    const idx = new SessionIndexCache({ root: projectsRoot, ttlMs: 60 * 60 * 1000 });
    const cache = new TreeCache();
    const metaPath = path.join(sessionDir, 'subagents', `agent-${A2}.meta.json`);
    const original = fs.readFileSync(metaPath, 'utf8');
    fs.unlinkSync(metaPath);

    const entry = idx.entry(SID);
    assert.equal(entry.subagents.find((s) => s.agentId === A2).metaPath, null,
      'the cached entry was taken while the meta.json was missing');

    // Anywhere in the answer: without its meta.json, A2 has no toolUseId and
    // no parentAgentId, so it cannot be placed under A1 - that part needs a
    // re-parse. The NAME is what the meta re-read can fix straight away.
    const findAnywhere = (view, id) => {
      const stack = [view.root, ...view.orphans];
      while (stack.length) {
        const n = stack.pop();
        if (n.id === id) return n;
        for (const c of n.children || []) stack.push(c);
      }
      return null;
    };

    const before = buildTreeView({ entry, cache, hookSession: null });
    const a2Before = findAnywhere(before, A2);
    assert.ok(a2Before, 'A2 is in the tree somewhere');
    assert.equal(a2Before.description, null);
    assert.equal(a2Before.label, A2.slice(0, 8), 'nothing to call it by yet');

    try {
      fs.writeFileSync(metaPath, original, 'utf8');
      // Same cached entry, same TreeCache: only the meta re-read can help.
      const after = buildTreeView({ entry, cache, hookSession: null });
      const a2After = findAnywhere(after, A2);
      assert.equal(a2After.description, 'second');
      assert.equal(a2After.agentType, 'Explore');
      assert.equal(a2After.descriptionSource, 'meta');
      assert.equal(a2After.label, 'second（Explore）');
      // This meta.json has no `model`, so the transcript still supplies it.
      assert.equal(a2After.model, 'claude-haiku-4-5');
      assert.equal(a2After.modelSource, 'transcript');
      assert.equal(idx.builds, 1, 'the index was not rebuilt - the metas were re-read');
    } finally {
      fs.writeFileSync(metaPath, original, 'utf8');
    }
  });
});

describe('review fix 2: a subagent that vanishes while the index still lists it', () => {
  let staleEntry;

  test('buildTreeView survives files deleted under a cached entry', () => {
    const idx = new SessionIndexCache({ root: projectsRoot, ttlMs: 60 * 60 * 1000 });
    staleEntry = idx.entry(DEL_SID);
    assert.equal(staleEntry.subagents.length, 2, 'both agents were on disk when the index ran');

    // Claude Code deletes a finished subagent's transcript AND its meta.json
    // (architecture 5-13, measured: 30 of 31 agents in one real session).
    fs.unlinkSync(path.join(delSessionDir, 'subagents', `agent-${A5}.jsonl`));
    fs.unlinkSync(path.join(delSessionDir, 'subagents', `agent-${A5}.meta.json`));

    const view = buildTreeView({ entry: staleEntry, cache: new TreeCache(), hookSession: null });
    assert.equal(view.ok, true);
    // The agent that is still there is intact, with its name.
    const a4 = view.root.children.find((c) => c.id === A4);
    assert.ok(a4, 'the surviving agent is still in the tree');
    assert.equal(a4.label, 'stays（general-purpose）');
    // The deleted one is still a node (the index said so) but has lost its
    // name and its bytes - and NOTHING threw.
    const a5 = view.root.children.find((c) => c.id === A5);
    assert.ok(a5, 'the vanished agent is still listed by the stale index');
    assert.equal(a5.description, null, 'its meta.json is gone');
    assert.equal(a5.tokens.total, 0);
    assert.ok(view.parse.failures >= 0);
  });

  test('a fresh index simply drops it, and hooks keep it visible', () => {
    const idx = new SessionIndexCache({ root: projectsRoot, ttlMs: 0 });
    const entry = idx.entry(DEL_SID);
    assert.equal(entry.subagents.length, 1, 'the deleted agent is gone from the index');

    const hookSession = new HookHistory({ dir: eventsDir, ttlMs: 0 }).session(DEL_SID);
    assert.ok(hookSession, 'hooks still remember this session');
    const view = buildTreeView({ entry, cache: new TreeCache(), hookSession });
    assert.equal(view.root.children.length, 1);
    assert.equal(view.root.children[0].id, A4);
    // The vanished agent survives as a hooks-only orphan rather than silently
    // disappearing from the picture.
    const a5 = view.orphans.find((o) => o.id === A5);
    assert.ok(a5, 'the vanished agent is still reported, from hooks');
    assert.equal(a5.origin, 'hooks');
    assert.equal(a5.status, 'completed');
    assert.equal(a5.statusSource, 'hooks:SubagentStop');
    assert.equal(view.hooksOnly, 1);
  });

  test('over HTTP it is a 200 and the server stays up', async () => {
    const tree = await getJson(`/api/tree/${DEL_SID}`);
    assert.equal(tree.status, 200);
    assert.equal(tree.json.ok, true);
    const everywhere = [...tree.json.root.children, ...tree.json.orphans].map((n) => n.id);
    assert.ok(everywhere.includes(A4), 'the surviving agent is shown');
    assert.ok(everywhere.includes(A5), 'the vanished one is shown from hooks');

    // The tool log walks the same missing files.
    const tools = await getJson(`/api/tools/${DEL_SID}`);
    assert.equal(tools.status, 200);
    assert.equal(tools.json.ok, true);

    // Still listening, still answering, and the failure was not counted as a
    // crash of ours.
    const health = await getJson('/api/health');
    assert.equal(health.status, 200);
    assert.equal(health.json.ok, true);
    const sessions = await getJson('/api/sessions?days=90');
    assert.equal(sessions.status, 200);
    assert.ok(sessions.json.sessions.some((s) => s.sessionId === DEL_SID));
  });
});
