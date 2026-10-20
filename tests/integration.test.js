'use strict';

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { classify, findLegalMoves } = require('../lib/cards');

const { server, closeForTests } = require('../server');

class TestClient {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.latest = null;
    this.joined = null;
    this.errors = [];
    this.closed = false;
  }

  async connect(port) {
    this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket open timeout')), 5000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(event.error || new Error('websocket error'));
      }, { once: true });
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
      if (message.type === 'error') this.errors.push(message);
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
    });
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  async waitFor(predicate, timeout = 7000, label = 'condition') {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (predicate(this)) return;
      await delay(15);
    }
    throw new Error(`timed out waiting for ${label}; last state: ${JSON.stringify(this.latest?.phase || null)}`);
  }

  async waitState(predicate, timeout = 7000, label = 'state') {
    await this.waitFor((client) => client.latest && predicate(client.latest), timeout, label);
    return this.latest;
  }

  close() {
    if (this.ws && this.ws.readyState <= WebSocket.OPEN) this.ws.close();
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('A3 在线联机：建房、准备、发牌、重连、自动跳过与完整结算', async (t) => {
  if (!server.listening) await once(server, 'listening');
  const port = server.address().port;
  const clients = [];

  t.after(async () => {
    for (const client of clients) client.close();
    await delay(100);
    await closeForTests();
  });

  const c0 = new TestClient('房主阿青');
  clients.push(c0);
  await c0.connect(port);
  c0.send({ type: 'create', name: '房主阿青' });
  await c0.waitFor((client) => client.joined, 5000, 'create joined');
  const code = c0.joined.roomCode;
  assert.match(code, /^[A-Z0-9]{4}$/);

  const names = ['小满', '老K', '南风'];
  const others = [];
  for (const name of names) {
    const client = new TestClient(name);
    clients.push(client);
    await client.connect(port);
    client.send({ type: 'join', code, name });
    await client.waitFor((entry) => entry.joined, 5000, 'join joined');
    others.push(client);
  }

  await c0.waitState((room) => room.players.length === 4, 5000, 'four players');
  assert.match(c0.latest.code, /^[A-Z0-9]{4}$/);
  assert.equal(c0.latest.phase, 'lobby');
  assert.equal(c0.latest.canStart, false);

  for (const client of others) client.send({ type: 'ready', ready: true });
  await c0.waitState((room) => room.canStart === true, 5000, 'host can start');

  c0.send({ type: 'settings', counterEnabled: true, turnSeconds: 30, tributeSeconds: 15 });
  await c0.waitState(
    (room) => room.counterEnabled === true && room.turnSeconds === 30 && room.tributeSeconds === 15,
    5000,
    'room settings',
  );

  c0.send({ type: 'start' });
  await c0.waitState((room) => room.phase === 'playing', 5000, 'game start');
  for (const client of clients) {
    await client.waitState((room) => room.phase === 'playing' && Array.isArray(room.hand), 5000, 'private hands');
    assert.equal(client.latest.hand.length, 13);
    assert.equal(client.latest.players.length, 4);
    assert.equal('landlordSeats' in client.latest, false);
    assert.equal(client.latest.players.filter((player) => player.handCount === 13).length, 4);
    assert.equal(client.latest.noLegalPlay, undefined);
    assert.equal(client.latest.counterEnabled, true);
    assert.equal(client.latest.cardCounter && Object.values(client.latest.cardCounter).reduce((a, b) => a + b, 0), 39);
    assert.equal(typeof client.latest.turnDeadline, 'number');
    assert.ok(client.latest.turnDeadline > client.latest.serverNow - 1000);
    assert.ok(Array.isArray(client.latest.trickPlays));
  }

  // 断线重连：关闭一个非当前回合玩家的连接，用 token 恢复同一个座位和手牌。
  const seatMap = new Map(clients.map((client) => [client.latest.youSeat, client]));
  const reconnectTarget = others.find((client) => client.latest.youSeat !== c0.latest.turnSeat) || others[0];
  const targetSeat = reconnectTarget.latest.youSeat;
  const targetHand = reconnectTarget.latest.hand.map((card) => card.id).sort();
  const targetToken = reconnectTarget.joined.token;
  const oldTarget = reconnectTarget;
  oldTarget.close();
  await c0.waitState(
    (room) => room.players.some((player) => player.seat === targetSeat && player.connected === false),
    5000,
    'offline player visible',
  );

  const revived = new TestClient(oldTarget.name);
  clients.push(revived);
  await revived.connect(port);
  revived.send({ type: 'join', code, token: targetToken, name: oldTarget.name, reconnect: true });
  await revived.waitFor((client) => client.joined?.reconnected, 5000, 'reconnected');
  await revived.waitState((room) => room.phase === 'playing' && Array.isArray(room.hand), 5000, 'reconnected state');
  assert.equal(revived.latest.youSeat, targetSeat);
  assert.deepEqual(revived.latest.hand.map((card) => card.id).sort(), targetHand);
  seatMap.set(targetSeat, revived);

  let guard = 0;
  let firstPlayChecked = false;
  let autoPassTested = false;
  let revealChecked = false;
  let lastEventId = c0.latest.events.at(-1).id;

  while (guard < 800) {
    guard += 1;
    assert.ok(guard < 800, 'online game did not finish');
    if (c0.latest.phase === 'ended') break;

    const observer = c0.latest;
    const turnSeat = observer.turnSeat;
    assert.notEqual(turnSeat, null);
    const actor = seatMap.get(turnSeat);
    assert.ok(actor, `client for seat ${turnSeat}`);
    await actor.waitState(
      (room) => room.phase === 'ended' || room.turnSeat === turnSeat,
      5000,
      `actor seat ${turnSeat} turn`,
    );

    const state = actor.latest;
    const previousCombo = state.lastPlay ? classify(state.lastPlay.cards) : null;
    const moves = findLegalMoves(state.hand, previousCombo, {
      mustIncludeDiamond4: state.mustIncludeDiamond4,
    });
    const before = c0.latest.events.at(-1)?.id || 0;

    if (moves.length === 0) {
      if (!autoPassTested) {
        // 不主动跳过，验证服务端会在 3 秒后自动推进。
        await c0.waitFor(
          (client) => client.latest && (client.latest.events.at(-1)?.id || 0) > before,
          6500,
          'server auto pass',
        );
        const fresh = c0.latest.events.filter((event) => event.id > before);
        assert.ok(
          fresh.some((event) => event.type === 'pass' || event.type === 'auto_pass'),
          'expected a pass event',
        );
        assert.ok(
          fresh.every((event) => event.type !== 'play' && event.type !== 'auto_play'),
          'auto pass should not play cards',
        );
        assert.equal(c0.latest.noLegalPlay, undefined, 'no-legal state must stay private');
        assert.equal(c0.latest.autoAction, null, 'no-legal auto countdown must stay private');
        autoPassTested = true;
      } else {
        actor.send({ type: 'pass' });
        await c0.waitFor(
          (client) => client.latest && (client.latest.events.at(-1)?.id || 0) > before,
          5000,
          'manual pass',
        );
      }
    } else {
      const move = moves[0];
      actor.send({ type: 'play', cards: move.cards.map((card) => card.id) });
      await c0.waitFor(
        (client) => client.latest && (
          client.latest.phase === 'ended' ||
          (client.latest.events.at(-1)?.id || 0) > before
        ),
        5000,
        'play accepted',
      );
      if (!firstPlayChecked) {
        assert.equal(state.mustIncludeDiamond4, true);
        assert.ok(move.cards.some((card) => card.id === 'd4'));
        firstPlayChecked = true;
      }
    }

    await delay(4);
    const fresh = c0.latest.events.filter((event) => event.id > lastEventId);
    if (!revealChecked && fresh.some((event) => event.type === 'reveal')) {
      const reveal = fresh.find((event) => event.type === 'reveal');
      const revealedPlayer = c0.latest.players.find((player) => player.seat === reveal.seat);
      assert.equal(revealedPlayer.landlordRevealed, true);
      assert.ok(revealedPlayer.revealedIdentityCards.length >= 1);
      revealChecked = true;
    }
    if (c0.latest.events.length > 0) lastEventId = c0.latest.events.at(-1).id;
  }

  assert.equal(c0.latest.phase, 'ended');
  assert.ok(c0.latest.result);
  assert.ok(['landlord', 'farmers', 'draw'].includes(c0.latest.result.winner));
  assert.ok(c0.latest.result.rankings.length >= 1);
  assert.ok(c0.latest.result.identities.length === 4);
  assert.equal(
    c0.latest.result.identities.flatMap((entry) => entry.cards.map((card) => card.id)).sort().join(','),
    's3,sA',
  );
  assert.equal(firstPlayChecked, true);
  assert.equal(autoPassTested, true, 'expected at least one no-legal-play auto pass');
  assert.ok(c0.latest.events.some((event) => event.type === 'end'));

  for (const client of clients) {
    if (client.closed) continue;
    await client.waitState((room) => room.phase === 'ended', 5000, 'ended state');
    assert.ok(client.latest.result);
  }
});
