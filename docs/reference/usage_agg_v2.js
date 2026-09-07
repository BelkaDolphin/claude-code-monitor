// v2: dedup by message.id but keep the LAST (latest timestamp / max usage) record,
// since duplicate log lines for the same message.id/requestId can carry partial
// (in-progress) usage snapshots followed by the final complete one.
//
// M0-era one-off verification script. Not part of the dashboard proper
// (see src/usage.js for the real, tested implementation).
const fs = require('fs');
const os = require('os');
const path = require('path');
const ROOT = process.argv[2]
  || (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, 'projects') : null)
  || path.join(os.homedir(), '.claude', 'projects');

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile() && ent.name.endsWith('.jsonl')) out.push(full);
  }
}
const files = [];
walk(ROOT, files);

let totalRecords = 0, parseFailures = 0, assistantRecords = 0, assistantWithUsage = 0;

// message.id -> best record {usage, timestamp}
const bestById = new Map();

function toLocalDate(ts) {
  const d = new Date(ts);
  if (isNaN(d.getTime())) return null;
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

for (const file of files) {
  let content;
  try { content = fs.readFileSync(file, 'utf-8'); } catch (e) { continue; }
  const lines = content.split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    totalRecords++;
    let rec;
    try { rec = JSON.parse(t); } catch (e) { parseFailures++; continue; }
    if (rec.type !== 'assistant') continue;
    assistantRecords++;
    const msg = rec.message;
    if (!msg || !msg.usage) continue;
    assistantWithUsage++;
    const usage = msg.usage;
    const ts = rec.timestamp || null;
    const id = msg.id || (rec.requestId ? 'REQ:' + rec.requestId : 'NOID:' + rec.uuid);

    const cur = bestById.get(id);
    const totalTok = (usage.input_tokens || 0) + (usage.output_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0);
    if (!cur) {
      bestById.set(id, { usage, timestamp: ts, totalTok });
    } else {
      // prefer later timestamp; if equal/missing, prefer larger total usage (assumed more complete)
      const curTs = cur.timestamp ? new Date(cur.timestamp).getTime() : -Infinity;
      const newTs = ts ? new Date(ts).getTime() : -Infinity;
      if (newTs > curTs || (newTs === curTs && totalTok > cur.totalTok)) {
        bestById.set(id, { usage, timestamp: ts, totalTok });
      }
    }
  }
}

console.log('=== SCAN SUMMARY ===');
console.log('files scanned:', files.length);
console.log('total non-empty lines:', totalRecords);
console.log('parse failures:', parseFailures);
console.log('assistant records:', assistantRecords);
console.log('assistant records with usage:', assistantWithUsage);
console.log('unique message.id (dedup-last) count:', bestById.size);

const agg = {};
for (const [id, v] of bestById) {
  const date = v.timestamp ? toLocalDate(v.timestamp) : 'UNKNOWN_DATE';
  if (!agg[date]) agg[date] = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, count: 0 };
  const a = agg[date];
  a.input_tokens += v.usage.input_tokens || 0;
  a.output_tokens += v.usage.output_tokens || 0;
  a.cache_creation_input_tokens += v.usage.cache_creation_input_tokens || 0;
  a.cache_read_input_tokens += v.usage.cache_read_input_tokens || 0;
  a.count += 1;
}

console.log('\n=== AGGREGATE BY DATE (DEDUP-LAST by message.id) ===');
for (const d of Object.keys(agg).sort()) {
  console.log(d, JSON.stringify(agg[d]));
}

fs.writeFileSync(path.join(__dirname, 'agg_dedup_last.json'), JSON.stringify(agg, null, 2));
console.log('\nwrote agg_dedup_last.json');
