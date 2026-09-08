/**
 * Token usage aggregation.
 *
 * DEDUPE RULE (proven against ccusage 20.0.20 on this machine, all metrics
 * matched exactly for every completed day):
 *   Key on message.id. Among duplicate lines with the same message.id, keep the
 *   one with the LATEST timestamp; on a timestamp tie keep the one with the
 *   larger total token count (a later line in the file is a more complete
 *   snapshot).
 *
 * Claude Code writes multiple lines for one assistant message: streaming
 * snapshots plus the final one. Taking the FIRST line is catastrophically wrong
 * (measured: output_tokens 522,600 vs the true 2,334,305 for one day - a 4.5x
 * undercount).
 *
 * Fallback key when message.id is missing: 'REQ:'+requestId, else 'NOID:'+uuid.
 */

import { localDateKey } from './paths.js';
import { parseFile, ParseStats } from './parser.js';

export const METRICS = ['input_tokens', 'output_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens'];

/** @returns {{input_tokens:number,output_tokens:number,cache_creation_input_tokens:number,cache_read_input_tokens:number,count:number}} */
export function emptyTotals() {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    count: 0,
  };
}

/** @param {any} usage */
export function usageTotal(usage) {
  if (!usage) return 0;
  let n = 0;
  for (const m of METRICS) n += num(usage[m]);
  return n;
}

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function addInto(target, usage) {
  for (const m of METRICS) target[m] += num(usage[m]);
  target.count += 1;
  return target;
}

/**
 * Streaming, order-independent deduplicating usage collector.
 *
 * Feed it every normalized record; it keeps only one entry per message.id, so
 * memory is O(unique messages) not O(lines).
 */
export class UsageCollector {
  constructor() {
    /** @type {Map<string, {usage:any, tsMs:number, total:number, dateKey:string|null, model:string|null, sessionId:string|null, agentId:string|null, isSidechain:boolean}>} */
    this.best = new Map();
    /** raw (pre-dedupe) sums, for comparison/diagnostics */
    this.raw = emptyTotals();
    this.seenLines = 0;
  }

  /**
   * @param {import('./parser.js').NormalizedRecord} rec
   * @returns {boolean} true when the record carried usage
   */
  add(rec) {
    if (!rec || rec.type !== 'assistant') return false;
    const usage = rec.usage;
    if (!usage || typeof usage !== 'object') return false;
    this.seenLines++;
    addInto(this.raw, usage);

    const key = rec.messageId
      ? rec.messageId
      : rec.requestId
        ? `REQ:${rec.requestId}`
        : `NOID:${rec.uuid ?? `${rec.file}#${rec.lineNo}`}`;

    const tsMs = Number.isFinite(rec.tsMs) ? rec.tsMs : -Infinity;
    const total = usageTotal(usage);
    const cur = this.best.get(key);
    if (!cur || tsMs > cur.tsMs || (tsMs === cur.tsMs && total > cur.total)) {
      this.best.set(key, {
        usage,
        tsMs,
        total,
        dateKey: rec.timestamp ? localDateKey(rec.timestamp) : null,
        model: rec.model,
        sessionId: rec.sessionId,
        agentId: rec.agentId,
        isSidechain: rec.isSidechain,
      });
    }
    return true;
  }

  /** Number of unique messages retained after dedupe. */
  get uniqueMessages() {
    return this.best.size;
  }

  /**
   * @returns {{
   *   totals: ReturnType<typeof emptyTotals>,
   *   rawTotals: ReturnType<typeof emptyTotals>,
   *   byDate: Record<string, any>,
   *   byDateModel: Record<string, Record<string, any>>,
   *   byModel: Record<string, any>,
   *   bySession: Record<string, any>,
   *   byAgent: Record<string, any>,
   *   uniqueMessages: number,
   *   usageLines: number
   * }}
   */
  summarize() {
    const totals = emptyTotals();
    /** @type {Record<string, any>} */
    const byDate = {};
    /** @type {Record<string, Record<string, any>>} date -> model -> totals */
    const byDateModel = {};
    const byModel = {};
    const bySession = {};
    const byAgent = {};
    for (const v of this.best.values()) {
      addInto(totals, v.usage);
      const dk = v.dateKey ?? 'UNKNOWN_DATE';
      addInto((byDate[dk] ??= emptyTotals()), v.usage);
      const mk = v.model ?? 'unknown-model';
      addInto((byModel[mk] ??= emptyTotals()), v.usage);
      addInto(((byDateModel[dk] ??= {})[mk] ??= emptyTotals()), v.usage);
      const sk = v.sessionId ?? 'unknown-session';
      addInto((bySession[sk] ??= emptyTotals()), v.usage);
      const ak = v.agentId ?? '(main)';
      addInto((byAgent[ak] ??= emptyTotals()), v.usage);
    }
    // dedupe counters
    for (const bucket of [byDate, byModel, bySession, byAgent]) {
      for (const k of Object.keys(bucket)) bucket[k].totalTokens = usageTotal(bucket[k]);
    }
    for (const dk of Object.keys(byDateModel)) {
      const inner = byDateModel[dk];
      for (const k of Object.keys(inner)) inner[k].totalTokens = usageTotal(inner[k]);
      byDateModel[dk] = sortKeys(inner);
    }
    totals.totalTokens = usageTotal(totals);
    this.raw.totalTokens = usageTotal(this.raw);
    return {
      totals,
      rawTotals: this.raw,
      byDate: sortKeys(byDate),
      byDateModel: sortKeys(byDateModel),
      byModel: sortKeys(byModel),
      bySession: sortKeys(bySession),
      byAgent: sortKeys(byAgent),
      uniqueMessages: this.best.size,
      usageLines: this.seenLines,
      duplicateLines: this.seenLines - this.best.size,
    };
  }
}

function sortKeys(o) {
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, o[k]]));
}

/**
 * Convenience: aggregate a list of transcript files.
 * @param {string[]} files
 * @param {{stats?: import('./parser.js').ParseStats, filter?: (rec:any)=>boolean}} [opts]
 */
export function aggregateFiles(files, opts = {}) {
  const collector = new UsageCollector();
  const stats = opts.stats ?? new ParseStats();
  for (const f of files) {
    // parseFile already turns a per-file I/O failure into stats.skippedFiles,
    // but guard here too so one bad path can never abort a whole aggregate.
    try {
      parseFile(f, (rec) => {
        if (opts.filter && !opts.filter(rec)) return;
        collector.add(rec);
      }, stats);
    } catch (err) {
      stats.recordSkippedFile(f, err);
    }
  }
  const summary = collector.summarize();
  summary.skippedFiles = stats.skippedFiles;
  return { collector, summary, stats };
}
