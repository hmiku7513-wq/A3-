'use strict';

(function () {
  const SUITS = {
    d: { symbol: '♦', name: '方块', value: 0, red: true },
    c: { symbol: '♣', name: '梅花', value: 1, red: false },
    h: { symbol: '♥', name: '红心', value: 2, red: true },
    s: { symbol: '♠', name: '黑桃', value: 3, red: false },
  };
  const RANKS = ['4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2', '3'];
  const RANK_VALUE = Object.fromEntries(RANKS.map((rank, index) => [rank, index]));
  const CARD_CATALOG = RANKS.flatMap((rank) =>
    ['d', 'c', 'h', 's'].map((suit) => ({ id: `${suit}${rank}`, rank, suit })),
  );
  const COMBO_RANK = {
    single: 0,
    pair: 1,
    trips: 2,
    straight: 3,
    flush: 4,
    fullhouse: 5,
    four: 6,
    straightflush: 7,
    royal: 8,
  };
  const COMBO_LABEL = {
    single: '单牌',
    pair: '对子',
    trips: '三条',
    straight: '顺子',
    flush: '同花',
    fullhouse: '三带二',
    four: '四带一',
    straightflush: '同花顺',
    royal: '皇家同花顺',
  };

  const SESSION_KEY = 'a3.session.v1';
  const NAME_KEY = 'a3.name';
  const SOUND_KEY = 'a3.sound';

  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');

  function loadJson(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function loadSession() {
    const session = loadJson(SESSION_KEY);
    if (
      !session ||
      typeof session.code !== 'string' ||
      typeof session.token !== 'string' ||
      session.code.length < 4
    ) {
      localStorage.removeItem(SESSION_KEY);
      return null;
    }
    return session;
  }

  const savedSession = loadSession();
  const app = {
    ws: null,
    connected: false,
    connecting: false,
    session: savedSession,
    room: null,
    playerId: null,
    name: localStorage.getItem(NAME_KEY) || savedSession?.name || '',
    selected: new Set(),
    handSignature: '',
    pending: false,
    pendingTimer: null,
    gameKey: null,
    lastEventId: 0,
    prevTurnSeat: null,
    resultKey: null,
    serverOffset: 0,
    sound: localStorage.getItem(SOUND_KEY) !== 'off',
    audioCtx: null,
    reconnectTimer: null,
    reconnectAttempts: 0,
    reconnectingSession: false,
    intentionalLeave: false,
    identityQueue: [],
    identityShowing: false,
    identityTimer: null,
    currentScreen: 'landing',
    modalReturnFocus: null,
    tributeSelection: new Set(),
    tributeKey: null,
    tributeHandSignature: '',
    tributeActionKey: null,
    lastTributeEventId: 0,
    hintMoves: [],
    hintIndex: -1,
    hintKey: null,
    lastDealKey: null,
    farmerClaimShown: false,
  };

  const el = {};

  function cacheElements() {
    const ids = [
      'screen-landing', 'screen-room', 'screen-game',
      'game-stage',
      'connection-text', 'landing-error',
      'name-input', 'create-btn', 'single-btn', 'room-code-input', 'join-btn',
      'room-code-display', 'copy-code-btn', 'copy-link-btn',
      'room-slots', 'room-hint', 'ready-btn', 'start-btn', 'leave-room-btn',
      'tribute-toggle', 'tribute-toggle-label',
      'counter-toggle', 'counter-toggle-label',
      'turn-range', 'turn-range-label', 'tribute-range', 'tribute-range-label',
      'settings-lock-note',
      'screen-tribute', 'tribute-room-code', 'tribute-leave-btn',
      'tribute-instruction', 'tribute-timer', 'tribute-previous', 'tribute-players',
      'tribute-pool', 'tribute-pool-note', 'tribute-return-pool',
      'tribute-return-note', 'tribute-selection-info', 'tribute-clear-btn',
      'tribute-confirm-btn', 'tribute-hand', 'tribute-waiting',
      'tribute-events',
      'game-room-code', 'game-phase-label', 'game-sound-dot', 'game-sound-btn',
      'game-log-btn', 'game-counter-btn', 'game-trust-btn', 'game-fullscreen-btn', 'game-result-btn', 'game-leave-btn',
      'landlord-strip', 'counter-panel', 'counter-chips',
      'seat-top', 'seat-left', 'seat-right', 'turn-banner', 'turn-timer',
      'center-empty', 'last-play', 'last-play-owner', 'last-play-type',
      'last-play-cards', 'pass-bubbles', 'auto-countdown', 'self-trick',
      'self-pod', 'selection-info', 'clear-btn', 'hint-btn', 'pass-btn',
      'play-btn', 'hand', 'action-hint',
      'toast-layer', 'identity-alert-layer',
      'deal-animation', 'finish-animation', 'role-claim-layer',
      'tribute-fly-layer',
      'orientation-guard', 'orientation-fullscreen-btn',
      'tribute-fullscreen-btn',
      'rules-modal', 'result-modal', 'result-hero', 'result-kicker',
      'counter-modal', 'counter-detail', 'counter-summary',
      'result-title', 'result-reason', 'result-teams', 'result-ranking',
      'restart-btn', 'restart-hint', 'result-leave-btn',
      'log-drawer', 'log-close-btn', 'log-list',
      'reconnect-overlay', 'reconnect-text', 'reconnect-now-btn',
      'reconnect-cancel-btn', 'card-template',
    ];
    for (const id of ids) el[id] = $(id);
  }

  const screens = {
    landing: null,
    room: null,
    game: null,
    tribute: null,
  };

  function bindEvents() {
    screens.landing = el['screen-landing'];
    screens.room = el['screen-room'];
    screens.game = el['screen-game'];
    screens.tribute = el['screen-tribute'];

    el['create-btn'].addEventListener('click', createRoom);
    el['single-btn'].addEventListener('click', startSingle);
    el['join-btn'].addEventListener('click', joinRoom);
    el['leave-room-btn'].addEventListener('click', leaveRoom);
    el['game-leave-btn'].addEventListener('click', leaveRoom);
    el['result-leave-btn'].addEventListener('click', leaveRoom);

    el['start-btn'].addEventListener('click', () => {
      if (app.pending) return;
      setPending(true);
      send({ type: 'start' });
    });

    el['ready-btn'].addEventListener('click', () => {
      if (!app.room || app.pending) return;
      const me = selfPlayer();
      if (!me) return;
      send({ type: 'ready', ready: !me.ready });
    });

    el['tribute-toggle'].addEventListener('click', () => {
      if (!app.room || app.room.phase !== 'lobby' || app.pending) return;
      if (app.room.hostId !== app.room.yourId) return;
      send({ type: 'settings', tributeEnabled: !app.room.tributeEnabled });
    });

    el['counter-toggle'].addEventListener('click', () => {
      if (!app.room || app.room.phase !== 'lobby' || app.pending) return;
      if (app.room.hostId !== app.room.yourId) return;
      send({ type: 'settings', counterEnabled: !app.room.counterEnabled });
    });

    const previewRange = (input, label, suffix = ' 秒') => {
      if (!input || !label) return;
      label.textContent = `${input.value}${suffix}`;
    };
    el['turn-range'].addEventListener('input', () => previewRange(el['turn-range'], el['turn-range-label']));
    el['tribute-range'].addEventListener('input', () => previewRange(el['tribute-range'], el['tribute-range-label']));
    el['turn-range'].addEventListener('change', sendSettingsFromRanges);
    el['tribute-range'].addEventListener('change', sendSettingsFromRanges);

    el['hint-btn'].addEventListener('click', useHint);
    el['game-fullscreen-btn'].addEventListener('click', toggleFullscreen);
    el['tribute-fullscreen-btn'].addEventListener('click', toggleFullscreen);
    el['orientation-fullscreen-btn'].addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', updateFullscreenUi);
    document.addEventListener('webkitfullscreenchange', updateFullscreenUi);
    window.addEventListener('resize', updateStageScale);
    window.addEventListener('orientationchange', updateStageScale);

    el['tribute-leave-btn'].addEventListener('click', leaveRoom);
    el['tribute-confirm-btn'].addEventListener('click', confirmTributeSelection);
    el['tribute-clear-btn'].addEventListener('click', () => {
      app.tributeSelection.clear();
      renderTributeSelection();
    });

    el['tribute-pool'].addEventListener('click', (event) => {
      handleTributeCardClick(event, 'pool');
    });
    el['tribute-return-pool'].addEventListener('click', (event) => {
      handleTributeCardClick(event, 'returnPool');
    });
    el['tribute-hand'].addEventListener('click', (event) => {
      handleTributeCardClick(event, 'hand');
    });

    el['play-btn'].addEventListener('click', playSelected);
    el['pass-btn'].addEventListener('click', passTurn);
    el['clear-btn'].addEventListener('click', () => {
      app.selected.clear();
      renderHandAndActions();
    });

    el.hand.addEventListener('click', (event) => {
      const button = event.target.closest('[data-card-id]');
      if (!button || !app.room || app.room.phase !== 'playing') return;
      const id = button.dataset.cardId;
      if (app.selected.has(id)) {
        app.selected.delete(id);
        button.classList.remove('selected');
        button.setAttribute('aria-pressed', 'false');
      } else {
        if (app.selected.size >= 5) {
          showToast('一次最多选 5 张啦，别贪心！', 'error');
          return;
        }
        app.selected.add(id);
        button.classList.add('selected');
        button.setAttribute('aria-pressed', 'true');
      }
      updateActionArea();
    });

    el['copy-code-btn'].addEventListener('click', () => {
      if (app.room) copyText(app.room.code, '房间号已复制');
    });
    el['copy-link-btn'].addEventListener('click', () => {
      if (app.room) copyText(inviteLink(app.room.code), '邀请链接已复制');
    });

    el['room-code-input'].addEventListener('input', () => {
      el['room-code-input'].value = el['room-code-input'].value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .slice(0, 4);
    });

    el['name-input'].addEventListener('input', () => {
      app.name = el['name-input'].value.trim();
      localStorage.setItem(NAME_KEY, app.name);
    });

    el['name-input'].addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        createRoom();
      }
    });
    el['room-code-input'].addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        joinRoom();
      }
    });

    el['game-log-btn'].addEventListener('click', toggleLog);
    el['game-counter-btn'].addEventListener('click', openCounterDetail);
    el['counter-panel'].addEventListener('click', openCounterDetail);
    el['game-trust-btn'].addEventListener('click', toggleTrust);
    el['log-close-btn'].addEventListener('click', closeLog);
    el['game-sound-btn'].addEventListener('click', toggleSound);
    el['game-result-btn'].addEventListener('click', () => {
      if (app.room?.result) openResult(true);
    });
    el['restart-btn'].addEventListener('click', restartGame);
    el['reconnect-now-btn'].addEventListener('click', () => {
      clearTimeout(app.reconnectTimer);
      connect();
    });
    el['reconnect-cancel-btn'].addEventListener('click', cancelReconnect);

    document.addEventListener('click', (event) => {
      if (event.target.closest('[data-open-rules]')) {
        openModal('rules');
      }
      const close = event.target.closest('[data-close-modal]');
      if (close) {
        closeModal(close.dataset.closeModal);
      }
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!el['log-drawer'].hidden) {
          closeLog();
        } else if (!el['result-modal'].hidden) {
          closeModal('result');
        } else if (!el['counter-modal'].hidden) {
          closeModal('counter');
        } else if (!el['rules-modal'].hidden) {
          closeModal('rules');
        }
      }
    });

    document.addEventListener('pointerdown', ensureAudio, { once: true });
    setInterval(updateCountdown, 100);
  }

  function ensureAudio() {
    if (!app.sound) return null;
    try {
      if (!app.audioCtx) {
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) return null;
        app.audioCtx = new AudioCtor();
      }
      if (app.audioCtx.state === 'suspended') app.audioCtx.resume();
      return app.audioCtx;
    } catch {
      return null;
    }
  }

  function tone(frequency, startOffset, duration, volume = 0.035, type = 'sine') {
    if (!app.sound) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    try {
      const oscillator = ctx.createOscillator();
      const gain = ctx.createGain();
      const start = ctx.currentTime + startOffset;
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(volume, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.03);
    } catch {
      // Audio is a nicety, never let it break the game.
    }
  }

  function playSound(kind) {
    if (!app.sound) return;
    if (kind === 'turn') {
      tone(523.25, 0, 0.14, 0.025);
      tone(659.25, 0.1, 0.2, 0.022);
    } else if (kind === 'reveal') {
      tone(196, 0, 0.55, 0.055, 'triangle');
      tone(392, 0.07, 0.5, 0.04, 'triangle');
      tone(783.99, 0.18, 0.42, 0.025, 'sine');
    } else if (kind === 'finish') {
      tone(440, 0, 0.18, 0.025);
      tone(587.33, 0.12, 0.26, 0.022);
    } else if (kind === 'win') {
      [392, 493.88, 587.33, 783.99].forEach((frequency, index) => {
        tone(frequency, index * 0.12, 0.55, 0.03, 'triangle');
      });
    } else if (kind === 'error') {
      tone(220, 0, 0.14, 0.025, 'square');
    }
  }

  function toggleSound() {
    app.sound = !app.sound;
    localStorage.setItem(SOUND_KEY, app.sound ? 'on' : 'off');
    updateSoundUi();
    if (app.sound) {
      ensureAudio();
      playSound('turn');
      showToast('音效开起来，气氛搞起来！');
    } else {
      showToast('音效关掉啦，安静摸牌！');
    }
  }

  function updateSoundUi() {
    el['game-sound-btn'].classList.toggle('muted', !app.sound);
    el['game-sound-btn'].setAttribute('aria-label', app.sound ? '关闭音效' : '开启音效');
    el['game-sound-btn'].title = app.sound ? '关闭音效' : '开启音效';
    el['game-sound-dot'].style.display = app.sound ? '' : 'none';
  }

  function connect() {
    if (app.ws && (app.ws.readyState === WebSocket.OPEN || app.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    clearTimeout(app.reconnectTimer);
    app.reconnectTimer = null;
    app.connecting = true;
    updateConnectionUi('connecting');

    let socket;
    try {
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      socket = new WebSocket(`${protocol}//${location.host}/ws`);
    } catch {
      app.connecting = false;
      updateConnectionUi('offline');
      scheduleReconnect();
      return;
    }
    app.ws = socket;

    socket.addEventListener('open', () => {
      if (app.ws !== socket) return;
      app.connected = true;
      app.connecting = false;
      app.reconnectAttempts = 0;
      updateConnectionUi('online');
      startPing();
      if (app.session) {
        app.reconnectingSession = true;
        showReconnect('正在恢复你的牌桌…');
        send({
          type: 'join',
          code: app.session.code,
          token: app.session.token,
          name: app.session.name || app.name,
          reconnect: true,
        });
      } else {
        hideReconnect();
      }
    });

    socket.addEventListener('message', (event) => {
      if (app.ws !== socket) return;
      handleServerMessage(event.data);
    });

    socket.addEventListener('close', () => {
      if (app.ws !== socket) return;
      app.ws = null;
      app.connected = false;
      app.connecting = false;
      stopPing();
      updateConnectionUi('offline');
      if (app.intentionalLeave) {
        hideReconnect();
        return;
      }
      if (app.session || app.room) {
        showReconnect('连接中断，牌桌还在。正在尝试重新连接…');
      }
      scheduleReconnect();
    });

    socket.addEventListener('error', () => {
      if (app.ws !== socket) return;
      app.connecting = false;
      updateConnectionUi('offline');
    });
  }

  function scheduleReconnect() {
    if (app.intentionalLeave) return;
    clearTimeout(app.reconnectTimer);
    const delay = Math.min(7000, 700 * 2 ** Math.min(app.reconnectAttempts, 4));
    app.reconnectAttempts += 1;
    const text = el['reconnect-text'];
    if (app.session && text && !el['reconnect-overlay'].hidden) {
      text.textContent = `连接中断，正在第 ${app.reconnectAttempts} 次重连…`;
    }
    app.reconnectTimer = setTimeout(connect, delay);
  }

  function startPing() {
    stopPing();
    app.pingTimer = setInterval(() => {
      if (app.connected) send({ type: 'ping' });
    }, 20000);
  }

  function stopPing() {
    if (app.pingTimer) {
      clearInterval(app.pingTimer);
      app.pingTimer = null;
    }
  }

  function send(message) {
    if (!app.ws || app.ws.readyState !== WebSocket.OPEN) {
      showToast('还在连服务器，稍等一下下！', 'error');
      return false;
    }
    app.ws.send(JSON.stringify(message));
    return true;
  }

  function handleServerMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    if (!message || typeof message.type !== 'string') return;

    switch (message.type) {
      case 'hello':
      case 'pong':
        break;
      case 'joined':
        handleJoined(message);
        break;
      case 'state':
        handleState(message.room);
        break;
      case 'left':
        handleLeft(message);
        break;
      case 'error':
        handleServerError(message);
        break;
      default:
        break;
    }
  }

  function handleJoined(message) {
    app.intentionalLeave = false;
    app.reconnectingSession = false;
    app.pending = false;
    app.session = {
      code: message.roomCode,
      token: message.token,
      playerId: message.playerId,
      name: app.name,
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(app.session));
    app.playerId = message.playerId;
    setUrlRoom(message.roomCode);
    hideReconnect();
    updateConnectionUi('online');
  }

  function handleLeft(message) {
    clearSession();
    app.room = null;
    app.pending = false;
    app.gameKey = null;
    app.selected.clear();
    app.tributeSelection.clear();
    app.tributeKey = null;
    app.intentionalLeave = false;
    clearIdentityAlerts();
    hideFxLayers();
    hideReconnect();
    closeModal('result');
    closeModal('counter');
    closeLog();
    setUrlRoom(null);
    showScreen('landing');
    if (message.reason) showToast(message.reason);
  }

  function handleServerError(message) {
    app.pending = false;
    app.connecting = false;
    updateRoomControls();
    updateActionArea();
    if (app.room?.phase === 'tribute') updateTributeAction();
    const code = message.code || 'ERROR';
    if (
      app.reconnectingSession &&
      ['SESSION_EXPIRED', 'ROOM_NOT_FOUND', 'ROOM_CLOSED', 'GAME_IN_PROGRESS'].includes(code)
    ) {
      app.reconnectingSession = false;
      clearSession();
      app.room = null;
      app.gameKey = null;
      hideReconnect();
      setUrlRoom(null);
      showScreen('landing');
      showToast('牌桌找不到了，重新开一桌或加入朋友的吧！', 'error');
      return;
    }
    if (app.reconnectingSession && code !== 'SESSION_EXPIRED') {
      app.reconnectingSession = false;
      hideReconnect();
    }
    setFormBusy(false);
    showToast(message.message || '操作失败', 'error');
    playSound('error');
  }

  function handleState(room) {
    if (!room || app.intentionalLeave) return;
    app.reconnectingSession = false;
    app.pending = false;
    clearPendingTimer();
    hideReconnect();
    setFormBusy(false);
    app.serverOffset = Number(room.serverNow || Date.now()) - Date.now();
    app.playerId = room.yourId;
    app.room = room;
    setUrlRoom(room.code);

    if (room.phase === 'lobby') {
      app.gameKey = null;
      app.lastEventId = 0;
      app.prevTurnSeat = null;
      app.selected.clear();
      app.handSignature = '';
      app.resultKey = null;
      closeModal('result');
      closeModal('counter');
      closeLog();
      renderRoom(room);
      showScreen('room');
      return;
    }

    if (room.phase === 'tribute') {
      app.prevTurnSeat = null;
      app.selected.clear();
      clearIdentityAlerts();
      closeLog();
      if (!el['result-modal'].hidden) {
        el['result-modal'].hidden = true;
        syncModalState();
      }
      closeModal('counter');
      handleTributeState(room);
      return;
    }

    const gameKey = `${room.code}:${room.startedAt || 'game'}`;
    const isNewGame = gameKey !== app.gameKey;
    if (isNewGame) {
      app.gameKey = gameKey;
      app.selected.clear();
      app.handSignature = '';
      app.resultKey = null;
      app.prevTurnSeat = null;
      app.tributeSelection.clear();
      app.tributeKey = null;
      app.hintMoves = [];
      app.hintIndex = -1;
      app.hintKey = null;
      app.farmerClaimShown = false;
      clearIdentityAlerts();
      hideFxLayers();
      el['screen-game'].classList.remove('counter-open');
      closeModal('counter');
      el['result-modal'].hidden = true;
      syncModalState();
      app.lastEventId = maxEventId(room.events);
      if (app.currentScreen !== 'game') {
        showToast('开局啦！先手必须带 ♦4 哦！', 'gold');
      }
    } else {
      processNewEvents(room);
    }
    app.lastEventId = Math.max(app.lastEventId, maxEventId(room.events));

    renderGame(room);
    showScreen('game');
    if (isNewGame) playDealAnimation();

    if (room.phase === 'playing' && room.turnSeat === room.youSeat &&
        app.prevTurnSeat !== room.youSeat && app.prevTurnSeat !== null) {
      playSound('turn');
    }
    app.prevTurnSeat = room.turnSeat;

    if (room.phase === 'ended' && room.result) {
      if (app.resultKey !== resultKey(room)) {
        openResult(false);
      }
    }
  }

  function maxEventId(events) {
    if (!Array.isArray(events) || events.length === 0) return 0;
    return events.reduce((max, event) => Math.max(max, Number(event.id) || 0), 0);
  }

  function processNewEvents(room) {
    const events = Array.isArray(room.events) ? room.events : [];
    const fresh = events.filter((event) => Number(event.id) > app.lastEventId);
    if (fresh.length === 0) return;

    for (const event of fresh) {
      if (event.type === 'reveal') {
        queueIdentityAlert(event);
        setTimeout(() => showRoleClaimAnimation(event), 180);
        if (!app.farmerClaimShown && room.bothLandlordsRevealed) {
          app.farmerClaimShown = true;
          setTimeout(() => showFarmerRevealAnimation(room), 520);
        }
      } else if (event.type === 'finish') {
        showToast(event.text, 'gold', 3800);
        showFinishAnimation(event);
        playSound('finish');
      } else if (event.type === 'trick') {
        showToast(event.text, '', 2800);
      } else if (event.type === 'end') {
        // The result modal carries the final message.
      }
    }
    app.lastEventId = fresh[fresh.length - 1].id;
  }

  function resultKey(room) {
    return `${room.code}:${room.startedAt || ''}:${room.result?.winner || ''}:${(room.result?.finishOrder || []).join(',')}`;
  }

  /* ---------------- Non-blocking table animations ---------------- */

  function hideFxLayers() {
    for (const id of ['deal-animation', 'finish-animation', 'role-claim-layer', 'tribute-fly-layer']) {
      if (!el[id]) continue;
      el[id].hidden = true;
      el[id].innerHTML = '';
    }
  }

  function playDealAnimation() {
    const layer = el['deal-animation'];
    if (!layer) return;
    layer.hidden = false;
    const targets = [
      { x: '-36vw', y: '-26vh', rot: '-18deg' },
      { x: '-12vw', y: '-30vh', rot: '-8deg' },
      { x: '12vw', y: '-30vh', rot: '8deg' },
      { x: '36vw', y: '-26vh', rot: '18deg' },
      { x: '-36vw', y: '8vh', rot: '-10deg' },
      { x: '36vw', y: '8vh', rot: '10deg' },
      { x: '-20vw', y: '24vh', rot: '-5deg' },
      { x: '20vw', y: '24vh', rot: '5deg' },
    ];
    layer.innerHTML = `
      <div class="deal-title">发牌中…</div>
      <div class="deal-deck">
        ${targets.map((target, index) => `
          <span class="deal-card" style="--tx:${target.x};--ty:${target.y};--rot:${target.rot};--delay:${index * 55}ms">
            <i>A3</i>
          </span>
        `).join('')}
      </div>
    `;
    setTimeout(() => {
      layer.hidden = true;
      layer.innerHTML = '';
    }, 1550);
  }

  function showFinishAnimation(event) {
    const layer = el['finish-animation'];
    if (!layer) return;
    const player = playerAtSeat(event.seat);
    layer.hidden = false;
    layer.innerHTML = `
      <div class="finish-flare"></div>
      <div class="finish-banner">
        <span class="finish-crown">✦</span>
        <b>${esc(player?.name || '玩家')} 出完啦！</b>
        <em>第 ${Number(event.place) || 1} 顺位</em>
      </div>
      <div class="finish-confetti">${Array.from({ length: 14 }, (_, index) => {
        const tx = (index - 6.5) * 7.2;
        const ty = ((index % 3) - 1) * 18 + 20;
        return `<i style="--i:${index};--tx:${tx}vw;--ty:${ty}vh;--rot:${index * 47}deg"></i>`;
      }).join('')}</div>
    `;
    setTimeout(() => {
      layer.hidden = true;
      layer.innerHTML = '';
    }, 2100);
  }

  function showRoleClaimAnimation(event) {
    const layer = el['role-claim-layer'];
    if (!layer) return;
    const player = playerAtSeat(event.seat);
    layer.hidden = false;
    const banner = document.createElement('div');
    banner.className = 'role-claim-banner landlord-claim';
    banner.innerHTML = `
      <span class="role-claim-crown">♛</span>
      <span><b>${esc(player?.name || '玩家')}</b> 归入地主阵营</span>
      <em>${event.double ? '双地主亮牌' : '身份牌现身'}</em>
    `;
    layer.appendChild(banner);
    setTimeout(() => {
      banner.classList.add('out');
      setTimeout(() => {
        banner.remove();
        if (layer.childElementCount === 0) layer.hidden = true;
      }, 350);
    }, 1700);
  }

  function showFarmerRevealAnimation(room) {
    const layer = el['role-claim-layer'];
    if (!layer) return;
    const names = (room.players || [])
      .filter((player) => player.farmerRevealed && !player.landlordRevealed)
      .map((player) => player.name);
    layer.hidden = false;
    const banner = document.createElement('div');
    banner.className = 'role-claim-banner farmer-claim';
    banner.innerHTML = `
      <span class="role-claim-mark">农</span>
      <span><b>地主全部现身</b> ${names.length ? `${esc(names.join('、'))} 归为农民` : '余下玩家归为农民'}</span>
      <em>阵营锁定</em>
    `;
    layer.appendChild(banner);
    setTimeout(() => {
      banner.classList.add('out');
      setTimeout(() => {
        banner.remove();
        if (layer.childElementCount === 0) layer.hidden = true;
      }, 350);
    }, 2400);
  }

  /* ---------------- Screen / room rendering ---------------- */

  function showScreen(name) {
    if (app.currentScreen === name) {
      document.body.classList.toggle('in-game', name === 'game' || name === 'tribute');
      return;
    }
    for (const [key, screen] of Object.entries(screens)) {
      if (!screen) continue;
      screen.classList.toggle('is-active', key === name);
      screen.hidden = key !== name;
    }
    app.currentScreen = name;
    document.body.classList.toggle('in-game', name === 'game' || name === 'tribute');
    if (name === 'game') updateStageScale();
    if (name !== 'game') closeLog();
    if (name === 'landing') {
      document.title = 'A3 · 欢乐暗牌';
    }
  }

  function updateConnectionUi(status) {
    const node = el['connection-text'];
    if (node) {
      node.classList.remove('online', 'offline');
      let text = '正在连接';
      if (status === 'online') {
        node.classList.add('online');
        text = '已连接';
      } else if (status === 'offline') {
        node.classList.add('offline');
        text = app.connecting ? '正在连接' : '连接断开';
      }
      node.innerHTML = `<span class="dot"></span>${text}`;
    }
    const disabled = !app.connected;
    el['create-btn'].disabled = disabled;
    el['join-btn'].disabled = disabled;
  }

  function setFormBusy(busy) {
    el['create-btn'].disabled = busy || !app.connected;
    el['join-btn'].disabled = busy || !app.connected;
  }

  function setLandingError(message) {
    el['landing-error'].textContent = message || '';
  }

  function requireName() {
    const name = el['name-input'].value.trim();
    if (!name) {
      setLandingError('先给自己起个响亮的外号吧！');
      el['name-input'].focus();
      return null;
    }
    app.name = name;
    localStorage.setItem(NAME_KEY, name);
    return name;
  }

  function createRoom() {
    setLandingError('');
    if (!app.connected) {
      setLandingError('还在连服务器，稍等一下下！');
      return;
    }
    const name = requireName();
    if (!name) return;
    app.intentionalLeave = false;
    app.reconnectingSession = false;
    setFormBusy(true);
    send({ type: 'create', name });
  }

  function startSingle() {
    setLandingError('');
    if (!app.connected) {
      setLandingError('还在连服务器，稍等一下下！');
      return;
    }
    const name = requireName();
    if (!name) return;
    app.intentionalLeave = false;
    app.reconnectingSession = false;
    setFormBusy(true);
    send({ type: 'single', name });
  }

  function toggleTrust() {
    const room = app.room;
    const me = selfPlayer();
    if (!room || !me || room.singlePlayer || room.phase === 'ended') return;
    send({ type: 'trust', enabled: !me.autoPlay });
  }

  function joinRoom() {
    setLandingError('');
    if (!app.connected) {
      setLandingError('还在连服务器，稍等一下下！');
      return;
    }
    const code = el['room-code-input'].value.trim().toUpperCase();
    if (code.length !== 4) {
      setLandingError('房间号是 4 位哦，再检查一下！');
      el['room-code-input'].focus();
      return;
    }
    const name = requireName();
    if (!name) return;
    app.intentionalLeave = false;
    app.reconnectingSession = false;
    setFormBusy(true);
    send({ type: 'join', code, name });
  }

  function selfPlayer() {
    if (!app.room) return null;
    return app.room.players.find((player) => player.id === app.room.yourId) ||
      app.room.players.find((player) => player.seat === app.room.youSeat) ||
      null;
  }

  function playerAtSeat(seat) {
    return app.room?.players.find((player) => player.seat === seat) || null;
  }

  function hueFor(seat, name) {
    let hash = (seat + 1) * 47;
    for (const char of String(name || '')) hash = (hash * 31 + char.charCodeAt(0)) % 360;
    return hash;
  }

  function initial(name) {
    const clean = String(name || '?').trim();
    return esc(clean.slice(0, 1).toUpperCase() || '?');
  }

  function renderRoom(room) {
    el['room-code-display'].textContent = room.code;
    el['room-code-display'].setAttribute('aria-label', `房间号 ${room.code}`);
    const slots = [];
    for (let seat = 0; seat < 4; seat += 1) {
      const player = playerAtSeat(seat);
      if (!player) {
        slots.push(`
          <div class="room-slot empty">
            <span class="slot-seat-number">SEAT 0${seat + 1}</span>
            <div class="slot-avatar">+</div>
            <p class="slot-name">等朋友来</p>
            <div class="slot-meta">空位</div>
          </div>
        `);
        continue;
      }
      const isYou = player.id === room.yourId;
      const isHost = player.id === room.hostId;
      const classes = [
        'room-slot',
        'filled',
        isYou ? 'you' : '',
        player.ready ? 'ready' : '',
        player.connected === false ? 'offline' : '',
      ].filter(Boolean).join(' ');
      const badges = [];
      if (isHost) badges.push('<span class="host-badge">♛ 房主</span>');
      if (isYou) badges.push('<span class="you-badge">你</span>');
      if (!isHost) {
        badges.push(
          player.ready
            ? '<span class="ready-badge">准备好啦</span>'
            : '<span class="slot-meta">还没准备</span>',
        );
      }
      if (player.connected === false) badges.push('<span class="offline-badge">离线</span>');
      slots.push(`
        <div class="${classes}">
          <span class="slot-seat-number">SEAT 0${seat + 1}</span>
          <div class="slot-avatar" style="--hue:${hueFor(seat, player.name)}">${initial(player.name)}</div>
          <p class="slot-name" title="${esc(player.name)}">${esc(player.name)}</p>
          <div class="slot-meta">${badges.join('')}</div>
        </div>
      `);
    }
    el['room-slots'].innerHTML = slots.join('');
    updateRoomControls();
  }

  function updateRoomControls() {
    const room = app.room;
    if (!room || room.phase !== 'lobby') return;
    updateTributeToggle(room);
    updateCounterToggle(room);
    updateTimeSettings(room);
    const me = selfPlayer();
    const isHost = room.hostId === room.yourId;
    const count = room.players.length;
    const connected = room.players.every((player) => player.connected);
    const waiting = room.players
      .filter((player) => player.id !== room.hostId && !player.ready && player.connected)
      .map((player) => player.name);

    el['start-btn'].hidden = !isHost;
    el['ready-btn'].hidden = isHost;
    el['start-btn'].disabled = !room.canStart || app.pending;
    el['ready-btn'].disabled = app.pending;

    if (isHost) {
      if (room.canStart) {
        el['start-btn'].textContent = '欢乐开局！';
        el['room-hint'].innerHTML = '<strong>人都齐啦！</strong> 发牌后，拿着 ♦4 的小伙伴先出牌！';
      } else if (count < 4) {
        el['start-btn'].textContent = `还差 ${4 - count} 人`;
        el['room-hint'].innerHTML = `<strong>${count}/4</strong> 人已上桌，快把房间号甩给朋友！`;
      } else if (!connected) {
        el['start-btn'].textContent = '有人掉线啦';
        el['room-hint'].textContent = '等掉线的小伙伴回来再开，一个都不能少！';
      } else {
        el['start-btn'].textContent = '等大家准备';
        el['room-hint'].textContent = waiting.length
          ? `等 ${waiting.join('、')} 点“我准备好啦”。`
          : '等大家点准备！';
      }
    } else if (me) {
      el['ready-btn'].textContent = me.ready ? '取消准备' : '我准备好啦';
      if (count < 4) {
        el['room-hint'].innerHTML = `<strong>${count}/4</strong> 人已上桌，还差 ${4 - count} 个小伙伴！`;
      } else if (room.canStart) {
        el['room-hint'].textContent = '都准备好啦，等房主喊开局！';
      } else if (!connected) {
        el['room-hint'].textContent = '有人掉线了，稍等一下下！';
      } else {
        el['room-hint'].textContent = '你已经准备好啦，等其他人！';
      }
    }
  }

  function updateTributeToggle(room) {
    const button = el['tribute-toggle'];
    if (!button) return;
    const isHost = room.hostId === room.yourId;
    button.disabled = !isHost || room.phase !== 'lobby';
    button.classList.toggle('on', Boolean(room.tributeEnabled));
    button.setAttribute('aria-checked', room.tributeEnabled ? 'true' : 'false');
    button.title = isHost ? '点击切换供牌规则' : '供牌规则由房主设置';
    el['tribute-toggle-label'].textContent = room.tributeEnabled ? '开启' : '关闭';
  }

  function updateCounterToggle(room) {
    const button = el['counter-toggle'];
    if (!button) return;
    const isHost = room.hostId === room.yourId;
    button.disabled = !isHost || room.phase !== 'lobby';
    button.classList.toggle('on', Boolean(room.counterEnabled));
    button.setAttribute('aria-checked', room.counterEnabled ? 'true' : 'false');
    button.title = isHost ? '点击切换记牌器' : '记牌器由房主设置';
    el['counter-toggle-label'].textContent = room.counterEnabled ? '开启' : '关闭';
  }

  function updateTimeSettings(room) {
    const isHost = room.hostId === room.yourId;
    const turn = Number(room.turnSeconds || 20);
    const tribute = Number(room.tributeSeconds || 30);
    for (const input of [el['turn-range'], el['tribute-range']]) {
      if (!input) continue;
      input.disabled = !isHost || room.phase !== 'lobby';
    }
    if (document.activeElement !== el['turn-range']) el['turn-range'].value = String(turn);
    if (document.activeElement !== el['tribute-range']) el['tribute-range'].value = String(tribute);
    el['turn-range-label'].textContent = `${turn} 秒`;
    el['tribute-range-label'].textContent = `${tribute} 秒`;
    el['settings-lock-note'].hidden = isHost;
  }

  function sendSettingsFromRanges() {
    const room = app.room;
    if (!room || room.phase !== 'lobby') return;
    if (room.hostId !== room.yourId || app.pending) return;
    send({
      type: 'settings',
      turnSeconds: Number(el['turn-range'].value),
      tributeSeconds: Number(el['tribute-range'].value),
    });
  }

  async function toggleFullscreen() {
    try {
      const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
      if (!fullscreenElement) {
        const target = document.documentElement;
        const request = target.requestFullscreen || target.webkitRequestFullscreen;
        if (!request) {
          showToast('这个浏览器不支持全屏，横过来也能玩哦！', 'error');
          return;
        }
        await request.call(target);
        if (screen.orientation?.lock) {
          try {
            await screen.orientation.lock('landscape');
          } catch {
            // 部分手机浏览器不允许锁定方向，横屏提示仍然有效。
          }
        }
      } else {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
        if (screen.orientation?.unlock) screen.orientation.unlock();
      }
    } catch {
      showToast('全屏失败啦，试试把手机横过来玩！', 'error');
    }
    updateFullscreenUi();
  }

  function updateFullscreenUi() {
    const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    for (const button of [el['game-fullscreen-btn'], el['tribute-fullscreen-btn']]) {
      if (!button) continue;
      button.textContent = active ? '⤢' : '⛶';
      button.title = active ? '退出全屏' : '全屏';
      button.setAttribute('aria-label', active ? '退出全屏' : '切换全屏');
    }
    updateStageScale();
  }

  function updateStageScale() {
    const stage = el['game-stage'];
    if (!stage) return;
    const scale = Math.min(window.innerWidth / 1280, window.innerHeight / 600);
    stage.style.setProperty('--stage-scale', String(Math.max(0.2, Math.min(1.75, scale))));
  }

  /* ---------------- Tribute phase ---------------- */

  function handleTributeState(room) {
    const key = `${room.code}:${room.round}:${room.previous?.winner || ''}`;
    if (app.tributeKey !== key) {
      app.tributeKey = key;
      app.tributeSelection.clear();
      app.tributeHandSignature = '';
      app.tributeActionKey = null;
      app.lastTributeEventId = 0;
      if (el['tribute-fly-layer']) {
        el['tribute-fly-layer'].hidden = true;
        el['tribute-fly-layer'].innerHTML = '';
      }
      showToast('进贡还贡时间到！按规矩来，谁也不许赖账！', 'gold', 4200);
    }
    const actionKey = `${room.stage}:${room.currentSeat}:${room.completed ? 'done' : ''}`;
    if (app.tributeActionKey !== actionKey) {
      app.tributeActionKey = actionKey;
      app.tributeSelection.clear();
    }
    app.pending = false;
    renderTribute(room);
    showScreen('tribute');
    updateTributeAction();
    processTributeEvents(room);
  }

  function processTributeEvents(room) {
    const events = Array.isArray(room.events) ? room.events : [];
    const fresh = events.filter((event) => Number(event.id) > app.lastTributeEventId);
    if (fresh.length === 0) return;
    for (const event of fresh) {
      if (['tribute', 'tribute_receive', 'return', 'return_receive'].includes(event.type)) {
        animateTributeEvent(event);
      }
    }
    app.lastTributeEventId = fresh[fresh.length - 1].id;
  }

  function tributeSeatElement(seat) {
    return document.querySelector(`#tribute-players .tribute-player[data-seat="${seat}"]`);
  }

  function flyTributeCard(card, fromNode, toNode, delay = 0) {
    const layer = el['tribute-fly-layer'];
    if (!layer || !fromNode || !toNode || !card) return;
    layer.hidden = false;
    const from = fromNode.getBoundingClientRect();
    const to = toNode.getBoundingClientRect();
    const suit = SUITS[card.suit] || SUITS.s;
    const node = document.createElement('div');
    node.className = `flying-card ${suit.red ? 'red' : ''}`;
    node.innerHTML = `<b>${esc(card.rank)}</b><i>${suit.symbol}</i>`;
    node.style.left = `${from.left + from.width / 2}px`;
    node.style.top = `${from.top + from.height / 2}px`;
    layer.appendChild(node);
    const dx = to.left + to.width / 2 - (from.left + from.width / 2);
    const dy = to.top + to.height / 2 - (from.top + from.height / 2);
    const animation = node.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.8) rotate(-8deg)', opacity: 0.2 },
        { transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.55 - 30}px)) scale(1.08) rotate(3deg)`, opacity: 1, offset: 0.55 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.72) rotate(0deg)`, opacity: 0 },
      ],
      { duration: 780, delay, easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'both' },
    );
    animation.onfinish = () => {
      node.remove();
      if (layer.childElementCount === 0) layer.hidden = true;
    };
  }

  function animateTributeEvent(event) {
    const pool = el['tribute-pool'];
    const returnPool = el['tribute-return-pool'];
    const player = tributeSeatElement(event.seat);
    if (event.type === 'tribute') {
      flyTributeCard(event.card, player, pool, 0);
    } else if (event.type === 'tribute_receive') {
      flyTributeCard(event.card, pool, player, 0);
    } else if (event.type === 'return') {
      (event.cards || []).forEach((card, index) => {
        flyTributeCard(card, player, returnPool, index * 120);
      });
    } else if (event.type === 'return_receive') {
      flyTributeCard(event.card, returnPool, player, 0);
    }
  }

  function renderTribute(room) {
    el['tribute-room-code'].textContent = room.code;
    el['tribute-instruction'].textContent = room.completed
      ? '供牌完成，马上开打！'
      : room.instruction || '正在准备供牌…';
    el['tribute-previous'].innerHTML = `
      <span class="previous-winner ${room.winnerSide}">${esc(room.previous?.winnerLabel || '上局结果')}</span>
      <span>${esc(room.previous?.reason || '')}</span>
    `;

    const youSeat = room.youSeat;
    el['tribute-players'].innerHTML = room.players.map((player) => {
      const classes = [
        'tribute-player',
        player.isWinner ? 'winner' : 'loser',
        player.isCurrent ? 'current' : '',
        player.connected === false ? 'offline' : '',
      ].filter(Boolean).join(' ');
      return `
        <div class="${classes}" data-seat="${player.seat}" style="--hue:${hueFor(player.seat, player.name)}">
          <span class="tribute-role">${player.isWinner ? '赢家' : '输家'}</span>
          <span class="tribute-avatar">${initial(player.name)}</span>
          <b>${esc(player.name)}${player.seat === youSeat ? ' · 你' : ''}</b>
          <em>${player.handCount} 张</em>
          ${player.isCurrent ? '<span class="tribute-now">挑牌中…</span>' : ''}
        </div>
      `;
    }).join('');

    renderTributePools(room);
    renderTributeHand(room);
    renderTributeEvents(room);
    updateTributeAction();
  }

  function renderTributePools(room) {
    const action = room.yourAction;
    const poolActive = !room.completed && action?.type === 'tribute_pick';
    const returnActive = !room.completed && action?.type === 'return_pick';

    el['tribute-pool'].innerHTML = room.pool.length
      ? room.pool.map((entry) => tributeCard(entry.card, 'pool', poolActive, entry.fromName)).join('')
      : '<p class="tribute-empty">暂无上供牌</p>';
    el['tribute-return-pool'].innerHTML = room.returnPool.length
      ? room.returnPool.map((entry) => tributeCard(entry.card, 'returnPool', returnActive, entry.fromName)).join('')
      : '<p class="tribute-empty">还没有还牌</p>';
    el['tribute-pool'].classList.toggle('is-active', poolActive);
    el['tribute-return-pool'].classList.toggle('is-active', returnActive);
    el['tribute-pool-note'].textContent = poolActive
      ? '点一张你想要的牌'
      : '输家供出的牌';
    el['tribute-return-note'].textContent = returnActive
      ? '点一张你想要的牌'
      : '赢家还出的牌';
  }

  function tributeCard(card, source, clickable, fromName = '') {
    const suit = SUITS[card.suit] || SUITS.s;
    const selected = app.tributeSelection.has(card.id);
    return `<button type="button"
      class="tribute-pick-card ${suit.red ? 'red' : ''} ${selected ? 'selected' : ''} ${clickable ? 'clickable' : ''}"
      data-tribute-source="${source}" data-card-id="${esc(card.id)}"
      aria-pressed="${selected ? 'true' : 'false'}"
      title="${esc(fromName ? `${fromName} 的牌` : suit.name + card.rank)}"
      ${clickable ? '' : 'disabled'}>
      <span class="tribute-card-rank">${esc(card.rank)}</span>
      <span class="tribute-card-suit">${suit.symbol}</span>
      <span class="tribute-card-watermark">${suit.symbol}</span>
      ${fromName ? `<span class="tribute-card-from">${esc(fromName)}</span>` : ''}
    </button>`;
  }

  function renderTributeHand(room) {
    const cards = sortHand(room.hand || []);
    const interactive = !room.completed && room.yourAction?.type === 'return_select';
    const signature = cards.map((card) => card.id).join(',');
    if (signature !== app.tributeHandSignature) {
      app.tributeHandSignature = signature;
      el['tribute-hand'].innerHTML = cards.map((card, index) => tributeHandCard(card, index, interactive)).join('');
    } else {
      for (const button of el['tribute-hand'].querySelectorAll('[data-card-id]')) {
        button.disabled = !interactive || isIdentityCardId(button.dataset.cardId);
      }
    }
    for (const button of el['tribute-hand'].querySelectorAll('[data-card-id]')) {
      const selected = app.tributeSelection.has(button.dataset.cardId);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  }

  function tributeHandCard(card, index, interactive) {
    const suit = SUITS[card.suit] || SUITS.s;
    const selected = app.tributeSelection.has(card.id);
    const identity = isIdentityCardId(card.id);
    return `<button type="button"
      class="playing-card hand-card tribute-hand-card ${suit.red ? 'red' : ''} ${selected ? 'selected' : ''} ${identity ? 'identity-locked' : ''}"
      data-tribute-source="hand" data-card-id="${esc(card.id)}"
      data-identity-locked="${identity ? 'true' : 'false'}"
      style="--z:${index + 1}"
      aria-pressed="${selected ? 'true' : 'false'}"
      aria-label="${esc(suit.name + card.rank)}${identity ? '，身份牌不能参与还牌' : ''}"
      title="${identity ? '身份牌不能参与还牌' : ''}"
      ${interactive && !identity ? '' : 'disabled'}>
      <span class="card-index"><b class="card-rank">${esc(card.rank)}</b><i class="card-suit">${suit.symbol}</i></span>
      <span class="card-watermark">${suit.symbol}</span>
      ${identity ? '<span class="identity-lock-tag">身份</span>' : ''}
    </button>`;
  }

  function handleTributeCardClick(event, source) {
    const button = event.target.closest('[data-card-id]');
    if (!button || button.disabled) return;
    const room = app.room;
    const action = room?.yourAction;
    if (!action || room.completed) return;

    const expectedSource =
      action.type === 'tribute_pick' ? 'pool' :
      action.type === 'return_pick' ? 'returnPool' : 'hand';
    if (source !== expectedSource) return;

    const id = button.dataset.cardId;
    if (action.type === 'return_select') {
      if (isIdentityCardId(id)) {
        showToast('身份牌不能参与还牌哦！', 'error');
        return;
      }
      if (app.tributeSelection.has(id)) app.tributeSelection.delete(id);
      else {
        if (app.tributeSelection.size >= action.count) {
          showToast(`最多选 ${action.count} 张还牌`, 'error');
          return;
        }
        app.tributeSelection.add(id);
      }
    } else {
      app.tributeSelection.clear();
      app.tributeSelection.add(id);
    }
    renderTributeSelection();
  }

  function renderTributeSelection() {
    for (const button of document.querySelectorAll('[data-tribute-source]')) {
      const selected = app.tributeSelection.has(button.dataset.cardId);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
    updateTributeAction();
  }

  function updateTributeAction() {
    const room = app.room;
    if (!room || room.phase !== 'tribute') return;
    for (const id of [...app.tributeSelection]) {
      if (isIdentityCardId(id)) app.tributeSelection.delete(id);
    }
    const action = room.yourAction;
    const selected = app.tributeSelection.size;
    const key = document.activeElement?.id;
    el['tribute-clear-btn'].hidden = selected === 0;
    el['tribute-clear-btn'].disabled = !action || app.pending;
    el['tribute-confirm-btn'].disabled = !action || app.pending ||
      (action.type === 'return_select' ? selected !== action.count : selected !== 1);
    if (room.completed) {
      el['tribute-confirm-btn'].disabled = true;
      el['tribute-confirm-btn'].textContent = '发牌中…';
    } else if (!action) {
      el['tribute-confirm-btn'].textContent = '等别人挑牌';
    } else if (action.type === 'return_select') {
      el['tribute-confirm-btn'].textContent = app.pending
        ? '提交中…'
        : `归还 ${selected}/${action.count} 张`;
    } else if (action.type === 'tribute_pick') {
      el['tribute-confirm-btn'].textContent = app.pending ? '提交中…' : '就选这张供牌';
    } else {
      el['tribute-confirm-btn'].textContent = app.pending ? '提交中…' : '收下这张还牌';
    }

    let info = '看清牌面，再出手哦！';
    if (room.completed) info = '供牌完成，马上开打，准备好你的表情包！';
    else if (action?.type === 'tribute_pick') info = selected ? '这张供牌不错，确认收下吧！' : '点一张上供牌，再确认。';
    else if (action?.type === 'return_select') info = `选择 ${action.count} 张还牌（身份牌不可还，已选 ${selected} 张）`;
    else if (action?.type === 'return_pick') info = selected ? '这张还牌可以，确认收下吧！' : '点一张还牌，再确认。';
    else if (room.instruction) info = room.instruction;
    el['tribute-selection-info'].textContent = info;

    const current = playerAtSeat(room.currentSeat);
    el['tribute-waiting'].hidden = Boolean(action) || room.completed;
    el['tribute-waiting'].textContent = room.completed
      ? ''
      : `等待 ${current?.name || '其他玩家'} 挑牌中…`;
    el['tribute-confirm-btn'].hidden = room.completed;
    if (key === 'tribute-confirm-btn') el['tribute-confirm-btn'].focus({ preventScroll: true });
    updateCountdown();
  }

  function renderTributeEvents(room) {
    const events = Array.isArray(room.events) ? room.events.slice(-10) : [];
    el['tribute-events'].innerHTML = events.length
      ? events.map((event) => `<li class="${esc(event.type)}">${esc(event.text)}</li>`).join('')
      : '<li>供牌马上开始…</li>';
    el['tribute-events'].scrollTop = el['tribute-events'].scrollHeight;
  }

  function confirmTributeSelection() {
    const room = app.room;
    if (!room || room.phase !== 'tribute' || app.pending || !room.yourAction) return;
    const action = room.yourAction;
    const cards = [...app.tributeSelection];
    if (action.type === 'return_select' && cards.length !== action.count) return;
    if (action.type !== 'return_select' && cards.length !== 1) return;

    setPending(true);
    if (action.type === 'tribute_pick') {
      send({ type: 'tribute_pick', cardId: cards[0] });
    } else if (action.type === 'return_select') {
      send({ type: 'tribute_return', cards });
    } else if (action.type === 'return_pick') {
      send({ type: 'tribute_receive', cardId: cards[0] });
    }
  }

  /* ---------------- Game rendering ---------------- */

  function renderGame(room) {
    el['game-room-code'].textContent = room.code;
    el['game-phase-label'].textContent = room.phase === 'ended'
      ? '对局结束'
      : `第 ${room.round || 1} 局 · ${room.singlePlayer ? '单机欢乐中' : '欢乐进行中'}`;
    el['game-result-btn'].hidden = room.phase !== 'ended';
    updateSoundUi();
    updateTrustButton(room);
    renderLandlordStrip(room);
    renderCounter(room);
    renderPods(room);
    renderCenter(room);
    renderHand(room);
    updateActionArea();
    renderLog(room);
  }

  function updateTrustButton(room) {
    const button = el['game-trust-btn'];
    if (!button) return;
    const me = playerAtSeat(room.youSeat);
    button.hidden = Boolean(room.singlePlayer);
    button.classList.toggle('on', Boolean(me?.autoPlay));
    button.textContent = me?.autoPlay ? '取消' : '托管';
    button.title = me?.autoPlay ? '取消自动出牌' : '开启自动出牌';
    button.disabled = room.phase === 'ended';
  }

  function renderCounter(room) {
    const counts = room.cardCounter;
    const visible = Boolean(room.counterEnabled && counts);
    el['counter-panel'].hidden = !visible;
    el['game-counter-btn'].hidden = !visible;
    if (!visible) {
      el['screen-game'].classList.remove('counter-open');
      el['counter-chips'].innerHTML = '';
      return;
    }
    el['counter-chips'].innerHTML = RANKS.map((rank) => {
      const count = Number(counts[rank] || 0);
      return `<span class="counter-chip ${count === 0 ? 'empty' : ''}" title="${esc(rank)} 还剩 ${count} 张">
        <b>${esc(rank)}</b><em>${count}</em>
      </span>`;
    }).join('');
  }

  function openCounterDetail() {
    const room = app.room;
    if (!room || !room.counterEnabled) return;
    renderCounterDetail(room);
    openModal('counter');
  }

  function renderCounterDetail(room) {
    const played = new Set(room.playedCardIds || []);
    const own = new Set((room.hand || []).map((card) => card.id));
    const counts = room.cardCounter || {};
    const total = Object.values(counts).reduce((sum, value) => sum + Number(value || 0), 0);
    el['counter-summary'].textContent =
      `不含你的手牌，其他玩家手中还剩 ${total} 张；已打出 ${played.size} 张。`;
    el['counter-detail'].innerHTML = RANKS.map((rank) => {
      const stack = CARD_CATALOG
        .filter((card) => card.rank === rank)
        .map((card) => {
          const suit = SUITS[card.suit];
          const status = played.has(card.id) ? 'played' : own.has(card.id) ? 'own' : 'unknown';
          const statusLabel = status === 'played' ? '已打出' : status === 'own' ? '你的手牌' : '未打出';
          return `<span class="detail-card ${status} ${suit.red ? 'red' : ''}" title="${esc(suit.name + card.rank)} · ${statusLabel}">
            <b>${suit.symbol}</b><i>${esc(card.rank)}</i>
          </span>`;
        }).join('');
      return `<section class="counter-stack ${Number(counts[rank] || 0) === 0 ? 'empty' : ''}">
        <header><b>${esc(rank)}</b><em>剩 ${Number(counts[rank] || 0)}</em></header>
        <div class="detail-stack">${stack}</div>
      </section>`;
    }).join('');
  }

  function renderLandlordStrip(room) {
    const revealed = room.players.filter((player) => player.landlordRevealed);
    if (revealed.length === 0) {
      el['landlord-strip'].innerHTML = '<span class="none">身份牌还藏着呢 · 队友是谁全靠猜</span>';
      return;
    }
    el['landlord-strip'].innerHTML = revealed.map((player) => `
      <span class="landlord-chip">
        <span class="crown">♛</span>
        <span>${esc(player.name)}${player.doubleRevealed ? ' · 双地主' : ' · 地主'}</span>
        <span class="mini-identities">${player.revealedIdentityCards.map(miniIdentity).join('')}</span>
      </span>
    `).join('');
  }

  function miniIdentity(card) {
    const suit = SUITS[card.suit] || SUITS.s;
    return `<span class="mini-identity ${suit.red ? 'red' : ''}" title="${esc(suit.name + card.rank)}">
      <b>${esc(card.rank)}</b><span>${suit.symbol}</span>
    </span>`;
  }

  function isIdentityCardId(cardId) {
    return cardId === 'sA' || cardId === 's3';
  }

  function playerBadges(player) {
    const badges = [];
    if (player.isHost) badges.push('<span class="badge">房主</span>');
    if (player.isBot) badges.push('<span class="badge bot-badge">电脑</span>');
    if (player.autoPlay && !player.isBot) badges.push('<span class="badge trust-badge">托管中</span>');
    if (player.connected === false) badges.push('<span class="badge offline-badge">离线</span>');
    if (player.finished) {
      badges.push(`<span class="badge finish-badge">第 ${player.place} 顺位</span>`);
    }
    if (player.landlordRevealed) {
      badges.push(`
        <span class="badge landlord-badge">♛ ${player.doubleRevealed ? '双地主' : '地主'}
          <span class="mini-identities">${player.revealedIdentityCards.map(miniIdentity).join('')}</span>
        </span>
      `);
    } else if (player.farmerRevealed) {
      badges.push('<span class="badge farmer-badge">农民</span>');
    }
    if (!player.finished && player.handCount > 0 && player.handCount <= 2) {
      badges.push(`<span class="badge report-badge">${player.handCount === 1 ? '报单' : '报双'}</span>`);
    }
    return badges.join('');
  }

  function trickPlayFor(room, seat) {
    return (room.trickPlays || []).find((entry) => entry.seat === seat) || null;
  }

  function trickMarkup(entry, small = false) {
    if (!entry) return '';
    if (entry.passed) return '<span class="trick-pass">过</span>';
    return `<span class="trick-cards ${small ? 'small' : ''}">${entry.cards.map((card) => {
      const suit = SUITS[card.suit] || SUITS.s;
      return `<span class="trick-card ${suit.red ? 'red' : ''}" title="${esc(suit.name + card.rank)}">
        <b>${esc(card.rank)}</b><i>${suit.symbol}</i>
      </span>`;
    }).join('')}</span>`;
  }

  function podMarkup(player, room) {
    const isTurn = room.phase === 'playing' && room.turnSeat === player.seat;
    const classes = [
      'player-pod',
      isTurn ? 'turn' : '',
      player.landlordRevealed ? 'landlord' : '',
      player.farmerRevealed ? 'farmer' : '',
      player.finished ? 'finished' : '',
      player.connected === false ? 'offline' : '',
      player.isBot ? 'bot' : '',
      player.autoPlay ? 'trusted' : '',
      player.handCount === 1 ? 'report-one' : '',
      player.handCount === 2 ? 'report-two' : '',
    ].filter(Boolean).join(' ');
    return `
      <div class="${classes}" style="--hue:${hueFor(player.seat, player.name)}" data-seat="${player.seat}">
        <div class="pod-avatar">${initial(player.name)}</div>
        <div class="pod-body">
          <div class="pod-name" title="${esc(player.name)}">${esc(player.name)}${player.isYou ? ' · 你' : ''}</div>
          <div class="pod-sub">${player.finished ? '已出完' : `剩 ${player.handCount} 张`}${isTurn ? ' · 出牌中' : ''}</div>
          <div class="pod-badges">${playerBadges(player)}</div>
        </div>
        <div class="pod-stack" aria-hidden="true">
          <span class="card-back-mini"></span><span class="card-back-mini"></span><span class="card-back-mini"></span>
          <span class="stack-count">${player.finished ? '✓' : player.handCount}</span>
        </div>
        ${trickMarkup(trickPlayFor(room, player.seat)) ? `<div class="pod-trick">${trickMarkup(trickPlayFor(room, player.seat))}</div>` : ''}
      </div>
    `;
  }

  function renderPods(room) {
    const you = room.youSeat;
    const left = playerAtSeat((you + 1) % 4);
    const top = playerAtSeat((you + 2) % 4);
    const right = playerAtSeat((you + 3) % 4);
    el['seat-left'].innerHTML = left ? podMarkup(left, room) : '';
    el['seat-top'].innerHTML = top ? podMarkup(top, room) : '';
    el['seat-right'].innerHTML = right ? podMarkup(right, room) : '';

    const me = playerAtSeat(you);
    if (!me) {
      el['self-pod'].innerHTML = '';
      el['self-trick'].hidden = true;
      return;
    }
    const isTurn = room.phase === 'playing' && room.turnSeat === room.youSeat;
    el['self-pod'].className = [
      'self-pod',
      isTurn ? 'turn' : '',
      me.landlordRevealed ? 'landlord' : '',
      me.farmerRevealed ? 'farmer' : '',
      me.autoPlay ? 'trusted' : '',
      me.handCount === 1 ? 'report-one' : '',
      me.handCount === 2 ? 'report-two' : '',
    ].filter(Boolean).join(' ');
    el['self-pod'].innerHTML = `
      <div class="self-avatar" style="--hue:${hueFor(me.seat, me.name)}">${initial(me.name)}</div>
      <div class="self-info">
        <div class="self-name">${esc(me.name)} · 你</div>
        <div class="self-sub">${me.finished ? `第 ${me.place} 顺位` : `剩 ${me.handCount} 张`}</div>
        <div class="self-tags">${playerBadges(me)}</div>
      </div>
    `;

    const selfTrick = trickPlayFor(room, room.youSeat);
    el['self-trick'].hidden = !selfTrick;
    el['self-trick'].innerHTML = selfTrick
      ? `<span class="self-trick-label">本轮</span>${trickMarkup(selfTrick, true)}`
      : '';
  }

  function renderCenter(room) {
    const last = room.lastPlay;
    const current = playerAtSeat(room.turnSeat);
    const isYourTurn = room.phase === 'playing' && room.turnSeat === room.youSeat;
    el['turn-banner'].classList.toggle('yours', isYourTurn);

    if (room.phase === 'ended') {
      el['turn-banner'].textContent = '这局结束啦';
    } else if (isYourTurn) {
      el['turn-banner'].textContent = '轮到你啦，出牌！';
    } else {
      el['turn-banner'].textContent = `等 ${current?.name || '下一位玩家'} 出牌中…`;
    }

    if (last) {
      el['last-play'].hidden = false;
      el['center-empty'].hidden = true;
      const owner = playerAtSeat(last.seat);
      el['last-play-owner'].textContent = `${owner?.name || '玩家'}${last.auto ? ' · 托管' : ''}`;
      el['last-play-type'].textContent = last.combo?.label || '牌型';
      el['last-play-cards'].innerHTML = last.cards.map((card) => tableCard(card)).join('');
    } else {
      el['last-play'].hidden = true;
      el['center-empty'].hidden = false;
      el['center-empty'].textContent = room.mustIncludeDiamond4
        ? '首手必须包含 ♦4'
        : '新一轮 · 任意合法牌型';
    }

    const passed = (room.passedSeats || [])
      .map((seat) => playerAtSeat(seat))
      .filter(Boolean);
    el['pass-bubbles'].innerHTML = passed
      .map((player) => `<span class="pass-bubble">${esc(player.name)} · 过！</span>`)
      .join('');

    updateCountdown();
  }

  function tableCard(card) {
    const suit = SUITS[card.suit] || SUITS.s;
    const identity = card.suit === 's' && (card.rank === 'A' || card.rank === '3');
    return `<div class="table-card ${suit.red ? 'red' : ''} ${identity ? 'identity-played' : ''}" data-card-id="${esc(card.id)}" title="${esc(suit.name + card.rank)}">
      <span class="card-rank">${esc(card.rank)}</span><span class="card-suit">${suit.symbol}</span>
    </div>`;
  }

  function sortHand(cards) {
    return [...cards].sort((a, b) => {
      const rankDiff = (RANK_VALUE[b.rank] ?? -1) - (RANK_VALUE[a.rank] ?? -1);
      if (rankDiff !== 0) return rankDiff;
      return (SUITS[b.suit]?.value ?? -1) - (SUITS[a.suit]?.value ?? -1);
    });
  }

  function renderHand(room) {
    const cards = sortHand(room.hand || []);
    const signature = cards.map((card) => card.id).join(',');
    if (signature === app.handSignature && el.hand.children.length === cards.length) {
      updateHandSelection();
      return;
    }
    app.handSignature = signature;
    el.hand.innerHTML = cards.map((card, index) => {
      const suit = SUITS[card.suit] || SUITS.s;
      const selected = app.selected.has(card.id);
      return `<button type="button"
        class="playing-card hand-card ${suit.red ? 'red' : ''} ${selected ? 'selected' : ''}"
        data-card-id="${esc(card.id)}"
        style="--z:${index + 1}"
        aria-pressed="${selected ? 'true' : 'false'}"
        aria-label="${esc(suit.name + card.rank)}"
        ${room.phase === 'ended' ? 'disabled' : ''}>
        <span class="card-index"><b class="card-rank">${esc(card.rank)}</b><i class="card-suit">${suit.symbol}</i></span>
        <span class="card-watermark">${suit.symbol}</span>
      </button>`;
    }).join('');
    updateHandSelection();
  }

  function updateHandSelection() {
    for (const button of el.hand.querySelectorAll('[data-card-id]')) {
      const selected = app.selected.has(button.dataset.cardId);
      button.classList.toggle('selected', selected);
      button.setAttribute('aria-pressed', selected ? 'true' : 'false');
    }
  }

  function renderHandAndActions() {
    if (!app.room) return;
    renderHand(app.room);
    updateActionArea();
  }

  function selectedCards() {
    if (!app.room) return [];
    return (app.room.hand || []).filter((card) => app.selected.has(card.id));
  }

  function updateActionArea() {
    const room = app.room;
    if (!room || room.phase === 'lobby') return;

    for (const id of [...app.selected]) {
      if (!(room.hand || []).some((card) => card.id === id)) app.selected.delete(id);
    }

    const selected = selectedCards();
    const isYourTurn = room.phase === 'playing' && room.turnSeat === room.youSeat;
    const evaluation = evaluateSelection(selected, room);
    const name = playerAtSeat(room.turnSeat)?.name || '下一位玩家';

    el['clear-btn'].hidden = selected.length === 0;
    el['selection-info'].classList.remove('valid', 'invalid');

    if (selected.length === 0) {
      if (room.phase === 'ended') {
        el['selection-info'].textContent = '对局已结束';
      } else if (isYourTurn) {
        el['selection-info'].textContent = room.mustIncludeDiamond4
          ? '首手必须包含 ♦4'
          : '点击手牌选择要出的牌';
      } else {
        el['selection-info'].textContent = `等 ${name} 出牌中…`;
      }
    } else if (evaluation.ok) {
      el['selection-info'].classList.add('valid');
      el['selection-info'].textContent = `已选 ${selected.length} 张 · ${evaluation.combo.label}${isYourTurn ? ' · 可以出！' : ''}`;
    } else {
      el['selection-info'].classList.add('invalid');
      el['selection-info'].textContent = evaluation.message;
    }

    const canPlay =
      room.phase === 'playing' &&
      isYourTurn &&
      evaluation.ok &&
      !app.pending;

    el['play-btn'].disabled = !canPlay;
    el['play-btn'].textContent = app.pending ? '提交中…' : '出牌！';
    const canPass = room.phase === 'playing' && isYourTurn && Boolean(room.lastPlay) && !app.pending;
    el['pass-btn'].disabled = !canPass;
    el['pass-btn'].textContent = '过！';
    el['hint-btn'].disabled = !(room.phase === 'playing' && isYourTurn && !app.pending);

    if (room.phase === 'ended') {
      el['action-hint'].textContent = '这局结束啦，点右上角“看结果”瞅瞅谁赢了！';
    } else if (isYourTurn) {
      if (!room.lastPlay && room.mustIncludeDiamond4) {
        el['action-hint'].textContent = '第一手必须带 ♦4 哦，先手不能过！';
      } else if (!room.lastPlay) {
        el['action-hint'].textContent = '这轮你说了算，想出啥牌型都行！';
      } else {
        el['action-hint'].textContent = '选好牌就出，压不过就潇洒点“过”！';
      }
    } else {
      el['action-hint'].textContent = `等 ${name} 出牌中…`;
    }

    updateHandSelection();
    updateCountdown();
  }

  function updateCountdown() {
    const room = app.room;
    const now = Date.now() + app.serverOffset;
    const turnNode = el['turn-timer'];
    const tributeNode = el['tribute-timer'];
    const autoNode = el['auto-countdown'];

    const turnRemaining = room?.phase === 'playing' && room.turnDeadline
      ? Math.max(0, (room.turnDeadline - now) / 1000)
      : null;
    if (turnNode) {
      turnNode.hidden = turnRemaining === null;
      turnNode.classList.toggle('low', turnRemaining !== null && turnRemaining <= 5);
      if (turnRemaining !== null) {
        turnNode.textContent = turnRemaining <= 0
          ? '时间到，正在自动处理…'
          : `剩余 ${Math.ceil(turnRemaining)}s`;
      }
    }

    const tributeRemaining = room?.phase === 'tribute' && room.actionDeadline
      ? Math.max(0, (room.actionDeadline - now) / 1000)
      : null;
    if (tributeNode) {
      tributeNode.hidden = tributeRemaining === null;
      tributeNode.classList.toggle('low', tributeRemaining !== null && tributeRemaining <= 5);
      if (tributeRemaining !== null) {
        tributeNode.textContent = tributeRemaining <= 0
          ? '时间到，正在自动选择…'
          : `剩余 ${Math.ceil(tributeRemaining)}s`;
      }
    }

    if (!autoNode) return;
    if (!room || room.phase !== 'playing' || !room.autoAction) {
      autoNode.hidden = true;
      autoNode.classList.remove('offline');
      return;
    }
    const auto = room.autoAction;
    const remaining = Math.max(0, (auto.at - now) / 1000);
    const player = playerAtSeat(auto.seat);
    const isYou = auto.seat === room.youSeat;
    const who = isYou ? '你' : (player?.name || '该玩家');
    autoNode.hidden = false;
    autoNode.classList.add('offline');
    autoNode.textContent = remaining <= 0
      ? '正在自动托管…'
      : `${who} 离线，${remaining.toFixed(1)}s 后自动托管`;
  }

  /* ---------------- Client-side rule preview ---------------- */

  function sortByPower(cards) {
    return [...cards].sort((a, b) => {
      const rankDiff = (RANK_VALUE[b.rank] ?? -1) - (RANK_VALUE[a.rank] ?? -1);
      return rankDiff !== 0 ? rankDiff : (SUITS[b.suit]?.value ?? -1) - (SUITS[a.suit]?.value ?? -1);
    });
  }

  function classifyClient(input) {
    const cards = [...input];
    if (![1, 2, 3, 5].includes(cards.length)) return null;
    const sorted = sortByPower(cards);

    if (sorted.length === 1) {
      return { type: 'single', label: '单牌', cat: 0, rank: RANK_VALUE[sorted[0].rank], highSuit: SUITS[sorted[0].suit].value };
    }
    if (sorted.length === 2) {
      if (sorted[0].rank !== sorted[1].rank) return null;
      return {
        type: 'pair',
        label: '对子',
        cat: 1,
        rank: RANK_VALUE[sorted[0].rank],
        suits: sorted.map((card) => SUITS[card.suit].value),
      };
    }
    if (sorted.length === 3) {
      if (!sorted.every((card) => card.rank === sorted[0].rank)) return null;
      return { type: 'trips', label: '三条', cat: 2, rank: RANK_VALUE[sorted[0].rank] };
    }

    const counts = new Map();
    for (const card of sorted) {
      const rank = RANK_VALUE[card.rank];
      counts.set(rank, (counts.get(rank) || 0) + 1);
    }
    const countList = [...counts.entries()]
      .map(([rank, count]) => ({ rank, count }))
      .sort((a, b) => b.count - a.count || b.rank - a.rank);
    const ranks = sorted.map((card) => RANK_VALUE[card.rank]);
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
      return {
        type: 'royal',
        label: '皇家同花顺',
        cat: 8,
        suitValue: SUITS[sorted[0].suit].value,
      };
    }
    if (isFlush && isStraight) {
      return {
        type: 'straightflush',
        label: '同花顺',
        cat: 7,
        suitValue: SUITS[sorted[0].suit].value,
        rank: uniqueRanks[0],
        highSuit: SUITS[sorted[0].suit].value,
        ranks: uniqueRanks,
      };
    }
    if (isFlush) {
      return {
        type: 'flush',
        label: '同花',
        cat: 4,
        suitValue: SUITS[sorted[0].suit].value,
        ranks: uniqueRanks,
      };
    }
    if (isStraight) {
      return {
        type: 'straight',
        label: '顺子',
        cat: 3,
        rank: uniqueRanks[0],
        highSuit: SUITS[sorted[0].suit].value,
      };
    }
    if (countList.length === 2 && countList[0].count === 3 && countList[1].count === 2) {
      return { type: 'fullhouse', label: '三带二', cat: 5, rank: countList[0].rank };
    }
    if (countList.length === 2 && countList[0].count === 4 && countList[1].count === 1) {
      return { type: 'four', label: '四带一', cat: 6, rank: countList[0].rank };
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

  function compareClient(a, b) {
    if (!a || !b) return 0;
    if (a.cat !== b.cat) return a.cat - b.cat;
    if (a.type === 'single') return a.rank - b.rank || a.highSuit - b.highSuit;
    if (a.type === 'pair') return a.rank - b.rank || compareNumberArrays(a.suits, b.suits);
    if (a.type === 'trips' || a.type === 'fullhouse' || a.type === 'four') return a.rank - b.rank;
    if (a.type === 'straight') return a.rank - b.rank || a.highSuit - b.highSuit;
    if (a.type === 'flush') return a.suitValue - b.suitValue || compareNumberArrays(a.ranks, b.ranks);
    if (a.type === 'straightflush') return a.rank - b.rank || a.highSuit - b.highSuit;
    if (a.type === 'royal') return a.suitValue - b.suitValue;
    return 0;
  }

  function canBeatClient(combo, previous) {
    if (!combo) return false;
    if (!previous) return true;
    const basic = combo.type === 'single' || combo.type === 'pair';
    const previousBasic = previous.type === 'single' || previous.type === 'pair';
    if (previousBasic) {
      if (combo.type !== previous.type) return false;
      return compareClient(combo, previous) > 0;
    }
    if (basic) return false;
    return compareClient(combo, previous) > 0;
  }

  function combinations(items, size) {
    const result = [];
    const walk = (start, picked) => {
      if (picked.length === size) {
        result.push(picked.slice());
        return;
      }
      for (let index = start; index < items.length; index += 1) {
        picked.push(items[index]);
        walk(index + 1, picked);
        picked.pop();
      }
    };
    walk(0, []);
    return result;
  }

  function computeHintMoves(room) {
    const hand = sortHand(room.hand || []);
    const key = [
      hand.map((card) => card.id).join(','),
      room.lastPlay?.cards?.map((card) => card.id).join(',') || 'lead',
      room.mustIncludeDiamond4 ? 'd4' : '',
    ].join('|');
    if (app.hintKey === key && app.hintMoves.length > 0) return app.hintMoves;

    const previous = room.lastPlay ? classifyClient(room.lastPlay.cards) : null;
    const moves = [];
    for (const size of [1, 2, 3, 5]) {
      for (const picked of combinations(hand, size)) {
        if (room.mustIncludeDiamond4 && !picked.some((card) => card.id === 'd4')) continue;
        const combo = classifyClient(picked);
        if (!combo) continue;
        if (previous && !canBeatClient(combo, previous)) continue;
        moves.push({ cards: picked, combo });
      }
    }
    moves.sort((a, b) => compareClient(a.combo, b.combo) || a.cards.length - b.cards.length);
    if (app.hintKey !== key) app.hintIndex = -1;
    app.hintKey = key;
    app.hintMoves = moves;
    return moves;
  }

  function useHint() {
    const room = app.room;
    if (!room || room.phase !== 'playing' || room.turnSeat !== room.youSeat || app.pending) return;
    const moves = computeHintMoves(room);
    if (moves.length === 0) {
      showToast('这轮没有能压过的牌，点“过”就行啦！', 'error');
      return;
    }
    app.hintIndex = ((app.hintIndex || 0) + 1) % moves.length;
    const move = moves[app.hintIndex];
    app.selected = new Set(move.cards.map((card) => card.id));
    updateHandSelection();
    updateActionArea();
    const suffix = moves.length > 1 ? `（${app.hintIndex + 1}/${moves.length}，再点提示可轮换）` : '';
    showToast(`提示：${move.combo.label}${suffix}`, 'gold', 2200);
  }

  function evaluateSelection(cards, room) {
    if (cards.length === 0) return { ok: false, message: '' };
    if (cards.length > 5) return { ok: false, message: '一次最多选 5 张啦！' };
    const combo = classifyClient(cards);
    if (!combo) {
      return { ok: false, message: '牌型不合法：单牌 / 对子 / 三条 / 顺子 / 同花 / 三带二 / 四带一 / 同花顺 / 皇家同花顺' };
    }
    if (room.mustIncludeDiamond4 && !cards.some((card) => card.id === 'd4')) {
      return { ok: false, message: '第一手得带上 ♦4 哦！' };
    }
    if (room.lastPlay) {
      const previous = classifyClient(room.lastPlay.cards);
      if (!previous || !canBeatClient(combo, previous)) {
        return { ok: false, message: `这手 ${combo.label} 压不过上家的 ${room.lastPlay.combo?.label || '牌型'}` };
      }
    }
    return { ok: true, combo, message: '' };
  }

  /* ---------------- Actions ---------------- */

  function playSelected() {
    if (!app.room || app.pending) return;
    const room = app.room;
    const isYourTurn = room.phase === 'playing' && room.turnSeat === room.youSeat;
    const selected = selectedCards();
    const evaluation = evaluateSelection(selected, room);
    if (!isYourTurn) {
      showToast('还没轮到你呢，先别急！', 'error');
      return;
    }
    if (!evaluation.ok) {
      showToast(evaluation.message || '请选择合法的牌', 'error');
      playSound('error');
      return;
    }
    setPending(true);
    send({ type: 'play', cards: selected.map((card) => card.id) });
  }

  function passTurn() {
    if (!app.room || app.pending) return;
    const room = app.room;
    if (room.phase !== 'playing' || room.turnSeat !== room.youSeat) return;
    if (!room.lastPlay) {
      showToast('本轮由你领出，不能跳过', 'error');
      return;
    }
    app.selected.clear();
    updateHandSelection();
    setPending(true);
    send({ type: 'pass' });
  }

  function setPending(value) {
    app.pending = value;
    clearPendingTimer();
    if (value) {
      app.pendingTimer = setTimeout(() => {
        if (app.pending) {
          app.pending = false;
          updateActionArea();
          updateRoomControls();
          showToast('服务器有点慢，再试一次吧！', 'error');
        }
      }, 8000);
    }
    updateRoomControls();
    updateActionArea();
    if (app.room?.phase === 'tribute') updateTributeAction();
  }

  function clearPendingTimer() {
    if (app.pendingTimer) {
      clearTimeout(app.pendingTimer);
      app.pendingTimer = null;
    }
  }

  function restartGame() {
    if (app.pending) return;
    setPending(true);
    send({ type: 'restart' });
  }

  function leaveRoom() {
    const inGame = app.room && (app.room.phase === 'playing' || app.room.phase === 'tribute');
    if (inGame) {
      const confirmed = window.confirm('现在离开的话，牌局会进入离线托管哦。确定要溜吗？');
      if (!confirmed) return;
    }
    app.intentionalLeave = true;
    if (app.connected) send({ type: 'leave' });
    clearSession();
    app.room = null;
    app.pending = false;
    app.gameKey = null;
    app.selected.clear();
    app.tributeSelection.clear();
    app.tributeKey = null;
    app.handSignature = '';
    app.resultKey = null;
    app.prevTurnSeat = null;
    clearIdentityAlerts();
    closeModal('result');
    closeModal('rules');
    closeLog();
    hideReconnect();
    setUrlRoom(null);
    showScreen('landing');
    setLandingError('');
    setFormBusy(false);
    setTimeout(() => {
      app.intentionalLeave = false;
    }, 800);
  }

  function clearSession() {
    app.session = null;
    localStorage.removeItem(SESSION_KEY);
  }

  /* ---------------- Result ---------------- */

  function openResult(force) {
    const room = app.room;
    if (!room || !room.result) return;
    const key = resultKey(room);
    if (!force && app.resultKey === key && !el['result-modal'].hidden) return;
    app.resultKey = key;
    const result = room.result;

    el['result-hero'].className = `result-hero ${result.winner}`;
    el['result-kicker'].innerHTML = '<span></span>' + (
      result.winner === 'landlord' ? 'LANDLORD WIN!' :
      result.winner === 'farmers' ? 'FARMERS WIN!' : 'HAPPY DRAW!'
    );
    el['result-title'].textContent =
      result.winner === 'landlord' ? '地主赢啦！' :
      result.winner === 'farmers' ? '农民翻身啦！' : '握手言和！';
    el['result-reason'].textContent = result.reason || '';

    const landlords = (result.identities || []).filter((entry) => entry.team === 'landlord');
    const farmers = (result.identities || []).filter((entry) => entry.team === 'farmers');
    el['result-teams'].innerHTML = `
      <div class="team-card landlord">
        <h3>地主阵营${result.doubleLandlord ? ' · 双地主' : ''}</h3>
        <div class="team-members">${landlords.map(teamMember).join('')}</div>
      </div>
      <div class="team-card farmers">
        <h3>农民阵营</h3>
        <div class="team-members">${farmers.map(teamMember).join('')}</div>
      </div>
    `;

    const rankingRows = (result.rankings || []).map((entry) => `
      <li>
        <span class="rank-number">${String(entry.place).padStart(2, '0')}</span>
        <span class="rank-name">${esc(entry.name)}</span>
        <span class="rank-team ${entry.team}">${entry.team === 'landlord' ? '地主' : '农民'}</span>
      </li>
    `);
    for (const entry of result.unfinished || []) {
      rankingRows.push(`
        <li>
          <span class="rank-number">—</span>
          <span class="rank-name">${esc(entry.name)}</span>
          <span class="rank-team ${entry.team}">没打完 · ${entry.team === 'landlord' ? '地主' : '农民'}</span>
        </li>
      `);
    }
    el['result-ranking'].innerHTML = rankingRows.join('');

    const isHost = app.room.hostId === app.room.yourId;
    el['restart-btn'].hidden = !(isHost && app.room.canRestart);
    el['restart-btn'].disabled = app.pending;
    el['restart-btn'].textContent = app.room.nextRoundTribute ? '下一局 · 先进贡' : '再来一把！';
    el['restart-hint'].hidden = false;
    if (isHost && app.room.canRestart) {
      el['restart-hint'].textContent = app.room.nextRoundTribute
        ? '下一局先进贡还贡，准备好收贡啦！'
        : (app.room.tributeEnabled
            ? '下一局平局免供，直接开打！'
            : '下一局直接开打！');
    } else if (isHost) {
      el['restart-hint'].textContent = '有玩家离线，暂时没法开下一把。';
    } else {
      el['restart-hint'].textContent = '等房主开下一把，别跑太远哦！';
    }

    el['result-modal'].hidden = false;
    syncModalState();
    playSound('win');
  }

  function teamMember(entry) {
    const identities = (entry.cards || []).map(miniIdentity).join('');
    return `<div class="team-member">
      <span>${esc(entry.name)}</span>
      <span class="mini-identities">${identities || '<span class="badge">无身份牌</span>'}</span>
    </div>`;
  }

  function openModal(name) {
    const modal = name === 'rules'
      ? el['rules-modal']
      : name === 'counter'
        ? el['counter-modal']
        : el['result-modal'];
    if (!modal) return;
    app.modalReturnFocus = document.activeElement;
    modal.hidden = false;
    syncModalState();
    const close = modal.querySelector('.modal-close');
    if (close) close.focus({ preventScroll: true });
  }

  function closeModal(name) {
    const modal = name === 'rules'
      ? el['rules-modal']
      : name === 'counter'
        ? el['counter-modal']
        : el['result-modal'];
    if (!modal) return;
    modal.hidden = true;
    syncModalState();
    if (app.modalReturnFocus && typeof app.modalReturnFocus.focus === 'function') {
      try {
        app.modalReturnFocus.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }
  }

  function syncModalState() {
    const open = !el['rules-modal'].hidden || !el['result-modal'].hidden || !el['counter-modal'].hidden;
    document.body.classList.toggle('modal-open', open);
  }

  /* ---------------- Identity alert ---------------- */

  function queueIdentityAlert(event) {
    app.identityQueue.push(event);
    if (!app.identityShowing) showNextIdentityAlert();
  }

  function clearIdentityAlerts() {
    clearTimeout(app.identityTimer);
    app.identityTimer = null;
    app.identityQueue = [];
    app.identityShowing = false;
    el['identity-alert-layer'].innerHTML = '';
  }

  function showNextIdentityAlert() {
    const event = app.identityQueue.shift();
    if (!event) {
      app.identityShowing = false;
      return;
    }
    app.identityShowing = true;
    const player = app.room?.players.find((entry) => entry.seat === event.seat);
    const name = player?.name || '一名玩家';
    const double = Boolean(event.double);

    const alert = document.createElement('div');
    alert.className = 'identity-alert';
    const shownCards = double
      ? (event.allIdentityCards || event.identityCards || [])
      : (event.identityCards || []);
    alert.innerHTML = `
      <p class="identity-kicker">身份牌亮啦！</p>
      <div class="identity-crown">♛</div>
      <h2>${double ? '双地主闪亮登场！' : '哇！身份牌现身！'}</h2>
      <p><b>${esc(name)}</b> 打出了身份牌，地主身份藏不住啦！</p>
      <div class="identity-showcase">
        ${shownCards.map((card) => {
          const suit = SUITS[card.suit] || SUITS.s;
          return `<div class="identity-card-large ${suit.red ? 'red' : ''}">${esc(card.rank)}<span>${suit.symbol}</span></div>`;
        }).join('')}
      </div>
      <p>${double ? '原来两张身份牌都在他手里，这波刺激了！三名农民快联手拦住他！' : '从这一刻起，全场都知道谁是地主啦，快商量对策！'}</p>
      <button type="button" class="identity-dismiss">知道啦</button>
    `;
    el['identity-alert-layer'].appendChild(alert);
    playSound('reveal');

    const flash = document.createElement('div');
    flash.className = 'identity-flash';
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 700);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(app.identityTimer);
      app.identityTimer = null;
      alert.classList.add('out');
      setTimeout(() => {
        alert.remove();
        app.identityShowing = false;
        showNextIdentityAlert();
      }, 260);
    };
    alert.querySelector('.identity-dismiss').addEventListener('click', close);
    app.identityTimer = setTimeout(close, 5600);
  }

  /* ---------------- Log ---------------- */

  function toggleLog() {
    if (el['log-drawer'].hidden) {
      el['log-drawer'].hidden = false;
      renderLog(app.room);
    } else {
      closeLog();
    }
  }

  function closeLog() {
    if (el['log-drawer']) el['log-drawer'].hidden = true;
  }

  function renderLog(room) {
    if (!room || el['log-drawer'].hidden) return;
    const events = Array.isArray(room.events) ? room.events : [];
    if (events.length === 0) {
      el['log-list'].innerHTML = '<li class="log-empty">暂无记录</li>';
      return;
    }
    el['log-list'].innerHTML = events.map((event) => {
      const time = new Date(event.at || Date.now()).toLocaleTimeString('zh-CN', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      return `<li class="log-item ${esc(event.type)}"><time>${time}</time><span>${esc(event.text)}</span></li>`;
    }).join('');
    el['log-list'].scrollTop = el['log-list'].scrollHeight;
  }

  /* ---------------- Toasts / misc ---------------- */

  function showToast(message, type = '', timeout = 3200) {
    if (!message) return;
    while (el['toast-layer'].children.length >= 4) {
      el['toast-layer'].firstElementChild.remove();
    }
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    el['toast-layer'].appendChild(toast);
    setTimeout(() => {
      toast.classList.add('out');
      setTimeout(() => toast.remove(), 240);
    }, timeout);
  }

  function showReconnect(text) {
    el['reconnect-overlay'].hidden = false;
    el['reconnect-text'].textContent = text || '正在连接牌桌…';
  }

  function hideReconnect() {
    el['reconnect-overlay'].hidden = true;
  }

  function cancelReconnect() {
    clearTimeout(app.reconnectTimer);
    app.reconnectTimer = null;
    app.reconnectingSession = false;
    app.intentionalLeave = false;
    if (app.connected) send({ type: 'leave' });
    clearSession();
    app.room = null;
    app.gameKey = null;
    app.selected.clear();
    app.tributeSelection.clear();
    app.tributeKey = null;
    app.handSignature = '';
    app.pending = false;
    clearIdentityAlerts();
    hideReconnect();
    setUrlRoom(null);
    closeModal('result');
    closeLog();
    showScreen('landing');
    if (app.ws) {
      try {
        app.ws.close();
      } catch {
        // ignore
      }
    }
    setFormBusy(false);
    setTimeout(connect, 200);
  }

  function inviteLink(code) {
    const url = new URL(location.href);
    url.search = '';
    url.searchParams.set('room', code);
    url.hash = '';
    return url.toString();
  }

  function setUrlRoom(code) {
    try {
      const url = new URL(location.href);
      if (code) url.searchParams.set('room', code);
      else url.searchParams.delete('room');
      history.replaceState({}, '', url);
    } catch {
      // ignore
    }
  }

  async function copyText(text, successMessage) {
    try {
      await navigator.clipboard.writeText(text);
      showToast(successMessage || '已复制', 'gold');
    } catch {
      try {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        area.remove();
        showToast(successMessage || '已复制', 'gold');
      } catch {
        showToast('复制失败啦，手动抄一下吧！', 'error');
      }
    }
  }

  function init() {
    cacheElements();
    bindEvents();
    updateSoundUi();
    updateFullscreenUi();
    updateStageScale();

    el['name-input'].value = app.name;
    const params = new URLSearchParams(location.search);
    const roomFromUrl = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (roomFromUrl) {
      el['room-code-input'].value = roomFromUrl;
      if (!app.name) setTimeout(() => el['name-input'].focus(), 200);
    } else if (!app.name) {
      setTimeout(() => el['name-input'].focus(), 200);
    }

    updateConnectionUi('connecting');
    if (app.session) {
      showReconnect('正在恢复你的牌桌…');
    }
    connect();
  }

  init();
})();
