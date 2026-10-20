'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { A3Game, GameError } = require('../lib/engine');
const { CARD_BY_ID, classify } = require('../lib/cards');

function makeGame(rng = () => 0.42) {
  return new A3Game({
    players: [
      { id: 'p0', name: '阿青' },
      { id: 'p1', name: '小满' },
      { id: 'p2', name: '老K' },
      { id: 'p3', name: '南风' },
    ],
    rng,
  });
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function cards(...ids) {
  return ids.map((id) => CARD_BY_ID[id]);
}

test('发牌：每人 13 张，首出为方块 4 持有者', () => {
  const game = makeGame(seeded(7));
  for (let seat = 0; seat < 4; seat += 1) {
    assert.equal(game.handOf(seat).length, 13);
  }
  const d4Owner = [0, 1, 2, 3].find((seat) => game.handOf(seat).some((card) => card.id === 'd4'));
  assert.equal(game.diamond4Seat, d4Owner);
  assert.equal(game.turnSeat, d4Owner);
  assert.equal(game.mustIncludeDiamond4, true);
  const view = game.getView(d4Owner);
  assert.equal(view.hand.length, 13);
});

test('首手不含方块 4 会被拒绝', () => {
  const game = makeGame(seeded(11));
  const seat = game.turnSeat;
  const nonDiamond = game.handOf(seat).find((card) => card.id !== 'd4');
  assert.throws(
    () => game.play(seat, [nonDiamond.id]),
    (error) => error instanceof GameError && error.code === 'MUST_INCLUDE_DIAMOND4',
  );
});

test('首手包含方块 4 可以出，之后解除限制', () => {
  const game = makeGame(seeded(13));
  const seat = game.turnSeat;
  game.play(seat, ['d4']);
  assert.equal(game.mustIncludeDiamond4, false);
  assert.equal(game.lastPlay.cards[0].id, 'd4');
  assert.equal(game.turnSeat, (seat + 1) % 4);
});

test('其余三家全部不出后，最后出牌者重新自由领出', () => {
  // 手动构造简单场景：三家都不出。
  const game2 = makeGame(seeded(19));
  game2.hands = [
    cards('s5', 'h6'),
    cards('d7', 'c8'),
    cards('h9', 's10'),
    cards('cJ', 'dQ'),
  ];
  game2.turnSeat = 1;
  game2.mustIncludeDiamond4 = false;
  game2.lastPlay = { seat: 0, cards: cards('s4'), combo: classify(cards('s4')), at: 0, auto: false };
  game2.passedSeats.clear();
  game2.turnVersion = 1;
  game2.pass(1);
  assert.equal(game2.turnSeat, 2);
  game2.pass(2);
  assert.equal(game2.turnSeat, 3);
  game2.pass(3);
  assert.equal(game2.lastPlay, null);
  assert.equal(game2.turnSeat, 0);
});

test('本轮出牌记录会显示每家最后一手，收轮后清空', () => {
  const game = makeGame(seeded(29));
  game.hands = [
    cards('s5', 'h6'),
    cards('d7', 'c8'),
    cards('h9', 's10'),
    cards('cJ', 'dQ'),
  ];
  game.turnSeat = 0;
  game.mustIncludeDiamond4 = false;
  game.lastPlay = null;
  game.passedSeats.clear();
  game.finishedSeats = [];

  game.play(0, ['s5']);
  let view = game.getView(0);
  assert.equal(view.trickPlays.length, 1);
  assert.equal(view.trickPlays[0].seat, 0);
  assert.equal(view.trickPlays[0].cards[0].id, 's5');

  game.pass(1);
  view = game.getView(0);
  assert.equal(view.trickPlays.find((entry) => entry.seat === 1).passed, true);

  game.pass(2);
  game.pass(3);
  view = game.getView(0);
  assert.deepEqual(view.trickPlays, []);
  assert.equal(view.lastPlay, null);
});

test('农民出完公开农民身份；两张地主牌都现身后余下农民全部公开', () => {
  const game = makeGame(seeded(31));
  const [farmerA, farmerB] = game.farmerSeats;

  game.finishedSeats = [farmerA];
  let view = game.getView(farmerA);
  assert.equal(view.players[farmerA].farmerRevealed, true);
  assert.equal(view.players[farmerB].farmerRevealed, false);

  const revealed = new Map();
  for (const seat of game.identitySeats) {
    revealed.set(seat, new Set((game.identityCardsBySeat.get(seat) || []).map((card) => card.id)));
  }
  game.revealedIdentities = revealed;
  view = game.getView(farmerB);
  assert.equal(view.bothLandlordsRevealed, true);
  for (const seat of game.farmerSeats) {
    assert.equal(view.players[seat].farmerRevealed, true);
  }
});

test('剩余牌统计等于所有玩家尚未打出的牌', () => {
  const game = makeGame(seeded(37));
  const counts = game.getRemainingRankCounts();
  assert.equal(Object.values(counts).reduce((sum, value) => sum + value, 0), 52);
});

test('出完牌的玩家仍保留最后一手，其余玩家继续跟牌；全过后由下一位领出', () => {  const game = makeGame(seeded(23));
  game.hands = [
    cards('s5'),
    cards('d6', 'c8'),
    cards('h9', 's10'),
    cards('cJ', 'dQ'),
  ];
  game.turnSeat = 0;
  game.mustIncludeDiamond4 = false;
  game.lastPlay = null;
  game.passedSeats.clear();
  game.finishedSeats = [];
  game.finishedSeats.length = 0;
  game.identitySeats = [1, 2];
  game.farmerSeats = [0, 3];
  game.doubleLandlord = false;

  game.play(0, ['s5']);
  assert.deepEqual(game.finishedSeats, [0]);
  assert.equal(game.turnSeat, 1);
  assert.equal(game.lastPlay.seat, 0);

  game.pass(1);
  game.pass(2);
  game.pass(3);
  // 出完牌的玩家不参与，下一位仍在场的玩家（座位 1）领出。
  assert.equal(game.lastPlay, null);
  assert.equal(game.turnSeat, 1);
});

test('积分倍率作用于最终分数，而不是打出顺序', () => {
  const game = makeGame(seeded(41));
  game._applyScore(0, { type: 'straightflush', label: '同花顺' });
  assert.equal(game.getRoundScore(0), 4);
  game._applyScore(0, { type: 'trips', label: '三条' });
  assert.equal(game.getRoundScore(0), 6);
});

test('积分结算：输家扣分，奖池按赢家本场分比例分配', () => {
  const game = makeGame(seeded(43));
  game.identitySeats = [0];
  game.farmerSeats = [1, 2, 3];
  const oneWinner = game._scoreDeltas('landlord');
  assert.deepEqual(oneWinner.roundScores, [2, 2, 2, 2]);
  assert.deepEqual(oneWinner.deltas, [6, -2, -2, -2]);
  assert.equal(oneWinner.deltas.reduce((sum, value) => sum + value, 0), 0);

  game.identitySeats = [0, 1];
  game.farmerSeats = [2, 3];
  const twoWinners = game._scoreDeltas('landlord');
  assert.deepEqual(twoWinners.deltas, [2, 2, -2, -2]);
  assert.equal(twoWinners.deltas.reduce((sum, value) => sum + value, 0), 0);
});

test('借风：身份全明后，出完牌者的队友接管领出', () => {
  const game = makeGame(seeded(23));
  game.borrowWind = true;
  game.hands = [
    cards('s5'),
    cards('d6', 'c8'),
    cards('h9', 's10'),
    cards('cJ', 'dQ'),
  ];
  game.turnSeat = 0;
  game.mustIncludeDiamond4 = false;
  game.lastPlay = null;
  game.passedSeats.clear();
  game.finishedSeats = [];
  game.identitySeats = [1, 2];
  game.farmerSeats = [0, 3];
  game.revealedIdentities = new Map([
    [1, new Set(['sA'])],
    [2, new Set(['s3'])],
  ]);

  game.play(0, ['s5']);
  game.pass(1);
  game.pass(2);
  game.pass(3);
  assert.equal(game.lastPlay, null);
  assert.equal(game.turnSeat, 3);
});

test('身份牌打出后立即公开并标记地主', () => {
  const game = makeGame(seeded(29));
  const owner = [0, 1, 2, 3].find((seat) =>
    game.handOf(seat).some((card) => card.id === 'sA' || card.id === 's3'),
  );
  game.hands[owner] = [CARD_BY_ID.sA, CARD_BY_ID.s3, CARD_BY_ID.d4];
  game.turnSeat = owner;
  game.mustIncludeDiamond4 = false;
  game.lastPlay = null;
  game.passedSeats.clear();

  const before = game.getView(owner);
  assert.equal(before.players[owner].landlordRevealed, false);
  game.play(owner, ['sA']);
  const reveal = game.events.find((event) => event.type === 'reveal');
  assert.ok(reveal);
  assert.equal(reveal.seat, owner);
  assert.ok(reveal.identityCards.some((card) => card.id === 'sA'));
  const after = game.getView(owner);
  assert.equal(after.players[owner].landlordRevealed, true);
  assert.ok(after.players[owner].revealedIdentityCards.some((card) => card.id === 'sA'));
});

test('无牌可出时判定为需要自动跳过', () => {
  const game = makeGame(seeded(31));
  game.hands = [
    cards('d4', 's5'),
    cards('h6', 'c7'),
    cards('h9', 's10'),
    cards('cJ', 'dQ'),
  ];
  game.turnSeat = 1;
  game.mustIncludeDiamond4 = false;
  game.lastPlay = { seat: 0, cards: cards('sA'), combo: classify(cards('sA')), at: 0, auto: false };
  assert.equal(game.hasLegalMoves(1), false);
  game.lastPlay = { seat: 0, cards: cards('d4'), combo: classify(cards('d4')), at: 0, auto: false };
  assert.equal(game.hasLegalMoves(1), true);
});

test('同花顺可以压过四带一，并作为独立牌型记录', () => {
  const game = makeGame(seeded(33));
  const fourCards = cards('s9', 'h9', 'c9', 'd9', 'hK');
  game.hands[0] = [...cards('d4', 'd5', 'd6', 'd7', 'd8'), CARD_BY_ID.s2];
  game.turnSeat = 0;
  game.mustIncludeDiamond4 = false;
  game.lastPlay = {
    seat: 1,
    cards: fourCards,
    combo: classify(fourCards),
    at: 0,
    auto: false,
  };
  game.passedSeats.clear();

  game.play(0, ['d4', 'd5', 'd6', 'd7', 'd8']);
  assert.equal(game.lastPlay.combo.type, 'straightflush');
  assert.equal(game.lastPlay.combo.label, '同花顺');
});

function finishScenario({ identitySeats, doubleLandlord, finishedSeats }) {
  const game = makeGame(seeded(37));
  game.identitySeats = [...identitySeats];
  game.farmerSeats = [0, 1, 2, 3].filter((seat) => !identitySeats.includes(seat));
  game.doubleLandlord = doubleLandlord;
  game.finishedSeats = [...finishedSeats];
  return game._evaluateResult();
}

test('双地主：进入前二即地主胜，否则农民胜', () => {
  assert.equal(finishScenario({
    identitySeats: [0], doubleLandlord: true, finishedSeats: [0],
  }).winner, 'landlord');
  assert.equal(finishScenario({
    identitySeats: [0], doubleLandlord: true, finishedSeats: [1],
  }), null);
  assert.equal(finishScenario({
    identitySeats: [0], doubleLandlord: true, finishedSeats: [1, 0],
  }).winner, 'landlord');
  assert.equal(finishScenario({
    identitySeats: [0], doubleLandlord: true, finishedSeats: [1, 2],
  }).winner, 'farmers');
});

test('无双地：同阵营包揽前二获胜；一三获胜；一四平局', () => {
  const base = { identitySeats: [0, 1], doubleLandlord: false };
  assert.equal(finishScenario({ ...base, finishedSeats: [0, 1] }).winner, 'landlord');
  assert.equal(finishScenario({ ...base, finishedSeats: [1, 0] }).winner, 'landlord');
  assert.equal(finishScenario({ ...base, finishedSeats: [0, 1] }).unfinished.length, 2);
  assert.equal(finishScenario({ ...base, finishedSeats: [0, 2, 1] }).winner, 'landlord');
  assert.equal(finishScenario({ ...base, finishedSeats: [0, 2, 1] }).unfinished.length, 0);
  assert.equal(finishScenario({ ...base, finishedSeats: [2, 0, 1] }).winner, 'draw');
  assert.equal(finishScenario({ ...base, finishedSeats: [2, 3] }).winner, 'farmers');
  assert.equal(finishScenario({ ...base, finishedSeats: [0, 2] }), null);
});

test('随机自动对局可以正常结束，且公开信息不泄露身份', () => {
  for (let seed = 1; seed <= 8; seed += 1) {
    const game = makeGame(seeded(seed * 101));
    const firstView = game.getView(0);
    assert.equal('landlordSeats' in firstView, false);

    let guard = 0;
    while (game.phase === 'playing') {
      guard += 1;
      assert.ok(guard < 1200, '对局不应无限循环');
      const seat = game.turnSeat;
      const moves = game.getLegalMoves(seat);
      if (moves.length > 0) {
        game.play(seat, moves[0].cards.map((card) => card.id));
      } else {
        game.pass(seat);
      }
      assert.ok(game.turnSeat === null || !game.finishedSeats.includes(game.turnSeat));
    }
    assert.ok(game.result);
    assert.ok(['landlord', 'farmers', 'draw'].includes(game.result.winner));
    assert.ok(game.result.rankings.length >= 1);
    const allIdentityCards = game.result.identities
      .flatMap((entry) => entry.cards.map((card) => card.id))
      .sort();
    assert.deepEqual(allIdentityCards, ['s3', 'sA']);
  }
});
