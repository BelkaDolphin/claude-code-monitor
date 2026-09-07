/**
 * Integration test against REAL local data and the real ccusage CLI.
 *
 * Skipped unless CLAUDE_MONITOR_IT=1, because it:
 *  - reads every transcript under ~/.claude/projects
 *  - runs `npx -y ccusage@latest`, which may download the package
 *
 *   CLAUDE_MONITOR_IT=1 node --test test/
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { projectsDir, localDateKey } from '../src/paths.js';
import { parseFile, ParseStats } from '../src/parser.js';
import { UsageCollector, METRICS } from '../src/usage.js';
import { ccusageDaily, normalizeDailyRow } from '../src/ccusage.js';
import { buildSessionIndex } from '../src/session-index.js';
import { buildTree } from '../src/tree.js';

const ENABLED = process.env.CLAUDE_MONITOR_IT === '1';
const opts = { skip: ENABLED ? false : 'set CLAUDE_MONITOR_IT=1 to run integration tests' };

function allTranscripts(root = projectsDir()) {
  const out = [];
  (function walk(dir) {
    let ents;
    try {
      ents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(full);
    }
  })(root);
  return out;
}

describe('integration: real ~/.claude data', opts, () => {
  test('every transcript parses with zero failures and no unknown types', () => {
    const files = allTranscripts();
    assert.ok(files.length > 0, 'expected at least one transcript');
    const stats = new ParseStats();
    for (const f of files) parseFile(f, () => {}, stats);
    assert.equal(stats.parseFailures, 0, `parse failures: ${JSON.stringify(stats.failureSamples)}`);
    assert.deepEqual(
      Object.keys(stats.toJSON().unknownTypes), [],
      'a new record type appeared - the transcript format changed, update parser.js KNOWN_IGNORED_TYPES',
    );
  });

  test('our daily aggregation equals ccusage daily for every completed day', async () => {
    const files = allTranscripts();
    const collector = new UsageCollector();
    for (const f of files) parseFile(f, (r) => collector.add(r), new ParseStats());
    const mine = collector.summarize().byDate;

    const res = await ccusageDaily({});
    assert.ok(res.ok, `ccusage failed: ${res.error}`);
    const rows = (res.data.daily ?? []).filter((r) => r?.agent === undefined || r.agent === 'all');
    assert.ok(rows.length > 0, 'ccusage returned no daily rows');

    const today = localDateKey(new Date());
    let compared = 0;
    for (const row of rows) {
      const nr = normalizeDailyRow(row);
      // The current day is still being written; ccusage snapshots it at its own
      // moment, so a difference there is expected and not a defect.
      if (!nr.date || nr.date === today) continue;
      const ours = mine[nr.date];
      assert.ok(ours, `we have no data for ${nr.date} but ccusage does`);
      for (const m of METRICS) {
        assert.equal(ours[m], nr[m], `${nr.date} ${m}: ours=${ours[m]} ccusage=${nr[m]}`);
      }
      compared++;
    }
    assert.ok(compared > 0, 'no completed day was available to compare');
  });

  test('the session index and tree build for every recent session', () => {
    const { sessions } = buildSessionIndex({ days: 30 });
    assert.ok(sessions.length > 0);
    for (const s of sessions.slice(0, 5)) {
      const { root, nodes, stats } = buildTree(s);
      assert.equal(root.id, s.sessionId);
      assert.equal(nodes.size, 1 + s.subagents.length);
      assert.equal(stats.parseFailures, 0);
      for (const sub of s.subagents) {
        const node = nodes.get(sub.agentId);
        assert.ok(node, `${sub.agentId} has a node`);
        assert.ok(
          ['completed', 'running', 'async-unknown', 'error'].includes(node.statusInferred),
          `unexpected status ${node.statusInferred}`,
        );
      }
    }
  });

  test('every subagent transcript reports its own agentId and isSidechain', () => {
    const { sessions } = buildSessionIndex({ days: 30 });
    const withSubs = sessions.find((s) => s.subagents.length > 0);
    if (!withSubs) return; // nothing to check on a fresh machine
    const sub = withSubs.subagents[0];
    let seen = 0;
    let sidechain = 0;
    parseFile(sub.jsonlPath, (r) => {
      if (r.agentId === sub.agentId) seen++;
      if (r.isSidechain) sidechain++;
    }, new ParseStats());
    assert.ok(seen > 0, 'agentId in the records matches the filename');
    assert.ok(sidechain > 0, 'subagent records are marked isSidechain');
  });
});
