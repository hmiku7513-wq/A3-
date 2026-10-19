'use strict';

/**
 * A3 牌型与比较规则。
 *
 * 点数：4 < 5 < 6 < 7 < 8 < 9 < 10 < J < Q < K < A < 2 < 3
 * 花色：♦ < ♣ < ♥ < ♠
 */

const RANKS = ['4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '3'];
const RANK_VALUE = Object.freeze(
  Object.fromEntries(RANKS.map((rank, index) => [rank, index])),
);

const SUITS = Object.freeze([
  Object.freeze({ id: 'd', symbol: '♦', name: '方块', color: 'red', value: 0 }),
  Object.freeze({ id: 'c', symbol: '♣', name: '梅花', color: 'black', value: 1 }),
  Object.freeze({ id: 'h', symbol: '♥', name: '红心', color: 'red', value: 2 }),
  Object.freeze({ id: 's', symbol: '♠', name: '黑桃', color: 'black', value: 3 }),
]);
const SUIT_BY_ID = Object.freeze(Object.fromEntries(SUITS.map((suit) => [suit.id, suit])));
const SUIT_VALUE = Object.freeze(Object.fromEntries(SUITS.map((suit) => [suit.id, suit.value])));

const CARDS = Object.freeze(
  SUITS.flatMap((suit) =>
    RANKS.map((rank) =>
      Object.freeze({
        id: `${suit.id}${rank}`,
        rank,
        suit: suit.id,
        rankValue: RANK_VALUE[rank],
        suitValue: suit.value,
      }),
    ),
  ),
);
const CARD_BY_ID = Object.freeze(Object.fromEntries(CARDS.map((card) => [card.id, card])));

const COMBO_LABELS = Object.freeze({
  single: '单牌',
  pair: '对子',
  trips: '三条',
  straight: '顺子',
  flush: '同花',
  fullhouse: '三带二',
  four: '四带一',
  straightflush: '同花顺',
  royal: '皇家同花顺',
});

// 单牌、对子不能跨级比较；所有多张牌按牌型等级比较。
const COMBO_RANK = Object.freeze({
  single: 0,
  pair: 1,
  trips: 2,
  straight: 3,
  flush: 4,
  fullhouse: 5,
  four: 6,
  straightflush: 7,
  royal: 8,
});

class CardRuleError extends Error {
  constructor(message, code = 'INVALID_COMBO') {
    super(message);
    this.name = 'CardRuleError';
    this.code = code;
  }
}

function getCard(cardOrId) {
  if (cardOrId && typeof cardOrId === 'object' && cardOrId.id) {
    return CARD_BY_ID[cardOrId.id] || null;
  }
  return CARD_BY_ID[cardOrId] || null;
}

function requireCard(cardOrId) {
  const card = getCard(cardOrId);
  if (!card) throw new CardRuleError(`未知的牌：${String(cardOrId)}`, 'UNKNOWN_CARD');
  return card;
}

function cardPower(cardOrId) {
  const card = requireCard(cardOrId);
  return card.rankValue * 4 + card.suitValue;
}

/** 手牌从大到小：点数优先，同点数黑桃 > 红心 > 梅花 > 方块。 */
function sortCards(cards) {
  return [...cards]
    .map(requireCard)
    .sort((a, b) => b.rankValue - a.rankValue || b.suitValue - a.suitValue);
}

function cardText(cardOrId) {
  const card = requireCard(cardOrId);
  return `${SUIT_BY_ID[card.suit].symbol}${card.rank}`;
}

function cardsText(cards) {
  return cards.map(cardText).join(' ');
}

function createDeck() {
  return CARDS.map((card) => card);
}

function shuffle(cards, rng = Math.random) {
  const array = [...cards];
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function isIdentityCard(cardOrId) {
  const card = requireCard(cardOrId);
  return card.suit === 's' && (card.rank === 'A' || card.rank === '3');
}

function countByRank(cards) {
  const counts = new Map();
  for (const card of cards) {
    counts.set(card.rankValue, (counts.get(card.rankValue) || 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .sort((a, b) => b.count - a.count || b.value - a.value);
}

function summary(type, cards, extra = {}) {
  return Object.freeze({
    type,
    label: COMBO_LABELS[type],
    cat: COMBO_RANK[type],
    size: cards.length,
    cards,
    ...extra,
  });
}

/**
 * 判断一组牌的牌型。
 * 5 张牌若同时满足多种牌型，采用等级最高的那一种
 * （皇家同花顺 > 同花顺 > 同花 / 顺子）。
 */
function classify(cardsInput) {
  const cards = [...cardsInput].map(requireCard);
  const size = cards.length;
  const sorted = sortCards(cards);

  if (size === 1) {
    return summary('single', sorted, {
      rank: sorted[0].rankValue,
      rankLabel: sorted[0].rank,
      suits: [sorted[0].suitValue],
      highSuit: sorted[0].suitValue,
    });
  }

  if (size === 2) {
    if (sorted[0].rankValue !== sorted[1].rankValue) return null;
    return summary('pair', sorted, {
      rank: sorted[0].rankValue,
      rankLabel: sorted[0].rank,
      suits: sorted.map((card) => card.suitValue),
      highSuit: sorted[0].suitValue,
    });
  }

  if (size === 3) {
    if (sorted.some((card) => card.rankValue !== sorted[0].rankValue)) return null;
    return summary('trips', sorted, {
      rank: sorted[0].rankValue,
      rankLabel: sorted[0].rank,
    });
  }

  if (size !== 5) return null;

  const counts = countByRank(sorted);
  const ranks = sorted.map((card) => card.rankValue);
  const uniqueRanks = [...new Set(ranks)].sort((a, b) => b - a);
  const isFlush = sorted.every((card) => card.suit === sorted[0].suit);
  const isStraight =
    uniqueRanks.length === 5 &&
    uniqueRanks[0] <= RANK_VALUE.A &&
    uniqueRanks[0] - uniqueRanks[4] === 4;

  if (
    isFlush &&
    uniqueRanks.length === 5 &&
    uniqueRanks[0] === RANK_VALUE.A &&
    uniqueRanks[4] === RANK_VALUE['10']
  ) {
    return summary('royal', sorted, {
      suit: sorted[0].suit,
      suitValue: sorted[0].suitValue,
      rank: uniqueRanks[0],
      ranks: uniqueRanks,
    });
  }

  if (isFlush && isStraight) {
    return summary('straightflush', sorted, {
      suit: sorted[0].suit,
      suitValue: sorted[0].suitValue,
      rank: uniqueRanks[0],
      rankLabel: sorted[0].rank,
      highSuit: sorted[0].suitValue,
      ranks: uniqueRanks,
    });
  }

  if (isFlush) {
    return summary('flush', sorted, {
      suit: sorted[0].suit,
      suitValue: sorted[0].suitValue,
      rank: uniqueRanks[0],
      rankLabel: sorted[0].rank,
      ranks: uniqueRanks,
    });
  }

  if (isStraight) {
    const highCard = sorted[0];
    return summary('straight', sorted, {
      rank: uniqueRanks[0],
      rankLabel: highCard.rank,
      highSuit: highCard.suitValue,
      ranks: uniqueRanks,
    });
  }

  if (counts.length === 2 && counts[0].count === 3 && counts[1].count === 2) {
    return summary('fullhouse', sorted, {
      rank: counts[0].value,
      rankLabel: RANKS[counts[0].value],
      pairRank: counts[1].value,
    });
  }

  if (counts.length === 2 && counts[0].count === 4 && counts[1].count === 1) {
    return summary('four', sorted, {
      rank: counts[0].value,
      rankLabel: RANKS[counts[0].value],
      kicker: counts[1].value,
    });
  }

  return null;
}

function compareNumberArrays(a, b) {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const av = a[i] ?? -1;
    const bv = b[i] ?? -1;
    if (av !== bv) return av - bv;
  }
  return 0;
}

/**
 * 比较两个已经识别出的牌型。
 * @returns {number} >0 表示 a 更大，<0 表示 b 更大，0 表示相同。
 */
function compareCombos(a, b) {
  if (!a || !b) throw new CardRuleError('无法比较空的牌型');
  if (a.cat !== b.cat) return a.cat - b.cat;

  switch (a.type) {
    case 'single':
      return a.rank - b.rank || a.highSuit - b.highSuit;
    case 'pair':
      return a.rank - b.rank || compareNumberArrays(a.suits, b.suits);
    case 'trips':
    case 'fullhouse':
    case 'four':
      return a.rank - b.rank;
    case 'straight':
      return a.rank - b.rank || a.highSuit - b.highSuit;
    case 'flush':
      return a.suitValue - b.suitValue || compareNumberArrays(a.ranks, b.ranks);
    case 'straightflush':
      return a.rank - b.rank || a.highSuit - b.highSuit;
    case 'royal':
      return a.suitValue - b.suitValue;
    default:
      return 0;
  }
}

/**
 * 判断 newCombo 能否压过 previousCombo。
 * 单牌只能压单牌，对子只能压对子；多张牌可以按牌型等级跨牌型压制。
 */
function canBeat(combo, previousCombo) {
  if (!combo) return false;
  if (!previousCombo) return true;

  const comboIsBasic = combo.type === 'single' || combo.type === 'pair';
  const previousIsBasic = previousCombo.type === 'single' || previousCombo.type === 'pair';

  if (previousIsBasic) {
    if (combo.type !== previousCombo.type) return false;
    return compareCombos(combo, previousCombo) > 0;
  }

  if (comboIsBasic) return false;
  return compareCombos(combo, previousCombo) > 0;
}

function combinations(items, count) {
  const result = [];
  const current = [];
  function walk(start) {
    if (current.length === count) {
      result.push([...current]);
      return;
    }
    for (let i = start; i <= items.length - (count - current.length); i += 1) {
      current.push(items[i]);
      walk(i + 1);
      current.pop();
    }
  }
  walk(0);
  return result;
}

/**
 * 求出手牌中所有可以出的牌组。
 * 仅用于服务端自动跳过判断、离线托管与测试，不会把结果全部发给客户端。
 */
function findLegalMoves(handInput, previousCombo = null, options = {}) {
  const hand = sortCards(handInput);
  const { mustIncludeDiamond4 = false } = options;
  const found = [];

  function addIfLegal(cards) {
    if (mustIncludeDiamond4 && !cards.some((card) => card.id === 'd4')) return;
    const combo = classify(cards);
    if (!combo) return;
    if (!canBeat(combo, previousCombo)) return;
    found.push({ combo, cards: sortCards(cards) });
  }

  for (const card of hand) addIfLegal([card]);

  const byRank = new Map();
  for (const card of hand) {
    if (!byRank.has(card.rankValue)) byRank.set(card.rankValue, []);
    byRank.get(card.rankValue).push(card);
  }

  for (const group of byRank.values()) {
    if (group.length >= 2) {
      for (const pair of combinations(group, 2)) addIfLegal(pair);
    }
    if (group.length >= 3) {
      for (const trips of combinations(group, 3)) addIfLegal(trips);
    }
  }

  for (const five of combinations(hand, 5)) addIfLegal(five);

  found.sort((a, b) => {
    const byCat = a.combo.cat - b.combo.cat;
    if (byCat !== 0) return byCat;
    const compare = compareCombos(a.combo, b.combo);
    if (compare !== 0) return compare;
    return a.cards.reduce((sum, card) => sum + cardPower(card), 0) -
      b.cards.reduce((sum, card) => sum + cardPower(card), 0);
  });

  return found;
}

function hasLegalMove(hand, previousCombo = null, options = {}) {
  return findLegalMoves(hand, previousCombo, options).length > 0;
}

function publicCard(cardOrId) {
  const card = requireCard(cardOrId);
  return { id: card.id, rank: card.rank, suit: card.suit };
}

function publicCards(cards) {
  return cards.map(publicCard);
}

function comboPublic(combo) {
  if (!combo) return null;
  return {
    type: combo.type,
    label: combo.label,
    cat: combo.cat,
    size: combo.size,
    rankLabel: combo.rankLabel || null,
    suit: combo.suit || null,
    royal: combo.type === 'royal',
  };
}

module.exports = {
  RANKS,
  RANK_VALUE,
  SUITS,
  SUIT_BY_ID,
  SUIT_VALUE,
  CARDS,
  CARD_BY_ID,
  COMBO_LABELS,
  COMBO_RANK,
  CardRuleError,
  getCard,
  requireCard,
  cardPower,
  sortCards,
  cardText,
  cardsText,
  createDeck,
  shuffle,
  isIdentityCard,
  classify,
  compareCombos,
  canBeat,
  combinations,
  findLegalMoves,
  hasLegalMove,
  publicCard,
  publicCards,
  comboPublic,
};
