'use strict';

const {
  createDeck,
  shuffle,
  sortCards,
  isIdentityCard,
  cardPower,
  cardText,
  publicCards,
  publicCard,
} = require('./cards');

class TributeError extends Error {
  constructor(message, code = 'TRIBUTE_ERROR') {
    super(message);
    this.name = 'TributeError';
    this.code = code;
  }
}

/**
 * 下一局开始前的供牌 / 还牌流程。
 *
 * 规则摘要：
 * - 1 个赢家（双地主）：3 个输家各供 1 张最高非身份牌；赢家还 3 张；
 *   按供牌大小，供牌最大的输家先挑还牌。
 * - 2 个赢家：2 个输家各供 1 张；赢家按上局出完顺序挑供牌；
 *   赢家各还 1 张；按供牌大小，输家依次挑还牌。
 * - 3 个赢家：1 个输家供 3 张最高非身份牌；赢家按出完顺序各挑 1 张；
 *   赢家各还 1 张，输家收下全部还牌。
 * - 平局不供牌。
 */
class TributeRound {
  constructor({ players, previousResult, rng = Math.random, now = Date.now } = {}) {
    if (!Array.isArray(players) || players.length !== 4) {
      throw new TributeError('供牌需要 4 名玩家', 'PLAYER_COUNT');
    }
    if (!previousResult || previousResult.winner === 'draw') {
      throw new TributeError('平局或没有上局结果时不需要供牌', 'NO_TRIBUTE');
    }

    this.now = typeof now === 'function' ? now : () => now;
    this.players = players.map((player, seat) => ({
      seat,
      id: player.id || `seat-${seat}`,
      name: String(player.name || `玩家${seat + 1}`),
    }));
    this.previousResult = previousResult;
    this.winnerSide = previousResult.winner;
    this.landlordSeats = [...(previousResult.landlordSeats || [])];
    this.farmerSeats = [...(previousResult.farmerSeats || [])];
    this.winnerSeats =
      previousResult.winner === 'landlord' ? this.landlordSeats : this.farmerSeats;
    this.loserSeats =
      previousResult.winner === 'landlord' ? this.farmerSeats : this.landlordSeats;
    this.winnerOrder = this._orderWinners();
    this.deck = shuffle(createDeck(), rng);
    this.hands = Array.from({ length: 4 }, (_, seat) =>
      sortCards(this.deck.slice(seat * 13, seat * 13 + 13)),
    );

    this.stage = 'collect';
    this.currentSeat = null;
    this.pickIndex = 0;
    this.returnIndex = 0;
    this.receiveIndex = 0;
    this.pool = [];
    this.returnPool = [];
    // 已被挑走 / 自动分配的供牌、还牌。池中对应牌会被移走（仍计入 finalHands），
    // 这里保留完整记录供客户端把原位置的牌渲染成“灰色已挑走”。
    this.pickedPool = [];
    this.pickedReturnPool = [];
    this.tributeBySeat = new Map();
    this.returnCounts = new Map();
    this.eventSeq = 0;
    this.events = [];
    this.tributeAssigned = false;
    this.completedAt = null;

    for (const seat of this.winnerSeats) {
      this.returnCounts.set(seat, this.winnerSeats.length === 1 ? 3 : 1);
    }

    this._addEvent(
      'start',
      `上局${previousResult.winnerLabel || (this.winnerSide === 'landlord' ? '地主胜' : '农民胜')}，开始供牌！`,
      { winner: this.winnerSide },
    );
    this._collectTribute();

    this.loserPickOrder = this._makeLoserPickOrder();
    this._advance();
  }

  _name(seat) {
    return this.players[seat]?.name || `玩家${seat + 1}`;
  }

  _addEvent(type, text, data = {}) {
    const event = {
      id: (this.eventSeq += 1),
      type,
      text,
      at: this.now(),
      ...data,
    };
    this.events.push(event);
    if (this.events.length > 60) this.events.shift();
    return event;
  }

  _orderWinners() {
    const finished = Array.isArray(this.previousResult.finishOrder)
      ? this.previousResult.finishOrder
      : [];
    const finishedWinners = finished.filter((seat) => this.winnerSeats.includes(seat));
    const rest = this.winnerSeats
      .filter((seat) => !finishedWinners.includes(seat))
      .sort((a, b) => a - b);
    return [...finishedWinners, ...rest];
  }

  _collectTribute() {
    const perLoser = this.winnerSeats.length === 3 ? 3 : 1;
    for (const loserSeat of this.loserSeats) {
      const eligible = sortCards(this.hands[loserSeat]).filter(
        (card) => !isIdentityCard(card),
      );
      if (eligible.length < perLoser) {
        throw new TributeError(`${this._name(loserSeat)} 的手牌不足以供牌`, 'NOT_ENOUGH_CARDS');
      }
      const given = eligible.slice(0, perLoser);
      const givenIds = new Set(given.map((card) => card.id));
      this.hands[loserSeat] = this.hands[loserSeat].filter(
        (card) => !givenIds.has(card.id),
      );
      this.tributeBySeat.set(loserSeat, given);
      for (const card of given) {
        this.pool.push({ card, fromSeat: loserSeat });
        this._addEvent(
          'tribute',
          `${this._name(loserSeat)} 供出 ${cardText(card)}。`,
          { seat: loserSeat, card: publicCard(card) },
        );
      }
    }
    this.pool.sort((a, b) => cardPower(b.card) - cardPower(a.card));
    // order 用于客户端在“池中灰牌”时保持原始展示位置。
    this.pool.forEach((entry, index) => {
      entry.order = index;
    });
  }

  _recordPicked(list, entry, pickedBySeat, { auto = false } = {}) {
    list.push({
      card: entry.card,
      fromSeat: entry.fromSeat,
      order: entry.order,
      pickedBySeat,
      pickedByName: this._name(pickedBySeat),
      pickedAt: this.now(),
      auto: Boolean(auto),
    });
  }

  _makeLoserPickOrder() {
    const seen = new Set();
    const order = [];
    const sorted = [...this.pool].sort((a, b) => cardPower(b.card) - cardPower(a.card));
    for (const entry of sorted) {
      if (!seen.has(entry.fromSeat)) {
        seen.add(entry.fromSeat);
        order.push(entry.fromSeat);
      }
    }
    // 三赢家时只有一个输家，其余顺序只用于展示。
    for (const seat of this.loserSeats) {
      if (!seen.has(seat)) order.push(seat);
    }
    return order;
  }

  _giveCard(card, toSeat) {
    this.hands[toSeat] = sortCards([...this.hands[toSeat], card]);
  }

  _assignRemainingTribute(toSeat) {
    const entries = this.pool.splice(0);
    for (const entry of entries) {
      this._giveCard(entry.card, toSeat);
      this._recordPicked(this.pickedPool, entry, toSeat, { auto: true });
      this._addEvent(
        'tribute_receive',
        `${this._name(toSeat)} 获得 ${this._name(entry.fromSeat)} 的供牌 ${cardText(entry.card)}。`,
        {
          seat: toSeat,
          fromSeat: entry.fromSeat,
          card: publicCard(entry.card),
        },
      );
    }
  }

  _advance() {
    if (this.stage === 'complete') return;

    // 只有一个赢家时，三张供牌全部归赢家。
    if (this.winnerSeats.length === 1 && !this.tributeAssigned) {
      this._assignRemainingTribute(this.winnerSeats[0]);
      this.tributeAssigned = true;
      this.pickIndex = this.winnerOrder.length;
    }

    // 两个或三个赢家按上局出完顺序挑供牌，最后一个自动获得剩余。
    while (this.winnerSeats.length > 1 && this.pool.length > 1) {
      if (this.pickIndex >= this.winnerOrder.length) break;
      this.stage = 'tribute_pick';
      this.currentSeat = this.winnerOrder[this.pickIndex];
      return;
    }
    if (this.winnerSeats.length > 1 && this.pool.length === 1) {
      const receiver = this.winnerOrder[this.pickIndex] ||
        this.winnerOrder[this.winnerOrder.length - 1];
      if (receiver !== undefined) {
        this._assignRemainingTribute(receiver);
      }
      this.pickIndex = this.winnerOrder.length;
    }

    // 赢家还牌，按赢家顺序逐个选择；最后一个赢家还完后再由输家挑。
    while (this.returnIndex < this.winnerOrder.length) {
      const seat = this.winnerOrder[this.returnIndex];
      const count = this.returnCounts.get(seat) || 0;
      if (count <= 0) {
        this.returnIndex += 1;
        continue;
      }
      this.stage = 'return_select';
      this.currentSeat = seat;
      return;
    }

    // 三赢家：唯一输家直接收下全部还牌。
    if (this.winnerSeats.length === 3 && this.returnPool.length > 0) {
      const loser = this.loserSeats[0];
      const entries = this.returnPool.splice(0);
      for (const entry of entries) {
        this._giveCard(entry.card, loser);
        this._recordPicked(this.pickedReturnPool, entry, loser, { auto: true });
        this._addEvent(
          'return_receive',
          `${this._name(loser)} 收下 ${this._name(entry.fromSeat)} 的还牌 ${cardText(entry.card)}。`,
          {
            seat: loser,
            fromSeat: entry.fromSeat,
            card: publicCard(entry.card),
          },
        );
      }
      this._complete();
      return;
    }

    // 一或两个赢家：输家按照自己供牌的大小，从大到小挑还牌。
    while (this.receiveIndex < this.loserPickOrder.length && this.returnPool.length > 0) {
      this.stage = 'return_pick';
      this.currentSeat = this.loserPickOrder[this.receiveIndex];
      return;
    }

    if (this.returnPool.length === 0) this._complete();
  }

  _complete() {
    this.stage = 'complete';
    this.currentSeat = null;
    this.completedAt = this.now();
    this._addEvent('complete', '供牌完成，准备发牌开局！');
  }

  _requireAction(seat, expectedStage) {
    if (this.stage !== expectedStage) {
      throw new TributeError('当前不是这个供牌步骤。', 'BAD_STAGE');
    }
    if (this.currentSeat !== seat) {
      throw new TributeError('还没有轮到你操作。', 'NOT_YOUR_TRIBUTE_TURN');
    }
  }

  pickTribute(seat, cardId) {
    this._requireAction(seat, 'tribute_pick');
    const index = this.pool.findIndex((entry) => entry.card.id === cardId);
    if (index === -1) {
      throw new TributeError('这张牌不在供牌池中。', 'CARD_NOT_IN_POOL');
    }
    const [entry] = this.pool.splice(index, 1);
    this._giveCard(entry.card, seat);
    this._recordPicked(this.pickedPool, entry, seat);
    this._addEvent(
      'tribute_receive',
      `${this._name(seat)} 挑走了 ${this._name(entry.fromSeat)} 的供牌 ${cardText(entry.card)}。`,
      {
        seat,
        fromSeat: entry.fromSeat,
        card: publicCard(entry.card),
      },
    );
    this.pickIndex += 1;
    this.stage = 'picking';
    this.currentSeat = null;
    this._advance();
  }

  selectReturns(seat, cardIds) {
    this._requireAction(seat, 'return_select');
    if (!Array.isArray(cardIds)) {
      throw new TributeError('请选择要归还的牌。', 'BAD_RETURN');
    }
    const uniqueIds = [...new Set(cardIds.map(String))];
    const required = this.returnCounts.get(seat);
    if (uniqueIds.length !== required || cardIds.length !== required) {
      throw new TributeError(`需要选择 ${required} 张牌归还。`, 'BAD_RETURN_COUNT');
    }
    const handIds = new Set(this.hands[seat].map((card) => card.id));
    for (const id of uniqueIds) {
      if (!handIds.has(id)) {
        throw new TributeError('归还的牌不在你的手牌中。', 'CARD_NOT_IN_HAND');
      }
      if (isIdentityCard(id)) {
        throw new TributeError('身份牌不能参与还牌。', 'IDENTITY_CANNOT_RETURN');
      }
    }
    const cards = uniqueIds.map((id) => this.hands[seat].find((card) => card.id === id));
    const removeIds = new Set(uniqueIds);
    this.hands[seat] = this.hands[seat].filter((card) => !removeIds.has(card.id));
    for (const card of cards) {
      this.returnPool.push({
        card,
        fromSeat: seat,
        order: this.returnPool.length,
      });
    }
    this._addEvent(
      'return',
      `${this._name(seat)} 归还了 ${cards.map(cardText).join('、')}。`,
      {
        seat,
        cards: publicCards(cards),
      },
    );
    this.returnIndex += 1;
    this.stage = 'returning';
    this.currentSeat = null;
    this._advance();
  }

  pickReturn(seat, cardId) {
    this._requireAction(seat, 'return_pick');
    const index = this.returnPool.findIndex((entry) => entry.card.id === cardId);
    if (index === -1) {
      throw new TributeError('这张牌不在还牌池中。', 'CARD_NOT_IN_POOL');
    }
    const [entry] = this.returnPool.splice(index, 1);
    this._giveCard(entry.card, seat);
    this._recordPicked(this.pickedReturnPool, entry, seat);
    this._addEvent(
      'return_receive',
      `${this._name(seat)} 收下 ${this._name(entry.fromSeat)} 的还牌 ${cardText(entry.card)}。`,
      {
        seat,
        fromSeat: entry.fromSeat,
        card: publicCard(entry.card),
      },
    );
    this.receiveIndex += 1;
    this.stage = 'receiving';
    this.currentSeat = null;
    this._advance();
  }

  get completed() {
    return this.stage === 'complete';
  }

  get finalHands() {
    if (!this.completed) {
      throw new TributeError('供牌尚未完成。', 'TRIBUTE_NOT_COMPLETE');
    }
    return this.hands.map((hand) => sortCards(hand));
  }

  getView(seat) {
    const viewer = this.players[seat];
    if (!viewer) throw new TributeError('无效的座位。', 'INVALID_SEAT');
    let yourAction = null;
    if (this.currentSeat === seat) {
      if (this.stage === 'tribute_pick') {
        yourAction = { type: 'tribute_pick', count: 1 };
      } else if (this.stage === 'return_select') {
        yourAction = { type: 'return_select', count: this.returnCounts.get(seat) };
      } else if (this.stage === 'return_pick') {
        yourAction = { type: 'return_pick', count: 1 };
      }
    }

    const instruction = this._instruction();
    return {
      stage: this.stage,
      currentSeat: this.currentSeat,
      instruction,
      yourAction,
      hand: publicCards(this.hands[seat]),
      players: this.players.map((player) => ({
        seat: player.seat,
        name: player.name,
        handCount: this.hands[player.seat].length,
        isWinner: this.winnerSeats.includes(player.seat),
        isLoser: this.loserSeats.includes(player.seat),
        isCurrent: this.currentSeat === player.seat,
      })),
      winners: [...this.winnerSeats],
      losers: [...this.loserSeats],
      winnerOrder: [...this.winnerOrder],
      loserPickOrder: [...this.loserPickOrder],
      winnerOrderNames: this.winnerOrder.map((winnerSeat) => this._name(winnerSeat)),
      loserPickOrderNames: this.loserPickOrder.map((loserSeat) => this._name(loserSeat)),
      pool: this.pool.map((entry) => ({
        card: publicCard(entry.card),
        fromSeat: entry.fromSeat,
        fromName: this._name(entry.fromSeat),
        order: entry.order ?? 0,
        picked: false,
      })),
      pickedPool: this.pickedPool.map((entry) => ({
        card: publicCard(entry.card),
        fromSeat: entry.fromSeat,
        fromName: this._name(entry.fromSeat),
        order: entry.order ?? 0,
        picked: true,
        pickedBySeat: entry.pickedBySeat,
        pickedByName: entry.pickedByName,
        pickedAt: entry.pickedAt,
        auto: Boolean(entry.auto),
      })),
      returnPool: this.returnPool.map((entry) => ({
        card: publicCard(entry.card),
        fromSeat: entry.fromSeat,
        fromName: this._name(entry.fromSeat),
        order: entry.order ?? 0,
        picked: false,
      })),
      pickedReturnPool: this.pickedReturnPool.map((entry) => ({
        card: publicCard(entry.card),
        fromSeat: entry.fromSeat,
        fromName: this._name(entry.fromSeat),
        order: entry.order ?? 0,
        picked: true,
        pickedBySeat: entry.pickedBySeat,
        pickedByName: entry.pickedByName,
        pickedAt: entry.pickedAt,
        auto: Boolean(entry.auto),
      })),
      tributeBySeat: [...this.tributeBySeat.entries()].map(([loserSeat, cards]) => ({
        seat: loserSeat,
        name: this._name(loserSeat),
        cards: publicCards(cards),
      })),
      events: this.events.slice(-60),
      completed: this.completed,
      completedAt: this.completedAt,
      previous: {
        winner: this.previousResult.winner,
        winnerLabel: this.previousResult.winnerLabel,
        reason: this.previousResult.reason,
        landlordSeats: [...this.landlordSeats],
        farmerSeats: [...this.farmerSeats],
      },
      winnerSide: this.winnerSide,
    };
  }

  _instruction() {
    if (this.completed) return '供牌完成，马上开打！';
    if (this.stage === 'tribute_pick') {
      return `${this._name(this.currentSeat)} 正在挑选上供的牌`;
    }
    if (this.stage === 'return_select') {
      return `${this._name(this.currentSeat)} 正在挑选归还的牌`;
    }
    if (this.stage === 'return_pick') {
      return `${this._name(this.currentSeat)} 正在挑选还牌`;
    }
    return '正在准备供牌…';
  }
}

module.exports = {
  TributeRound,
  TributeError,
};
