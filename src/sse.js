/**
 * Server-Sent Events hub.
 *
 * The whole state is small (a handful of sessions), so every push is a full
 * `snapshot` event rather than a diff: no patch protocol to get wrong, and a
 * client that missed a message self-heals on the next one. Bursts are already
 * coalesced by the collector's 250ms debounce.
 *
 * A comment line (`: ping`) every 15s keeps intermediaries and the browser from
 * dropping an idle connection, and gives us a cheap write that fails fast when
 * the peer is gone.
 */

const PING_MS = 15000;
const MAX_CLIENTS = 8;

export class SseHub {
  /** @param {{maxClients?: number, pingMs?: number}} [opts] */
  constructor(opts = {}) {
    this.maxClients = Number.isFinite(opts.maxClients) ? opts.maxClients : MAX_CLIENTS;
    this.pingMs = Number.isFinite(opts.pingMs) ? opts.pingMs : PING_MS;
    /** @type {Set<{res: any, id: number}>} */
    this.clients = new Set();
    this.nextId = 1;
    this.pingTimer = null;
    this.closed = false;
  }

  get size() {
    return this.clients.size;
  }

  /**
   * Attach a response as an SSE stream.
   * @param {import('node:http').IncomingMessage} req
   * @param {import('node:http').ServerResponse} res
   * @param {Record<string,string>} [headers] extra response headers
   * @returns {{ok: boolean, client?: any, reason?: string}}
   */
  add(req, res, headers = {}) {
    if (this.closed) return { ok: false, reason: 'closed' };
    if (this.clients.size >= this.maxClients) return { ok: false, reason: 'too-many-clients' };

    res.writeHead(200, {
      ...headers,
      'Content-Type': 'text/event-stream; charset=utf-8',
      Connection: 'keep-alive',
      // Ask any proxy in between not to buffer; there should not be one on
      // loopback, but it costs nothing.
      'X-Accel-Buffering': 'no',
    });
    // Nagle would add latency to these tiny writes.
    if (res.socket && typeof res.socket.setNoDelay === 'function') res.socket.setNoDelay(true);
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    const client = { res, id: this.nextId++ };
    this.clients.add(client);

    const drop = () => this.remove(client);
    req.on('close', drop);
    req.on('error', drop);
    res.on('error', drop);
    res.on('close', drop);

    // Tell the browser how long to wait before auto-reconnecting.
    this.writeTo(client, 'retry: 2000\n\n');
    this.startPing();
    return { ok: true, client };
  }

  /** @param {{res: any}} client */
  remove(client) {
    if (!this.clients.delete(client)) return;
    try {
      client.res.end();
    } catch { /* already torn down */ }
    if (!this.clients.size) this.stopPing();
  }

  writeTo(client, chunk) {
    try {
      client.res.write(chunk);
      return true;
    } catch {
      this.remove(client);
      return false;
    }
  }

  /**
   * Send one named event to one client.
   * @param {any} client
   * @param {string} event
   * @param {any} data
   */
  send(client, event, data) {
    let payload;
    try {
      payload = JSON.stringify(data);
    } catch (err) {
      payload = JSON.stringify({ ok: false, error: String((err && err.message) || err) });
    }
    // A JSON payload never contains a raw newline, so one data: line is enough.
    return this.writeTo(client, `event: ${event}\ndata: ${payload}\n\n`);
  }

  /** Send one named event to every connected client. */
  broadcast(event, data) {
    let sent = 0;
    for (const client of [...this.clients]) {
      if (this.send(client, event, data)) sent++;
    }
    return sent;
  }

  startPing() {
    if (this.pingTimer || this.pingMs <= 0) return;
    this.pingTimer = setInterval(() => {
      for (const client of [...this.clients]) this.writeTo(client, ': ping\n\n');
    }, this.pingMs);
    if (typeof this.pingTimer.unref === 'function') this.pingTimer.unref();
  }

  stopPing() {
    if (!this.pingTimer) return;
    clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  /** Disconnect everybody (shutdown path). */
  closeAll() {
    this.closed = true;
    for (const client of [...this.clients]) {
      try {
        client.res.end();
      } catch { /* ignore */ }
      this.clients.delete(client);
    }
    this.stopPing();
  }
}

export default SseHub;
