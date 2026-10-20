'use strict';

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');

const { server, rooms, closeForTests } = require('../server');

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

  async waitFor(predicate, timeout = 8000, label = 'condition') {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate(this)) return;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
    throw new Error(`timeout waiting for ${label}`);
  }

  close() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
  }
}

test('联机供牌：规则开关、两家赢家挑供牌与还牌、自动开局', async (t) => {
  if (!server.listening) await once(server, 'listening');
  const port = server.address().port;
  const clients = [];

  t.after(async () => {
    for (const client of clients) client.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await closeForTests();
  });

  for (let i = 0; i < 4; i += 1) {
    const client = new Client(`玩家${i + 1}`);
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

  clients[0].send({ type: 'settings', tributeEnabled: true });
  await clients[0].waitFor((client) => client.latest?.tributeEnabled === true, 5000, 'tribute enabled');

  // 直接构造上一局结果，专注验证供牌协议与状态机。
  const room = rooms.get(code);
  room.phase = 'ended';
  room.lastResult = {
    winner: 'landlord',
    winnerLabel: '地主胜',
    reason: '地主阵营包揽前二顺位。',
    landlordSeats: [0, 1],
    farmerSeats: [2, 3],
    finishOrder: [0, 1],
  };
  room.lastResultRound = 1;
  room.round = 1;

  clients[0].send({ type: 'restart' });
  await clients[0].waitFor((client) => client.latest?.phase === 'tribute', 5000, 'tribute phase');
  assert.equal(typeof clients[0].latest.actionDeadline, 'number');
  assert.equal(clients[0].latest.tributeSeconds, 30);
  const seatClients = new Map(clients.map((client) => [client.latest.youSeat, client]));
  let guard = 0;
  let sawTributePick = false;
  let sawReturnSelect = false;
  let sawReturnPick = false;

  while (guard < 20) {
    guard += 1;
    const state = clients[0].latest;
    if (state.phase === 'playing') break;
    assert.equal(state.phase, 'tribute');
    if (state.completed) break;
    const seat = state.currentSeat;
    const actor = seatClients.get(seat);
    assert.ok(actor, `seat ${seat} client`);
    await actor.waitFor((client) => client.latest?.currentSeat === seat, 5000, 'actor state');
    const actorState = actor.latest;
    const before = clients[0].latest.events.at(-1)?.id || 0;

    if (actorState.stage === 'tribute_pick') {
      sawTributePick = true;
      assert.equal(actorState.yourAction.type, 'tribute_pick');
      actor.send({ type: 'tribute_pick', cardId: actorState.pool[0].card.id });
    } else if (actorState.stage === 'return_select') {
      sawReturnSelect = true;
      assert.equal(actorState.yourAction.type, 'return_select');
      const count = actorState.yourAction.count;
      const ids = actorState.hand.slice(-count).map((card) => card.id);
      actor.send({ type: 'tribute_return', cards: ids });
    } else if (actorState.stage === 'return_pick') {
      sawReturnPick = true;
      assert.equal(actorState.yourAction.type, 'return_pick');
      actor.send({ type: 'tribute_receive', cardId: actorState.returnPool[0].card.id });
    } else {
      throw new Error(`unexpected tribute stage ${actorState.stage}`);
    }

    await clients[0].waitFor(
      (client) => {
        if (client.latest?.phase === 'playing') return true;
        if (client.latest?.completed) return true;
        const latestId = client.latest?.events?.at(-1)?.id || 0;
        return latestId > before;
      },
      5000,
      `tribute action ${actorState.stage}`,
    );
  }

  assert.equal(sawTributePick, true);
  assert.equal(sawReturnSelect, true);
  assert.equal(sawReturnPick, true);

  await clients[0].waitFor((client) => client.latest?.phase === 'playing', 6000, 'game after tribute');
  for (const client of clients) {
    await client.waitFor(
      (entry) => entry.latest?.phase === 'playing' && entry.latest.hand.length === 13,
      5000,
      '13-card hand after tribute',
    );
    assert.equal(client.latest.players.reduce((sum, player) => sum + player.handCount, 0), 52);
    assert.equal(client.latest.tributeEnabled, true);
  }
});
