#!/usr/bin/env node
/**
 * claude-monitor hook writer.
 *
 * Reads the hook payload JSON from stdin and appends one line to
 *   <monitorDir>/events/<YYYY-MM-DD>.jsonl
 * as {receivedAt, hookEventName, ...payload}.
 *
 * Contract:
 *  - fire and forget: NEVER print to stdout/stderr, ALWAYS exit 0.
 *    (stdout from a hook can be injected into the conversation; stderr on a
 *    blocking hook can surface as an error. Silence is the only safe output.)
 *  - fast: no imports beyond node:fs/node:path/node:os, single appendFileSync.
 *  - self-contained: does not import src/ so it stays cheap to start.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MAX_STDIN = 4 * 1024 * 1024; // 4MB guard; payloads are normally tiny

/**
 * Same rule as src/paths.js monitorDir(): a relative CLAUDE_MONITOR_DIR is
 * resolved against HOME. This process is started by Claude Code with the
 * PROJECT as its cwd, while the server is started from wherever the user ran
 * it - resolving against cwd would put the events somewhere the server never
 * looks.
 */
function monitorDir() {
  const env = process.env.CLAUDE_MONITOR_DIR;
  if (env && env.trim()) {
    const v = env.trim();
    return path.isAbsolute(v) ? path.resolve(v) : path.resolve(os.homedir(), v);
  }
  return path.join(os.homedir(), '.claude-monitor');
}

function dateKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    };
    process.stdin.on('data', (c) => {
      size += c.length;
      if (size <= MAX_STDIN) chunks.push(c);
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    // Never hang the parent: bail out after 2s no matter what.
    const t = setTimeout(finish, 2000);
    if (typeof t.unref === 'function') t.unref();
  });
}

async function main() {
  const raw = await readStdin();
  const now = new Date();
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    payload = { parseError: true, raw: raw.slice(0, 2000) };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    payload = { parseError: true, raw: String(raw).slice(0, 2000) };
  }
  const record = {
    receivedAt: now.toISOString(),
    hookEventName: typeof payload.hook_event_name === 'string' ? payload.hook_event_name : null,
    ...payload,
  };
  const dir = path.join(monitorDir(), 'events');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, `${dateKey(now)}.jsonl`), `${JSON.stringify(record)}\n`, 'utf8');
}

main()
  .catch(() => { /* swallow: a monitoring hook must never disturb the session */ })
  .finally(() => process.exit(0));
