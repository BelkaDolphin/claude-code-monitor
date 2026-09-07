/**
 * Reader for the status line sidecar files written by hooks/statusline.js.
 *
 * <monitorDir>/statusline/<session_id>.json holds the last stdin payload Claude
 * Code handed the status line script. It is the ONLY source of `rate_limits`:
 * that object is absent from the transcripts, from sessions/<pid>.json, and
 * from ccusage. It also only exists for Claude.ai Pro/Max subscribers (or
 * behind a Claude apps gateway with a spend limit) and only after the first API
 * response of a session - an API-key setup will never produce it.
 *
 * Windows are dropped by Claude Code once `resets_at` (UNIX epoch SECONDS)
 * passes, and we additionally ignore any window whose resets_at is already in
 * the past when we read it.
 */

import fs from 'node:fs';
import path from 'node:path';
import { statuslineDir, readJsonUtf8 } from './paths.js';

export const RATE_LIMIT_WINDOWS = ['five_hour', 'seven_day', 'spend_limit'];

/**
 * @typedef {Object} SidecarEntry
 * @property {string} sessionId
 * @property {string} file
 * @property {number} mtimeMs
 * @property {string|null} capturedAt
 * @property {string|null} model
 * @property {string|null} cwd
 * @property {string|null} version
 * @property {number|null} contextUsedPct
 * @property {number|null} costUsd
 * @property {Record<string, {used_percentage:number, resets_at:number|null, resetsAtIso:string|null}>} rateLimits
 * @property {any} raw
 */

/** @param {{dir?: string, nowSec?: number}} [opts] */
export function readSidecars(opts = {}) {
  const dir = opts.dir ?? statuslineDir();
  const nowSec = opts.nowSec ?? Math.floor(Date.now() / 1000);
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { entries: [], dir, present: false };
  }
  /** @type {SidecarEntry[]} */
  const entries = [];
  for (const e of ents) {
    if (!e.isFile() || !e.name.endsWith('.json')) continue;
    const file = path.join(dir, e.name);
    const data = readJsonUtf8(file);
    if (!data || typeof data !== 'object') continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
    } catch { /* ignore */ }
    entries.push({
      sessionId: typeof data.session_id === 'string' ? data.session_id : e.name.slice(0, -5),
      file,
      mtimeMs,
      capturedAt: typeof data.capturedAt === 'string' ? data.capturedAt : null,
      model: data?.model?.display_name ?? data?.model?.id ?? null,
      cwd: typeof data.cwd === 'string' ? data.cwd : null,
      version: typeof data.version === 'string' ? data.version : null,
      contextUsedPct: numOrNull(data?.context_window?.used_percentage),
      costUsd: numOrNull(data?.cost?.total_cost_usd),
      rateLimits: extractRateLimits(data?.rate_limits, nowSec),
      raw: data,
    });
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return { entries, dir, present: true };
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * @param {any} rl
 * @param {number} nowSec
 */
export function extractRateLimits(rl, nowSec = Math.floor(Date.now() / 1000)) {
  /** @type {Record<string, any>} */
  const out = {};
  if (!rl || typeof rl !== 'object') return out;
  for (const key of RATE_LIMIT_WINDOWS) {
    const w = rl[key];
    if (!w || typeof w !== 'object') continue;
    const used = numOrNull(w.used_percentage);
    if (used === null) continue;
    const resets = numOrNull(w.resets_at);
    // resets_at is epoch seconds; a passed window is stale and must be ignored.
    if (resets !== null && resets <= nowSec) continue;
    out[key] = {
      used_percentage: used,
      resets_at: resets,
      resetsAtIso: resets !== null ? new Date(resets * 1000).toISOString() : null,
    };
  }
  return out;
}

/**
 * The freshest rate_limits across all sessions. Rate limits are account-wide,
 * so the most recently captured session wins per window.
 * @param {{dir?: string, nowSec?: number}} [opts]
 */
export function latestRateLimits(opts = {}) {
  const { entries, present, dir } = readSidecars(opts);
  /** @type {Record<string, any>} */
  const merged = {};
  let sourceSessionId = null;
  let capturedAt = null;
  for (const e of entries) {
    for (const [k, v] of Object.entries(e.rateLimits)) {
      if (!(k in merged)) {
        merged[k] = v;
        sourceSessionId ??= e.sessionId;
        capturedAt ??= e.capturedAt;
      }
    }
  }
  return {
    dir,
    present,
    sessionCount: entries.length,
    rateLimits: merged,
    sourceSessionId,
    capturedAt,
    available: Object.keys(merged).length > 0,
    /** Why nothing is available - useful for the UI to explain itself. */
    unavailableReason: Object.keys(merged).length > 0
      ? null
      : !present
        ? 'no statusline sidecar directory (statusLine hook not installed yet)'
        : entries.length === 0
          ? 'no statusline payloads captured yet'
          : 'no live rate_limits window (API-key auth, or none captured since the first API response)',
  };
}
