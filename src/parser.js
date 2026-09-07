/**
 * Defensive normalizer for Claude Code transcript JSONL lines.
 *
 * The official docs state plainly that this format is INTERNAL and changes
 * between versions ("scripts that parse these files directly can break on any
 * release"). So this parser must never throw and never assume a field exists:
 *  - JSON.parse failures are counted with their line number; a few samples kept.
 *  - Unknown `type` values are counted and listed, never fatal.
 *  - Every field access is optional-chained / defaulted.
 *
 * Type inventory below was measured on this machine against Claude Code 2.1.258
 * (171 transcript files, 45,613 lines, 0 parse failures).
 */

import { streamLines } from './jsonl-tail.js';

/** Types we extract structured data from. */
export const RICH_TYPES = new Set(['assistant', 'user', 'system', 'summary']);

/**
 * Types that legitimately appear in transcripts but carry no data we need.
 * Measured counts on 2.1.258 in parentheses.
 */
export const KNOWN_IGNORED_TYPES = new Set([
  'attachment', // 1202
  'last-prompt', // 735
  'ai-title', // 649  (not in m0 findings; discovered in M1)
  'mode', // 594
  'permission-mode', // 593
  'queue-operation', // 563
  'file-history-delta', // 143 (not in m0 findings)
  'file-history-snapshot', // 139
  'frame-link', // 46  (not in m0 findings)
  'bridge-session', // 36
  'atis-latch', // 32
  'agent-name', // 16  (not in m0 findings)
  'cost-state', // 6   (not in m0 findings)
  'artifact-autoreact-ledger', // 3 (not in m0 findings)
  'artifact-comment-monitor', // 2 (not in m0 findings)
  // Documented / historically seen but not observed in this dataset:
  'progress',
  'x-anthropic-internal',
]);

export class ParseStats {
  constructor({ maxSamples = 5 } = {}) {
    this.totalLines = 0;
    this.blankLines = 0;
    this.parsed = 0;
    this.parseFailures = 0;
    /** @type {{file: string|null, lineNo: number, error: string, snippet: string}[]} */
    this.failureSamples = [];
    /** @type {Map<string, number>} */
    this.typeCounts = new Map();
    /** @type {Map<string, number>} */
    this.unknownTypes = new Map();
    /** @type {Map<string, number>} */
    this.blockCounts = new Map();
    this.maxSamples = maxSamples;
    this.files = 0;
    /** Files that could not be read at all (deleted, locked, permission denied). */
    this.skippedFiles = 0;
    /** @type {{file: string, error: string}[]} */
    this.skippedFileSamples = [];
  }

  /** @param {string} file @param {any} error */
  recordSkippedFile(file, error) {
    this.skippedFiles++;
    if (this.skippedFileSamples.length < this.maxSamples) {
      this.skippedFileSamples.push({
        file: String(file),
        error: String(error && error.message ? error.message : error),
      });
    }
  }

  bump(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  recordFailure(file, lineNo, error, raw) {
    this.parseFailures++;
    if (this.failureSamples.length < this.maxSamples) {
      this.failureSamples.push({
        file: file ?? null,
        lineNo,
        error: String(error && error.message ? error.message : error),
        snippet: String(raw).slice(0, 200),
      });
    } else {
      // keep the most recent few: drop oldest, push newest
      this.failureSamples.shift();
      this.failureSamples.push({
        file: file ?? null,
        lineNo,
        error: String(error && error.message ? error.message : error),
        snippet: String(raw).slice(0, 200),
      });
    }
  }

  merge(other) {
    this.totalLines += other.totalLines;
    this.blankLines += other.blankLines;
    this.parsed += other.parsed;
    this.parseFailures += other.parseFailures;
    this.files += other.files;
    this.skippedFiles += other.skippedFiles;
    for (const s of other.skippedFileSamples) {
      if (this.skippedFileSamples.length < this.maxSamples) this.skippedFileSamples.push(s);
    }
    for (const s of other.failureSamples) {
      if (this.failureSamples.length < this.maxSamples) this.failureSamples.push(s);
    }
    for (const [k, v] of other.typeCounts) this.typeCounts.set(k, (this.typeCounts.get(k) || 0) + v);
    for (const [k, v] of other.unknownTypes) this.unknownTypes.set(k, (this.unknownTypes.get(k) || 0) + v);
    for (const [k, v] of other.blockCounts) this.blockCounts.set(k, (this.blockCounts.get(k) || 0) + v);
    return this;
  }

  toJSON() {
    const sortEntries = (m) => Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
    return {
      files: this.files,
      skippedFiles: this.skippedFiles,
      skippedFileSamples: this.skippedFileSamples,
      totalLines: this.totalLines,
      blankLines: this.blankLines,
      parsed: this.parsed,
      parseFailures: this.parseFailures,
      failureSamples: this.failureSamples,
      typeCounts: sortEntries(this.typeCounts),
      unknownTypes: sortEntries(this.unknownTypes),
      blockCounts: sortEntries(this.blockCounts),
    };
  }
}

/**
 * @typedef {Object} ContentBlock
 * @property {string} kind        'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image' | other
 * @property {string} [id]        tool_use id
 * @property {string} [name]      tool name
 * @property {string} [toolUseId] tool_result -> tool_use id
 * @property {boolean} [isError]  tool_result is_error
 * @property {any} [input]        tool_use raw input (kept; summarize at display time)
 * @property {number} [textLength]
 */

/**
 * @typedef {Object} NormalizedRecord
 * @property {string} type
 * @property {string|null} uuid
 * @property {string|null} parentUuid
 * @property {string|null} timestamp   ISO8601 string as written
 * @property {number} tsMs             epoch ms, NaN when unparsable
 * @property {string|null} sessionId
 * @property {boolean} isSidechain
 * @property {string|null} agentId
 * @property {string|null} requestId
 * @property {string|null} messageId
 * @property {string|null} model
 * @property {any} usage
 * @property {ContentBlock[]} blocks
 * @property {string|null} cwd
 * @property {string|null} version
 * @property {string|null} gitBranch
 * @property {string|null} subtype     for type=system
 * @property {any} toolUseResult       for type=user
 * @property {string|null} stopReason
 * @property {number} lineNo
 * @property {string|null} file
 */

/** Normalize a message.content array (or plain string) into ContentBlock[]. */
function normalizeBlocks(content, stats) {
  /** @type {ContentBlock[]} */
  const out = [];
  if (typeof content === 'string') {
    if (content.length) out.push({ kind: 'text', textLength: content.length });
    return out;
  }
  if (!Array.isArray(content)) return out;
  for (const b of content) {
    if (!b || typeof b !== 'object') continue;
    const kind = typeof b.type === 'string' ? b.type : 'unknown';
    if (stats) stats.bump(stats.blockCounts, kind);
    switch (kind) {
      case 'tool_use':
        out.push({
          kind,
          id: typeof b.id === 'string' ? b.id : null,
          name: typeof b.name === 'string' ? b.name : null,
          input: b.input ?? null,
        });
        break;
      case 'tool_result':
        out.push({
          kind,
          toolUseId: typeof b.tool_use_id === 'string' ? b.tool_use_id : null,
          isError: b.is_error === true,
          contentLength: measureContentLength(b.content),
        });
        break;
      case 'text':
        out.push({ kind, textLength: typeof b.text === 'string' ? b.text.length : 0 });
        break;
      case 'thinking':
        out.push({ kind, textLength: typeof b.thinking === 'string' ? b.thinking.length : 0 });
        break;
      default:
        out.push({ kind });
    }
  }
  return out;
}

function measureContentLength(c) {
  if (typeof c === 'string') return c.length;
  if (Array.isArray(c)) {
    let n = 0;
    for (const part of c) {
      if (part && typeof part === 'object' && typeof part.text === 'string') n += part.text.length;
    }
    return n;
  }
  return 0;
}

/**
 * Parse one raw JSONL line into a NormalizedRecord.
 * Returns null for blank lines and for parse failures (both counted in stats).
 *
 * @param {string} raw
 * @param {number} lineNo 1-based line number in the file
 * @param {{stats?: ParseStats, file?: string}} [ctx]
 * @returns {NormalizedRecord|null}
 */
export function parseLine(raw, lineNo, ctx = {}) {
  const stats = ctx.stats;
  if (stats) stats.totalLines++;
  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (!trimmed) {
    if (stats) stats.blankLines++;
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(trimmed);
  } catch (err) {
    if (stats) stats.recordFailure(ctx.file, lineNo, err, trimmed);
    return null;
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    if (stats) stats.recordFailure(ctx.file, lineNo, new Error('not a JSON object'), trimmed);
    return null;
  }
  if (stats) stats.parsed++;

  const type = typeof obj.type === 'string' ? obj.type : '(missing-type)';
  if (stats) {
    stats.bump(stats.typeCounts, type);
    if (!RICH_TYPES.has(type) && !KNOWN_IGNORED_TYPES.has(type)) {
      stats.bump(stats.unknownTypes, type);
    }
  }

  const msg = obj.message && typeof obj.message === 'object' ? obj.message : null;
  const timestamp = typeof obj.timestamp === 'string' ? obj.timestamp : null;

  /** @type {NormalizedRecord} */
  const rec = {
    type,
    uuid: str(obj.uuid),
    parentUuid: str(obj.parentUuid),
    timestamp,
    tsMs: timestamp ? Date.parse(timestamp) : NaN,
    // `session_id` (snake_case) also occurs on some records; sessionId wins.
    sessionId: str(obj.sessionId) ?? str(obj.session_id),
    isSidechain: obj.isSidechain === true,
    agentId: str(obj.agentId),
    attributionAgent: str(obj.attributionAgent),
    requestId: str(obj.requestId),
    messageId: msg ? str(msg.id) : null,
    model: msg ? str(msg.model) : null,
    usage: msg && msg.usage && typeof msg.usage === 'object' ? msg.usage : null,
    stopReason: msg ? str(msg.stop_reason) : null,
    blocks: msg ? normalizeBlocks(msg.content, stats) : [],
    cwd: str(obj.cwd),
    version: str(obj.version),
    gitBranch: str(obj.gitBranch),
    subtype: str(obj.subtype),
    // type:'ai-title' records are {type, aiTitle, sessionId} - no timestamp.
    // The last one in a transcript is the current title.
    aiTitle: str(obj.aiTitle),
    toolUseResult: type === 'user' ? (obj.toolUseResult ?? null) : null,
    isMeta: obj.isMeta === true,
    lineNo,
    file: ctx.file ?? null,
  };
  return rec;
}

function str(v) {
  return typeof v === 'string' && v.length ? v : null;
}

/** Convenience: tool_use blocks of a record. */
export function toolUses(rec) {
  return rec.blocks.filter((b) => b.kind === 'tool_use');
}

/** Convenience: tool_result blocks of a record. */
export function toolResults(rec) {
  return rec.blocks.filter((b) => b.kind === 'tool_result');
}

/**
 * Stream a whole transcript file, invoking onRecord for each normalized record.
 * Memory stays flat regardless of file size (35MB transcripts exist).
 * @param {string} file
 * @param {(rec: NormalizedRecord) => void} onRecord
 * @param {ParseStats} [stats]
 * @returns {ParseStats}
 */
export function parseFile(file, onRecord, stats = new ParseStats()) {
  stats.files++;
  let delivered = 0;
  let result;
  try {
    result = streamLines(file, (line, lineNo) => {
      delivered++;
      const rec = parseLine(line, lineNo, { stats, file });
      if (rec) onRecord(rec);
    });
  } catch (err) {
    // A per-file I/O problem (permissions, a lock, a disappearing file) must
    // not abort an aggregate over hundreds of transcripts.
    stats.recordSkippedFile(file, err);
    return stats;
  }
  if (result.missing) {
    // Enumerated a moment ago, gone now: Claude Code prunes old transcripts on
    // its own schedule. Report it rather than silently counting an empty file.
    stats.recordSkippedFile(file, new Error('file disappeared before it could be read'));
    return stats;
  }
  // streamLines skips empty lines entirely, so add them back to keep
  // totalLines equal to the file's real line count.
  const blank = result.lineCount - delivered;
  if (blank > 0) {
    stats.blankLines += blank;
    stats.totalLines += blank;
  }
  return stats;
}
