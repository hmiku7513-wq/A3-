'use strict';

const {
  RANKS,
  CARD_BY_ID,
  createDeck,
  shuffle,
  sortCards,
  isIdentityCard,
  classify,
  canBeat,
  compareCombos,
  findLegalMoves,
  cardText,
  cardsText,
  comboPublic,
  publicCards,
} = require('./cards');

class GameError extends Error {
  constructor(message, code = 'GAME_ERROR') {
    super(message);
    this.name = 'GameError';
    this.code = code;
  }
}

/**
 * 一局 A3 的权威状态。所有出牌和跳过都必须经过这里。
 */
class A3Game {
  constructor({ players, rng = Math.random, now = Date.now, hands = null, startNote = '', borrowWind = false } = {}) {
    if (!Array.isArray(players) || players.length !== 4) {
      throw new GameError('A3 需要正好 4 名玩家', 'PLAYER_COUNT');
    }
    this.now = typeof now === 'function' ? now : () => now;
    this.borrowWind = Boolean(borrowWind);
    this.players = players.map((player, seat) => ({
      seat,
      id: player.id || `seat-${seat}`,
      name: String(player.name || `玩家${seat + 1}`),
    }));

    if (hands) {
      if (!Array.isArray(hands) || hands.length !== 4 || hands.some((hand) => hand.length !== 13)) {
        throw new GameError('供牌完成后的手牌必须是四家各 13 张', 'BAD_HANDS');
      }
      const allIds = hands.flat().map((card) => card.id || card);
      if (new Set(allIds).size !== 52) {
        throw new GameError('供牌完成后的手牌必须包含 52 张不同的牌', 'BAD_HANDS');
      }
      this.deck = [];
      this.hands = hands.map((hand) => sortCards(hand));
    } else {
      this.deck = shuffle(createDeck(), rng);
      this.hands = Array.from({ length: 4 }, (_, seat) =>
        sortCards(this.deck.slice(seat * 13, seat * 13 + 13)),
      );
    }

    this.identitySeats = this.players
      .filter((player) => this.hands[player.seat].some(isIdentityCard))
      .map((player) => player.seat);
    this.farmerSeats = this.players
      .map((player) => player.seat)
      .filter((seat) => !this.identitySeats.includes(seat));
    this.doubleLandlord = this.identitySeats.length === 1;
    this.identityCardsBySeat = new Map(
      this.players.map((player) => [
        player.seat,
        this.hands[player.seat].filter(isIdentityCard),
      ]),
    );

    this.diamond4Seat = this.players.find((player) =>
      this.hands[player.seat].some((card) => card.id === 'd4'),
    ).seat;
    this.firstSeat = this.diamond4Seat;

    this.phase = 'playing';
    this.turnSeat = this.firstSeat;
    this.turnVersion = 1;
    // 本局积分是整桌共用的单一数字 S：底分 2 + 任意玩家累计加分，最后乘全局倍率。
    this.scoreBonus = 0;
    this.scoreMultiplier = 1;
    this.lastPlay = null;
    this.passedSeats = new Set();
    this.trickPlays = new Map();
    this.playedCardIds = new Set();
    this.finishedSeats = [];
    this.mustIncludeDiamond4 = true;
    this.result = null;
    this.revealedIdentities = new Map();
    this.eventSeq = 0;
    this.events = [];
    this.startedAt = this.now();

    this._addEvent(
      'start',
      `${startNote ? `${startNote} ` : '欢乐开局！'}${this._name(this.diamond4Seat)} 拿到 ♦4，先出牌咯！`,
      { seat: this.diamond4Seat, diamond4: true },
    );
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
    if (this.events.length > 80) this.events.shift();
    return event;
  }

  _activeSeats() {
    return this.players
      .map((player) => player.seat)
      .filter((seat) => !this.finishedSeats.includes(seat));
  }

  _nextActiveSeat(fromSeat) {
    for (let step = 1; step <= 4; step += 1) {
      const seat = (fromSeat + step) % 4;
      if (!this.finishedSeats.includes(seat)) return seat;
    }
    return null;
  }

  _setTurn(seat) {
    this.turnSeat = seat;
    this.turnVersion += 1;
    // 注意：不能在这里清空 passedSeats，否则“三家连续不出”永远无法成立。
  }

  _revealIdentityCards(seat, cards) {
    const identityCards = cards.filter(isIdentityCard);
    if (identityCards.length === 0) return null;

    if (!this.revealedIdentities.has(seat)) this.revealedIdentities.set(seat, new Set());
    const already = this.revealedIdentities.get(seat);
    const fresh = identityCards.filter((card) => !already.has(card.id));
    if (fresh.length === 0) return null;

    for (const card of fresh) already.add(card.id);
    const allRevealed = [...already];
    const doubleNow = allRevealed.length === 2;

    return this._addEvent(
      'reveal',
      doubleNow
        ? `双地主闪亮登场！${this._name(seat)} 打出了两张身份牌 ${allRevealed.map(cardText).join(' ')}。`
        : `身份牌亮啦！${this._name(seat)} 打出了 ${fresh.map(cardText).join(' ')}，地主身份藏不住咯！`,
      {
        seat,
        identityCards: fresh.map((card) => ({ id: card.id, rank: card.rank, suit: card.suit })),
        allIdentityCards: allRevealed.map((cardId) => {
          const card = CARD_BY_ID[cardId];
          return { id: card.id, rank: card.rank, suit: card.suit };
        }),
        double: doubleNow,
      },
    );
  }

  _teamOf(seat) {
    return this.identitySeats.includes(seat) ? 'landlord' : 'farmers';
  }

  _teammateActive(seat) {
    const team = this._teamOf(seat);
    for (let step = 1; step <= 4; step += 1) {
      const candidate = (seat + step) % 4;
      if (candidate === seat || this.finishedSeats.includes(candidate)) continue;
      if (this._teamOf(candidate) === team) return candidate;
    }
    return null;
  }

  /**
   * 任意玩家打出的计分牌型都累加到同一个本局积分 S。
   * - 加分项：三条 +1；顺子/同花 +2；三带二/四带一 +3；
   * - 倍率项：同花顺 ×2；皇家同花顺 ×4，乘在最终 S 上（可叠乘）。
   */
  _applyScore(seat, combo) {
    if (!combo) return;
    let bonus = 0;
    let multiplier = 1;
    if (combo.type === 'trips') bonus = 1;
    else if (combo.type === 'straight' || combo.type === 'flush') bonus = 2;
    else if (combo.type === 'fullhouse' || combo.type === 'four') bonus = 3;
    else if (combo.type === 'straightflush') multiplier = 2;
    else if (combo.type === 'royal') multiplier = 4;
    this.scoreBonus += bonus;
    this.scoreMultiplier *= multiplier;
    if (bonus > 0 || multiplier > 1) {
      const roundScore = this.getRoundScore();
      this._addEvent(
        'score',
        `${this._name(seat)} 的 ${combo.label} 计入本局积分，本局积分变成 ${roundScore}。`,
        {
          seat,
          combo: combo.type,
          bonus,
          multiplier,
          roundScore,
        },
      );
    }
  }

  /** 本局全局积分 S（整桌共用，所有玩家看到同一个数字）。 */
  getRoundScore() {
    return (2 + this.scoreBonus) * this.scoreMultiplier;
  }

  /** 兼容旧调用：四家看到的是同一个 S。 */
  getRoundScores() {
    const roundScore = this.getRoundScore();
    return this.players.map(() => roundScore);
  }

  /**
   * 本局结算（零和、同阵营等额）：
   * - 每个输家向每个赢家各支付 S；
   * - 赢家 delta = 输家数 × S；输家 delta = -(赢家数 × S)；
   * - 同一阵营所有人得分/扣分完全相同，Σdelta 恒为 0；
   * - 平局全 0。
   */
  _scoreDeltas(winner) {
    const roundScore = this.getRoundScore();
    const deltas = [0, 0, 0, 0];
    if (winner === 'draw') {
      return { roundScore, roundScores: this.getRoundScores(), deltas };
    }
    const winnerSeats = winner === 'landlord' ? [...this.identitySeats] : [...this.farmerSeats];
    const loserSeats = this.players
      .map((player) => player.seat)
      .filter((seat) => !winnerSeats.includes(seat));
    if (winnerSeats.length === 0 || loserSeats.length === 0) {
      return { roundScore, roundScores: this.getRoundScores(), deltas };
    }

    const winnerDelta = loserSeats.length * roundScore;
    const loserDelta = -(winnerSeats.length * roundScore);
    for (const seat of winnerSeats) deltas[seat] = winnerDelta;
    for (const seat of loserSeats) deltas[seat] = loserDelta;
    return { roundScore, roundScores: this.getRoundScores(), deltas };
  }

  _finishPlayer(seat) {
    this.finishedSeats.push(seat);
    const place = this.finishedSeats.length;
    this._addEvent('finish', `${this._name(seat)} 出完手牌，喜提第 ${place} 顺位！`, {
      seat,
      place,
    });
    return place;
  }

  _finishPlace(seat) {
    return this.finishedSeats.indexOf(seat) + 1;
  }

  _buildResult(winner, reason) {
    const finishedOrder = [...this.finishedSeats];
    const rankings = finishedOrder.map((seat, index) => ({
      seat,
      name: this._name(seat),
      place: index + 1,
      team: this._teamOf(seat),
    }));

    let lastUnfinished = [];
    if (!this.doubleLandlord && finishedOrder.length === 3) {
      const lastSeat = this.players
        .map((player) => player.seat)
        .find((seat) => !finishedOrder.includes(seat));
      rankings.push({
        seat: lastSeat,
        name: this._name(lastSeat),
        place: 4,
        team: this._teamOf(lastSeat),
      });
    }

    const rankedSeats = new Set(rankings.map((entry) => entry.seat));
    lastUnfinished = this.players
      .map((player) => player.seat)
      .filter((seat) => !rankedSeats.has(seat))
      .map((seat) => ({ seat, name: this._name(seat), team: this._teamOf(seat) }));

    const identities = this.players.map((player) => ({
      seat: player.seat,
      name: player.name,
      team: this._teamOf(player.seat),
      cards: (this.identityCardsBySeat.get(player.seat) || []).map((card) => ({
        id: card.id,
        rank: card.rank,
        suit: card.suit,
      })),
    }));

    return {
      winner,
      winnerLabel: winner === 'landlord'
        ? '地主赢啦！'
        : winner === 'farmers'
          ? '农民翻身啦！'
          : '握手言和！',
      reason,
      doubleLandlord: this.doubleLandlord,
      landlordSeats: [...this.identitySeats],
      farmerSeats: [...this.farmerSeats],
      rankings,
      unfinished: lastUnfinished,
      identities,
      finishOrder: [...this.finishedSeats],
    };
  }

  _evaluateResult() {
    const order = this.finishedSeats;
    if (this.doubleLandlord) {
      const landlordSeat = this.identitySeats[0];
      if (order.length >= 1 && order[0] === landlordSeat) {
        return this._buildResult('landlord', '双地主一马当先，前二稳稳到手，太强啦！');
      }
      if (order.length >= 2) {
        if (order[1] === landlordSeat) {
          return this._buildResult('landlord', '双地主抢到第二顺位，前二稳稳拿下！');
        }
        return this._buildResult('farmers', '双地主没进前二，农民阵营欢乐翻盘！');
      }
      return null;
    }

    if (order.length < 2) return null;
    const firstTeam = this._teamOf(order[0]);
    if (this._teamOf(order[1]) === firstTeam) {
      return this._buildResult(
        firstTeam,
        `${firstTeam === 'landlord' ? '地主' : '农民'}阵营包揽前二，配合简直天衣无缝！`,
      );
    }
    if (order.length >= 3) {
      if (this._teamOf(order[2]) === firstTeam) {
        return this._buildResult(
          firstTeam,
          `${firstTeam === 'landlord' ? '地主' : '农民'}阵营拿下一、三顺位，稳稳收下胜利！`,
        );
      }
      return this._buildResult('draw', '双方踢成一、四和二、三，谁也不服谁，平局！');
    }
    return null;
  }

  _endGame(result) {
    this.phase = 'ended';
    const settlement = this._scoreDeltas(result.winner);
    result.roundScore = settlement.roundScore;
    result.roundScores = settlement.roundScores;
    result.scoreDeltas = settlement.deltas;
    this.result = result;
    this.turnSeat = null;
    this.turnVersion += 1;
    this._addEvent('end', `${result.winnerLabel}：${result.reason}`, {
      winner: result.winner,
      roundScore: settlement.roundScore,
    });
  }

  getPlayer(seat) {
    return this.players[seat];
  }

  getLegalMoves(seat) {
    if (this.phase !== 'playing' || this.turnSeat !== seat) return [];
    return findLegalMoves(this.hands[seat], this.lastPlay?.combo || null, {
      mustIncludeDiamond4: this.mustIncludeDiamond4,
    });
  }

  hasLegalMoves(seat) {
    return this.getLegalMoves(seat).length > 0;
  }

  pickAutoMove(seat) {
    const moves = this.getLegalMoves(seat);
    if (moves.length === 0) return null;
    return moves[0];
  }

  play(seat, cardIds, options = {}) {
    if (this.phase !== 'playing') throw new GameError('这局已经结束啦！', 'GAME_ENDED');
    if (this.turnSeat !== seat) throw new GameError('还没轮到你出牌哦，先等等！', 'NOT_YOUR_TURN');
    if (!Array.isArray(cardIds) || cardIds.length === 0) {
      throw new GameError('先选几张牌再出吧！', 'NO_CARDS');
    }

    const ids = cardIds.map(String);
    if (new Set(ids).size !== ids.length) {
      throw new GameError('同一张牌不能选两次哦！', 'DUPLICATE_CARD');
    }
    const handIds = new Set(this.hands[seat].map((card) => card.id));
    for (const id of ids) {
      if (!CARD_BY_ID[id]) throw new GameError(`未知的牌：${id}`, 'UNKNOWN_CARD');
      if (!handIds.has(id)) throw new GameError('这几张牌不在你手里哦！', 'CARD_NOT_IN_HAND');
    }

    const cards = ids.map((id) => CARD_BY_ID[id]);
    const combo = classify(cards);
    if (!combo) {
      throw new GameError(
        '牌型不合法。可选：单牌、对子、三条、顺子、同花、三带二、四带一、同花顺、皇家同花顺。',
        'INVALID_COMBO',
      );
    }

    if (this.mustIncludeDiamond4 && !ids.includes('d4')) {
      throw new GameError('第一手牌必须包含 ♦4。', 'MUST_INCLUDE_DIAMOND4');
    }

    if (this.lastPlay && !canBeat(combo, this.lastPlay.combo)) {
      throw new GameError(
        `这手 ${combo.label} 无法压过 ${this.lastPlay.combo.label}。`,
        'COMBO_TOO_SMALL',
      );
    }

    this.hands[seat] = this.hands[seat].filter((card) => !ids.includes(card.id));
    for (const id of ids) this.playedCardIds.add(id);
    this.mustIncludeDiamond4 = false;
    this.lastPlay = {
      seat,
      cards: sortCards(cards),
      combo,
      at: this.now(),
      auto: Boolean(options.auto),
    };
    this.trickPlays.set(seat, {
      seat,
      cards: sortCards(cards),
      combo,
      passed: false,
      at: this.lastPlay.at,
    });
    this._applyScore(seat, combo);
    this.passedSeats.clear();

    const eventType = options.auto ? 'auto_play' : 'play';
    const prefix = options.auto ? '托管出牌：' : '';
    this._addEvent(
      eventType,
      `${prefix}${this._name(seat)} 甩出 ${combo.label}：${cardsText(sortCards(cards))}`,
      {
        seat,
        cards: publicCards(sortCards(cards)),
        combo: comboPublic(combo),
        auto: Boolean(options.auto),
      },
    );

    this._revealIdentityCards(seat, cards);

    if (this.hands[seat].length === 0) {
      this._finishPlayer(seat);
      const result = this._evaluateResult();
      if (result) {
        this._endGame(result);
        return { ok: true, ended: true, result, combo: comboPublic(combo) };
      }
      const next = this._nextActiveSeat(seat);
      if (next === null) {
        const fallback = this._buildResult(
          this._teamOf(seat),
          '其余玩家均已出完，对局结束。',
        );
        this._endGame(fallback);
        return { ok: true, ended: true, result: fallback, combo: comboPublic(combo) };
      }
      this._setTurn(next);
      return { ok: true, ended: false, combo: comboPublic(combo) };
    }

    const next = this._nextActiveSeat(seat);
    if (next === null) {
      const fallback = this._buildResult(
        this._teamOf(seat),
        '其余玩家均已出完，对局结束。',
      );
      this._endGame(fallback);
      return { ok: true, ended: true, result: fallback, combo: comboPublic(combo) };
    }
    this._setTurn(next);
    return { ok: true, ended: false, combo: comboPublic(combo) };
  }

  pass(seat, options = {}) {
    if (this.phase !== 'playing') throw new GameError('这局已经结束啦！', 'GAME_ENDED');
    if (this.turnSeat !== seat) throw new GameError('还没轮到你呢！', 'NOT_YOUR_TURN');
    if (!this.lastPlay) {
      throw new GameError('这轮你是先手，必须出牌哦！', 'CANNOT_PASS_LEAD');
    }

    this.passedSeats.add(seat);
    this.trickPlays.set(seat, {
      seat,
      cards: [],
      combo: null,
      passed: true,
      at: this.now(),
    });
    const auto = Boolean(options.auto);
    const eventType = auto ? 'auto_pass' : 'pass';
    const prefix = auto ? '托管：' : '';
    this._addEvent(eventType, `${prefix}${this._name(seat)} 潇洒地过啦！`, {
      seat,
      auto,
    });

    const lastSeat = this.lastPlay.seat;
    const activeSeats = this._activeSeats();
    const shouldReset = activeSeats
      .filter((activeSeat) => activeSeat !== lastSeat)
      .every((activeSeat) => this.passedSeats.has(activeSeat));

    if (shouldReset) {
      const lastPlayedCombo = this.lastPlay.combo;
      let leader;
      if (activeSeats.includes(lastSeat)) {
        leader = lastSeat;
      } else if (this.borrowWind && this._bothIdentityCardsRevealed()) {
        const teammate = this._teammateActive(lastSeat);
        leader = teammate === null ? this._nextActiveSeat(lastSeat) : teammate;
      } else {
        leader = this._nextActiveSeat(lastSeat);
      }

      this.lastPlay = null;
      this.passedSeats.clear();
      this.trickPlays.clear();

      if (leader === null) {
        const result = this._buildResult(
          this._teamOf(seat),
          '其余玩家均已出完，对局结束。',
        );
        this._endGame(result);
        return { ok: true, ended: true, reset: true, result };
      }

      this._setTurn(leader);
      this._addEvent(
        'trick',
        `大家都没要，${this._name(leader)} 重新领出！（上一手：${lastPlayedCombo.label}）`,
        { seat: leader, previousType: lastPlayedCombo.type },
      );
      return { ok: true, ended: false, reset: true, leader };
    }

    const next = this._nextActiveSeat(seat);
    if (next === null) {
      const result = this._buildResult(
        this._teamOf(seat),
        '其余玩家均已出完，对局结束。',
      );
      this._endGame(result);
      return { ok: true, ended: true, reset: false, result };
    }
    this._setTurn(next);
    return { ok: true, ended: false, reset: false, next };
  }

  _bothIdentityCardsRevealed() {
    if (this.phase === 'ended') return true;
    let count = 0;
    for (const cards of this.revealedIdentities.values()) count += cards.size;
    return count >= 2;
  }

  _revealedFor(seat) {
    const revealed = this.revealedIdentities.get(seat);
    const allPublic = this.phase === 'ended';
    const identityCards = (this.identityCardsBySeat.get(seat) || []).map((card) => ({
      id: card.id,
      rank: card.rank,
      suit: card.suit,
    }));
    const isFarmer = !this.identitySeats.includes(seat);
    const allLandlordsRevealed = this._bothIdentityCardsRevealed();

    if (allPublic) {
      return {
        cards: identityCards,
        landlordRevealed: identityCards.length > 0,
        doubleRevealed: identityCards.length === 2,
        farmerRevealed: isFarmer,
        team: isFarmer ? 'farmers' : 'landlord',
      };
    }

    const cards = revealed
      ? [...revealed].map((id) => {
          const card = CARD_BY_ID[id];
          return { id: card.id, rank: card.rank, suit: card.suit };
        })
      : [];
    const landlordRevealed = cards.length > 0;
    const farmerRevealed = isFarmer && (allLandlordsRevealed || this.finishedSeats.includes(seat));
    return {
      cards,
      landlordRevealed,
      doubleRevealed: cards.length === 2,
      farmerRevealed,
      team: landlordRevealed ? 'landlord' : farmerRevealed ? 'farmers' : null,
    };
  }

  getView(seat) {
    const you = this.players[seat];
    if (!you) throw new GameError('无效的座位。', 'INVALID_SEAT');

    return {
      phase: this.phase,
      youSeat: seat,
      hand: publicCards(this.hands[seat]),
      players: this.players.map((player) => {
        const identity = this._revealedFor(player.seat);
        return {
          seat: player.seat,
          name: player.name,
          handCount: this.hands[player.seat].length,
          finished: this.finishedSeats.includes(player.seat),
          place: this.finishedSeats.includes(player.seat)
            ? this._finishPlace(player.seat)
            : null,
          landlordRevealed: identity.landlordRevealed,
          farmerRevealed: identity.farmerRevealed,
          team: identity.team,
          revealedIdentityCards: identity.cards,
          doubleRevealed: identity.doubleRevealed,
        };
      }),
      turnSeat: this.turnSeat,
      lastPlay: this.lastPlay
        ? {
            seat: this.lastPlay.seat,
            cards: publicCards(this.lastPlay.cards),
            combo: comboPublic(this.lastPlay.combo),
            at: this.lastPlay.at,
            auto: Boolean(this.lastPlay.auto),
          }
        : null,
      trickPlays: [...this.trickPlays.values()].map((entry) => ({
        seat: entry.seat,
        cards: publicCards(entry.cards),
        combo: entry.combo ? comboPublic(entry.combo) : null,
        passed: entry.passed,
        at: entry.at,
      })),
      passedSeats: [...this.passedSeats],
      finishedSeats: [...this.finishedSeats],
      finishOrder: [...this.finishedSeats].map((finishedSeat) => ({
        seat: finishedSeat,
        name: this._name(finishedSeat),
        place: this._finishPlace(finishedSeat),
      })),
      mustIncludeDiamond4: this.mustIncludeDiamond4,
      firstSeat: this.firstSeat,
      bothLandlordsRevealed: this._bothIdentityCardsRevealed(),
      borrowWind: this.borrowWind,
      roundScore: this.getRoundScore(),
      // 兼容旧字段：四家合并成同一个本局积分 S。
      roundScores: this.getRoundScores(),
      yourRole: {
        isLandlord: this.identitySeats.includes(seat),
        doubleLandlord: this.doubleLandlord && this.identitySeats.includes(seat),
      },
      remainingCounts: this.getRemainingRankCounts(),
      playedCardIds: [...this.playedCardIds],
      events: this.events.slice(-60),
      result: this.result,
      startedAt: this.startedAt,
    };
  }

  getRemainingRankCounts(excludeSeat = null) {
    const counts = Object.fromEntries(RANKS.map((rank) => [rank, 0]));
    for (let seat = 0; seat < this.hands.length; seat += 1) {
      if (seat === excludeSeat) continue;
      for (const card of this.hands[seat]) counts[card.rank] += 1;
    }
    return counts;
  }

  /** 测试辅助：当前手牌副本。 */
  handOf(seat) {
    return [...this.hands[seat]];
  }

  /** 测试辅助：直接比较当前牌型。 */
  compareToLast(cards) {
    const combo = classify(cards);
    if (!combo || !this.lastPlay) return combo && !this.lastPlay ? 1 : 0;
    return compareCombos(combo, this.lastPlay.combo);
  }
}

module.exports = {
  A3Game,
  GameError,
};
