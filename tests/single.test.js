'use strict';

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { server, closeForTests } = require('../server');

class Client {
  constructor() {
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

  async waitFor(predicate, timeout = 8000, label = 'condition') {
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

test('单机模式：一名玩家加三名电脑玩家，直接发牌并启用记牌器', async (t) => {
  if (!server.listening) await once(server, 'listening');
  const port = server.address().port;
  const client = new Client();

  t.after(async () => {
    client.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await closeForTests();
  });

  await client.connect(port);
  client.send({ type: 'single', name: '单机阿青' });
  await client.waitFor((entry) => entry.joined, 5000, 'single joined');
  await client.waitFor((entry) => entry.latest?.phase === 'playing', 5000, 'single game start');

  const room = client.latest;
  assert.equal(room.singlePlayer, true);
  assert.equal(room.counterEnabled, true);
  assert.equal(room.players.length, 4);
  assert.equal(room.players.filter((player) => player.isBot).length, 3);
  assert.equal(room.players.find((player) => player.isYou).isBot, false);
  assert.equal(room.hand.length, 13);
  assert.equal(typeof room.turnDeadline, 'number');
  assert.ok(Object.values(room.cardCounter).reduce((sum, value) => sum + value, 0) <= 39);

  const startEvent = room.events.at(-1).id;
  client.send({ type: 'trust', enabled: true });
  await client.waitFor(
    (entry) => entry.latest?.players.find((player) => player.isYou)?.autoPlay === true,
    5000,
    'single trust enabled',
  );
  await client.waitFor(
    (entry) => entry.latest?.events.some(
      (event) => event.id > startEvent && event.seat !== room.youSeat &&
        ['play', 'auto_play', 'pass', 'auto_pass'].includes(event.type),
    ),
    6000,
    'bot action',
  );
});
