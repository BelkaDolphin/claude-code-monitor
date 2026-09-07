/**
 * Test helpers. Every fixture is SYNTHESIZED here - we never copy real
 * transcripts into the repo.
 *
 * Temp root: CLAUDE_MONITOR_TEST_DIR when set, else os.tmpdir().
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tmpRoot() {
  const env = process.env.CLAUDE_MONITOR_TEST_DIR;
  return env && env.trim() ? path.resolve(env.trim()) : os.tmpdir();
}

/** Create an isolated temp dir; returns {dir, cleanup}. */
export function makeTmpDir(label = 'cm') {
  fs.mkdirSync(tmpRoot(), { recursive: true });
  const dir = fs.mkdtempSync(path.join(tmpRoot(), `${label}-`));
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch { /* ignore */ }
    },
  };
}

/** Write JSONL from an array of objects (or raw strings). */
export function writeJsonl(file, items, { trailingNewline = true } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = items.map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).join('\n');
  fs.writeFileSync(file, trailingNewline ? `${body}\n` : body, 'utf8');
  return file;
}

export function appendJsonl(file, items, { trailingNewline = true } = {}) {
  const body = items.map((i) => (typeof i === 'string' ? i : JSON.stringify(i))).join('\n');
  fs.appendFileSync(file, trailingNewline ? `${body}\n` : body, 'utf8');
  return file;
}

let seq = 0;
/** Minimal but realistic assistant record. */
export function assistantRec(overrides = {}) {
  seq++;
  const {
    messageId = `msg_${seq}`,
    usage = {},
    content = [],
    timestamp = new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(),
    ...rest
  } = overrides;
  return {
    type: 'assistant',
    uuid: `u-${seq}`,
    parentUuid: null,
    isSidechain: false,
    timestamp,
    sessionId: 'sess-1',
    requestId: `req_${seq}`,
    cwd: 'D:\\test',
    version: '2.1.258',
    gitBranch: 'main',
    message: {
      id: messageId,
      type: 'message',
      role: 'assistant',
      model: 'claude-opus-5',
      stop_reason: null,
      content,
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        ...usage,
      },
    },
    ...rest,
  };
}

/** Minimal user record carrying a tool_result. */
export function toolResultRec(toolUseId, overrides = {}) {
  seq++;
  const { isError = false, toolUseResult = null, timestamp = new Date(Date.UTC(2026, 8, 1, 0, 0, seq)).toISOString(), ...rest } = overrides;
  return {
    type: 'user',
    uuid: `ur-${seq}`,
    parentUuid: null,
    isSidechain: false,
    timestamp,
    sessionId: 'sess-1',
    cwd: 'D:\\test',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: 'ok' }],
    },
    toolUseResult,
    ...rest,
  };
}

export function toolUseBlock(id, name, input) {
  return { type: 'tool_use', id, name, input };
}
