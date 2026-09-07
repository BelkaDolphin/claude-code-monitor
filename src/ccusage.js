/**
 * Thin wrapper around the ccusage CLI, used only to CROSS-CHECK our own
 * aggregation. The dashboard never depends on it at runtime.
 *
 * Invocation: `npx -y ccusage@latest <cmd> --json [...]`. That downloads on
 * first use, so the default timeout is generous.
 *
 * Doc caveat carried over from M0: json-output.md and blocks-reports.md show
 * two different shapes for `blocks --json`. We normalize both.
 */

import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 180_000;

/** Args are built by us plus user-supplied dates; allow-list them all. */
export const SAFE_ARG = /^[A-Za-z0-9@._:=-]+$/;

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
 *   can be tested without downloading ccusage; production never passes it.
 * @returns {Promise<{ok: boolean, code: number|null, stdout: string, stderr: string, error: string|null, timedOut: boolean}>}
 */
export function runCcusage(args, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise((resolve) => {
    const bad = args.find((a) => !SAFE_ARG.test(String(a)));
    if (bad !== undefined) {
      return resolve({ ok: false, code: null, stdout: '', stderr: '', error: `unsafe ccusage argument: ${bad}`, timedOut: false });
    }
    let child;
    try {
      // Windows: npx is a .cmd shim. Node >= 20.12 refuses to spawn .cmd
      // directly (EINVAL), and shell:true triggers DEP0190, so go through
      // cmd.exe ourselves. Every argument is allow-listed above, so there is
      // nothing to escape.
      const cmdline = ['npx', '-y', 'ccusage@latest', ...args].join(' ');
      if (opts.command && typeof opts.command.file === 'string') {
        const extra = Array.isArray(opts.command.args) ? opts.command.args : [];
        child = spawn(opts.command.file, extra, {
          cwd: opts.cwd,
          windowsHide: true,
          windowsVerbatimArguments: process.platform === 'win32',
        });
      } else {
        child = process.platform === 'win32'
          ? spawn('cmd.exe', ['/d', '/s', '/c', cmdline], { cwd: opts.cwd, windowsHide: true, windowsVerbatimArguments: true })
          : spawn('npx', ['-y', 'ccusage@latest', ...args], { cwd: opts.cwd });
      }
    } catch (err) {
      return resolve({ ok: false, code: null, stdout: '', stderr: '', error: String(err), timedOut: false });
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
      resolve({ ok: false, code: null, stdout, stderr, error: String(err), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        error: timedOut ? `timed out after ${timeoutMs}ms` : code === 0 ? null : `exit code ${code}`,
        timedOut,
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
 * @returns {Promise<{ok: boolean, data: any, error: string|null, raw: string}>}
 */
export async function ccusageDaily(opts = {}) {
  const args = ['daily', '--json'];
  if (opts.since) args.push('--since', opts.since);
  if (opts.until) args.push('--until', opts.until);
  const res = await runCcusage(args, { timeoutMs: opts.timeoutMs });
  if (!res.ok) return { ok: false, data: null, error: res.error ?? 'failed', raw: res.stderr || res.stdout };
  const data = parseCcusageJson(res.stdout);
  if (!data) return { ok: false, data: null, error: 'could not parse ccusage JSON', raw: res.stdout.slice(0, 500) };
  return { ok: true, data, error: null, raw: '' };
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
  if (!res.ok) return { ok: false, data: null, blocks: [], error: res.error ?? 'failed', raw: res.stderr || res.stdout };
  const data = parseCcusageJson(res.stdout);
  if (!data) return { ok: false, data: null, blocks: [], error: 'could not parse ccusage JSON', raw: res.stdout.slice(0, 500) };
  // Two documented shapes: {blocks:[...]} and {type:'blocks', data:[...]}.
  const blocks = Array.isArray(data.blocks) ? data.blocks : Array.isArray(data.data) ? data.data : [];
  return { ok: true, data, blocks, error: null, raw: '' };
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
