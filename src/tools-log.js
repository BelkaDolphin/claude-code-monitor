/**
 * Tool call log: pair every `tool_use` block with its `tool_result` via
 * tool_use_id, across the main transcript and every subagent transcript.
 *
 * A tool_use lives in an `assistant` record; its result arrives in a later
 * `user` record. Results can be missing (still running, or the session ended
 * mid-call) - those are reported with status 'pending'.
 */

import { parseFile, ParseStats } from './parser.js';

const MAX_SUMMARY = 80;

/**
 * @typedef {Object} ToolCall
 * @property {string} id
 * @property {string|null} name
 * @property {string} summary
 * @property {string|null} startedAt
 * @property {string|null} endedAt
 * @property {number|null} durationMs
 * @property {boolean} isError
 * @property {'ok'|'error'|'pending'} status
 * @property {string|null} agentId   null = main session thread
 */

/**
 * Short, human-readable rendering of a tool's input.
 * @param {string|null} name
 * @param {any} input
 */
export function summarizeInput(name, input) {
  if (input == null) return '';
  if (typeof input === 'string') return clip(input);
  if (typeof input !== 'object') return clip(String(input));
  const pick = (...keys) => {
    for (const k of keys) {
      const v = input[k];
      if (typeof v === 'string' && v.length) return v;
      if (typeof v === 'number') return String(v);
    }
    return null;
  };
  switch (name) {
    case 'Bash':
    case 'PowerShell': {
      const cmd = pick('command');
      return cmd ? clip(oneLine(cmd)) : '';
    }
    case 'Read':
    case 'Write':
    case 'NotebookEdit':
      return clip(pick('file_path', 'notebook_path') ?? '');
    case 'Edit': {
      const fp = pick('file_path') ?? '';
      const old = pick('old_string');
      return clip(old ? `${fp} :: ${oneLine(old).slice(0, 30)}` : fp);
    }
    case 'Glob':
      return clip([pick('pattern'), pick('path')].filter(Boolean).join(' in '));
    case 'Grep':
      return clip([pick('pattern'), pick('path'), pick('glob')].filter(Boolean).join(' | '));
    case 'Agent':
      return clip([pick('subagent_type'), pick('description')].filter(Boolean).join(': '));
    case 'WebFetch':
    case 'WebSearch':
      return clip(pick('url', 'query') ?? '');
    case 'Skill':
      return clip(pick('skill') ?? '');
    case 'ToolSearch':
      return clip(pick('query') ?? '');
    default: {
      // Generic: first string-ish field, else compact JSON.
      const generic = pick('file_path', 'path', 'command', 'query', 'pattern', 'description', 'url', 'prompt');
      if (generic) return clip(oneLine(generic));
      try {
        return clip(oneLine(JSON.stringify(input)));
      } catch {
        return '';
      }
    }
  }
}

function oneLine(s) {
  return String(s).replace(/\s+/g, ' ').trim();
}

function clip(s, n = MAX_SUMMARY) {
  const t = String(s);
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

/**
 * Build the tool log for a session (main + subagents).
 * @param {import('./session-index.js').SessionEntry} entry
 * @param {{stats?: ParseStats}} [opts]
 * @returns {{calls: ToolCall[], stats: ParseStats, byTool: Record<string, number>, pending: number, errors: number}}
 */
export function buildToolLog(entry, opts = {}) {
  const stats = opts.stats ?? new ParseStats();
  /** @type {Map<string, ToolCall>} */
  const calls = new Map();

  const scan = (file, agentId) => {
    parseFile(file, (rec) => {
      for (const b of rec.blocks) {
        if (b.kind === 'tool_use' && b.id) {
          const existing = calls.get(b.id);
          const call = existing ?? {
            id: b.id,
            name: b.name,
            summary: '',
            startedAt: null,
            endedAt: null,
            durationMs: null,
            isError: false,
            status: 'pending',
            agentId,
          };
          // Streaming snapshots repeat the same tool_use with a growing input;
          // the later record has the complete input, so overwrite.
          call.name = b.name ?? call.name;
          call.summary = summarizeInput(b.name, b.input) || call.summary;
          if (rec.timestamp && (!call.startedAt || rec.timestamp < call.startedAt)) call.startedAt = rec.timestamp;
          call.agentId = agentId;
          calls.set(b.id, call);
        } else if (b.kind === 'tool_result' && b.toolUseId) {
          const call = calls.get(b.toolUseId) ?? {
            id: b.toolUseId,
            name: null,
            summary: '',
            startedAt: null,
            endedAt: null,
            durationMs: null,
            isError: false,
            status: 'pending',
            agentId,
          };
          call.endedAt = rec.timestamp ?? call.endedAt;
          call.isError = call.isError || b.isError === true;
          call.status = call.isError ? 'error' : 'ok';
          call.resultLength = b.contentLength ?? null;
          calls.set(b.toolUseId, call);
        }
      }
    }, stats);
  };

  scan(entry.jsonlPath, null);
  for (const sub of entry.subagents) scan(sub.jsonlPath, sub.agentId);

  const out = [...calls.values()];
  for (const c of out) {
    if (c.startedAt && c.endedAt) {
      const d = Date.parse(c.endedAt) - Date.parse(c.startedAt);
      c.durationMs = Number.isFinite(d) && d >= 0 ? d : null;
    }
  }
  out.sort((a, b) => String(a.startedAt ?? '').localeCompare(String(b.startedAt ?? '')));

  /** @type {Record<string, number>} */
  const byTool = {};
  let pending = 0;
  let errors = 0;
  for (const c of out) {
    const k = c.name ?? '(unknown)';
    byTool[k] = (byTool[k] || 0) + 1;
    if (c.status === 'pending') pending++;
    if (c.status === 'error') errors++;
  }
  return { calls: out, stats, byTool, pending, errors };
}
