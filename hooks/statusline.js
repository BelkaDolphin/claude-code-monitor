#!/usr/bin/env node
/**
 * claude-monitor status line script.
 *
 * Two jobs:
 *  1. Persist the stdin JSON to <monitorDir>/statusline/<session_id>.json
 *     (tmp file + rename, so a reader never sees a half-written file). This is
 *     the ONLY way to observe `rate_limits`, which appears nowhere else.
 *  2. Print exactly one line for the status bar, e.g.
 *       Opus | ctx 8% | 5h 23% (resets 21:30) | 7d 41%
 *
 * Schema notes (from the official statusline docs):
 *  - rate_limits appears only for Claude.ai Pro/Max subscribers, or behind a
 *    Claude apps gateway with a spend limit, and only after the first API
 *    response. Each window (five_hour / seven_day / spend_limit) may be absent
 *    independently, and Claude Code drops a window once resets_at has passed.
 *  - resets_at is UNIX epoch SECONDS.
 *  - context_window.current_usage is null before the first API response and
 *    right after /compact.
 * Budget: updates are debounced at 300ms and an in-flight script is cancelled
 * by the next update, so this must stay in the tens of milliseconds. No imports
 * beyond node core, no network, one write.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Relative CLAUDE_MONITOR_DIR resolves against HOME - see src/paths.js. */
function monitorDir() {
  const env = process.env.CLAUDE_MONITOR_DIR;
  if (env && env.trim()) {
    const v = env.trim();
    return path.isAbsolute(v) ? path.resolve(v) : path.resolve(os.homedir(), v);
  }
  return path.join(os.homedir(), '.claude-monitor');
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(Buffer.concat(chunks).toString('utf8')); } };
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    const t = setTimeout(finish, 2000);
    if (typeof t.unref === 'function') t.unref();
  });
}

/** @param {number} epochSeconds */
function hhmm(epochSeconds) {
  const d = new Date(epochSeconds * 1000);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** Truncate, don't round: the docs render 23.5 as "23%". */
function pct(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.floor(v)}%` : null;
}

/**
 * Build the one-line status text.
 * Exported shape is mirrored in src/statusline-sidecar.js tests.
 * @param {any} data
 * @param {number} [nowSec]
 */
export function renderStatusLine(data, nowSec = Math.floor(Date.now() / 1000)) {
  const parts = [];
  const model = data?.model?.display_name || data?.model?.id;
  if (model) parts.push(String(model));

  const used = data?.context_window?.used_percentage;
  if (typeof used === 'number' && Number.isFinite(used)) parts.push(`ctx ${Math.floor(used)}%`);

  const rl = data?.rate_limits;
  if (rl && typeof rl === 'object') {
    // Only the 5h window gets a reset clock: it is the one that matters within a
    // working session, and the 7d/spend resets are days away. The full values
    // (including every resets_at) are preserved in the sidecar JSON.
    for (const [key, label, showReset] of [['five_hour', '5h', true], ['seven_day', '7d', false], ['spend_limit', 'spend', false]]) {
      const w = rl[key];
      if (!w || typeof w !== 'object') continue;
      const p = pct(w.used_percentage);
      if (p === null) continue;
      // resets_at is epoch SECONDS; a window already past its reset is stale.
      const resets = typeof w.resets_at === 'number' ? w.resets_at : null;
      if (resets !== null && resets <= nowSec) continue;
      const t = showReset && resets !== null ? hhmm(resets) : null;
      parts.push(t ? `${label} ${p} (resets ${t})` : `${label} ${p}`);
    }
  }
  return parts.join(' | ');
}

async function main() {
  const raw = await readStdin();
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch { /* keep null */ }

  if (data && typeof data === 'object') {
    try {
      const dir = path.join(monitorDir(), 'statusline');
      fs.mkdirSync(dir, { recursive: true });
      const sid = typeof data.session_id === 'string' && data.session_id ? data.session_id : 'unknown';
      const safe = sid.replace(/[^A-Za-z0-9_.-]/g, '_');
      const target = path.join(dir, `${safe}.json`);
      const tmp = `${target}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify({ capturedAt: new Date().toISOString(), ...data }), 'utf8');
      try {
        fs.renameSync(tmp, target);
      } catch {
        fs.rmSync(target, { force: true });
        fs.renameSync(tmp, target);
      }
    } catch { /* never break the status bar because of our own IO */ }
  }

  const line = data ? renderStatusLine(data) : '';
  process.stdout.write(`${line}\n`);
}

// Only run when invoked as a script, so tests can import renderStatusLine.
const invokedDirectly = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));
if (invokedDirectly) {
  main().catch(() => process.stdout.write('\n'));
}
