import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { planInstall, planUninstall, applySettings, hookCommand, statuslineCommand } from '../src/installer.js';
import { TRACKED_EVENTS } from '../src/hooks-ingest.js';
import { makeTmpDir } from './helpers.js';

/** The user's real settings shape, including a pre-existing SessionEnd hook. */
function existingSettings() {
  return {
    permissions: { allow: ['Bash(flake8:*)', 'Bash(cmd /c:*)', 'mcp__pencil'] },
    hooks: {
      SessionEnd: [{
        hooks: [{
          type: 'command',
          command: 'powershell -NoProfile -ExecutionPolicy Bypass -File "C:\\Users\\alice\\.claude\\bin\\session_end.ps1"',
        }],
      }],
    },
    enabledPlugins: { 'feature-dev@claude-plugins-official': true },
    language: '小悪魔的でちょいツンデレな京都弁を話すJK',
    effortLevel: 'xhigh',
    model: 'claude-fable-5-1[1m]',
  };
}

describe('planInstall', () => {
  test('preserves the pre-existing SessionEnd hook', () => {
    const { next } = planInstall(existingSettings());
    const cmds = next.hooks.SessionEnd.flatMap((e) => e.hooks.map((h) => h.command));
    assert.equal(cmds.length, 2);
    assert.ok(cmds.some((c) => c.includes('session_end.ps1')), 'the user hook survives');
    assert.ok(cmds.includes(hookCommand()));
  });

  test('preserves every unrelated key verbatim', () => {
    const before = existingSettings();
    const { next } = planInstall(before);
    assert.deepEqual(next.permissions, before.permissions);
    assert.deepEqual(next.enabledPlugins, before.enabledPlugins);
    assert.equal(next.language, before.language);
    assert.equal(next.model, before.model);
    assert.equal(next.effortLevel, before.effortLevel);
  });

  test('does not mutate the input object', () => {
    const before = existingSettings();
    const snapshot = JSON.stringify(before);
    planInstall(before);
    assert.equal(JSON.stringify(before), snapshot);
  });

  test('registers every tracked event exactly once', () => {
    const { next, added } = planInstall(existingSettings());
    assert.deepEqual(added.sort(), [...TRACKED_EVENTS].sort());
    for (const ev of TRACKED_EVENTS) {
      const hits = next.hooks[ev].flatMap((e) => e.hooks).filter((h) => h.command === hookCommand());
      assert.equal(hits.length, 1, `${ev} has exactly one of our hooks`);
    }
  });

  test('SessionEnd is synchronous, every other event is async', () => {
    // SessionEnd hooks share a 1.5s budget; a backgrounded process could lose
    // the event during teardown, so it must run inline.
    const { next } = planInstall(existingSettings());
    const ours = (ev) => next.hooks[ev].flatMap((e) => e.hooks).find((h) => h.command === hookCommand());
    assert.equal(ours('SessionEnd').async, undefined);
    assert.equal(ours('SessionEnd').timeout, 5);
    assert.equal(ours('Stop').async, true);
    assert.equal(ours('PreToolUse').async, true);
  });

  test('is idempotent: a second install adds nothing', () => {
    const first = planInstall(existingSettings());
    const second = planInstall(first.next);
    assert.deepEqual(second.added, []);
    assert.deepEqual(second.skipped.sort(), [...TRACKED_EVENTS].sort());
    assert.equal(JSON.stringify(second.next), JSON.stringify(first.next));
  });

  test('sets statusLine', () => {
    const { next, statusLine } = planInstall(existingSettings());
    assert.equal(statusLine, 'added');
    assert.deepEqual(next.statusLine, { type: 'command', command: statuslineCommand() });
  });

  test('works from an empty or missing settings file', () => {
    const { next } = planInstall(null);
    assert.ok(next.hooks.SessionStart);
    assert.ok(next.statusLine);
  });
});

describe('planUninstall', () => {
  test('removes only our hooks and leaves the user hook intact', () => {
    const installed = planInstall(existingSettings()).next;
    const { next, removed, statusLine } = planUninstall(installed);
    assert.ok(removed.includes('SessionEnd'));
    assert.equal(statusLine, 'removed');
    assert.equal(next.statusLine, undefined);
    const cmds = next.hooks.SessionEnd.flatMap((e) => e.hooks.map((h) => h.command));
    assert.deepEqual(cmds, [existingSettings().hooks.SessionEnd[0].hooks[0].command]);
  });

  test('round-trips back to the original settings', () => {
    const original = existingSettings();
    const restored = planUninstall(planInstall(original).next).next;
    assert.deepEqual(restored, original);
  });

  test('does not remove a foreign statusLine', () => {
    const s = { ...existingSettings(), statusLine: { type: 'command', command: 'some-other-script' } };
    const { next, statusLine } = planUninstall(s);
    assert.equal(statusLine, 'unchanged');
    assert.deepEqual(next.statusLine, s.statusLine);
  });

  test('uninstalling when nothing is installed is a no-op', () => {
    const s = existingSettings();
    assert.deepEqual(planUninstall(s).next, s);
  });
});

describe('applySettings', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('installer'); });
  after(() => tmp.cleanup());

  test('--dry-run writes nothing', () => {
    const file = path.join(tmp.dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify(existingSettings(), null, 2), 'utf8');
    const before = fs.readFileSync(file, 'utf8');
    const res = applySettings('install', { dryRun: true, settingsFile: file });
    assert.equal(res.dryRun, true);
    assert.equal(res.backupFile, null);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'file untouched');
    assert.match(res.json, /monitor-hook\.js/);
  });

  test('a real install backs up first, then writes', () => {
    const file = path.join(tmp.dir, 'settings2.json');
    fs.writeFileSync(file, JSON.stringify(existingSettings(), null, 2), 'utf8');
    const res = applySettings('install', { settingsFile: file });
    assert.ok(res.backupFile, 'a backup was made');
    assert.ok(fs.existsSync(res.backupFile));
    assert.deepEqual(JSON.parse(fs.readFileSync(res.backupFile, 'utf8')), existingSettings());

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(written.statusLine);
    assert.equal(written.hooks.SessionEnd.length, 2);

    // Second install: no change, so no new backup either.
    const again = applySettings('install', { settingsFile: file });
    assert.equal(again.unchanged, true);
    assert.equal(again.backupFile, null);

    // Uninstall restores the original content.
    applySettings('uninstall', { settingsFile: file });
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), existingSettings());
  });

  test('the written JSON keeps non-ASCII settings readable', () => {
    const file = path.join(tmp.dir, 'settings3.json');
    fs.writeFileSync(file, JSON.stringify(existingSettings(), null, 2), 'utf8');
    applySettings('install', { settingsFile: file });
    const text = fs.readFileSync(file, 'utf8');
    assert.ok(text.includes('小悪魔的'), 'Japanese setting round-trips as UTF-8');
  });
});
