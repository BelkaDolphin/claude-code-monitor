/**
 * SSE hub tests.
 *
 * The hub only ever touches four things on a response (writeHead, write, end,
 * the error/close events) plus req's close/error, so a stub is enough and the
 * tests stay free of sockets and timing.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { SseHub } from '../src/sse.js';

class StubReq extends EventEmitter {}

class StubRes extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.chunks = [];
    this.statusCode = null;
    this.headers = null;
    this.ended = false;
    this.writeHeadCalls = 0;
    this.failWrite = opts.failWrite === true;
    this.socket = { setNoDelay() { /* noop */ } };
  }

  writeHead(status, headers) {
    this.writeHeadCalls++;
    this.statusCode = status;
    this.headers = headers;
    return this;
  }

  flushHeaders() { /* noop */ }

  write(chunk) {
    if (this.failWrite) {
      const err = new Error('write EPIPE');
      err.code = 'EPIPE';
      throw err;
    }
    this.chunks.push(String(chunk));
    return true;
  }

  end() {
    this.ended = true;
    this.emit('close');
  }

  get text() {
    return this.chunks.join('');
  }
}

function connect(hub, opts = {}) {
  const req = new StubReq();
  const res = new StubRes(opts);
  const added = hub.add(req, res);
  return { req, res, added };
}

describe('sse: connection limit', () => {
  test('accepts up to maxClients and refuses the next one', () => {
    const hub = new SseHub({ pingMs: 0 });
    const ok = [];
    for (let i = 0; i < 8; i++) ok.push(connect(hub));
    assert.equal(hub.size, 8);
    assert.ok(ok.every((c) => c.added.ok === true));

    const ninth = connect(hub);
    assert.equal(ninth.added.ok, false);
    assert.equal(ninth.added.reason, 'too-many-clients');
    assert.equal(hub.size, 8);
    // Crucially, the refused response was NOT written to, so the caller is
    // still free to send its own 503 status.
    assert.equal(ninth.res.writeHeadCalls, 0);
    hub.closeAll();
  });

  test('a slot freed by a disconnect can be reused', () => {
    const hub = new SseHub({ maxClients: 2, pingMs: 0 });
    const a = connect(hub);
    connect(hub);
    assert.equal(connect(hub).added.ok, false);

    a.req.emit('close');
    assert.equal(hub.size, 1);
    assert.equal(connect(hub).added.ok, true);
    hub.closeAll();
  });

  test('a stream opens with the event-stream content type and a retry hint', () => {
    const hub = new SseHub({ pingMs: 0 });
    const { res } = connect(hub);
    assert.equal(res.statusCode, 200);
    assert.match(res.headers['Content-Type'], /text\/event-stream/);
    assert.equal(res.headers.Connection, 'keep-alive');
    assert.equal(res.text, 'retry: 2000\n\n');
    hub.closeAll();
  });

  test('extra headers passed by the caller are kept', () => {
    const hub = new SseHub({ pingMs: 0 });
    const req = new StubReq();
    const res = new StubRes();
    hub.add(req, res, { 'X-Content-Type-Options': 'nosniff' });
    assert.equal(res.headers['X-Content-Type-Options'], 'nosniff');
    hub.closeAll();
  });
});

describe('sse: disconnect cleanup', () => {
  test("req 'close' drops the client and ends the response", () => {
    const hub = new SseHub({ pingMs: 0 });
    const { req, res } = connect(hub);
    assert.equal(hub.size, 1);
    req.emit('close');
    assert.equal(hub.size, 0);
    assert.equal(res.ended, true);
  });

  test("req 'error' drops the client too", () => {
    const hub = new SseHub({ pingMs: 0 });
    const { req } = connect(hub);
    req.emit('error', new Error('reset'));
    assert.equal(hub.size, 0);
  });

  test('a repeated close is harmless', () => {
    const hub = new SseHub({ pingMs: 0 });
    const { req } = connect(hub);
    req.emit('close');
    req.emit('close');
    assert.equal(hub.size, 0);
  });

  test('closeAll ends everybody and refuses later connections', () => {
    const hub = new SseHub({ pingMs: 0 });
    const clients = [connect(hub), connect(hub), connect(hub)];
    hub.closeAll();
    assert.equal(hub.size, 0);
    assert.ok(clients.every((c) => c.res.ended));
    assert.equal(connect(hub).added.reason, 'closed');
  });
});

describe('sse: broadcast', () => {
  test('every client receives the same named event', () => {
    const hub = new SseHub({ pingMs: 0 });
    const a = connect(hub);
    const b = connect(hub);
    const sent = hub.broadcast('snapshot', { ok: true, n: 1 });
    assert.equal(sent, 2);
    for (const c of [a, b]) {
      assert.match(c.res.text, /event: snapshot\ndata: \{"ok":true,"n":1\}\n\n$/);
    }
    hub.closeAll();
  });

  test('a client whose socket is gone is dropped, the others still get it', () => {
    const hub = new SseHub({ pingMs: 0 });
    const good = connect(hub);
    const bad = connect(hub, { failWrite: true });
    // The failing client throws on the very first write (the retry hint), so
    // it is already gone; connect a second good one to prove delivery.
    const good2 = connect(hub);

    const sent = hub.broadcast('snapshot', { ok: true });
    assert.equal(hub.clients.has(bad.added.client), false);
    assert.equal(sent, 2);
    assert.match(good.res.text, /event: snapshot/);
    assert.match(good2.res.text, /event: snapshot/);
    hub.closeAll();
  });

  test('an unserialisable payload does not throw or kill the stream', () => {
    const hub = new SseHub({ pingMs: 0 });
    const { res } = connect(hub);
    const circular = {};
    circular.self = circular;
    assert.doesNotThrow(() => hub.broadcast('snapshot', circular));
    assert.match(res.text, /event: snapshot\ndata: \{"ok":false/);
    assert.equal(hub.size, 1);
    hub.closeAll();
  });
});

describe('sse: ping timer', () => {
  test('starts with the first client and stops when the last one leaves', async () => {
    const hub = new SseHub({ pingMs: 15 });
    assert.equal(hub.pingTimer, null);

    const { req, res } = connect(hub);
    assert.notEqual(hub.pingTimer, null, 'ping should start with the first client');
    await new Promise((r) => setTimeout(r, 50));
    assert.match(res.text, /: ping\n\n/);

    req.emit('close');
    assert.equal(hub.size, 0);
    assert.equal(hub.pingTimer, null, 'ping should stop when nobody is listening');
  });

  test('closeAll also stops the ping timer', () => {
    const hub = new SseHub({ pingMs: 15 });
    connect(hub);
    assert.notEqual(hub.pingTimer, null);
    hub.closeAll();
    assert.equal(hub.pingTimer, null);
  });

  test('a ping to a dead socket drops that client', async () => {
    const hub = new SseHub({ pingMs: 15 });
    const good = connect(hub);
    const bad = connect(hub);
    bad.res.failWrite = true; // dies after the successful handshake write
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(hub.clients.has(bad.added.client), false);
    assert.equal(hub.clients.has(good.added.client), true);
    hub.closeAll();
  });
});
