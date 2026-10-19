'use strict';

const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE_BYTES = 256 * 1024;

function acceptKey(key) {
  return createHash('sha1').update(key + WS_GUID).digest('base64');
}

function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  let header;
  if (body.length < 126) {
    header = Buffer.alloc(2);
    header[1] = body.length;
  } else if (body.length < 65536) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, body]);
}

class WebSocketConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.fragmentOpcode = null;
    this.closed = false;
    this.pongAt = Date.now();

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._handleClose());
    socket.on('end', () => this._handleClose());
    socket.on('error', (error) => {
      this.emit('error', error);
      this._handleClose();
    });
  }

  _handleClose() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }

  sendText(text) {
    if (this.closed) return false;
    this.socket.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
    return true;
  }

  sendJson(value) {
    return this.sendText(JSON.stringify(value));
  }

  ping() {
    if (this.closed) return;
    this.socket.write(encodeFrame(0x9, Buffer.from(String(Date.now()))));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const reasonBuffer = Buffer.from(reason, 'utf8').subarray(0, 120);
    const payload = Buffer.alloc(2 + reasonBuffer.length);
    payload.writeUInt16BE(code, 0);
    reasonBuffer.copy(payload, 2);
    try {
      this.socket.write(encodeFrame(0x8, payload));
    } catch {
      // Socket may already be gone.
    }
    this.closed = true;
    this.socket.end();
    this.emit('close');
  }

  terminate() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('close');
  }

  _onData(chunk) {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (this.buffer.length > MAX_MESSAGE_BYTES * 2) {
      this.close(1009, 'message too large');
      return;
    }

    try {
      while (this.buffer.length >= 2) {
        const first = this.buffer[0];
        const second = this.buffer[1];
        const fin = (first & 0x80) !== 0;
        const opcode = first & 0x0f;
        const masked = (second & 0x80) !== 0;
        let length = second & 0x7f;
        let offset = 2;

        if (!masked) {
          this.close(1002, 'client frames must be masked');
          return;
        }

        if (length === 126) {
          if (this.buffer.length < 4) return;
          length = this.buffer.readUInt16BE(2);
          offset = 4;
        } else if (length === 127) {
          if (this.buffer.length < 10) return;
          const bigLength = this.buffer.readBigUInt64BE(2);
          if (bigLength > BigInt(MAX_MESSAGE_BYTES)) {
            this.close(1009, 'message too large');
            return;
          }
          length = Number(bigLength);
          offset = 10;
        }

        if (length > MAX_MESSAGE_BYTES) {
          this.close(1009, 'message too large');
          return;
        }
        if (this.buffer.length < offset + 4 + length) return;

        const mask = this.buffer.subarray(offset, offset + 4);
        offset += 4;
        const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
        for (let i = 0; i < payload.length; i += 1) {
          payload[i] ^= mask[i % 4];
        }
        this.buffer = this.buffer.subarray(offset + length);

        if (opcode === 0x8) {
          let code = 1000;
          if (payload.length >= 2) code = payload.readUInt16BE(0);
          this.close(code, '');
          return;
        }
        if (opcode === 0x9) {
          if (!this.closed) this.socket.write(encodeFrame(0xa, payload));
          continue;
        }
        if (opcode === 0xa) {
          this.pongAt = Date.now();
          continue;
        }

        if (opcode === 0x0) {
          if (this.fragmentOpcode === null) {
            this.close(1002, 'unexpected continuation');
            return;
          }
          this.fragments.push(payload);
        } else if (opcode === 0x1 || opcode === 0x2) {
          if (this.fragmentOpcode !== null) {
            this.close(1002, 'fragment already open');
            return;
          }
          this.fragmentOpcode = opcode;
          this.fragments = [payload];
        } else {
          this.close(1003, 'unsupported opcode');
          return;
        }

        if (fin) {
          const complete = Buffer.concat(this.fragments);
          const completeOpcode = this.fragmentOpcode;
          this.fragments = [];
          this.fragmentOpcode = null;
          if (complete.length > MAX_MESSAGE_BYTES) {
            this.close(1009, 'message too large');
            return;
          }
          if (completeOpcode === 0x1) {
            this.emit('message', complete.toString('utf8'));
          } else {
            this.emit('binary', complete);
          }
        }
      }
    } catch (error) {
      this.emit('error', error);
      this.close(1011, 'internal error');
    }
  }
}

/**
 * 将 WebSocket 升级请求挂到原生 HTTP server 上。
 */
function attachWebSocket(server, { path = '/ws', onConnection } = {}) {
  server.on('upgrade', (request, socket) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== path || request.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = request.headers['sec-websocket-key'];
    const version = request.headers['sec-websocket-version'];
    if (!key || version !== '13') {
      socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }

    const headers = [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${acceptKey(key)}`,
      '\r\n',
    ];
    socket.write(headers.join('\r\n'));
    socket.setNoDelay(true);

    const connection = new WebSocketConnection(socket);
    try {
      onConnection(connection, request);
    } catch (error) {
      connection.close(1011, 'connection failed');
      throw error;
    }
  });
}

module.exports = {
  WebSocketConnection,
  attachWebSocket,
  acceptKey,
  encodeFrame,
};
