'use strict';

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, randomBytes } = require('node:crypto');
const { attachWebSocket } = require('./lib/websocket');
const { A3Game, GameError } = require('./lib/engine');
const { TributeRound, TributeError } = require('./lib/tribute');
const { cardPower, isIdentityCard, publicCard } = require('./lib/cards');

const PORT = Number(process.env.PORT || 3213);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const LOBBY_DISCONNECT_GRACE_MS = 60_000;
const OFFLINE_AUTO_PLAY_MS = 10_000;
const NO_MOVE_AUTO_PASS_MS = 3_000;

function randomAutoPassDelay() {
  return 2500 + Math.floor(Math.random() * 1001);
}
const TRIBUTE_OFFLINE_AUTO_MS = 4_000;
const TRIBUTE_COMPLETE_DELAY_MS = 1_800;
const DEFAULT_TURN_SECONDS = 20;
const MIN_TURN_SECONDS = 5;
const MAX_TURN_SECONDS = 30;
const DEFAULT_TRIBUTE_SECONDS = 30;
const MIN_TRIBUTE_SECONDS = 15;
const MAX_TRIBUTE_SECONDS = 60;
// 头像:客户端压到约 100KB,服务端上限 140KB(须小于 websocket 单帧 256KB 上限)。
const MAX_AVATAR_DATA_URL_LENGTH = 140 * 1024;
const AVATAR_DATA_URL_PATTERN =
  /^data:image\/(?:png|jpe?g|webp|gif);base64,[a-z0-9+/]+={0,2}$/i;
// 表情:通用 emoji + 定向送花/砸蛋(菜篮子),同一玩家 3 秒冷却(与客户端 3s 动画一致)。
const EMOTE_KINDS = new Set(['emoji', 'flower', 'egg']);
const EMOTE_RATE_LIMIT_MS = 3_000;
const MAX_EMOJI_CODE_POINTS = 4;
const EMOJI_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

const rooms = new Map();
const sockets = new Set();

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function log(...args) {
  const timestamp = new Date().toISOString().slice(11, 23);
  console.log(`[${timestamp}]`, ...args);
}

function send(ws, message) {
  if (!ws || ws.closed) return;
  try {
    ws.sendJson(message);
  } catch (error) {
    log('send failed:', error.message);
  }
}

function sendError(ws, message, code = 'ERROR') {
  send(ws, { type: 'error', message, code });
}

function sanitizeName(value) {
  const name = String(value ?? '')
    .normalize('NFKC')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 12);
  return name || '无名玩家';
}

function normalizedCode(value) {
  return String(value ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
}

function makeRoomCode() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = '';
    for (let i = 0; i < 4; i += 1) {
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    }
    if (!rooms.has(code)) return code;
  }
  return randomBytes(4).toString('hex').toUpperCase();
}

function makeToken() {
  return randomBytes(24).toString('base64url');
}

function uniqueName(room, desired) {
  const base = sanitizeName(desired);
  const exists = (name) => room.players.some((player) => player.name === name);
  if (!exists(base)) return base;
  for (let suffix = 2; suffix < 100; suffix += 1) {
    const tail = `·${suffix}`;
    const candidate = `${base.slice(0, Math.max(1, 12 - tail.length))}${tail}`;
    if (!exists(candidate)) return candidate;
  }
  return `${base.slice(0, 8)}·${Math.floor(Math.random() * 90 + 10)}`;
}

function playerByToken(room, token) {
  if (!token) return null;
  return room.players.find((player) => player.token === token) || null;
}

function playerById(room, id) {
  return room.players.find((player) => player.id === id) || null;
}

function nextFreeSeat(room) {
  const used = new Set(room.players.map((player) => player.seat));
  for (let seat = 0; seat < 4; seat += 1) {
    if (!used.has(seat)) return seat;
  }
  return -1;
}

function touch(room) {
  room.updatedAt = Date.now();
}

function clampInteger(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function markRoomChanged(room) {
  touch(room);
  if (room.phase === 'playing' && room.game?.phase === 'ended') {
    room.phase = 'ended';
    room.lastResult = room.game.result;
    room.lastResultRound = room.round;
  }
}

function transferHost(room) {
  if (playerById(room, room.hostId)) return;
  const next = room.players.find((player) => player.connected && !player.isBot) || room.players[0];
  room.hostId = next?.id || null;
}

function clearDisconnectTimer(player) {
  if (player.disconnectTimer) {
    clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null;
  }
}

function roomSummaryPlayers(room) {
  return room.players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((player) => ({
      id: player.id,
      name: player.name,
      seat: player.seat,
      ready: Boolean(player.ready),
      connected: Boolean(player.connected),
      isBot: Boolean(player.isBot),
      autoPlay: Boolean(player.autoPlay),
      avatar: player.avatar || null,
      isHost: player.id === room.hostId,
    }));
}

function buildLobbyState(room, viewer) {
  const readyOthers = room.players
    .filter((player) => player.id !== room.hostId)
    .every((player) => player.ready && player.connected);
  const canStart =
    room.phase === 'lobby' &&
    viewer.id === room.hostId &&
    room.players.length === 4 &&
    room.players.every((player) => player.connected) &&
    readyOthers;

  return {
    type: 'state',
    room: {
      code: room.code,
      phase: 'lobby',
      singlePlayer: Boolean(room.singlePlayer),
      hostId: room.hostId,
      yourId: viewer.id,
      maxPlayers: 4,
      minPlayers: 4,
      canStart,
      tributeEnabled: Boolean(room.tributeEnabled),
      counterEnabled: Boolean(room.counterEnabled),
      borrowWindEnabled: Boolean(room.borrowWindEnabled),
      scoringEnabled: true,
      turnSeconds: room.turnSeconds,
      tributeSeconds: room.tributeSeconds,
      canEditSettings: viewer.id === room.hostId,
      // 积分:roundScore 是最近一局的本局全局积分 S,scores 是每位玩家个人累计。
      roundScore: Number(room.roundScore || 0),
      scores: [...(room.scores || [0, 0, 0, 0])],
      yourScore: Number(room.scores?.[viewer.seat] || 0),
      // 旧字段兼容:sharedScore 不再累计,等同于最近一局 S。
      sharedScore: Number(room.roundScore || 0),
      sharedScoreDelta: room.sharedScoreDelta ?? null,
      players: roomSummaryPlayers(room),
      serverNow: Date.now(),
    },
  };
}

function sendLobbyState(room, player) {
  if (!player.ws || !player.connected) return;
  send(player.ws, buildLobbyState(room, player));
}

function broadcastLobby(room) {
  for (const player of room.players) sendLobbyState(room, player);
}

function clearAuto(room) {
  if (room.autoTimer) {
    clearTimeout(room.autoTimer);
    room.autoTimer = null;
  }
  room.auto = null;
}

/**
 * 每个出牌回合都有可配置时限；无牌可出仍保留 3 秒静默自动过，
 * 但这个原因绝不下发给其他玩家。离线玩家使用较短的托管时限。
 */
function scheduleAuto(room) {
  const game = room.game;
  if (!game || game.phase !== 'playing' || game.turnSeat === null) {
    clearAuto(room);
    room.currentNoLegal = false;
    room.turnDeadline = null;
    return;
  }

  const seat = game.turnSeat;
  const player = room.players.find((entry) => entry.seat === seat);
  const noLegal = !game.hasLegalMoves(seat);
  room.currentNoLegal = noLegal;

  if (room.turnDeadlineVersion !== game.turnVersion) {
    room.turnDeadlineVersion = game.turnVersion;
    room.turnDeadline = Date.now() + room.turnSeconds * 1000;
  }

  const deadlineRemaining = room.turnDeadline
    ? Math.max(0, room.turnDeadline - Date.now())
    : room.turnSeconds * 1000;
  const dealGrace = Math.max(0, (room.dealGraceUntil || 0) - Date.now());
  let kind = null;
  let delay = 0;
  if (player?.isBot) {
    kind = 'bot';
    delay = 850;
  } else if (player?.autoPlay) {
    kind = 'trusted';
    delay = 850;
  } else if (!player?.connected) {
    kind = 'offline';
    delay = noLegal
      ? Math.min(randomAutoPassDelay(), deadlineRemaining)
      : Math.min(OFFLINE_AUTO_PLAY_MS, deadlineRemaining);
  } else if (noLegal) {
    kind = 'no_moves';
    delay = Math.min(randomAutoPassDelay(), deadlineRemaining);
  } else {
    kind = 'timeout';
    delay = deadlineRemaining;
  }
  if (kind) delay += dealGrace;

  if (
    room.auto &&
    room.auto.turnVersion === game.turnVersion &&
    room.auto.seat === seat &&
    room.auto.kind === kind &&
    kind !== null
  ) {
    return;
  }

  clearAuto(room);
  if (!kind) return;

  const auto = {
    seat,
    kind,
    at: Date.now() + delay,
    turnVersion: game.turnVersion,
    noLegal,
  };
  room.auto = auto;

  room.autoTimer = setTimeout(() => {
    room.autoTimer = null;
    if (
      room.game !== game ||
      game.phase !== 'playing' ||
      game.turnSeat !== seat ||
      game.turnVersion !== auto.turnVersion
    ) {
      return;
    }

    try {
      if (kind === 'bot' || kind === 'trusted') {
        const move = game.pickAutoMove(seat);
        const auto = kind === 'trusted';
        if (move) {
          game.play(seat, move.cards.map((card) => card.id), { auto });
        } else {
          game.pass(seat, { auto });
        }
      } else if (kind === 'timeout') {
        if (game.lastPlay) {
          game.pass(seat, { auto: true });
        } else {
          const move = game.pickAutoMove(seat);
          if (move) {
            game.play(seat, move.cards.map((card) => card.id), { auto: true });
          }
        }
      } else if (kind === 'offline' && !noLegal) {
        const move = game.pickAutoMove(seat);
        if (move) {
          game.play(seat, move.cards.map((card) => card.id), { auto: true });
        } else {
          game.pass(seat, { auto: true });
        }
      } else if (kind === 'no_moves') {
        // 不把“无牌可出”暴露给其他玩家，按普通“过”广播。
        game.pass(seat, { auto: false });
      } else {
        game.pass(seat, { auto: !noLegal });
      }
      markRoomChanged(room);
      broadcastGame(room);
    } catch (error) {
      log('auto action failed:', error.message);
      clearAuto(room);
    }
  }, delay);
}

/**
 * 每局结算只落一次:
 * - 引擎给出本局全局积分 S(roundScore)与零和 scoreDeltas;
 * - room.scores 保存每位玩家的个人累计积分,跨局保留(新房间为 0);
 * - room.roundScore 保存本局 S;
 * - 积分规则永久开启,不再有 scoringEnabled 关闭分支;
 * - sharedScore / sharedScoreDelta 仅为旧客户端保留的兼容别名,不再累计。
 * scoreAppliedRound 用于幂等,重复 build 状态不会重复结算。
 */
function finalizeScores(room) {
  if (!room.game?.result) return;
  if (room.scoreAppliedRound === room.round) return;
  room.scoringEnabled = true;
  const result = room.game.result;
  const roundScore = Number(result.roundScore || 0);
  const deltas = Array.isArray(result.scoreDeltas) ? result.scoreDeltas : [0, 0, 0, 0];
  room.scores = room.scores || [0, 0, 0, 0];
  let sharedDelta = 0;
  for (let seat = 0; seat < 4; seat += 1) {
    const delta = Number(deltas[seat] || 0);
    room.scores[seat] = Number(room.scores[seat] || 0) + delta;
    if (delta > 0) sharedDelta += delta;
  }
  room.roundScore = roundScore;
  // 兼容旧字段:不再累计,直接等于本局 S / 本局奖池。
  room.sharedScore = roundScore;
  room.sharedScoreDelta = sharedDelta;
  room.scoreAppliedRound = room.round;
}

const RESULT_ACTION_EVENT_TYPES = new Set([
  'play',
  'auto_play',
  'pass',
  'auto_pass',
  'trick',
]);

/**
 * 最后一手含身份牌(黑桃 A / 黑桃 3)并直接导致结束时,给客户端一个
 * 延迟结算信号,让它先播完身份牌揭晓动画;游戏状态照常立即广播。
 */
function identityFinishingInfo(game) {
  if (!game || game.phase !== 'ended' || !game.result) return null;
  const events = Array.isArray(game.events) ? game.events : [];
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'end') continue;
    if (!RESULT_ACTION_EVENT_TYPES.has(event.type)) continue;
    if (event.type !== 'play' && event.type !== 'auto_play') return null;
    const cards = Array.isArray(event.cards) ? event.cards : [];
    const identityCards = cards.filter((card) => isIdentityCard(card));
    if (identityCards.length === 0) return null;
    return {
      seat: event.seat,
      cards: identityCards.map((card) => publicCard(card)),
    };
  }
  return null;
}

function buildGameState(room, viewer) {
  if (room.phase === 'ended' || room.game?.phase === 'ended') finalizeScores(room);
  const game = room.game;
  const view = game.getView(viewer.seat);
  const { remainingCounts: ignoredRemaining, ...publicView } = view;
  const remainingCounts = game.getRemainingRankCounts(viewer.seat);
  const roomPlayers = new Map(room.players.map((player) => [player.seat, player]));
  const players = publicView.players.map((publicPlayer) => {
    const member = roomPlayers.get(publicPlayer.seat);
    return {
      ...publicPlayer,
      id: member?.id || null,
      connected: Boolean(member?.connected),
      isHost: member?.id === room.hostId,
      isYou: member?.id === viewer.id,
      isBot: Boolean(member?.isBot),
      autoPlay: Boolean(member?.autoPlay),
      avatar: member?.avatar || null,
    };
  });

  const allConnected = room.players.length === 4 && room.players.every((player) => player.connected);
  const yourIdentityCards = (game.identityCardsBySeat?.get(viewer.seat) || []).map((card) => ({
    id: card.id,
    rank: card.rank,
    suit: card.suit,
  }));
  const autoAction =
    room.auto && room.auto.kind === 'offline'
      ? {
          seat: room.auto.seat,
          kind: room.auto.kind,
          at: room.auto.at,
        }
      : null;

  const identityFinishing = identityFinishingInfo(room.game);

  return {
    type: 'state',
    room: {
      ...publicView,
      yourRole: {
        ...(publicView.yourRole || {}),
        cards: yourIdentityCards,
      },
      code: room.code,
      phase: room.phase,
      singlePlayer: Boolean(room.singlePlayer),
      hostId: room.hostId,
      yourId: viewer.id,
      players,
      autoAction,
      tributeEnabled: Boolean(room.tributeEnabled),
      counterEnabled: Boolean(room.counterEnabled),
      borrowWindEnabled: Boolean(room.borrowWindEnabled),
      scoringEnabled: true,
      // 积分:roundScore 是整桌共用的本局 S(随任意玩家出牌更新),scores 是每位玩家个人累计。
      roundScore: Number(publicView.roundScore ?? room.roundScore ?? 0),
      scores: [...(room.scores || [0, 0, 0, 0])],
      yourScore: Number(room.scores?.[viewer.seat] || 0),
      roundScores: publicView.roundScores || [2, 2, 2, 2],
      // 旧字段兼容:sharedScore 不再累计,等于当前本局 S。
      sharedScore: Number(publicView.roundScore ?? room.roundScore ?? 0),
      sharedScoreDelta: room.sharedScoreDelta ?? null,
      borrowWindVotes: room.borrowWindVotes
        ? {
            on: [...room.borrowWindVotes.values()].filter(Boolean).length,
            off: [...room.borrowWindVotes.values()].filter((value) => !value).length,
          }
        : { on: 0, off: 0 },
      yourBorrowWindVote: room.borrowWindVotes?.has(viewer.seat)
        ? room.borrowWindVotes.get(viewer.seat)
        : null,
      yourAutoPassAt:
        room.auto && room.auto.seat === viewer.seat && room.auto.kind === 'no_moves'
          ? room.auto.at
          : null,
      cardCounter: room.counterEnabled ? remainingCounts : null,
      turnSeconds: room.turnSeconds,
      tributeSeconds: room.tributeSeconds,
      turnDeadline: room.turnDeadline,
      round: room.round,
      nextRoundTribute:
        room.phase === 'ended' &&
        Boolean(room.tributeEnabled) &&
        room.lastResult?.winner !== 'draw',
      canRestart:
        room.phase === 'ended' &&
        viewer.id === room.hostId &&
        allConnected,
      result: publicView.result
        ? {
            ...publicView.result,
            // 积分永久开启:始终返回每局变化与个人累计。
            scoreDeltas: publicView.result.scoreDeltas || [0, 0, 0, 0],
            scoreTotals: [...(room.scores || [0, 0, 0, 0])],
            // 本局全局积分 S + 兼容旧字段。
            roundScore: Number(
              publicView.result.roundScore ?? publicView.roundScore ?? room.roundScore ?? 0,
            ),
            roundScores: publicView.result.roundScores ||
              publicView.roundScores ||
              [2, 2, 2, 2],
            sharedScore: Number(
              publicView.result.roundScore ?? publicView.roundScore ?? room.roundScore ?? 0,
            ),
            sharedScoreDelta: Number(room.sharedScoreDelta || 0),
            // 最后一手含身份牌导致结束时,客户端先播完身份揭晓再弹结算。
            identityFinishing: Boolean(identityFinishing),
            identityFinishingSeat: identityFinishing?.seat ?? null,
            identityFinishingCards: identityFinishing?.cards || [],
          }
        : null,
      serverNow: Date.now(),
    },
  };
}

function buildTributeState(room, viewer) {
  const view = room.tribute.getView(viewer.seat);
  const roomPlayers = new Map(room.players.map((player) => [player.seat, player]));
  const players = view.players.map((publicPlayer) => {
    const member = roomPlayers.get(publicPlayer.seat);
    return {
      ...publicPlayer,
      id: member?.id || null,
      connected: Boolean(member?.connected),
      isHost: member?.id === room.hostId,
      isYou: member?.id === viewer.id,
      isBot: Boolean(member?.isBot),
      autoPlay: Boolean(member?.autoPlay),
      avatar: member?.avatar || null,
    };
  });

  return {
    type: 'state',
    room: {
      code: room.code,
      phase: 'tribute',
      singlePlayer: Boolean(room.singlePlayer),
      hostId: room.hostId,
      yourId: viewer.id,
      youSeat: viewer.seat,
      round: room.round,
      tributeEnabled: Boolean(room.tributeEnabled),
      // 积分规则永久开启。
      scoringEnabled: true,
      // 供牌阶段新一局尚未发牌,先沿用上一局 S;开局后由 game view 提供实时 S。
      roundScore: Number(room.roundScore || 0),
      scores: [...(room.scores || [0, 0, 0, 0])],
      yourScore: Number(room.scores?.[viewer.seat] || 0),
      sharedScore: Number(room.roundScore || 0),
      sharedScoreDelta: room.sharedScoreDelta ?? null,
      ...view,
      players,
      tributeSeconds: room.tributeSeconds,
      actionDeadline: room.tributeDeadline,
      serverNow: Date.now(),
    },
  };
}

function broadcastTribute(room) {
  if (!room.tribute) return;
  scheduleTributeAuto(room);
  for (const player of room.players) {
    if (!player.ws || !player.connected) continue;
    try {
      send(player.ws, buildTributeState(room, player));
    } catch (error) {
      log('broadcast tribute failed:', error.message);
    }
  }
}

function clearTributeTimers(room) {
  if (room.tributeAutoTimer) {
    clearTimeout(room.tributeAutoTimer);
    room.tributeAutoTimer = null;
  }
  if (room.tributeStartTimer) {
    clearTimeout(room.tributeStartTimer);
    room.tributeStartTimer = null;
  }
  room.tributeDeadline = null;
  room.tributeDeadlineKey = null;
}

function scheduleTributeAuto(room) {
  const tribute = room.tribute;
  if (!tribute || tribute.completed || tribute.currentSeat === null) {
    if (room.tributeAutoTimer) {
      clearTimeout(room.tributeAutoTimer);
      room.tributeAutoTimer = null;
    }
    room.tributeDeadline = null;
    room.tributeDeadlineKey = null;
    return;
  }

  const stage = tribute.stage;
  const seat = tribute.currentSeat;
  const player = room.players.find((entry) => entry.seat === seat);
  const key = [
    stage,
    seat,
    tribute.pool.length,
    tribute.returnPool.length,
    tribute.returnCounts.get(seat) || 0,
    player?.connected ? 'online' : 'offline',
    player?.isBot ? 'bot' : '',
    player?.autoPlay ? 'trusted' : '',
  ].join(':');
  if (room.tributeDeadlineKey === key && room.tributeAutoTimer) return;

  if (room.tributeAutoTimer) {
    clearTimeout(room.tributeAutoTimer);
    room.tributeAutoTimer = null;
  }

  const limit = player?.isBot || player?.autoPlay
    ? 850
    : player?.connected
      ? room.tributeSeconds * 1000
      : Math.min(TRIBUTE_OFFLINE_AUTO_MS, room.tributeSeconds * 1000);
  room.tributeDeadlineKey = key;
  room.tributeDeadline = Date.now() + limit;

  room.tributeAutoTimer = setTimeout(() => {
    room.tributeAutoTimer = null;
    if (
      room.tribute !== tribute ||
      tribute.completed ||
      tribute.currentSeat !== seat ||
      tribute.stage !== stage
    ) {
      return;
    }
    try {
      if (stage === 'tribute_pick') {
        const entry = tribute.pool[0];
        if (entry) tribute.pickTribute(seat, entry.card.id);
      } else if (stage === 'return_select') {
        const count = tribute.returnCounts.get(seat) || 1;
        const cards = tribute.hands[seat]
          .filter((card) => !isIdentityCard(card))
          .slice(-count)
          .map((card) => card.id);
        tribute.selectReturns(seat, cards);
      } else if (stage === 'return_pick') {
        const entry = [...tribute.returnPool]
          .sort((a, b) => cardPower(b.card) - cardPower(a.card))[0];
        if (entry) tribute.pickReturn(seat, entry.card.id);
      }
      afterTributeAction(room);
    } catch (error) {
      log('auto tribute action failed:', error.message);
      clearTributeTimers(room);
    }
  }, limit);
}

function afterTributeAction(room) {
  if (!room.tribute) return;
  broadcastTribute(room);
  if (room.tribute.completed) {
    scheduleGameAfterTribute(room);
  }
}

function scheduleGameAfterTribute(room) {
  if (room.tributeStartTimer) clearTimeout(room.tributeStartTimer);
  room.tributeStartTimer = setTimeout(() => {
    room.tributeStartTimer = null;
    if (!room.tribute?.completed || room.phase !== 'tribute') return;
    const finalHands = room.tribute.finalHands;
    const enginePlayers = room.players
      .slice()
      .sort((a, b) => a.seat - b.seat)
      .map((player) => ({ id: player.id, name: player.name }));
    room.game = new A3Game({
      players: enginePlayers,
      hands: finalHands,
      startNote: '供牌完成，身份重新入局！',
      borrowWind: Boolean(room.borrowWindEnabled),
    });
    room.tribute = null;
    room.phase = 'playing';
    room.dealGraceUntil = Date.now() + (room.singlePlayer ? 4500 : 1500);
    room.currentNoLegal = false;
    room.turnDeadline = null;
    room.turnDeadlineVersion = 0;
    room.tributeDeadline = null;
    room.tributeDeadlineKey = null;
    touch(room);
    log(`room ${room.code}: tribute finished, game ${room.round} started`);
    broadcastGame(room);
  }, TRIBUTE_COMPLETE_DELAY_MS);
}

function broadcastGame(room) {
  if (!room.game) return;
  scheduleAuto(room);
  for (const player of room.players) {
    if (!player.ws || !player.connected) continue;
    try {
      send(player.ws, buildGameState(room, player));
    } catch (error) {
      log('broadcast game failed:', error.message);
    }
  }
}

/** 按当前阶段给整桌推送对应状态(头像等非牌局数据更新时复用)。 */
function broadcastRoomState(room) {
  if (room.phase === 'lobby') {
    broadcastLobby(room);
  } else if (room.phase === 'tribute' && room.tribute) {
    broadcastTribute(room);
  } else if (room.game) {
    broadcastGame(room);
  }
}

function resetReady(room) {
  for (const player of room.players) player.ready = player.id === room.hostId;
}

function startGame(room, starter) {
  if (starter.id !== room.hostId) {
    throw new GameError('只有房主能开这局哦！', 'NOT_HOST');
  }
  if (room.players.length !== 4) {
    throw new GameError('要凑齐 4 个小伙伴才能开打哦！', 'NEED_PLAYERS');
  }
  if (room.players.some((player) => !player.connected)) {
    throw new GameError('还有人没连上，再等一小会儿吧！', 'PLAYER_OFFLINE');
  }

  const startedFromEnded = room.phase === 'ended';
  if (room.phase === 'lobby') {
    const waiting = room.players.filter(
      (player) => player.id !== room.hostId && !player.ready,
    );
    if (waiting.length > 0) {
      throw new GameError('还有人没准备好，再等等！', 'NOT_READY');
    }
  } else if (!startedFromEnded) {
    throw new GameError('现在还不能开局哦！', 'BAD_PHASE');
  }

  clearAuto(room);
  clearTributeTimers(room);
  room.borrowWindVotes?.clear();
  room.round = (room.round || 0) + 1;
  resetReady(room);
  const enginePlayers = room.players
    .slice()
    .sort((a, b) => a.seat - b.seat)
    .map((player) => ({ id: player.id, name: player.name }));
  const previousResult = startedFromEnded ? room.lastResult : null;

  if (
    startedFromEnded &&
    room.tributeEnabled &&
    previousResult &&
    previousResult.winner !== 'draw'
  ) {
    room.tribute = new TributeRound({
      players: enginePlayers,
      previousResult,
      now: Date.now,
    });
    room.phase = 'tribute';
    room.game = null;
    room.currentNoLegal = false;
    room.turnDeadline = null;
    room.turnDeadlineVersion = 0;
    touch(room);
    log(`room ${room.code}: tribute for round ${room.round} started`);
    broadcastTribute(room);
    return;
  }

  let startNote = '';
  if (startedFromEnded && room.tributeEnabled && previousResult?.winner === 'draw') {
    startNote = '上局平局，本局免供！';
  } else if (!startedFromEnded) {
    startNote = '欢乐开局！';
  }

  const playersReady = room.players.length === 4;
  if (!playersReady) throw new GameError('要凑齐 4 个小伙伴才能开打哦！', 'NEED_PLAYERS');
  room.game = new A3Game({ players: enginePlayers, startNote, borrowWind: Boolean(room.borrowWindEnabled) });
  room.phase = 'playing';
  room.tribute = null;
  room.dealGraceUntil = Date.now() + (room.singlePlayer ? 7000 : 2000);
  room.currentNoLegal = false;
  room.turnDeadline = null;
  room.turnDeadlineVersion = 0;
  room.tributeDeadline = null;
  room.tributeDeadlineKey = null;
  touch(room);
  log(`room ${room.code}: game ${room.round} started`);
  broadcastGame(room);
}

function removePlayer(room, player) {
  clearDisconnectTimer(player);
  const index = room.players.findIndex((entry) => entry.id === player.id);
  if (index === -1) return;
  // 个人累计积分跟人走、不跟座位走：压缩座位前先按玩家 id 暂存。
  const scoreByPlayerId = new Map(
    room.players.map((entry) => [entry.id, Number(room.scores?.[entry.seat] || 0)]),
  );
  room.players.splice(index, 1);
  if (room.hostId === player.id) {
    room.hostId = room.players.find((entry) => entry.connected)?.id || room.players[0]?.id || null;
  }
  // 压缩座位，保证大厅和下一局座位连续。
  room.players.sort((a, b) => a.seat - b.seat);
  room.players.forEach((entry, seat) => {
    entry.seat = seat;
  });
  if (room.scores) {
    const remapped = room.players.map((entry) => scoreByPlayerId.get(entry.id) || 0);
    while (remapped.length < 4) remapped.push(0);
    room.scores = remapped;
  }

  if (room.phase === 'ended') {
    // 有人在结算后离开，剩余玩家回到大厅等待新玩家，避免出现不存在的“残局”。
    room.phase = 'lobby';
    room.game = null;
    room.tribute = null;
    room.lastResult = null;
    room.lastResultRound = null;
    clearAuto(room);
    clearTributeTimers(room);
    room.currentNoLegal = false;
    room.turnDeadline = null;
    room.turnDeadlineVersion = 0;
  }

  touch(room);
  if (room.players.length === 0) {
    deleteRoom(room);
    return;
  }
  if (room.game && room.phase === 'playing') {
    // 对局中不移除玩家，理论上不会走到这里。
    broadcastGame(room);
  } else {
    resetReady(room);
    broadcastLobby(room);
  }
}

function deleteRoom(room) {
  clearAuto(room);
  clearTributeTimers(room);
  for (const player of room.players) {
    clearDisconnectTimer(player);
    if (player.ws) {
      player.ws.session = null;
      try {
        player.ws.close(4000, 'room closed');
      } catch {
        // ignore
      }
    }
  }
  rooms.delete(room.code);
  log(`room ${room.code}: closed`);
}

function attachPlayerSocket(room, player, ws) {
  if (player.ws && player.ws !== ws && !player.ws.closed) {
    player.ws.session = null;
    player.ws.close(4001, 'logged in elsewhere');
  }
  clearDisconnectTimer(player);
  player.ws = ws;
  player.connected = true;
  player.lastSeen = Date.now();
  ws.session = { roomCode: room.code, playerId: player.id };
  touch(room);
}

function sendCurrentState(room, player) {
  if (!player.connected || !player.ws) return;
  if (room.phase === 'lobby') {
    send(player.ws, buildLobbyState(room, player));
  } else if (room.phase === 'tribute' && room.tribute) {
    send(player.ws, buildTributeState(room, player));
  } else if (room.game) {
    scheduleAuto(room);
    send(player.ws, buildGameState(room, player));
  }
}

function handleCreate(ws, message) {
  if (ws.session) {
    sendError(ws, '你已经在牌桌上啦！', 'ALREADY_IN_ROOM');
    return;
  }
  const name = sanitizeName(message.name);
  const code = makeRoomCode();
  const id = randomUUID();
  const token = makeToken();
  const player = {
    id,
    token,
    name,
    seat: 0,
    ready: true,
    connected: true,
    ws,
    isBot: false,
    autoPlay: false,
    avatar: null,
    disconnectTimer: null,
    lastSeen: Date.now(),
  };
  const room = {
    code,
    hostId: id,
    players: [player],
    phase: 'lobby',
    singlePlayer: false,
    game: null,
    tribute: null,
    tributeEnabled: false,
    counterEnabled: false,
    borrowWindEnabled: false,
    borrowWindVotes: new Map(),
    scoringEnabled: true,
    scores: [0, 0, 0, 0],
    roundScore: 0,
    sharedScore: 0,
    sharedScoreDelta: null,
    scoreAppliedRound: null,
    turnSeconds: DEFAULT_TURN_SECONDS,
    tributeSeconds: DEFAULT_TRIBUTE_SECONDS,
    lastResult: null,
    lastResultRound: null,
    auto: null,
    autoTimer: null,
    turnDeadline: null,
    turnDeadlineVersion: 0,
    tributeAutoTimer: null,
    tributeStartTimer: null,
    tributeDeadline: null,
    tributeDeadlineKey: null,
    currentNoLegal: false,
    round: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  rooms.set(code, room);
  ws.session = { roomCode: code, playerId: id };
  send(ws, { type: 'joined', roomCode: code, playerId: id, token });
  send(ws, buildLobbyState(room, player));
  log(`room ${code}: created by ${name}`);
}

function handleSingle(ws, message) {
  if (ws.session) {
    sendError(ws, '你已经在牌桌上啦！', 'ALREADY_IN_ROOM');
    return;
  }
  const name = sanitizeName(message.name);
  const code = makeRoomCode();
  const id = randomUUID();
  const token = makeToken();
  const host = {
    id,
    token,
    name,
    seat: 0,
    ready: true,
    connected: true,
    ws,
    isBot: false,
    autoPlay: false,
    avatar: null,
    disconnectTimer: null,
    lastSeen: Date.now(),
  };
  const botNames = ['小乐', '阿福', '圆圆'];
  const bots = botNames.map((botName, index) => ({
    id: randomUUID(),
    token: null,
    name: botName,
    seat: index + 1,
    ready: true,
    connected: true,
    ws: null,
    isBot: true,
    autoPlay: true,
    avatar: null,
    disconnectTimer: null,
    lastSeen: Date.now(),
  }));
  const room = {
    code,
    hostId: id,
    players: [host, ...bots],
    phase: 'lobby',
    singlePlayer: true,
    game: null,
    tribute: null,
    tributeEnabled: false,
    counterEnabled: true,
    borrowWindEnabled: false,
    borrowWindVotes: new Map(),
    scoringEnabled: true,
    scores: [0, 0, 0, 0],
    roundScore: 0,
    sharedScore: 0,
    sharedScoreDelta: null,
    scoreAppliedRound: null,
    turnSeconds: DEFAULT_TURN_SECONDS,
    tributeSeconds: DEFAULT_TRIBUTE_SECONDS,
    lastResult: null,
    lastResultRound: null,
    auto: null,
    autoTimer: null,
    turnDeadline: null,
    turnDeadlineVersion: 0,
    tributeAutoTimer: null,
    tributeStartTimer: null,
    tributeDeadline: null,
    tributeDeadlineKey: null,
    currentNoLegal: false,
    round: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  rooms.set(code, room);
  ws.session = { roomCode: code, playerId: id };
  send(ws, { type: 'joined', roomCode: code, playerId: id, token, singlePlayer: true });
  try {
    startGame(room, host);
  } catch (error) {
    log(`room ${code}: single start failed: ${error.message}`);
    sendError(ws, error.message || '单机开局失败。', error.code || 'SINGLE_START_FAILED');
  }
  log(`room ${code}: single-player game created by ${name}`);
}

function handleJoin(ws, message) {
  if (ws.session) {
    sendError(ws, '你已经在牌桌上啦！', 'ALREADY_IN_ROOM');
    return;
  }
  const code = normalizedCode(message.code);
  const name = sanitizeName(message.name);
  const room = rooms.get(code);
  if (!room) {
    sendError(ws, '房间号不对哦，再瞅一眼！', 'ROOM_NOT_FOUND');
    return;
  }

  const reconnectToken = typeof message.token === 'string' ? message.token : '';
  if (reconnectToken) {
    const existing = playerByToken(room, reconnectToken);
    if (!existing) {
      if (message.reconnect) {
        sendError(ws, '刚才的牌桌找不到了，重新进一桌吧！', 'SESSION_EXPIRED');
        return;
      }
    } else {
      attachPlayerSocket(room, existing, ws);
      send(ws, {
        type: 'joined',
        roomCode: room.code,
        playerId: existing.id,
        token: existing.token,
        reconnected: true,
      });
      if (room.phase === 'lobby') broadcastLobby(room);
      else if (room.phase === 'tribute') broadcastTribute(room);
      else broadcastGame(room);
      log(`room ${code}: ${existing.name} reconnected`);
      return;
    }
  }

  if (room.singlePlayer) {
    sendError(ws, '这是单机牌桌，不能加入哦～', 'SINGLE_PLAYER_ONLY');
    return;
  }
  if (room.phase !== 'lobby') {
    sendError(ws, '这桌已经开打啦，等下一局吧！', 'GAME_IN_PROGRESS');
    return;
  }
  if (room.players.length >= 4) {
    sendError(ws, '这桌坐满啦，换一桌吧！', 'ROOM_FULL');
    return;
  }

  const seat = nextFreeSeat(room);
  if (seat < 0) {
    sendError(ws, '这桌坐满啦，换一桌吧！', 'ROOM_FULL');
    return;
  }

  const player = {
    id: randomUUID(),
    token: makeToken(),
    name: uniqueName(room, name),
    seat,
    ready: false,
    connected: true,
    ws,
    isBot: false,
    autoPlay: false,
    avatar: null,
    disconnectTimer: null,
    lastSeen: Date.now(),
  };
  room.players.push(player);
  attachPlayerSocket(room, player, ws);
  send(ws, {
    type: 'joined',
    roomCode: room.code,
    playerId: player.id,
    token: player.token,
  });
  broadcastLobby(room);
  log(`room ${code}: ${player.name} joined (${room.players.length}/4)`);
}

function handleReady(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  if (room.phase !== 'lobby') {
    sendError(ws, '已经开打啦！', 'BAD_PHASE');
    return;
  }
  player.ready = Boolean(message.ready);
  touch(room);
  broadcastLobby(room);
}

function handleSettings(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  const singleInGame = room.singlePlayer && ['playing', 'ended'].includes(room.phase);
  const hostInResult = room.phase === 'ended' && player.id === room.hostId;
  if (room.phase !== 'lobby' && !singleInGame && !hostInResult) {
    sendError(ws, '只能在大厅或结算页改规则哦！', 'BAD_PHASE');
    return;
  }
  if (player.id !== room.hostId) {
    sendError(ws, '只有房主能改规则哦！', 'NOT_HOST');
    return;
  }
  if (Object.prototype.hasOwnProperty.call(message, 'tributeEnabled')) {
    room.tributeEnabled = Boolean(message.tributeEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(message, 'counterEnabled')) {
    room.counterEnabled = Boolean(message.counterEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(message, 'borrowWindEnabled')) {
    room.borrowWindEnabled = Boolean(message.borrowWindEnabled);
  }
  if (Object.prototype.hasOwnProperty.call(message, 'scoringEnabled')) {
    // 积分规则已全局永久开启:忽略关闭请求,但保留字段兼容不报错。
    log(`room ${room.code}: scoringEnabled is permanently on, ignoring setting=${message.scoringEnabled}`);
  }
  if (Object.prototype.hasOwnProperty.call(message, 'turnSeconds')) {
    room.turnSeconds = clampInteger(
      message.turnSeconds,
      MIN_TURN_SECONDS,
      MAX_TURN_SECONDS,
      DEFAULT_TURN_SECONDS,
    );
  }
  if (Object.prototype.hasOwnProperty.call(message, 'tributeSeconds')) {
    room.tributeSeconds = clampInteger(
      message.tributeSeconds,
      MIN_TRIBUTE_SECONDS,
      MAX_TRIBUTE_SECONDS,
      DEFAULT_TRIBUTE_SECONDS,
    );
  }
  room.scoringEnabled = true;
  touch(room);
  if (room.phase === 'lobby') broadcastLobby(room);
  else broadcastGame(room);
  log(
    `room ${room.code}: settings tribute=${room.tributeEnabled} counter=${room.counterEnabled} ` +
    `turn=${room.turnSeconds}s tributeTime=${room.tributeSeconds}s`,
  );
}

function handleBorrowWindVote(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  if (room.phase !== 'ended') {
    sendError(ws, '只能在结算页投票借风规则。', 'BAD_PHASE');
    return;
  }
  if (room.singlePlayer) {
    room.borrowWindEnabled = Boolean(message.enabled);
  } else {
    if (!room.borrowWindVotes) room.borrowWindVotes = new Map();
    room.borrowWindVotes.set(player.seat, Boolean(message.enabled));
    const on = [...room.borrowWindVotes.values()].filter(Boolean).length;
    const off = [...room.borrowWindVotes.values()].filter((value) => !value).length;
    if (on > off) room.borrowWindEnabled = true;
    else if (off > on) room.borrowWindEnabled = false;
  }
  touch(room);
  broadcastGame(room);
  log(`room ${room.code}: borrow wind vote ${player.name}=${Boolean(message.enabled)} enabled=${room.borrowWindEnabled}`);
}

/**
 * 房主踢人:
 * - 大厅 / 结算页可踢,被踢玩家收到 kicked 消息并被断开连接;
 * - 对局 / 供牌中不允许踢人,由房主改用托管或等本局结束。
 */
function handleKick(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  if (player.id !== room.hostId) {
    sendError(ws, '只有房主能踢人哦！', 'NOT_HOST');
    return;
  }
  const target = playerById(room, typeof message.playerId === 'string' ? message.playerId : '');
  if (!target) {
    sendError(ws, '这名玩家已经不在房间啦！', 'PLAYER_NOT_FOUND');
    return;
  }
  if (target.id === player.id) {
    sendError(ws, '不能把自己踢出房间哦！', 'CANNOT_KICK_SELF');
    return;
  }
  if (room.singlePlayer) {
    sendError(ws, '单机牌桌不能踢人哦！', 'SINGLE_PLAYER_ONLY');
    return;
  }
  if (room.phase === 'playing' || room.phase === 'tribute') {
    sendError(ws, '对局中不能踢人，等这局结算或回到大厅再踢吧！', 'KICK_IN_GAME');
    return;
  }

  const kickedWs = target.ws;
  if (kickedWs) {
    send(kickedWs, {
      type: 'kicked',
      roomCode: room.code,
      playerId: target.id,
      name: target.name,
      byId: player.id,
      byName: player.name,
      at: Date.now(),
      reason: '你被房主请出了房间。',
    });
    kickedWs.session = null;
  }
  removePlayer(room, target);
  if (kickedWs) {
    try {
      kickedWs.close(4003, 'kicked');
    } catch {
      // ignore
    }
  }
  log(`room ${room.code}: ${player.name} kicked ${target.name}`);
}

function handleTrust(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  if (player.isBot) return;
  // 单人房、联机房都走同一套:玩家自己切换自己的托管,机器人永远托管。
  if (room.phase !== 'playing' && room.phase !== 'tribute') {
    sendError(ws, '开局后才能托管哦～', 'BAD_PHASE');
    return;
  }
  player.autoPlay = Object.prototype.hasOwnProperty.call(message, 'enabled')
    ? Boolean(message.enabled)
    : !player.autoPlay;
  touch(room);
  if (room.phase === 'tribute') broadcastTribute(room);
  else broadcastGame(room);
  log(`room ${room.code}: ${player.name} autoPlay=${player.autoPlay}`);
}

/**
 * 表情协议:
 * - {type:'emote', kind:'emoji', emoji:'😀'} 顶栏通用 emoji(最多 4 个码点);
 * - {type:'emote', kind:'flower'|'egg', targetSeat:N} 菜篮子定向送花/砸蛋,
 *   targetSeat 必须是其他玩家有效座位;缺省时兼容旧客户端,默认对家;
 * - 广播给整桌在线玩家,同一玩家 3 秒冷却(超频静默丢弃);
 * - 单机/联机均可用,机器人永远不会发送。
 */
function handleEmote(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  if (player.isBot) return;

  const kind = typeof message.kind === 'string' ? message.kind : '';
  if (!EMOTE_KINDS.has(kind)) {
    sendError(ws, '表情类型不对哦！', 'BAD_EMOTE_KIND');
    return;
  }

  let emoji = null;
  let targetSeat = null;
  let targetName = null;

  if (kind === 'emoji') {
    emoji = typeof message.emoji === 'string' ? message.emoji.trim() : '';
    if (
      !emoji ||
      EMOJI_CONTROL_CHARS.test(emoji) ||
      Array.from(emoji).length > MAX_EMOJI_CODE_POINTS
    ) {
      sendError(ws, '这个 emoji 不太对哦，最多 4 个字符！', 'BAD_EMOJI');
      return;
    }
  } else {
    // 送花/砸蛋属于对局内互动。
    if (!['playing', 'tribute', 'ended'].includes(room.phase)) {
      sendError(ws, '现在还不能送花/砸蛋哦！', 'BAD_PHASE');
      return;
    }
    const rawTarget = message.targetSeat;
    const hasTarget = rawTarget !== undefined && rawTarget !== null && rawTarget !== '';
    if (hasTarget) {
      if (typeof rawTarget !== 'number' && typeof rawTarget !== 'string') {
        sendError(ws, '送花/砸蛋的目标不对哦！', 'BAD_EMOTE_TARGET');
        return;
      }
      const parsed = Number(rawTarget);
      if (!Number.isInteger(parsed)) {
        sendError(ws, '送花/砸蛋的目标不对哦！', 'BAD_EMOTE_TARGET');
        return;
      }
      targetSeat = parsed;
    } else {
      // 兼容旧客户端:没有 targetSeat 时默认对家。
      targetSeat = (player.seat + 2) % 4;
    }
    const target = room.players.find((entry) => entry.seat === targetSeat) || null;
    if (!target || target.id === player.id) {
      sendError(ws, '只能把花或蛋送给其他玩家哦！', 'BAD_EMOTE_TARGET');
      return;
    }
    targetSeat = target.seat;
    targetName = target.name;
  }

  // 3 秒冷却:超频静默丢弃,避免错误提示刷屏。
  const now = Date.now();
  if (player.lastEmoteAt && now - player.lastEmoteAt < EMOTE_RATE_LIMIT_MS) return;
  player.lastEmoteAt = now;

  const payload = {
    type: 'emote',
    kind,
    emoji,
    seat: player.seat,
    name: player.name,
    id: randomUUID(),
    playerId: player.id,
    at: now,
    targetSeat,
    targetName,
  };
  for (const member of room.players) {
    if (!member.ws || !member.connected) continue;
    send(member.ws, payload);
  }
}

/**
 * 头像:只接受 data:image/(png|jpeg|webp|gif);base64,...,
 * 上限 140KB(客户端压到约 100KB);空字符串 / null 表示清除。
 */
function handleAvatar(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  const raw = message.dataUrl;
  let avatar = null;

  if (raw !== undefined && raw !== null && raw !== '') {
    if (typeof raw !== 'string') {
      sendError(ws, '头像格式不支持哦，请用图片文件。', 'BAD_AVATAR');
      return;
    }
    const dataUrl = raw.trim();
    if (dataUrl.length > MAX_AVATAR_DATA_URL_LENGTH) {
      sendError(ws, '头像太大了，压缩后再试试吧！', 'AVATAR_TOO_LARGE');
      return;
    }
    if (dataUrl.length > 0) {
      if (!AVATAR_DATA_URL_PATTERN.test(dataUrl)) {
        sendError(ws, '头像格式不支持哦，请用图片文件。', 'BAD_AVATAR');
        return;
      }
      avatar = dataUrl;
    }
  }

  if ((player.avatar || null) === avatar) return;
  player.avatar = avatar;
  touch(room);
  broadcastRoomState(room);
  log(`room ${room.code}: ${player.name} avatar ${avatar ? 'updated' : 'cleared'}`);
}

function handleStart(ws) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  try {
    startGame(room, player);
  } catch (error) {
    handleActionError(ws, error);  }
}

function handlePlay(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  if (room.phase !== 'playing' || !room.game) {
    sendError(ws, '现在不在对局中哦！', 'BAD_PHASE');
    return;
  }
  try {
    room.game.play(player.seat, message.cards, { auto: false });
    markRoomChanged(room);
    broadcastGame(room);
  } catch (error) {
    handleActionError(ws, error);
    broadcastGame(room);
  }
}

function handlePass(ws) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  if (room.phase !== 'playing' || !room.game) {
    sendError(ws, '现在不在对局中哦！', 'BAD_PHASE');
    return;
  }
  try {
    room.game.pass(player.seat, { auto: false });
    markRoomChanged(room);
    broadcastGame(room);
  } catch (error) {
    handleActionError(ws, error);
    broadcastGame(room);
  }
}

function handleTributePick(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  if (room.phase !== 'tribute' || !room.tribute) {
    sendError(ws, '现在不是供牌时间哦！', 'BAD_PHASE');
    return;
  }
  try {
    room.tribute.pickTribute(player.seat, String(message.cardId || ''));
    afterTributeAction(room);
  } catch (error) {
    handleActionError(ws, error);
    broadcastTribute(room);
  }
}

function handleTributeReturn(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  if (room.phase !== 'tribute' || !room.tribute) {
    sendError(ws, '现在不是供牌时间哦！', 'BAD_PHASE');
    return;
  }
  try {
    room.tribute.selectReturns(player.seat, message.cards);
    afterTributeAction(room);
  } catch (error) {
    handleActionError(ws, error);
    broadcastTribute(room);
  }
}

function handleTributeReceive(ws, message) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  if (room.phase !== 'tribute' || !room.tribute) {
    sendError(ws, '现在不是供牌时间哦！', 'BAD_PHASE');
    return;
  }
  try {
    room.tribute.pickReturn(player.seat, String(message.cardId || ''));
    afterTributeAction(room);
  } catch (error) {
    handleActionError(ws, error);
    broadcastTribute(room);
  }
}

function handleLeave(ws) {
  const context = socketContext(ws);
  if (!context) return;
  const { room, player } = context;
  ws.session = null;

  if (room.singlePlayer) {
    send(ws, { type: 'left' });
    try {
      ws.close(4002, 'left single game');
    } catch {
      // ignore
    }
    deleteRoom(room);
    return;
  }

  if (
    (room.phase === 'playing' && room.game?.phase === 'playing') ||
    room.phase === 'tribute'
  ) {
    // 对局 / 供牌中离席：保留座位，进入离线托管，避免直接破坏牌局。
    if (player.ws === ws) {
      player.ws = null;
      player.connected = false;
    }
    if (room.hostId === player.id) {
      const next = room.players.find((entry) => entry.connected);
      if (next) room.hostId = next.id;
    }
    touch(room);
    if (room.phase === 'tribute') broadcastTribute(room);
    else broadcastGame(room);
    send(ws, { type: 'left', reason: '已进入离线托管，牌局会继续。' });
    ws.close(4002, 'left game');
    return;
  }

  removePlayer(room, player);
  send(ws, { type: 'left' });
  ws.close(4002, 'left room');
}

function handleRestart(ws) {
  const context = socketContext(ws);
  if (!context) return;
  const { room } = context;
  if (room.phase !== 'ended') {
    sendError(ws, '现在还不能开下一把哦！', 'BAD_PHASE');
    return;
  }
  handleStart(ws);
}

function socketContext(ws) {
  if (!ws.session) {
    sendError(ws, '先创建或加入一桌吧！', 'NOT_IN_ROOM');
    return null;
  }
  const room = rooms.get(ws.session.roomCode);
  if (!room) {
    sendError(ws, '这桌已经散场啦！', 'ROOM_CLOSED');
    ws.session = null;
    return null;
  }
  const player = playerById(room, ws.session.playerId);
  if (!player) {
    sendError(ws, '你已经不在这个房间啦！', 'NOT_IN_ROOM');
    ws.session = null;
    return null;
  }
  if (player.ws !== ws) {
    sendError(ws, '这个座位在别处登录啦！', 'SESSION_REPLACED');
    return null;
  }
  return { room, player };
}

function handleActionError(ws, error) {
  if (error instanceof GameError || error instanceof TributeError) {
    sendError(ws, error.message, error.code);
  } else {
    log('action error:', error);
    sendError(ws, '手滑了一下，再试一次吧！', 'INTERNAL');
  }
}

function handleClose(ws) {
  sockets.delete(ws);
  if (!ws.session) return;
  const room = rooms.get(ws.session.roomCode);
  if (!room) return;
  const player = playerById(room, ws.session.playerId);
  if (!player || player.ws !== ws) return;

  if (room.singlePlayer && player.id === room.hostId) {
    deleteRoom(room);
    return;
  }

  player.ws = null;
  player.connected = false;
  player.lastSeen = Date.now();
  touch(room);

  if (room.phase === 'lobby') {
    broadcastLobby(room);
    clearDisconnectTimer(player);
    player.disconnectTimer = setTimeout(() => {
      if (!player.connected && room.players.includes(player)) {
        log(`room ${room.code}: removing disconnected ${player.name}`);
        removePlayer(room, player);
      }
    }, LOBBY_DISCONNECT_GRACE_MS);
  } else if (room.phase === 'tribute') {
    broadcastTribute(room);
  } else {
    broadcastGame(room);
  }
}

function handleMessage(ws, text) {
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    sendError(ws, '消息格式错误。', 'BAD_JSON');
    return;
  }
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    sendError(ws, '消息格式错误。', 'BAD_MESSAGE');
    return;
  }

  switch (message.type) {
    case 'create':
      handleCreate(ws, message);
      break;
    case 'single':
      handleSingle(ws, message);
      break;
    case 'join':
      handleJoin(ws, message);
      break;
    case 'ready':
      handleReady(ws, message);
      break;
    case 'settings':
      handleSettings(ws, message);
      break;
    case 'start':
      handleStart(ws);
      break;
    case 'trust':
      handleTrust(ws, message);
      break;
    case 'emote':
      handleEmote(ws, message);
      break;
    case 'avatar':
      handleAvatar(ws, message);
      break;
    case 'kick':
      handleKick(ws, message);
      break;
    case 'borrow_wind':
      handleBorrowWindVote(ws, message);
      break;
    case 'play':
      handlePlay(ws, message);
      break;
    case 'pass':
      handlePass(ws);
      break;
    case 'tribute_pick':
      handleTributePick(ws, message);
      break;
    case 'tribute_return':
      handleTributeReturn(ws, message);
      break;
    case 'tribute_receive':
      handleTributeReceive(ws, message);
      break;
    case 'leave':
      handleLeave(ws);
      break;
    case 'restart':
      handleRestart(ws);
      break;
    case 'ping':
      send(ws, { type: 'pong', at: Date.now() });
      break;
    default:
      sendError(ws, '未知的操作。', 'UNKNOWN_TYPE');
  }
}

async function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (requestUrl.pathname === '/healthz') {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, rooms: rooms.size, uptime: process.uptime() }));
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    response.writeHead(400).end('Bad Request');
    return;
  }
  if (pathname === '/') pathname = '/index.html';
  const resolved = path.resolve(PUBLIC_DIR, `.${pathname}`);
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(`${PUBLIC_DIR}${path.sep}`)) {
    response.writeHead(403).end('Forbidden');
    return;
  }

  try {
    const stat = await fsp.stat(resolved);
    if (!stat.isFile()) throw new Error('not a file');
    const extension = path.extname(resolved).toLowerCase();
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extension] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'same-origin',
      'Content-Security-Policy':
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' ws: wss:; font-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    fs.createReadStream(resolved).pipe(response);
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not Found');
  }
}

const server = http.createServer((request, response) => {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405).end('Method Not Allowed');
    return;
  }
  serveStatic(request, response).catch((error) => {
    log('http error:', error);
    if (!response.headersSent) response.writeHead(500);
    response.end('Internal Server Error');
  });
});

attachWebSocket(server, {
  path: '/ws',
  onConnection(ws) {
    sockets.add(ws);
    ws.on('message', (text) => handleMessage(ws, text));
    ws.on('close', () => handleClose(ws));
    ws.on('error', (error) => log('socket error:', error.message));
    send(ws, { type: 'hello', at: Date.now() });
  },
});

const heartbeat = setInterval(() => {
  const now = Date.now();
  for (const ws of sockets) {
    if (ws.closed) {
      sockets.delete(ws);
      continue;
    }
    if (now - ws.pongAt > 75_000) {
      ws.terminate();
      continue;
    }
    ws.ping();
  }
}, 30_000);
heartbeat.unref();

const cleanup = setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const empty = room.players.every((player) => !player.connected);
    const stale = now - room.updatedAt > (empty ? 10 * 60_000 : 3 * 60 * 60_000);
    if (stale) {
      log(`room ${room.code}: cleaning up`);
      deleteRoom(room);
    }
  }
}, 5 * 60_000);
cleanup.unref();

server.listen(PORT, HOST, () => {
  const addresses = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) addresses.push(entry.address);
    }
  }
  log(`A3 server listening on http://127.0.0.1:${PORT}`);
  for (const address of addresses) log(`LAN: http://${address}:${PORT}`);
  log(`rooms are in memory; restarting the server clears active games`);
});

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  clearInterval(heartbeat);
  clearInterval(cleanup);
  for (const room of rooms.values()) clearAuto(room);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

async function closeForTests() {
  clearInterval(heartbeat);
  clearInterval(cleanup);
  for (const room of rooms.values()) {
    clearAuto(room);
    clearTributeTimers(room);
    for (const player of room.players) clearDisconnectTimer(player);
  }
  for (const ws of [...sockets]) {
    try {
      ws.terminate();
    } catch {
      // ignore
    }
  }
  sockets.clear();
  rooms.clear();
  if (server.listening) {
    await new Promise((resolve) => server.close(resolve));
  }
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

module.exports = {
  server,
  rooms,
  startGame,
  closeForTests,
};
