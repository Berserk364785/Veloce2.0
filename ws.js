'use strict';
/* Минимальный WebSocket-сервер (RFC 6455) без внешних зависимостей.
   Нужен только текстовый обмен JSON, поэтому реализовано ровно это:
   рукопожатие, фрагментация, ping/pong, закрытие, лимит размера кадра. */

const crypto = require('crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_PAYLOAD = 64 * 1024;
const PING_EVERY = 25000; // держит соединение живым за прокси (Render и т.п.)
const MAX_BACKLOG = 2 * 1024 * 1024;

class Conn {
  constructor(socket, req) {
    this.socket = socket;
    this.req = req;
    this.buf = Buffer.alloc(0);
    this.frag = null;
    this.fragOp = 0;
    this.fragSize = 0;
    this.alive = true;
    this.closed = false;
    this.onmessage = () => {};
    this.onclose = () => {};

    socket.on('data', (d) => this._data(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => {});
    this.pingTimer = setInterval(() => {
      if (!this.alive) return this.terminate();
      this.alive = false;
      this._frame(0x9, Buffer.alloc(0));
    }, PING_EVERY);
  }

  send(str) {
    if (this.socket.writableLength > MAX_BACKLOG) return this.terminate(); // «медленный» клиент
    this._frame(0x1, Buffer.from(str, 'utf8'));
  }

  close(code = 1000) {
    if (this.closed) return;
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code, 0);
    this._frame(0x8, p);
    this.socket.end();
  }

  terminate() {
    this.socket.destroy();
    this._closed();
  }

  _closed() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.pingTimer);
    try { this.onclose(); } catch (e) { console.error(e); }
  }

  _frame(op, payload) {
    if (this.closed || this.socket.destroyed) return;
    const len = payload.length;
    let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeUInt32BE(0, 2); h.writeUInt32BE(len, 6); }
    h[0] = 0x80 | op;
    this.socket.write(Buffer.concat([h, payload]));
  }

  _data(chunk) {
    this.alive = true;
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      const f = this._parse();
      if (f === null) break; // нужно больше данных
      if (f === false) return; // протокольная ошибка, соединение закрыто
      this._handle(f);
    }
  }

  _parse() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = !!(b[0] & 0x80);
    const op = b[0] & 0x0f;
    const masked = !!(b[1] & 0x80);
    let len = b[1] & 0x7f;
    let off = 2;
    if (!masked) { this.close(1002); return false; } // клиентские кадры обязаны быть замаскированы
    if (len === 126) {
      if (b.length < 4) return null;
      len = b.readUInt16BE(2);
      off = 4;
    } else if (len === 127) {
      if (b.length < 10) return null;
      if (b.readUInt32BE(2) !== 0) { this.close(1009); return false; }
      len = b.readUInt32BE(6);
      off = 10;
    }
    if (len > MAX_PAYLOAD) { this.close(1009); return false; }
    if (b.length < off + 4 + len) return null;
    const mask = b.subarray(off, off + 4);
    const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
    for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
    this.buf = b.subarray(off + 4 + len);
    return { fin, op, payload };
  }

  _handle({ fin, op, payload }) {
    if (op === 0x8) return this.close(1000);
    if (op === 0x9) return this._frame(0xa, payload);
    if (op === 0xa) return;
    if (op === 0x1 || op === 0x2) {
      this.fragOp = op;
      this.frag = [payload];
      this.fragSize = payload.length;
    } else if (op === 0x0) {
      if (!this.frag) return this.close(1002);
      this.frag.push(payload);
      this.fragSize += payload.length;
      if (this.fragSize > MAX_PAYLOAD) return this.close(1009);
    } else {
      return this.close(1002);
    }
    if (!fin) return;
    const data = Buffer.concat(this.frag);
    const type = this.fragOp;
    this.frag = null;
    if (type === 0x1) {
      try { this.onmessage(data.toString('utf8')); } catch (e) { console.error(e); }
    }
  }
}

function attach(server, wsPath, onConnect) {
  server.on('upgrade', (req, socket) => {
    let pathname = '';
    try { pathname = new URL(req.url, 'http://x').pathname; } catch { /* пусто */ }
    const key = req.headers['sec-websocket-key'];
    if (pathname !== wsPath || String(req.headers.upgrade || '').toLowerCase() !== 'websocket' || !key) {
      socket.destroy();
      return;
    }
    // Защита от чужих сайтов: подключаться можно только со своего домена
    const origin = req.headers.origin;
    if (origin) {
      let ok = false;
      try { ok = new URL(origin).host === req.headers.host; } catch { /* нет */ }
      if (!ok) { socket.destroy(); return; }
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\nConnection: Upgrade\r\n' +
      'Sec-WebSocket-Accept: ' + accept + '\r\n\r\n'
    );
    socket.setNoDelay(true);
    onConnect(new Conn(socket, req));
  });
}

module.exports = { attach };
