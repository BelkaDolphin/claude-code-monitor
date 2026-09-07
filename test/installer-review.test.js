/**
 * Regression tests for the code-review findings on src/installer.js:
 *   #1 corrupt settings.json must not be mistaken for a missing one
 *   #2 the write must be atomic
 *   #5 the existing file's indentation must be preserved
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applySettings,
  readSettingsFile,
  detectIndent,
  CorruptSettingsError,
} from '../src/installer.js';
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
    tui: 'fullscreen',
    agentPushNotifEnabled: true,
    model: 'claude-fable-5-1[1m]',
  };
}

/** A truncated settings.json - exactly what a bad hand-edit leaves behind. */
const CORRUPT = '{\n  "permissions": { "allow": ["Bash(flake8:*)"] },\n  "model": "claude-fable-5-1",\n';

describe('corrupt settings.json is never mistaken for a fresh install (review #1)', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('inst-corrupt'); });
  after(() => tmp.cleanup());

  test('readSettingsFile separates missing / ok / corrupt', () => {
    assert.equal(readSettingsFile(path.join(tmp.dir, 'does-not-exist.json')).state, 'missing');

    const bad = path.join(tmp.dir, 'bad.json');
    fs.writeFileSync(bad, CORRUPT, 'utf8');
    const r = readSettingsFile(bad);
    assert.equal(r.state, 'corrupt');
    assert.equal(r.data, null);
    assert.ok(r.error, 'the underlying parse error is retained');

    const good = path.join(tmp.dir, 'good.json');
    fs.writeFileSync(good, JSON.stringify(existingSettings()), 'utf8');
    assert.equal(readSettingsFile(good).state, 'ok');
  });

  test('a top-level JSON array counts as corrupt, not as settings', () => {
    const arr = path.join(tmp.dir, 'array.json');
    fs.writeFileSync(arr, '[1,2,3]', 'utf8');
    assert.equal(readSettingsFile(arr).state, 'corrupt');
  });

  test('a settings.json with a BOM still parses as ok', () => {
    const bom = path.join(tmp.dir, 'bom.json');
    fs.writeFileSync(bom, `\uFEFF${JSON.stringify(existingSettings())}`, 'utf8');
    const r = readSettingsFile(bom);
    assert.equal(r.state, 'ok');
    assert.equal(r.data.model, 'claude-fable-5-1[1m]');
  });

  test('install THROWS instead of overwriting a corrupt file', () => {
    const file = path.join(tmp.dir, 'c1.json');
    fs.writeFileSync(file, CORRUPT, 'utf8');

    assert.throws(
      () => applySettings('install', { settingsFile: file }),
      (err) => err instanceof CorruptSettingsError && /not valid JSON/.test(err.message),
    );

    // The whole point of the fix: the user's file survives untouched.
    assert.equal(fs.readFileSync(file, 'utf8'), CORRUPT, 'corrupt file left byte-identical');
  });

  test('a backup is written before the refusal', () => {
    const file = path.join(tmp.dir, 'c2.json');
    fs.writeFileSync(file, CORRUPT, 'utf8');

    let caught = null;
    try {
      applySettings('install', { settingsFile: file });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught instanceof CorruptSettingsError);
    assert.ok(caught.backupFile, 'a backup path is reported');
    assert.ok(fs.existsSync(caught.backupFile), 'the backup exists on disk');
    assert.equal(fs.readFileSync(caught.backupFile, 'utf8'), CORRUPT, 'backup is a faithful copy');
    assert.match(caught.message, /Refusing to overwrite/);
  });

  test('--dry-run refuses too, and writes absolutely nothing', () => {
    const dir = makeTmpDir('inst-corrupt-dry');
    try {
      const file = path.join(dir.dir, 'settings.json');
      fs.writeFileSync(file, CORRUPT, 'utf8');
      const before = fs.readdirSync(dir.dir);

      assert.throws(() => applySettings('install', { settingsFile: file, dryRun: true }), CorruptSettingsError);

      assert.equal(fs.readFileSync(file, 'utf8'), CORRUPT);
      assert.deepEqual(fs.readdirSync(dir.dir), before, 'dry run created no backup and no output');
    } finally {
      dir.cleanup();
    }
  });

  test('uninstall refuses on a corrupt file as well', () => {
    const file = path.join(tmp.dir, 'c3.json');
    fs.writeFileSync(file, CORRUPT, 'utf8');
    assert.throws(() => applySettings('uninstall', { settingsFile: file, dryRun: true }), CorruptSettingsError);
    assert.equal(fs.readFileSync(file, 'utf8'), CORRUPT);
  });

  test('a genuinely MISSING file is still a normal fresh install', () => {
    const file = path.join(tmp.dir, 'fresh', 'settings.json');
    const res = applySettings('install', { settingsFile: file });
    assert.equal(res.existed, false);
    assert.equal(res.backupFile, null, 'nothing to back up');
    assert.ok(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.SessionStart);
  });

  test('an intact file with every user setting survives a full round trip', () => {
    const file = path.join(tmp.dir, 'intact.json');
    fs.writeFileSync(file, JSON.stringify(existingSettings(), null, 2), 'utf8');
    applySettings('install', { settingsFile: file });
    const after = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const key of ['permissions', 'enabledPlugins', 'language', 'effortLevel', 'tui', 'agentPushNotifEnabled', 'model']) {
      assert.deepEqual(after[key], existingSettings()[key], `${key} preserved`);
    }
    assert.ok(
      after.hooks.SessionEnd.flatMap((e) => e.hooks).some((h) => h.command.includes('session_end.ps1')),
      'the pre-existing SessionEnd hook survives',
    );
  });
});

describe('settings.json is written atomically (review #2)', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('inst-atomic'); });
  after(() => tmp.cleanup());

  test('install leaves no .tmp- scratch file behind', () => {
    const file = path.join(tmp.dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify(existingSettings(), null, 2), 'utf8');
    applySettings('install', { settingsFile: file });

    const leftovers = fs.readdirSync(tmp.dir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, [], `temp files left behind: ${leftovers.join(', ')}`);

    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.ok(written.statusLine, 'the file is complete, never half-written');
    assert.equal(written.hooks.SessionEnd.length, 2);
  });

  test('uninstall is atomic as well', () => {
    const file = path.join(tmp.dir, 'settings2.json');
    fs.writeFileSync(file, JSON.stringify(existingSettings(), null, 2), 'utf8');
    applySettings('install', { settingsFile: file });
    applySettings('uninstall', { settingsFile: file });

    assert.deepEqual(fs.readdirSync(tmp.dir).filter((f) => f.includes('.tmp-')), []);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), existingSettings());
  });

  test('a fresh install into a new directory leaves no temp file', () => {
    const nested = path.join(tmp.dir, 'a', 'b', 'settings.json');
    applySettings('install', { settingsFile: nested });
    assert.deepEqual(fs.readdirSync(path.dirname(nested)).filter((f) => f.includes('.tmp-')), []);
    assert.ok(fs.existsSync(nested));
  });
});

describe('existing indentation is preserved (review #5)', () => {
  let tmp;
  before(() => { tmp = makeTmpDir('inst-indent'); });
  after(() => tmp.cleanup());

  test('detects 2 spaces, 4 spaces and tabs', () => {
    assert.equal(detectIndent('{\n  "a": 1\n}'), 2);
    assert.equal(detectIndent('{\n    "a": 1\n}'), 4);
    assert.equal(detectIndent('{\n\t"a": 1\n}'), '\t');
  });

  test('falls back to 2 for minified, empty or implausible input', () => {
    assert.equal(detectIndent('{"a":1}'), 2);
    assert.equal(detectIndent(''), 2);
    assert.equal(detectIndent(null), 2);
    assert.equal(detectIndent(undefined), 2);
    assert.equal(detectIndent(`{\n${' '.repeat(40)}"a": 1\n}`), 2, 'an absurd indent is ignored');
  });

  test('a 4-space settings.json is rewritten with 4 spaces', () => {
    const file = path.join(tmp.dir, 'four.json');
    fs.writeFileSync(file, JSON.stringify(existingSettings(), null, 4), 'utf8');
    const res = applySettings('install', { settingsFile: file });
    assert.equal(res.indent, 4);
    const text = fs.readFileSync(file, 'utf8');
    assert.match(text, /\n {4}"permissions"/, 'top-level keys keep a 4-space indent');
    assert.doesNotMatch(text, /\n {2}"permissions"/);
  });

  test('a tab-indented settings.json stays tab-indented', () => {
    const file = path.join(tmp.dir, 'tabs.json');
    fs.writeFileSync(file, JSON.stringify(existingSettings(), null, '\t'), 'utf8');
    const res = applySettings('install', { settingsFile: file });
    assert.equal(res.indent, '\t');
    assert.match(fs.readFileSync(file, 'utf8'), /\n\t"permissions"/);
  });

  test('a 2-space file is still written with 2 spaces', () => {
    const file = path.join(tmp.dir, 'two.json');
    fs.writeFileSync(file, JSON.stringify(existingSettings(), null, 2), 'utf8');
    const res = applySettings('install', { settingsFile: file });
    assert.equal(res.indent, 2);
    assert.match(fs.readFileSync(file, 'utf8'), /\n {2}"permissions"/);
  });

  test('indentation never changes the parsed content', () => {
    const a = path.join(tmp.dir, 'ind-a.json');
    const b = path.join(tmp.dir, 'ind-b.json');
    fs.writeFileSync(a, JSON.stringify(existingSettings(), null, 2), 'utf8');
    fs.writeFileSync(b, JSON.stringify(existingSettings(), null, '\t'), 'utf8');
    applySettings('install', { settingsFile: a });
    applySettings('install', { settingsFile: b });
    assert.deepEqual(JSON.parse(fs.readFileSync(a, 'utf8')), JSON.parse(fs.readFileSync(b, 'utf8')));
  });

  test('the idempotency check uses the detected indent, so no needless rewrite', () => {
    const file = path.join(tmp.dir, 'idem.json');
    fs.writeFileSync(file, JSON.stringify(existingSettings(), null, 4), 'utf8');
    applySettings('install', { settingsFile: file });
    const second = applySettings('install', { settingsFile: file });
    assert.equal(second.unchanged, true, 'a 4-space file is not rewritten just because of its indent');
    assert.equal(second.backupFile, null, 'and therefore no extra backup piles up');
  });
});
