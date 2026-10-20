'use strict';

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { server, closeForTests } = require('../server');

class Client {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.latest = null;
    this.joined = null;
  }

  async connect(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('open timeout')), 5000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'state') this.latest = message.room;
      if (message.type === 'joined') this.joined = message;
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  async waitFor(predicate, timeout = 9000, label = 'condition') {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate(this)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  close() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
  }
}

test('出牌限时到点后自动推进，并按先手/跟牌规则处理', async (t) => {
  if (!server.listening) await once(server, 'listening');
  const port = server.address().port;
  const clients = [];

  t.after(async () => {
    for (const client of clients) client.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await closeForTests();
  });

  for (let i = 0; i < 4; i += 1) {
    const client = new Client(`计时玩家${i + 1}`);
    clients.push(client);
    await client.connect(port);
  }
  clients[0].send({ type: 'create', name: '青禾' });
  await clients[0].waitFor((client) => client.joined, 5000, 'create');
  const code = clients[0].joined.roomCode;
  const names = ['小满', '老K', '南风'];

  for (let i = 1; i < 4; i += 1) {
    clients[i].send({ type: 'join', code, name: names[i - 1] });
    await clients[i].waitFor((client) => client.joined, 5000, `join ${i}`);
  }
  await clients[0].waitFor(
    (client) => client.latest?.phase === 'lobby' && client.latest.players.length === 4,
    5000,
    'four players',
  );
  for (let i = 1; i < 4; i += 1) clients[i].send({ type: 'ready', ready: true });
  await clients[0].waitFor((client) => client.latest?.canStart, 5000, 'start enabled');
  clients[0].send({ type: 'settings', turnSeconds: 5 });
  await clients[0].waitFor((client) => client.latest?.turnSeconds === 5, 5000, 'turn limit set');
  clients[0].send({ type: 'start' });
  await clients[0].waitFor((client) => client.latest?.phase === 'playing', 5000, 'game start');

  const firstSeat = clients[0].latest.turnSeat;
  const firstEventId = clients[0].latest.events.at(-1).id;
  assert.equal(typeof clients[0].latest.turnDeadline, 'number');

  await clients[0].waitFor(
    (client) => client.latest.events.some((event) => event.id > firstEventId && event.type === 'auto_play'),
    9000,
    'timeout auto play',
  );

  const event = clients[0].latest.events.find((entry) => entry.id > firstEventId);
  assert.equal(event.seat, firstSeat);
  assert.equal(event.auto, true);
  assert.notEqual(clients[0].latest.turnSeat, firstSeat);
  assert.equal(clients[0].latest.autoAction, null);
});
