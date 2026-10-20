'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  classify,
  compareCombos,
  canBeat,
  sortCards,
  findLegalMoves,
  createDeck,
  isIdentityCard,
  CARD_BY_ID,
} = require('../lib/cards');

function cards(...ids) {
  return ids.map((id) => CARD_BY_ID[id]);
}

function combo(...ids) {
  return classify(cards(...ids));
}

test('牌序：点数与花色严格遵循 A3 规则', () => {
  assert.deepEqual(
    sortCards(cards('d4', 's4', 'c4', 'h4', 's5')).map((card) => card.id),
    ['s5', 's4', 'h4', 'c4', 'd4'],
  );
  assert.ok(combo('s3').rank > combo('s2').rank);
  assert.ok(combo('s2').rank > combo('sA').rank);
  assert.ok(combo('sA').rank > combo('sK').rank);
  assert.ok(combo('s4').rank < combo('d5').rank);
  assert.ok(combo('s4').highSuit > combo('h4').highSuit);
});

test('牌型识别：单牌、对子、三条', () => {
  assert.equal(combo('sA').type, 'single');
  assert.equal(combo('d9', 'h9').type, 'pair');
  assert.equal(combo('s9', 'h9', 'c9').type, 'trips');
  assert.equal(combo('d9', 'h8'), null);
  assert.equal(combo('s9', 'h9', 'c8'), null);
});

test('牌型识别：顺子、同花、三带二、四带一、同花顺、皇家同花顺', () => {
  assert.equal(combo('d4', 'h5', 'c6', 's7', 'd8').type, 'straight');
  assert.equal(combo('d4', 'd5', 'd7', 'd9', 'dJ').type, 'flush');
  assert.equal(combo('s9', 'h9', 'c9', 'dK', 'hK').type, 'fullhouse');
  assert.equal(combo('s9', 'h9', 'c9', 'd9', 'hK').type, 'four');
  assert.equal(combo('d4', 'd5', 'd6', 'd7', 'd8').type, 'straightflush');
  assert.equal(combo('s10', 'sJ', 'sQ', 'sK', 'sA').type, 'royal');
  assert.equal(combo('sJ', 'sQ', 'sK', 'sA', 'd2'), null);
  assert.equal(combo('d4', 'h5', 'c6', 's7', 'd9'), null);
});

test('同花顺比较：最高牌点数，再比较最高牌花色', () => {
  const sf8Spade = combo('s4', 's5', 's6', 's7', 's8');
  const sf8Heart = combo('h4', 'h5', 'h6', 'h7', 'h8');
  const sf9Diamond = combo('d5', 'd6', 'd7', 'd8', 'd9');

  assert.equal(sf8Spade.type, 'straightflush');
  assert.equal(sf8Spade.label, '同花顺');
  assert.ok(canBeat(sf9Diamond, sf8Spade));
  assert.ok(canBeat(sf8Spade, sf8Heart));
  assert.ok(!canBeat(sf8Heart, sf8Spade));
});

test('单牌与对子比较：点数优先，再比较花色', () => {
  assert.ok(canBeat(combo('s5'), combo('h4')));
  assert.ok(canBeat(combo('s5'), combo('d5')));
  assert.ok(!canBeat(combo('h5'), combo('s5')));
  assert.ok(canBeat(combo('s9', 'h9'), combo('h9', 'd9')));
  assert.ok(!canBeat(combo('s9', 'h9'), combo('h9', 'd9', 'c9')));
  assert.ok(!canBeat(combo('s4', 'h4'), combo('d5')));
});

test('多张牌按牌型等级跨牌型压制', () => {
  const trips = combo('s9', 'h9', 'c9');
  const straight = combo('d4', 'h5', 'c6', 's7', 'd8');
  const flush = combo('d4', 'd6', 'd8', 'd10', 'dK');
  const fullhouse = combo('s9', 'h9', 'c9', 'dK', 'hK');
  const four = combo('s9', 'h9', 'c9', 'd9', 'hK');
  const straightflush = combo('h4', 'h5', 'h6', 'h7', 'h8');
  const royal = combo('s10', 'sJ', 'sQ', 'sK', 'sA');

  assert.ok(canBeat(straight, trips));
  assert.ok(canBeat(flush, straight));
  assert.ok(canBeat(fullhouse, flush));
  assert.ok(canBeat(four, fullhouse));
  assert.ok(canBeat(straightflush, four));
  assert.ok(canBeat(royal, straightflush));
  assert.ok(!canBeat(four, straightflush));
  assert.ok(!canBeat(straightflush, royal));
  assert.ok(!canBeat(trips, straight));
});

test('顺子比较：最大点数，再比较最大牌花色', () => {
  const straightTo8 = combo('d4', 'h5', 'c6', 's7', 'd8');
  const straightTo9 = combo('s4', 'h5', 'c6', 'd7', 's8');
  assert.ok(canBeat(straightTo9, straightTo8));
  const highSpade = combo('s4', 'd5', 'c6', 'h7', 's8');
  const highHeart = combo('s4', 'd5', 'c6', 'h8', 'h7');
  assert.ok(canBeat(highSpade, highHeart));
});

test('同花比较：先比花色，再比数字序列', () => {
  const lowSpade = combo('s4', 's5', 's7', 's9', 'sJ');
  const highHeart = combo('h5', 'h8', 'h9', 'hJ', 'hK');
  assert.ok(canBeat(lowSpade, highHeart));
  const sameSuitLow = combo('h4', 'h6', 'h8', 'h10', 'hQ');
  assert.ok(canBeat(highHeart, sameSuitLow));
});

test('皇家同花顺按花色决胜', () => {
  const spadeRoyal = combo('s10', 'sJ', 'sQ', 'sK', 'sA');
  const heartRoyal = combo('h10', 'hJ', 'hQ', 'hK', 'hA');
  assert.ok(canBeat(spadeRoyal, heartRoyal));
  assert.ok(!canBeat(heartRoyal, spadeRoyal));
});

test('三条、三带二、四带一只比较核心点数', () => {
  const lowTrips = combo('d9', 'c9', 'h9');
  const highTrips = combo('sJ', 'cJ', 'dJ');
  assert.ok(canBeat(highTrips, lowTrips));
  assert.ok(canBeat(
    combo('s9', 'h9', 'c9', 'dK', 'hK'),
    combo('s8', 'h8', 'c8', 'dA', 'hA'),
  ));
  assert.ok(canBeat(
    combo('s9', 'h9', 'c9', 'd9', 'h4'),
    combo('s8', 'h8', 'c8', 'd8', 'hA'),
  ));
});

test('首出必须包含方块 4', () => {
  const hand = cards('d4', 's4', 'h4', 'd5', 's5', 'c6', 'h7', 's8', 'd9', 'c10', 'hJ', 'sQ', 'dK');
  const legal = findLegalMoves(hand, null, { mustIncludeDiamond4: true });
  assert.ok(legal.length > 0);
  assert.ok(legal.every((move) => move.cards.some((card) => card.id === 'd4')));
  assert.ok(legal.some((move) => move.combo.type === 'single' && move.cards[0].id === 'd4'));
  const illegal = findLegalMoves(hand, null, { mustIncludeDiamond4: false });
  assert.ok(illegal.some((move) => !move.cards.some((card) => card.id === 'd4')));
});

test('52 张牌完整且身份牌为黑桃 A / 黑桃 3', () => {
  const deck = createDeck();
  assert.equal(deck.length, 52);
  assert.equal(new Set(deck.map((card) => card.id)).size, 52);
  assert.deepEqual(deck.filter(isIdentityCard).map((card) => card.id).sort(), ['s3', 'sA']);
});

test('相同牌型无法用完全相同的牌压过', () => {
  assert.equal(compareCombos(combo('sA'), combo('sA')), 0);
  assert.equal(canBeat(combo('sA'), combo('sA')), false);
});
