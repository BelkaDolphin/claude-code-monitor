/**
 * Thin wrapper around the ccusage CLI, used only to CROSS-CHECK our own
 * aggregation. The dashboard never depends on it at runtime.
 *
 * Invocation: `npx --no ccusage@20.0.20 <cmd> --json [...]`.
 *
 * NOTHING HERE DOWNLOADS ANYTHING. `--no` (the opposite of `-y`) makes npx run
 * ccusage only if it is ALREADY on PATH or in the npx cache; when it is not,
 * npx exits 1 without touching the network and prints
 * `npx canceled due to missing packages and no YES option: ["ccusage@20.0.20"]`
 * on stderr (measured with npm 11.6.2 on Windows). We detect exactly that and
 * report it as `notInstalled`, so the UI can say "install it first" instead of
 * "ccusage unavailable". The version is PINNED: `@latest` would mean a silently
 * changing third-party JSON shape under our cross-check.
 *
 * The timeout stays generous even though no download can happen any more: a
 * 30-day corpus is ~100 MB of transcripts and ccusage reads all of it.
 *
 * Doc caveat carried over from M0: json-output.md and blocks-reports.md show
 * two different shapes for `blocks --json`. We normalize both.
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 180_000;

/**
 * The ONE place the ccusage version lives. Bumping it means re-verifying the
 * JSON shape (see normalizeDailyRow's doc discrepancy note).
 */
export const CCUSAGE_VERSION = '20.0.20';
/** What goes on npx's argv: `ccusage@20.0.20`. */
export const CCUSAGE_SPEC = `ccusage@${CCUSAGE_VERSION}`;

/**
 * npx's refusal when the package is neither on PATH nor in its cache. Both the
 * current wording (`npm error npx canceled due to missing packages and no YES
 * option: [...]`) and the older `npm ERR!` prefix contain this substring.
 */
const NOT_INSTALLED_RE = /npx canceled due to missing packages/i;

/** @param {string} stderr @returns {boolean} */
export function isNotInstalled(stderr) {
  return NOT_INSTALLED_RE.test(String(stderr || ''));
}

/** Args are built by us plus user-supplied dates; allow-list them all. */
export const SAFE_ARG = /^[A-Za-z0-9@._:=-]+$/;

/**
 * The exact process we spawn, in one place so a test can read it without
 * running anything.
 *
 * Windows: npx is a .cmd shim. Node >= 20.12 refuses to spawn .cmd directly
 * (EINVAL), and shell:true triggers DEP0190, so go through cmd.exe ourselves.
 * Every argument is allow-listed by SAFE_ARG, so there is nothing to escape.
 *
 * @param {string[]} args ccusage's own argv (already SAFE_ARG-checked)
 * @param {string} [platform] defaults to the running platform (tests pass both)
 * @returns {{file: string, args: string[], verbatim: boolean}}
 */
export function ccusageCommand(args, platform = process.platform) {
  const npxArgs = ['--no', CCUSAGE_SPEC, ...args];
  if (platform === 'win32') {
    return { file: 'cmd.exe', args: ['/d', '/s', '/c', ['npx', ...npxArgs].join(' ')], verbatim: true };
  }
  return { file: 'npx', args: npxArgs, verbatim: false };
}

/**
 * Kill the child AND everything it started.
 *
 * On Windows the thing we spawn is `cmd.exe`, which starts `npx.cmd`, which
 * starts `node.exe` (ccusage). `child.kill()` signals only the cmd.exe at the
 * top; the node grandchild survives, keeps the transcripts open and keeps
 * burning CPU for as long as it likes. Same reasoning - and the same
 * `taskkill /T /F` - as `killTree()` in src/autostart.js.
 *
 * Nothing in here may throw: it runs from a setTimeout callback, so an escaping
 * error would land in `uncaughtException` and installCrashHandlers would treat
 * a failed cross-check as fatal (4.7).
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function killChildTree(child) {
  const plainKill = () => { try { child.kill(); } catch { /* already gone */ } };
  if (process.platform !== 'win32' || !child.pid) return plainKill();
  try {
    // spawn, not a shell string: the only interpolated value is our own pid.
    const tk = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    // taskkill missing from PATH, or refusing: fall back rather than hang.
    tk.on('error', plainKill);
    tk.on('exit', (code) => { if (code !== 0) plainKill(); });
  } catch {
    plainKill();
  }
}

/**
 * @param {string[]} args
 * @param {{timeoutMs?: number, cwd?: string, command?: {file: string, args?: string[]}}} [opts]
 *   `command` replaces the npx invocation. It exists so the timeout/kill path
 *   can be tested without ccusage being installed; production never passes it.
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, error: string|null, timedOut: boolean, notInstalled: boolean}>}
 */
export function runCcusage(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const bad = args.find((a) => !SAFE_ARG.test(String(a)));
    if (bad !== undefined) {
      return resolve({ ok: false, code: null, stdout: '', stderr: '', error: `unsafe ccusage argument: ${bad}`, timedOut: false, notInstalled: false });
    }
    let child;
    try {
      const cmd = opts.command && typeof opts.command.file === 'string'
        ? {
            file: opts.command.file,
            args: Array.isArray(opts.command.args) ? opts.command.args : [],
            verbatim: process.platform === 'win32',
          }
        : ccusageCommand(args);
      child = spawn(cmd.file, cmd.args, {
        cwd: opts.cwd,
        windowsHide: true,
        windowsVerbatimArguments: cmd.verbatim,
      });
    } catch (err) {
      return resolve({ ok: false, code: null, stdout: '', stderr: '', error: String(err), timedOut: false, notInstalled: false });
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killChildTree(child);
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
    child.stderr.on('data', (d) => { stderr += d.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, stdout, stderr, error: String(err), timedOut, notInstalled: isNotInstalled(stderr) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const notInstalled = code !== 0 && !timedOut && isNotInstalled(stderr);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        error: timedOut
          ? `timed out after ${timeoutMs}ms`
          : code === 0 ? null
          : notInstalled ? `${CCUSAGE_SPEC} is not installed (npx refused to download it)`
          : `exit code ${code}`,
        timedOut,
        notInstalled,
      });
    });
  });
}

/** Extract the JSON object from ccusage stdout (it may print banners first). */
export function parseCcusageJson(stdout) {
  const text = String(stdout || '');
  const start = text.indexOf('{');
  if (start < 0) return null;
  const candidate = text.slice(start);
  try {
    return JSON.parse(candidate);
  } catch { /* fall through */ }
  // Trailing noise after the JSON: walk back to the last closing brace.
  const end = candidate.lastIndexOf('}');
  if (end > 0) {
    try {
      return JSON.parse(candidate.slice(0, end + 1));
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * `ccusage daily --json`
 * @param {{since?: string, until?: string, timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, data: any, error: string|null, raw: string, notInstalled: boolean}>}
 */
export async function ccusageDaily(opts = {}) {
  const args = ['daily', '--json'];
  if (opts.since) args.push('--since', opts.since);
  if (opts.until) args.push('--until', opts.until);
  const res = await runCcusage(args, { timeoutMs: opts.timeoutMs });
  if (!res.ok) return { ok: false, data: null, error: res.error ?? 'failed', raw: res.stderr || res.stdout, notInstalled: !!res.notInstalled };
  const data = parseCcusageJson(res.stdout);
  if (!data) return { ok: false, data: null, error: 'could not parse ccusage JSON', raw: res.stdout.slice(0, 500), notInstalled: false };
  return { ok: true, data, error: null, raw: '', notInstalled: false };
}

/**
 * `ccusage blocks --json`
 * @param {{active?: boolean, recent?: boolean, timeoutMs?: number}} [opts]
 */
export async function ccusageBlocks(opts = {}) {
  const args = ['blocks', '--json'];
  if (opts.active) args.push('--active');
  if (opts.recent) args.push('--recent');
  const res = await runCcusage(args, { timeoutMs: opts.timeoutMs });
  if (!res.ok) return { ok: false, data: null, blocks: [], error: res.error ?? 'failed', raw: res.stderr || res.stdout, notInstalled: !!res.notInstalled };
  const data = parseCcusageJson(res.stdout);
  if (!data) return { ok: false, data: null, blocks: [], error: 'could not parse ccusage JSON', raw: res.stdout.slice(0, 500), notInstalled: false };
  // Two documented shapes: {blocks:[...]} and {type:'blocks', data:[...]}.
  const blocks = Array.isArray(data.blocks) ? data.blocks : Array.isArray(data.data) ? data.data : [];
  return { ok: true, data, blocks, error: null, raw: '', notInstalled: false };
}

/**
 * Normalize one ccusage daily row into our metric names.
 *
 * DOC DISCREPANCY (measured on ccusage 20.0.20, 2026-09-02): the published
 * docs/guide/json-output.md shows the date field as `date`, but the real CLI
 * emits `period` (plus `agent`, `metadata`). We accept either.
 * @param {any} row
 */
export function normalizeDailyRow(row) {
  return {
    date: row?.date ?? row?.period ?? null,
    input_tokens: num(row?.inputTokens),
    output_tokens: num(row?.outputTokens),
    cache_creation_input_tokens: num(row?.cacheCreationTokens),
    cache_read_input_tokens: num(row?.cacheReadTokens),
    totalCost: num(row?.totalCost),
    modelsUsed: Array.isArray(row?.modelsUsed) ? row.modelsUsed : [],
  };
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}
