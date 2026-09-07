/**
 * Regression tests for the code-review findings on src/installer.js:
 *   #1 corrupt settings.json must not be mistaken for a missing one
 *   #2 the write must be atomic
 *   #5 the existing file's indentation must be preserved
 *
 * ...plus the pre-release batch:
 *   B-3 the command we install is quoted, checked, and names THIS node
 *   B-4 a statusLine that is not ours is not taken over without being asked
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  applySettings,
  planInstall,
  planUninstall,
  readSettingsFile,
  detectIndent,
  hookCommand,
  statuslineCommand,
  hookScriptPath,
  statuslineScriptPath,
  assertCommandSafePath,
  ownsCommand,
  nodePath,
  CorruptSettingsError,
  UnsafeCommandPathError,
  STATUSLINE_BACKUP_KEY,
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

/**
 * B-3. The hook command is a shell command line, and we build it out of two
 * paths we do not control the shape of.
 */
describe('the hook command names THIS node, quoted and checked (B-3)', () => {
  const ROOT = 'D:\\develop\\Claude監視';

  test('it is the absolute node, not a bare `node` off the PATH', () => {
    // A bare `node` resolves out of whatever PATH the hook happens to inherit.
    // Claude Code started from the GUI does not inherit the shell profile a
    // version manager puts node on the PATH from, so the hooks - and only the
    // hooks - would die silently on a machine where everything else works.
    const cmd = hookCommand(ROOT);
    assert.equal(cmd.startsWith(`"${process.execPath}" `), true, cmd);
    assert.equal(cmd.includes(hookScriptPath(ROOT)), true, cmd);
    assert.equal(/^node\s/.test(cmd), false, 'never a bare `node`');
    assert.equal(nodePath(), process.execPath);
  });

  test('both halves are quoted, so a space in either is survivable', () => {
    // The path this project is actually installed under is the Japanese one;
    // the one node ships under is C:\Program Files\nodejs\node.exe.
    const cmd = hookCommand(ROOT, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(cmd, `"C:\\Program Files\\nodejs\\node.exe" "${hookScriptPath(ROOT)}"`);
    assert.equal((cmd.match(/"/g) ?? []).length, 4, 'exactly two quoted arguments');
  });

  test('statuslineCommand follows the same rule', () => {
    const cmd = statuslineCommand(ROOT, 'C:\\Program Files\\nodejs\\node.exe');
    assert.equal(cmd, `"C:\\Program Files\\nodejs\\node.exe" "${statuslineScriptPath(ROOT)}"`);
  });

  test('a path that would break out of the command line is refused', () => {
    // The same rule autostart.assertQuotablePath applies to the .vbs launcher
    // and to schtasks /TR, one layer further out: hooks are `type: "command"`
    // and Claude Code hands the string to a shell.
    for (const bad of ['C:\\a"b\\x.js', 'C:\\a\r\nb\\x.js', 'C:\\a\0b\\x.js']) {
      assert.throws(() => assertCommandSafePath(bad, 'test path'), UnsafeCommandPathError, bad);
    }
  });

  test('the shell metacharacters checked are the ones THIS shell expands', () => {
    // A backslash is the separator every Windows path is made of and rejecting
    // it would reject them all; on POSIX it is an escape inside double quotes.
    // `%` is expanded by cmd.exe inside quotes and is inert to sh. So the set
    // is platform-dependent on purpose, and the plain path passes either way.
    const plain = process.platform === 'win32' ? 'D:\\develop\\Claude監視\\hooks\\x.js' : '/home/a b/x.js';
    assert.equal(assertCommandSafePath(plain), plain);
    const hostile = process.platform === 'win32' ? 'C:\\a%USERPROFILE%\\x.js' : '/home/$(id)/x.js';
    assert.throws(() => assertCommandSafePath(hostile), UnsafeCommandPathError, hostile);
  });

  test('applySettings refuses before it takes a backup or writes a byte', () => {
    const tmp2 = makeTmpDir('installer-unsafe');
    try {
      const file = path.join(tmp2.dir, 'settings.json');
      fs.writeFileSync(file, JSON.stringify(existingSettings(), null, 2), 'utf8');
      const before = fs.readFileSync(file, 'utf8');
      const badRoot = process.platform === 'win32' ? 'C:\\a"b' : '/home/a$b';
      assert.throws(
        () => applySettings('install', { settingsFile: file, root: badRoot }),
        UnsafeCommandPathError,
      );
      assert.equal(fs.readFileSync(file, 'utf8'), before);
      assert.deepEqual(fs.readdirSync(tmp2.dir), ['settings.json'], 'no backup was taken');
      // A dry run refuses identically - the refusal is about the path, not the
      // write, so seeing it only on the real run would be useless.
      assert.throws(
        () => applySettings('install', { settingsFile: file, root: badRoot, dryRun: true }),
        UnsafeCommandPathError,
      );
    } finally {
      tmp2.cleanup();
    }
  });
});

describe('an entry written by an older build is replaced, not duplicated (B-3)', () => {
  /** Settings as a user who installed before this change actually has them. */
  function legacyInstalled(root) {
    return {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: `node "${hookScriptPath(root)}"`, async: true }] }],
        SessionEnd: [{ hooks: [{ type: 'command', command: `node "${hookScriptPath(root)}"`, timeout: 5 }] }],
      },
      statusLine: { type: 'command', command: `node "${statuslineScriptPath(root)}"` },
    };
  }

  test('ownsCommand recognises every generation by the script path', () => {
    const script = hookScriptPath('D:\\repo');
    assert.equal(ownsCommand(`node "${script}"`, script), true, 'the old bare-node form');
    assert.equal(ownsCommand(`"C:\\other\\node.exe" "${script}"`, script), true, 'another node');
    assert.equal(ownsCommand(hookCommand('D:\\repo'), script), true, 'the current form');
    assert.equal(ownsCommand('powershell -File other.ps1', script), false);
    assert.equal(ownsCommand(undefined, script), false);
  });

  test('re-running install rewrites the old entry in place', () => {
    const root = 'D:\\repo';
    const events = ['SessionStart', 'SessionEnd'];
    const { next, added, replaced, skipped } = planInstall(legacyInstalled(root), { root, events });
    assert.deepEqual(added, [], 'nothing new was appended');
    assert.deepEqual(replaced.sort(), ['SessionEnd', 'SessionStart']);
    assert.deepEqual(skipped, []);
    for (const ev of events) {
      const hooks = next.hooks[ev].flatMap((e) => e.hooks);
      assert.equal(hooks.length, 1, `${ev} must not end up with two of our hooks`);
      assert.equal(hooks[0].command, hookCommand(root));
    }
    // The rest of the entry survives: async/timeout are how SessionEnd stays
    // inside its 1.5s budget, and they were not ours to reset.
    assert.equal(next.hooks.SessionStart[0].hooks[0].async, true);
    assert.equal(next.hooks.SessionEnd[0].hooks[0].timeout, 5);
  });

  test('the statusLine an older build wrote is ours to update without asking', () => {
    const root = 'D:\\repo';
    const { next, statusLine } = planInstall(legacyInstalled(root), { root, events: [] });
    assert.equal(statusLine, 'updated');
    assert.equal(next.statusLine.command, statuslineCommand(root));
    assert.equal(next[STATUSLINE_BACKUP_KEY], undefined, 'ours is not worth backing up');
  });

  test('a second run after that changes nothing at all', () => {
    const root = 'D:\\repo';
    const events = ['SessionStart', 'SessionEnd'];
    const once = planInstall(legacyInstalled(root), { root, events }).next;
    const twice = planInstall(once, { root, events });
    assert.deepEqual(twice.added, []);
    assert.deepEqual(twice.replaced, []);
    assert.deepEqual(twice.skipped.sort(), ['SessionEnd', 'SessionStart']);
    assert.equal(JSON.stringify(twice.next), JSON.stringify(once));
  });

  test('uninstall removes the old form too', () => {
    const root = 'D:\\repo';
    const { next, removed, statusLine } = planUninstall(legacyInstalled(root), { root });
    assert.deepEqual(removed.sort(), ['SessionEnd', 'SessionStart']);
    assert.equal(next.hooks, undefined);
    assert.equal(statusLine, 'removed');
    assert.equal(next.statusLine, undefined);
  });
});

/**
 * B-4. There is exactly one statusLine, and a user may already be using it.
 */
describe('a foreign statusLine is not taken over silently (B-4)', () => {
  const root = 'D:\\repo';
  const FOREIGN = { type: 'command', command: 'powershell -File C:\\Users\\alice\\my-statusline.ps1' };
  const withForeign = () => ({ ...existingSettings(), statusLine: { ...FOREIGN } });

  test('without --force-statusline it is left exactly as it was', () => {
    const { next, statusLine, statusLineExisting, added } = planInstall(withForeign(), { root });
    assert.equal(statusLine, 'kept-foreign');
    assert.deepEqual(next.statusLine, FOREIGN, 'untouched');
    assert.equal(statusLineExisting, FOREIGN.command, 'and reported, so the user can decide');
    assert.equal(next[STATUSLINE_BACKUP_KEY], undefined, 'nothing to back up');
    assert.ok(added.length > 0, 'the hooks are still installed - they are a list, not a slot');
  });

  test('with --force-statusline the old value is parked, not lost', () => {
    const { next, statusLine } = planInstall(withForeign(), { root, forceStatusLine: true });
    assert.equal(statusLine, 'replaced');
    assert.equal(next.statusLine.command, statuslineCommand(root));
    assert.deepEqual(next[STATUSLINE_BACKUP_KEY], FOREIGN);
  });

  test('uninstall puts the parked value back', () => {
    const forced = planInstall(withForeign(), { root, forceStatusLine: true }).next;
    const { next, statusLine } = planUninstall(forced, { root });
    assert.equal(statusLine, 'restored');
    assert.deepEqual(next.statusLine, FOREIGN);
    assert.equal(Object.prototype.hasOwnProperty.call(next, STATUSLINE_BACKUP_KEY), false,
      'and the parking slot is cleaned up');
    assert.deepEqual(next, withForeign(), 'a full round trip');
  });

  test('with no backup recorded, uninstall still just removes ours', () => {
    const installed = planInstall(existingSettings(), { root }).next;
    const { next, statusLine } = planUninstall(installed, { root });
    assert.equal(statusLine, 'removed');
    assert.equal(next.statusLine, undefined);
  });

  test('a backup sitting next to a statusLine that is NOT ours is left alone', () => {
    // Nothing here is ours to act on, so nothing here is ours to delete.
    const s = { ...withForeign(), [STATUSLINE_BACKUP_KEY]: { type: 'command', command: 'older' } };
    const { next, statusLine } = planUninstall(s, { root });
    assert.equal(statusLine, 'unchanged');
    assert.deepEqual(next[STATUSLINE_BACKUP_KEY], { type: 'command', command: 'older' });
  });

  test('the dry run reaches the same verdict as the write would', () => {
    const tmp2 = makeTmpDir('installer-statusline');
    try {
      const file = path.join(tmp2.dir, 'settings.json');
      fs.writeFileSync(file, `${JSON.stringify(withForeign(), null, 2)}\n`, 'utf8');
      const dry = applySettings('install', { settingsFile: file, dryRun: true });
      assert.equal(dry.statusLine, 'kept-foreign');
      assert.equal(JSON.parse(dry.json).statusLine.command, FOREIGN.command);

      const real = applySettings('install', { settingsFile: file });
      assert.equal(real.statusLine, 'kept-foreign');
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, FOREIGN);

      // ...and the forced run, on the same file, does replace it and can be
      // undone.
      const forced = applySettings('install', { settingsFile: file, forceStatusLine: true });
      assert.equal(forced.statusLine, 'replaced');
      const after = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(after.statusLine.command, statuslineCommand());
      assert.deepEqual(after[STATUSLINE_BACKUP_KEY], FOREIGN);

      applySettings('uninstall', { settingsFile: file });
      assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).statusLine, FOREIGN);
    } finally {
      tmp2.cleanup();
    }
  });
});
