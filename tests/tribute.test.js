'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { TributeRound, TributeError } = require('../lib/tribute');
const { isIdentityCard, cardPower, CARD_BY_ID } = require('../lib/cards');

const players = [
  { id: 'p0', name: '青禾' },
  { id: 'p1', name: '小满' },
  { id: 'p2', name: '老K' },
  { id: 'p3', name: '南风' },
];

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function previousResult({ winner, landlordSeats, farmerSeats, finishOrder }) {
  return {
    winner,
    winnerLabel: winner === 'landlord' ? '地主胜' : '农民胜',
    reason: 'test',
    landlordSeats,
    farmerSeats,
    finishOrder,
  };
}

function assertFinalHands(tribute) {
  const hands = tribute.finalHands;
  assert.equal(hands.length, 4);
  for (const hand of hands) assert.equal(hand.length, 13);
  const ids = hands.flat().map((card) => card.id);
  assert.equal(new Set(ids).size, 52);
}

test('平局不需要供牌', () => {
  assert.throws(
    () => new TributeRound({
      players,
      previousResult: previousResult({
        winner: 'draw',
        landlordSeats: [0, 1],
        farmerSeats: [2, 3],
        finishOrder: [0, 2],
      }),
      rng: seeded(1),
    }),
    (error) => error instanceof TributeError && error.code === 'NO_TRIBUTE',
  );
});

test('一个赢家：三家各供一张，赢家还三张，供牌最大者先挑还牌', () => {
  const tribute = new TributeRound({
    players,
    previousResult: previousResult({
      winner: 'landlord',
      landlordSeats: [0],
      farmerSeats: [1, 2, 3],
      finishOrder: [0],
    }),
    rng: seeded(11),
  });

  assert.equal(tribute.stage, 'return_select');
  assert.equal(tribute.currentSeat, 0);
  assert.equal(tribute.getView(0).hand.length, 16);
  for (const seat of [1, 2, 3]) {
    assert.equal(tribute.getView(seat).hand.length, 12);
    assert.equal(tribute.tributeBySeat.get(seat).length, 1);
    assert.equal(isIdentityCard(tribute.tributeBySeat.get(seat)[0]), false);
  }

  const hand = tribute.hands[0];
  tribute.selectReturns(0, hand.slice(-3).map((card) => card.id));
  assert.equal(tribute.stage, 'return_pick');
  assert.equal(tribute.returnPool.length, 3);

  const expectedOrder = [...tribute.tributeBySeat.entries()]
    .sort((a, b) => cardPower(b[1][0]) - cardPower(a[1][0]))
    .map(([seat]) => seat);
  assert.deepEqual(tribute.loserPickOrder, expectedOrder);

  for (let i = 0; i < 3; i += 1) {
    assert.equal(tribute.currentSeat, expectedOrder[i]);
    const cardId = tribute.returnPool[0].card.id;
    tribute.pickReturn(tribute.currentSeat, cardId);
  }
  assert.equal(tribute.completed, true);
  assertFinalHands(tribute);
});

test('两个赢家：赢家按出完顺序挑供牌，再由输家按供牌大小挑还牌', () => {
  const tribute = new TributeRound({
    players,
    previousResult: previousResult({
      winner: 'landlord',
      landlordSeats: [0, 1],
      farmerSeats: [2, 3],
      finishOrder: [0, 1],
    }),
    rng: seeded(23),
  });

  assert.equal(tribute.stage, 'tribute_pick');
  assert.equal(tribute.currentSeat, 0);
  assert.equal(tribute.pool.length, 2);
  assert.equal(tribute.tributeBySeat.get(2).length, 1);
  assert.equal(tribute.tributeBySeat.get(3).length, 1);

  tribute.pickTribute(0, tribute.pool[0].card.id);
  // 剩余一张会自动归第二个赢家。
  assert.equal(tribute.stage, 'return_select');
  assert.equal(tribute.currentSeat, 0);
  assert.equal(tribute.getView(0).hand.length, 14);
  assert.equal(tribute.getView(1).hand.length, 14);

  tribute.selectReturns(0, [tribute.hands[0].at(-1).id]);
  assert.equal(tribute.currentSeat, 1);
  tribute.selectReturns(1, [tribute.hands[1].at(-1).id]);
  assert.equal(tribute.stage, 'return_pick');
  assert.equal(tribute.returnPool.length, 2);

  const expectedOrder = [...tribute.tributeBySeat.entries()]
    .sort((a, b) => cardPower(b[1][0]) - cardPower(a[1][0]))
    .map(([seat]) => seat);
  assert.deepEqual(tribute.loserPickOrder, expectedOrder);
  for (let i = 0; i < 2; i += 1) {
    assert.equal(tribute.currentSeat, expectedOrder[i]);
    tribute.pickReturn(tribute.currentSeat, tribute.returnPool[0].card.id);
  }
  assert.equal(tribute.completed, true);
  assertFinalHands(tribute);
});

test('三个赢家：单输家供三张，赢家按出完顺序挑选并各自还一张', () => {
  const tribute = new TributeRound({
    players,
    previousResult: previousResult({
      winner: 'farmers',
      landlordSeats: [0],
      farmerSeats: [1, 2, 3],
      finishOrder: [1, 2],
    }),
    rng: seeded(37),
  });

  assert.equal(tribute.stage, 'tribute_pick');
  assert.equal(tribute.pool.length, 3);
  assert.equal(tribute.tributeBySeat.get(0).length, 3);
  assert.ok(tribute.tributeBySeat.get(0).every((card) => !isIdentityCard(card)));
  assert.deepEqual(tribute.winnerOrder, [1, 2, 3]);

  tribute.pickTribute(1, tribute.pool[0].card.id);
  assert.equal(tribute.currentSeat, 2);
  tribute.pickTribute(2, tribute.pool[0].card.id);
  assert.equal(tribute.stage, 'return_select');
  assert.equal(tribute.currentSeat, 1);
  assert.equal(tribute.pool.length, 0);

  tribute.selectReturns(1, [tribute.hands[1].at(-1).id]);
  tribute.selectReturns(2, [tribute.hands[2].at(-1).id]);
  tribute.selectReturns(3, [tribute.hands[3].at(-1).id]);
  assert.equal(tribute.completed, true);
  assertFinalHands(tribute);
});

test('供牌阶段不会向其他玩家泄露手牌，且只暴露当前操作', () => {
  const tribute = new TributeRound({
    players,
    previousResult: previousResult({
      winner: 'landlord',
      landlordSeats: [0, 1],
      farmerSeats: [2, 3],
      finishOrder: [0, 1],
    }),
    rng: seeded(41),
  });
  const view = tribute.getView(0);
  assert.equal('hands' in view, false);
  assert.equal(view.yourAction.type, 'tribute_pick');
  const otherView = tribute.getView(2);
  assert.equal(otherView.yourAction, null);
  assert.equal(otherView.hand.length, 12);
  assert.ok(view.events.some((event) => event.type === 'tribute'));
});

test('非当前玩家或错误步骤不能操作', () => {
  const tribute = new TributeRound({
    players,
    previousResult: previousResult({
      winner: 'landlord',
      landlordSeats: [0, 1],
      farmerSeats: [2, 3],
      finishOrder: [0, 1],
    }),
    rng: seeded(43),
  });
  assert.throws(() => tribute.pickTribute(2, tribute.pool[0].card.id), TributeError);
  assert.throws(() => tribute.selectReturns(0, []), TributeError);
});

test('身份牌不能用于还牌', () => {
  const tribute = new TributeRound({
    players,
    previousResult: previousResult({
      winner: 'landlord',
      landlordSeats: [0, 1],
      farmerSeats: [2, 3],
      finishOrder: [0, 1],
    }),
    rng: seeded(47),
  });
  tribute.pickTribute(0, tribute.pool[0].card.id);
  assert.equal(tribute.stage, 'return_select');
  assert.equal(tribute.currentSeat, 0);

  if (!tribute.hands[0].some((card) => card.id === 'sA')) {
    tribute.hands[0] = [...tribute.hands[0], CARD_BY_ID.sA];
  }
  assert.throws(
    () => tribute.selectReturns(0, ['sA']),
    (error) => error instanceof TributeError && error.code === 'IDENTITY_CANNOT_RETURN',
  );

  const normal = tribute.hands[0].find((card) => !isIdentityCard(card));
  tribute.selectReturns(0, [normal.id]);
  assert.equal(tribute.returnPool.length, 1);
  assert.ok(tribute.returnPool.every((entry) => !isIdentityCard(entry.card)));
});
