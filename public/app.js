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
  const BGM_KEY = 'a3.bgm';
  const SFX_KEY = 'a3.sfx';
  const THEME_KEY = 'a3.dark';
  const VOLUME_KEY = 'a3.volume';
  const AVATAR_KEY = 'a3.avatar';
  // 客户端压缩目标:文件 ≤2MB,输出 dataUrl 估算 ≤100KB(服务端上限 140KB)。
  const AVATAR_MAX_INPUT_BYTES = 2 * 1024 * 1024;
  const AVATAR_TARGET_BYTES = 100 * 1024;
  const AVATAR_MAX_DATA_URL_LENGTH = 140 * 1024;
  const AVATAR_OUTPUT_SIZES = [512, 384, 256, 192, 128];
  const AVATAR_QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5];
  // 表情互动:通用 emoji 面板 + 菜篮子定向送花/砸蛋;发送后 3s 动画锁,与服务端冷却一致。
  const EMOTE_LOCK_MS = 3000;
  const EMOJI_LIST = [
    '😀', '😄', '😁', '😂', '🤣', '😊',
    '😍', '😘', '😎', '🤔', '😅', '😭',
    '😡', '👍', '👎', '👏', '🙏', '💪',
    '🎉', '❤️', '🔥', '🍀', '🌹', '🥚',
  ];
  const GIFT_ICONS = { flower: '🌹', egg: '🥚' };
  const GIFT_LANDING_ICONS = { flower: '💐', egg: '💥' };

  const IDENTITY_EMBLEM_LANDLORD = `<svg viewBox="0 0 128 128" aria-hidden="true"><path fill="currentColor" d="M19 77c1-28 19-46 45-46s44 18 45 46H19zm-7 0h104c3 0 5 2 5 5v9c0 4-3 7-7 7H14c-4 0-7-3-7-7v-9c0-3 2-5 5-5z"/><circle cx="64" cy="26" r="4.5"/><path d="M52 92h24v4H52z"/></svg>`;
  const IDENTITY_EMBLEM_FARMER = `<svg viewBox="0 0 128 128" aria-hidden="true"><mask id="a3-tractor-cut"><rect width="128" height="128" fill="#fff"/><circle cx="42" cy="91" r="14" fill="#000"/><circle cx="102" cy="96" r="9" fill="#000"/></mask><g fill="currentColor" mask="url(#a3-tractor-cut)"><path d="M20 58h79a6 6 0 0 1 6 6v25H20z"/><path d="M27 58V31h39l9 27z"/><path d="M20 58l-9 10h15z"/><rect x="92" y="33" width="8" height="44" rx="4" transform="rotate(12 96 55)"/><circle cx="42" cy="91" r="26"/><circle cx="102" cy="96" r="19"/></g></svg>`;

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
  const savedVolume = loadJson(VOLUME_KEY) || {};
  const volumeValue = (key) => {
    const value = Number(savedVolume[key]);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 100;
  };
  const app = {
    ws: null,
    connected: false,
    connecting: false,
    session: savedSession,
    room: null,
    playerId: null,
    name: localStorage.getItem(NAME_KEY) || savedSession?.name || '',
    avatar: localStorage.getItem(AVATAR_KEY) || '',
    avatarCache: new Map(),
    avatarStyleSignature: '',
    lastSentAvatar: null,
    emoteLockUntil: 0,
    emoteLockTimer: null,
    giftTargetSeat: null,
    selected: new Set(),
    handSignature: '',
    pending: false,
    pendingTimer: null,
    gameKey: null,
    lastEventId: 0,
    prevTurnSeat: null,
    resultKey: null,
    resultPendingKey: null,
    resultPollTimer: null,
    serverOffset: 0,
    sound: localStorage.getItem(SOUND_KEY) !== 'off',
    bgmSound: localStorage.getItem(BGM_KEY) !== 'off',
    sfxSound: localStorage.getItem(SFX_KEY) !== 'off',
    darkMode: localStorage.getItem(THEME_KEY) === 'on',
    masterVolume: volumeValue('master'),
    bgmVolume: volumeValue('bgm'),
    sfxVolume: volumeValue('sfx'),
    audioCtx: null,
    offlineCtx: null,
    sfxRaw: new Map(),
    sfxBuffers: new Map(),
    sfxLoading: new Set(),
    bgmBlobUrls: new Map(),
    bgmFetching: new Set(),
    reconnectTimer: null,
    reconnectAttempts: 0,
    reconnectingSession: false,
    intentionalLeave: false,
    identityQueue: [],
    identityShowing: false,
    identityTimer: null,
    identityCountdownTimer: null,
    playFxActive: false,
    playFxQueue: [],
    playFxTimer: null,
    dealActive: false,
    dealKey: null,
    dealCounts: [0, 0, 0, 0],
    dealTimers: [],
    tributeDealDoneKey: null,
    tributeDealRunning: false,
    tributeAutoKey: null,
    tributeAutoActive: false,
    tributeAutoTimer: null,
    tributeAutoFinishTimer: null,
    privateIdentityKey: null,
    privateIdentityTimer: null,
    identityIntroActive: false,
    reportAnnounced: new Set(),
    currentScreen: 'landing',
    inviteCode: null,
    counterCollapsed: false,
    tutorialMatchIndex: 0,
    tutorialRulesViewed: [],
    tutorialRuleLast: null,
    tutorialPhase: 'basic',
    tutorialWaiting: null,
    tutorialPendingScene: -1,
    tutorialPopupScene: -1,
    tutorialSelection: new Set(),
    tutorialGame: null,
    tutorialAutoTimer: null,
    tutorialTimerDeadline: 0,
    tutorialTimerPaused: false,
    tutorialTimerPauseLeft: 0,
    tutorialHintIndex: 0,
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
      'name-input', 'avatar-preview', 'avatar-upload-btn', 'avatar-input',
      'home-create-btn', 'home-join-btn', 'home-join-modal', 'home-join-code',
      'home-join-submit', 'home-join-close', 'home-join-error',
      'home-single-btn', 'home-tutorial-btn',
      'room-code-display', 'copy-code-btn', 'copy-link-btn',
      'room-slots', 'room-hint', 'ready-btn', 'start-btn', 'leave-room-btn',
      'tribute-toggle', 'tribute-toggle-label',
      'counter-toggle', 'counter-toggle-label', 'borrow-wind-toggle', 'borrow-wind-toggle-label',
      'turn-range', 'turn-range-label', 'tribute-range', 'tribute-range-label',
      'settings-lock-note',
      'screen-tribute', 'tribute-room-code', 'tribute-leave-btn',
      'tribute-instruction', 'tribute-timer', 'tribute-previous', 'tribute-players',
      'tribute-auto', 'tribute-auto-cards', 'tribute-auto-countdown',
      'tribute-pool', 'tribute-pool-note', 'tribute-return-pool',
      'tribute-return-note', 'tribute-selection-info', 'tribute-clear-btn',
      'tribute-confirm-btn', 'tribute-hand', 'tribute-waiting',
      'tribute-events',
      'game-room-code', 'game-phase-label', 'game-sound-dot', 'game-sound-btn', 'shared-score',
      'home-audio-btn', 'room-audio-btn',
      'home-theme-btn', 'room-theme-btn', 'game-theme-btn',
      'audio-settings-modal', 'audio-master-toggle', 'audio-bgm-toggle', 'audio-sfx-toggle',
      'audio-master-volume', 'audio-bgm-volume', 'audio-sfx-volume',
      'audio-master-volume-value', 'audio-bgm-volume-value', 'audio-sfx-volume-value',
      'audio-settings-hint',
      'game-log-btn', 'game-counter-btn', 'game-trust-btn', 'single-counter-btn',
      'single-tribute-btn', 'single-borrow-btn', 'game-fullscreen-btn', 'game-result-btn', 'game-leave-btn',
      'emote-btn', 'emote-menu', 'emote-layer', 'gift-menu',
      'landlord-strip', 'counter-panel', 'counter-chips', 'counter-collapse-btn',
      'seat-top', 'seat-left', 'seat-right', 'turn-banner', 'turn-timer',
      'center-empty', 'last-play', 'last-play-owner', 'last-play-type',
      'last-play-cards', 'pass-bubbles', 'auto-countdown', 'self-trick',
      'self-pod', 'selection-info', 'clear-btn', 'hint-btn', 'pass-btn',
      'play-btn', 'hand', 'action-hint',
      'toast-layer', 'identity-alert-layer',
      'deal-animation', 'finish-animation', 'role-claim-layer',
      'tribute-fly-layer', 'play-animation', 'private-identity',
      'orientation-guard', 'orientation-fullscreen-btn', 'orientation-copy-btn',
      'tribute-fullscreen-btn',
      'fullscreen-tip', 'fullscreen-tip-url', 'copy-fullscreen-link', 'copy-fullscreen-mobile',
      'tutorial-match', 'tutorial-match-close', 'tutorial-progress', 'tutorial-rules-btn',
      'tutorial-seats', 'tutorial-turn', 'tutorial-played', 'tutorial-scene-rule',
      'tutorial-match-hand', 'tutorial-scene-eyebrow', 'tutorial-scene-title',
      'tutorial-scene-text', 'tutorial-scene-actions', 'tutorial-rules-sheet',
      'tutorial-rules-close', 'tutorial-rule-detail', 'tutorial-rule-actions',
      'tutorial-topbar', 'tutorial-timer', 'tutorial-hint-btn', 'tutorial-skip-btn',
      'tutorial-play-btn', 'tutorial-play-actions', 'tutorial-rule-pop',
      'tutorial-result-panel', 'tutorial-result-title', 'tutorial-home-btn',
      'continue-fullscreen', 'close-fullscreen-tip',
      'rules-modal', 'result-modal', 'result-hero', 'result-kicker',
      'counter-modal', 'counter-detail', 'counter-summary',
      'result-title', 'result-reason', 'result-teams', 'result-ranking',
      'result-tribute-toggle', 'result-tribute-label',
      'result-borrow-toggle', 'result-borrow-label',
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

  function on(id, type, handler) {
    const node = el[id];
    if (!node) return null;
    node.addEventListener(type, handler);
    return node;
  }

  function bindHomeEvents() {
    on('home-create-btn', 'click', createRoom);
    on('home-single-btn', 'click', startSingle);
    on('home-tutorial-btn', 'click', openTutorialMatch);
    on('home-join-btn', 'click', () => openJoinModal());
    on('home-join-close', 'click', closeJoinModal);
    on('home-join-submit', 'click', () => joinRoom());
    on('home-join-modal', 'click', (event) => {
      if (event.target === el['home-join-modal'] || event.target.closest('.modal-backdrop')) {
        closeJoinModal();
      }
    });
    on('home-join-code', 'input', () => {
      const input = el['home-join-code'];
      if (!input) return;
      input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      setLandingError('');
    });
    on('home-join-code', 'keydown', (event) => {
      if (event.key !== 'Enter') return;
      event.preventDefault();
      joinRoom();
    });
    on('avatar-upload-btn', 'click', openAvatarPicker);
    on('avatar-preview', 'click', openAvatarPicker);
    on('avatar-input', 'change', () => {
      const input = el['avatar-input'];
      const file = input?.files && input.files[0];
      if (input) input.value = '';
      handleAvatarFile(file);
    });
  }

  function bindEvents() {
    screens.landing = el['screen-landing'];
    screens.room = el['screen-room'];
    screens.game = el['screen-game'];
    screens.tribute = el['screen-tribute'];

    bindHomeEvents();
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

    el['borrow-wind-toggle'].addEventListener('click', () => {
      if (!app.room || app.room.phase !== 'lobby' || app.pending) return;
      if (app.room.hostId !== app.room.yourId) return;
      if (!app.room.borrowWindEnabled) playSound('borrowWind');
      send({ type: 'settings', borrowWindEnabled: !app.room.borrowWindEnabled });
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
    el['tribute-fullscreen-btn'].addEventListener('click', toggleFullscreen);
    el['orientation-fullscreen-btn'].addEventListener('click', () => {
      // guard 里的“进入全屏”属于用户手势，直接尝试全屏 + 锁横屏。
      enterFullscreen();
    });
    el['orientation-copy-btn'].addEventListener('click', () => copyText(location.href, '链接已复制，粘贴到手机浏览器打开'));
    el['copy-fullscreen-link'].addEventListener('click', () => copyText(location.href, '链接已复制，粘贴到手机浏览器打开'));
    el['copy-fullscreen-mobile'].addEventListener('click', () => copyText(location.href, '链接已复制，粘贴到手机浏览器打开'));
    el['continue-fullscreen'].addEventListener('click', continueFullscreen);
    el['close-fullscreen-tip'].addEventListener('click', closeFullscreenTip);
    el['tutorial-match-close'].addEventListener('click', closeTutorialMatch);
    el['tutorial-rules-btn'].addEventListener('click', openTutorialRules);
    el['tutorial-rules-close'].addEventListener('click', closeTutorialRules);
    el['tutorial-match'].addEventListener('click', handleTutorialMatchClick);
    el['tutorial-match-hand'].addEventListener('click', handleTutorialHandClick);
    el['tutorial-play-btn'].addEventListener('click', tutorialPlaySelected);
    el['tutorial-hint-btn'].addEventListener('click', tutorialUseHint);
    el['tutorial-skip-btn'].addEventListener('click', tutorialSkipTurn);
    el['tutorial-home-btn'].addEventListener('click', tutorialBackHome);
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
      playSound('selectCard');
      updateActionArea();
    });

    el['copy-code-btn'].addEventListener('click', () => {
      if (app.room) copyText(app.room.code, '房间号已复制');
    });
    el['copy-link-btn'].addEventListener('click', () => {
      if (app.room) copyText(inviteLink(app.room.code), '邀请链接已复制');
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

    el['game-log-btn'].addEventListener('click', toggleLog);
    el['game-counter-btn'].addEventListener('click', openCounterDetail);
    el['counter-panel'].addEventListener('click', openCounterDetail);
    el['counter-collapse-btn'].addEventListener('click', (event) => {
      event.stopPropagation();
      app.counterCollapsed = !app.counterCollapsed;
      renderCounter(app.room);
    });
    el['game-trust-btn'].addEventListener('click', toggleTrust);
    el['single-counter-btn'].addEventListener('click', () => {
      if (!app.room?.singlePlayer) return;
      send({ type: 'settings', counterEnabled: !app.room.counterEnabled });
    });
    el['single-tribute-btn'].addEventListener('click', () => {
      if (!app.room?.singlePlayer) return;
      send({ type: 'settings', tributeEnabled: !app.room.tributeEnabled });
    });
    el['single-borrow-btn'].addEventListener('click', () => {
      if (!app.room?.singlePlayer) return;
      send({ type: 'settings', borrowWindEnabled: !app.room.borrowWindEnabled });
    });
    el['log-close-btn'].addEventListener('click', closeLog);
    el['game-sound-btn'].addEventListener('click', openAudioSettings);
    el['home-audio-btn'].addEventListener('click', openAudioSettings);
    el['room-audio-btn'].addEventListener('click', openAudioSettings);
    for (const [id, handler] of [
      ['home-theme-btn', toggleDarkMode],
      ['room-theme-btn', toggleDarkMode],
      ['game-theme-btn', toggleDarkMode],
    ]) {
      if (el[id]) el[id].addEventListener('click', handler);
    }
    for (const node of document.querySelectorAll('[data-close-audio-settings]')) {
      node.addEventListener('click', closeAudioSettings);
    }
    el['audio-master-toggle'].addEventListener('change', () => setMasterSound(el['audio-master-toggle'].checked));
    el['audio-bgm-toggle'].addEventListener('change', () => setBgmEnabled(el['audio-bgm-toggle'].checked));
    el['audio-sfx-toggle'].addEventListener('change', () => setSfxEnabled(el['audio-sfx-toggle'].checked));
    for (const [id, key] of [['audio-master-volume', 'master'], ['audio-bgm-volume', 'bgm'], ['audio-sfx-volume', 'sfx']]) {
      el[id].addEventListener('input', () => setVolume(key, el[id].value));
    }
    on('emote-btn', 'click', (event) => {
      event.stopPropagation();
      toggleEmoteMenu();
    });
    on('emote-menu', 'click', (event) => {
      const item = event.target.closest('[data-emoji]');
      if (!item) return;
      sendEmoji(item.dataset.emoji);
    });
    on('gift-menu', 'click', (event) => {
      const item = event.target.closest('[data-gift]');
      if (!item) return;
      sendGift(item.dataset.gift);
    });
    el['game-stage'].addEventListener('click', (event) => {
      const basket = event.target.closest('.gift-basket-btn');
      if (!basket) return;
      event.stopPropagation();
      openGiftMenu(Number(basket.dataset.seat), basket);
    });
    el['room-slots'].addEventListener('click', (event) => {
      const addAi = event.target.closest('[data-add-ai]');
      if (addAi) {
        const room = app.room;
        if (!room || room.phase !== 'lobby' || room.hostId !== room.yourId) return;
        if (app.pending) return;
        send({ type: 'add_bot' });
        return;
      }
      const kick = event.target.closest('[data-kick-player]');
      if (!kick) return;
      const room = app.room;
      if (!room || room.phase !== 'lobby' || room.hostId !== room.yourId) return;
      if (app.pending) return;
      const name = kick.dataset.kickName || '这名玩家';
      if (!window.confirm(`确定把「${name}」请出房间吗？`)) return;
      send({ type: 'kick', playerId: kick.dataset.kickPlayer });
    });
    const resultRuleSwitch = (buttonId, property) => {
      el[buttonId].addEventListener('click', () => {
        const room = app.room;
        if (!room || room.phase !== 'ended') return;
        if (!room.singlePlayer && room.hostId !== room.yourId) return;
        send({ type: 'settings', [property]: !Boolean(room[property]) });
      });
    };
    resultRuleSwitch('result-tribute-toggle', 'tributeEnabled');
    resultRuleSwitch('result-borrow-toggle', 'borrowWindEnabled');
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

    // 表情/礼物菜单：点击按钮和菜单之外的区域关闭。
    document.addEventListener('click', (event) => {
      const inEmote = event.target.closest('#emote-menu') || event.target.closest('#emote-btn');
      const inGift = event.target.closest('#gift-menu');
      const inBasket = event.target.closest('.gift-basket-btn');
      if (emoteMenuOpen() && !inEmote && !inGift && !inBasket) closeEmoteMenu();
      if (giftMenuOpen() && !inGift && !inBasket) closeGiftMenu();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (el['fullscreen-tip'] && !el['fullscreen-tip'].hidden) {
          closeFullscreenTip();
        } else if (el['audio-settings-modal'] && !el['audio-settings-modal'].hidden) {
          closeAudioSettings();
        } else if (el['home-join-modal'] && !el['home-join-modal'].hidden) {
          closeJoinModal();
        } else if (emoteMenuOpen()) {
          closeEmoteMenu();
        } else if (giftMenuOpen()) {
          closeGiftMenu();
        } else if (el['tutorial-match'] && !el['tutorial-match'].hidden) {
          if (el['tutorial-rules-sheet'] && !el['tutorial-rules-sheet'].hidden) {
            closeTutorialRules();
          } else if (el['tutorial-result-panel'] && !el['tutorial-result-panel'].hidden) {
            tutorialBackHome();
          } else if (app.tutorialWaiting === 'popup') {
            tutorialConfirmPopup();
          }
        } else if (!el['log-drawer'].hidden) {
          closeLog();
        } else if (!el['counter-modal'].hidden) {
          closeModal('counter');
        } else if (!el['rules-modal'].hidden) {
          closeModal('rules');
        }
      }
    });

    document.addEventListener('pointerdown', () => {
      ensureAudio();
      syncBgm();
    }, { once: true });
    // 首次用户手势里补一次“全屏 + 锁横屏”；失败不打扰，guard 会继续提示。
    document.addEventListener('pointerdown', (event) => {
      if (event.target instanceof Element && event.target.closest('#orientation-fullscreen-btn')) return;
      attemptLandscapeLock({ requestFullscreen: true });
    }, { once: true });
    setInterval(updateCountdown, 100);
    setInterval(updateTutorialTimerUi, 200);
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
      decodeSfx(app.audioCtx);
      return app.audioCtx;
    } catch {
      return null;
    }
  }

  const BGM_TRACKS = {
    global: '/assets/bgm/0054.mp3?v=web48',
    match: '/assets/bgm/0008.mp3?v=web90',
    report: '/assets/bgm/0129.mp3?v=web48',
    result: '/assets/bgm/0037.mp3?v=web48',
  };
  const PLAY_SFX = {
    single: 'play_single',
    pair: 'play_pair',
    trips: 'play_trips',
    straight: 'play_straight',
    flush: 'play_flush',
    full_house: 'play_full_house',
    four_with_one: 'play_four_with_one',
    straight_flush: 'play_straight_flush',
    royal_flush: 'play_royal_flush',
  };
  const SFX_IDS = [
    ...Object.values(PLAY_SFX),
    'finish_hand', 'round_win', 'round_lose', 'deck_shuffle', 'deal_card', 'select_card',
    'first_round_start', 'round_draw', 'identity_landlord',
    'tribute_start', 'tribute_pick', 'tribute_confirm', 'tribute_send',
    'tribute_receive', 'tribute_return_send', 'tribute_return_receive',
    'tribute_complete', 'tribute_timeout', 'borrow_wind_activate',
  ];
  let bgmAudio = null;
  let bgmKey = '';

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function fetchWithRetry(url, attempts = 3) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12000);
      try {
        const response = await fetch(url, { cache: 'force-cache', signal: controller.signal });
        if (!response.ok) throw new Error(String(response.status));
        return response;
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await wait(600 + attempt * 600);
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError || new Error('fetch failed');
  }

  function prefetchSfx() {
    const jobs = [];
    for (const id of SFX_IDS) {
      if (app.sfxRaw.has(id) || app.sfxBuffers.has(id) || app.sfxLoading.has(id)) continue;
      app.sfxLoading.add(id);
      jobs.push(fetchWithRetry(`/sound-assets/${id}.wav?v=20261023p0final`)
        .then((response) => response.arrayBuffer())
        .then((buffer) => {
          app.sfxRaw.set(id, buffer);
          app.sfxLoading.delete(id);
          try {
            if (!app.audioCtx && !app.offlineCtx) {
              const Ctor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
              if (Ctor) app.offlineCtx = new Ctor(1, 1, 44100);
            }
            decodeSfx(app.audioCtx || app.offlineCtx);
          } catch {}
        })
        .catch(() => { app.sfxLoading.delete(id); }));
    }
    return Promise.allSettled(jobs);
  }

  function decodeSfx(ctx) {
    if (!ctx) return;
    for (const [id, buffer] of app.sfxRaw) {
      if (app.sfxBuffers.has(id)) continue;
      ctx.decodeAudioData(buffer.slice(0)).then((decoded) => {
        app.sfxBuffers.set(id, decoded);
      }).catch(() => {});
    }
  }

  async function prefetchBgm() {
    // Keep URL changes stable while loading all four tracks in parallel.
    const jobs = ['global', 'match', 'report', 'result'].map(async (key) => {
      if (app.bgmBlobUrls.has(key) || app.bgmFetching.has(key)) return;
      const url = BGM_TRACKS[key];
      app.bgmFetching.add(key);
      try {
        const response = await fetchWithRetry(url);
        const blob = await response.blob();
        app.bgmBlobUrls.set(key, URL.createObjectURL(blob));
      } catch {}
      app.bgmFetching.delete(key);
      if (bgmWanted() === key) syncBgm();
    });
    await Promise.allSettled(jobs);
  }

  function sfxFor(kind, detail) {
    if (kind === 'play') return PLAY_SFX[detail] || 'play_single';
    const table = {
      finish: 'finish_hand',
      identityCard: 'identity_landlord',
      win: 'round_win',
      lose: 'round_lose',
      deal: 'deck_shuffle',
      dealCard: 'deal_card',
      selectCard: 'select_card',
      firstRound: 'first_round_start',
      roundDraw: 'round_draw',
      tributeStart: 'tribute_start',
      tributePick: 'tribute_pick',
      tributeConfirm: 'tribute_confirm',
      tributeSend: 'tribute_send',
      tributeReceive: 'tribute_receive',
      tributeReturnSend: 'tribute_return_send',
      tributeReturnReceive: 'tribute_return_receive',
      tributeComplete: 'tribute_complete',
      tributeTimeout: 'tribute_timeout',
      borrowWind: 'borrow_wind_activate',
    };
    return table[kind] || null;
  }

  function playSample(id, volume = 0.72) {
    if (!app.sound || !app.sfxSound || !id) return false;
    const ctx = ensureAudio();
    if (!ctx) return false;
    const buffer = app.sfxBuffers.get(id);
    if (!buffer) {
      prefetchSfx();
      return true;
    }
    try {
      const source = ctx.createBufferSource();
      const gain = ctx.createGain();
      source.buffer = buffer;
      source.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.value = Math.max(0, Math.min(1, volume * (app.masterVolume / 100) * (app.sfxVolume / 100)));
      source.start(0);
      return true;
    } catch {
      return false;
    }
  }

  function bgmWanted() {
    if (el['result-modal'] && !el['result-modal'].hidden) return 'result';
    if (app.currentScreen === 'game' || app.currentScreen === 'tribute') {
      const room = app.room;
      const lowHand = Boolean(room && Array.isArray(room.players)
        && room.players.some((player) => !player.finished
          && (Number(player.handCount) === 1 || Number(player.handCount) === 2)));
      return lowHand ? 'report' : 'match';
    }
    return 'global';
  }

  function ensureBgm() {
    if (!bgmAudio) {
      bgmAudio = new Audio();
      bgmAudio.loop = true;
      bgmAudio.volume = 0.32;
      bgmAudio.preload = 'auto';
      bgmAudio.autoplay = true;
    }
    return bgmAudio;
  }

  function syncBgm() {
    if (!app.sound || !app.bgmSound) {
      if (bgmAudio) bgmAudio.pause();
      return;
    }
    const wanted = bgmWanted();
    const track = app.bgmBlobUrls.get(wanted);
    if (!track) {
      prefetchBgm();
      return;
    }
    const player = ensureBgm();
    const bgmGain = (app.masterVolume / 100) * (app.bgmVolume / 100);
    player.volume = Math.max(0, Math.min(1, (wanted === 'result' ? 0.58 : 0.32) * bgmGain));
    const resolvedTrack = new URL(track, location.href).href;
    if (bgmKey !== wanted || player.src !== resolvedTrack) {
      bgmKey = wanted;
      player.src = track;
    }
    if (player.paused) {
      player.play().catch(() => {
        // Autoplay may stay blocked until the next pointer/touch.
      });
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
      // 整体音量提升约 4 倍（系统 15% 也要听得到），限幅 0.8 防破音。
      const level = Math.min(0.8, Math.max(0.0001, volume * 4));
      oscillator.type = type;
      oscillator.frequency.setValueAtTime(frequency, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(level, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
      oscillator.connect(gain);
      gain.connect(ctx.destination);
      oscillator.start(start);
      oscillator.stop(start + duration + 0.03);
    } catch {
      // Audio is a nicety, never let it break the game.
    }
  }

  function playSound(kind, detail = null) {
    if (!app.sound || !app.sfxSound) return;
    if (playSample(sfxFor(kind, detail))) return;
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
    } else if (kind === 'play') {
      tone(659.25, 0, 0.07, 0.018);
      tone(880, 0.06, 0.09, 0.016);
    } else if (kind === 'landlord') {
      tone(261.63, 0, 0.28, 0.035, 'triangle');
      tone(392, 0.1, 0.3, 0.03, 'triangle');
      tone(523.25, 0.2, 0.36, 0.025);
    } else if (kind === 'farmer') {
      tone(392, 0, 0.18, 0.025);
      tone(523.25, 0.1, 0.22, 0.02);
    } else if (kind === 'report') {
      tone(1046.5, 0, 0.08, 0.018);
      tone(1318.5, 0.09, 0.1, 0.016);
    } else if (kind === 'win') {
      [392, 493.88, 587.33, 783.99].forEach((frequency, index) => {
        tone(frequency, index * 0.12, 0.55, 0.03, 'triangle');
      });
    } else if (kind === 'error') {
      tone(220, 0, 0.14, 0.025, 'square');
    }
  }

  function setMasterSound(enabled) {
    app.sound = Boolean(enabled);
    localStorage.setItem(SOUND_KEY, app.sound ? 'on' : 'off');
    updateSoundUi();
    if (app.sound) {
      ensureAudio();
      syncBgm();
    } else if (bgmAudio) {
      bgmAudio.pause();
    }
  }

  function setBgmEnabled(enabled) {
    app.bgmSound = Boolean(enabled);
    localStorage.setItem(BGM_KEY, app.bgmSound ? 'on' : 'off');
    updateSoundUi();
    syncBgm();
  }

  function setSfxEnabled(enabled) {
    app.sfxSound = Boolean(enabled);
    localStorage.setItem(SFX_KEY, app.sfxSound ? 'on' : 'off');
    if (!app.sfxSound && 'speechSynthesis' in window) {
      try { window.speechSynthesis.cancel(); } catch {}
    }
    updateSoundUi();
  }

  function saveVolumes() {
    try {
      localStorage.setItem(VOLUME_KEY, JSON.stringify({
        master: app.masterVolume,
        bgm: app.bgmVolume,
        sfx: app.sfxVolume,
      }));
    } catch {}
  }

  function setVolume(kind, value) {
    const next = Math.max(0, Math.min(100, Number(value) || 0));
    if (kind === 'master') app.masterVolume = next;
    else if (kind === 'bgm') app.bgmVolume = next;
    else app.sfxVolume = next;
    saveVolumes();
    updateAudioSettingsUi();
    syncBgm();
  }

  function updateAudioSettingsUi() {
    if (!el['audio-master-toggle']) return;
    el['audio-master-toggle'].checked = app.sound;
    el['audio-master-toggle'].setAttribute('aria-checked', String(app.sound));
    el['audio-bgm-toggle'].checked = app.bgmSound;
    el['audio-bgm-toggle'].setAttribute('aria-checked', String(app.bgmSound));
    el['audio-sfx-toggle'].checked = app.sfxSound;
    el['audio-sfx-toggle'].setAttribute('aria-checked', String(app.sfxSound));
    for (const [kind, value] of [['master', app.masterVolume], ['bgm', app.bgmVolume], ['sfx', app.sfxVolume]]) {
      const range = el[`audio-${kind}-volume`];
      const output = el[`audio-${kind}-volume-value`];
      if (range) range.value = String(value);
      if (output) output.textContent = `${Math.round(value)}%`;
    }
    const hint = el['audio-settings-hint'];
    if (hint) {
      hint.textContent = !app.sound
        ? '全局声音已关闭，音乐与音效都会静音。'
        : (!app.bgmSound && !app.sfxSound)
          ? '音乐和音效当前都已关闭。'
          : '切换后立即生效，并会记住你的选择。';
    }
  }

  function openAudioSettings() {
    updateAudioSettingsUi();
    el['audio-settings-modal'].hidden = false;
    syncModalState();
    const first = el['audio-master-toggle'];
    if (first) setTimeout(() => first.focus({ preventScroll: true }), 30);
  }

  function closeAudioSettings() {
    el['audio-settings-modal'].hidden = true;
    syncModalState();
  }

  function updateSoundUi() {
    const muted = !app.sound || (!app.bgmSound && !app.sfxSound);
    for (const button of [el['game-sound-btn'], el['home-audio-btn'], el['room-audio-btn']]) {
      if (!button) continue;
      button.classList.toggle('muted', muted);
      button.title = '声音设置';
      button.setAttribute('aria-label', '声音设置');
    }
    if (el['game-sound-dot']) el['game-sound-dot'].style.display = app.sound ? '' : 'none';
    updateAudioSettingsUi();
  }

  function updateThemeUi() {
    for (const button of [el['home-theme-btn'], el['room-theme-btn'], el['game-theme-btn']]) {
      if (!button) continue;
      button.textContent = app.darkMode ? '☀' : '☾';
      button.title = app.darkMode ? '关闭暗色模式' : '开启暗色模式';
      button.setAttribute('aria-label', button.title);
      button.setAttribute('aria-pressed', String(app.darkMode));
    }
  }

  function applyTheme() {
    document.documentElement.dataset.theme = app.darkMode ? 'dark' : 'light';
    document.body.classList.toggle('theme-dark', app.darkMode);
    updateThemeUi();
  }

  function toggleDarkMode() {
    app.darkMode = !app.darkMode;
    localStorage.setItem(THEME_KEY, app.darkMode ? 'on' : 'off');
    applyTheme();
  }

  function closeLoadingScreen() {
    const screen = document.getElementById('loading-screen');
    if (!screen) return;
    screen.classList.add('is-hidden');
    setTimeout(() => { screen.hidden = true; }, 520);
    syncBgm();
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
      case 'kicked':
        handleKicked(message);
        break;
      case 'emote':
        handleEmote(message);
        break;
      default:
        break;
    }
  }

  function handleJoined(message) {
    app.intentionalLeave = false;
    app.reconnectingSession = false;
    app.pending = false;
    closeJoinModal();
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
    // 刷新/重连后把本地保存的头像重新同步给服务端(服务端按玩家保存并广播)。
    app.lastSentAvatar = null;
    if (app.avatar && send({ type: 'avatar', dataUrl: app.avatar })) {
      app.lastSentAvatar = app.avatar;
    }
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
    clearResultPending();
    clearIdentityAlerts();
    hideFxLayers();
    hideReconnect();
    resetAvatarStyles();
    closeModal('result');
    closeModal('counter');
    closeLog();
    setUrlRoom(null);
    showScreen('landing');
    if (message.reason) showToast(message.reason);
  }

  function handleKicked(message) {
    const reason = message.reason || '你被房主请出了房间。';
    // 抑制断线重连：服务端会在 kicked 之后立刻关闭连接，这里主动放弃旧会话。
    app.intentionalLeave = true;
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
    clearResultPending();
    clearIdentityAlerts();
    hideFxLayers();
    hideReconnect();
    resetAvatarStyles();
    closeModal('result');
    closeModal('counter');
    closeLog();
    setUrlRoom(null);
    showScreen('landing');
    setLandingError('');
    setFormBusy(false);
    showToast(reason, 'error', 5000);
    const socket = app.ws;
    app.ws = null;
    app.connected = false;
    app.connecting = false;
    stopPing();
    updateConnectionUi('offline');
    if (socket) {
      try {
        socket.close();
      } catch {
        // ignore
      }
    }
    setTimeout(() => {
      app.intentionalLeave = false;
      connect();
    }, 900);
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
    const errorMessage = message.message || '操作失败';
    showToast(errorMessage, 'error');
    if (el['home-join-modal'] && !el['home-join-modal'].hidden) setLandingError(errorMessage);
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
    rememberRoomAvatars(room);
    syncAvatarStyles(room);
    setUrlRoom(room.code);

    if (room.phase === 'lobby') {
      app.gameKey = null;
      app.lastEventId = 0;
      app.prevTurnSeat = null;
      app.selected.clear();
      app.handSignature = '';
      app.resultKey = null;
      clearResultPending();
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
      clearResultPending();
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

    const gameKey = `${room.code}:${room.round || 1}`;
    const isNewGame = gameKey !== app.gameKey;
    const tributeDealKey = `${room.code}:${room.round}`;
    const skipDeal = app.tributeDealDoneKey === tributeDealKey;
    if (isNewGame) {
      app.gameKey = gameKey;
      app.selected.clear();
      app.handSignature = '';
      app.resultKey = null;
      clearResultPending();
      app.prevTurnSeat = null;
      app.tributeSelection.clear();
      app.tributeKey = null;
      app.hintMoves = [];
      app.hintIndex = -1;
      app.hintKey = null;
      app.farmerClaimShown = false;
      app.privateIdentityKey = null;
      app.identityIntroActive = false;
      app.reportAnnounced.clear();
      clearIdentityAlerts();
      hideFxLayers();
      clearDealTimers();
      app.dealActive = !skipDeal;
      app.dealKey = gameKey;
      app.dealCounts = [0, 0, 0, 0];
      if (skipDeal) app.tributeDealDoneKey = null;
      el['screen-game'].classList.remove('counter-open');
      closeModal('counter');
      el['result-modal'].hidden = true;
      syncModalState();
      app.lastEventId = maxEventId(room.events);
      if ((room.round || 1) === 1) playSound('firstRound');
      if (app.currentScreen !== 'game') {
        showToast('开局啦！先手必须带 ♦4 哦！', 'gold');
      }
    } else {
      processNewEvents(room);
    }
    app.lastEventId = Math.max(app.lastEventId, maxEventId(room.events));

    renderGame(room);
    showScreen('game');
    if (isNewGame && !skipDeal) {
      playDealAnimation(room);
    } else if (isNewGame) {
      app.dealActive = false;
      app.dealCounts = [13, 13, 13, 13];
      app.identityIntroActive = true;
      updateActionArea();
      setTimeout(() => showPrivateIdentity(app.room || room), 260);
    }

    if (room.phase === 'playing' && room.turnSeat === room.youSeat &&
        app.prevTurnSeat !== room.youSeat && app.prevTurnSeat !== null) {
      playSound('turn');
    }
    app.prevTurnSeat = room.turnSeat;

    if (room.phase === 'ended' && room.result) {
      if (app.resultKey !== resultKey(room)) {
        if (hasFinishingIdentity(room)) scheduleResultOpen(room);
        else openResult(false);
      } else if (!el['result-modal'].hidden) {
        renderResultRules();
      }
    }
    syncBgm();
  }

  function clearResultPending() {
    clearTimeout(app.resultPollTimer);
    app.resultPollTimer = null;
    app.resultPendingKey = null;
  }

  function hasFinishingIdentity(room) {
    const result = room?.result;
    if (!result) return false;
    if (result.identityFinishing) return true;
    if (Array.isArray(result.identityFinishingCards) && result.identityFinishingCards.length > 0) return true;
    const events = Array.isArray(room.events) ? room.events : [];
    const skipTypes = new Set(['end', 'trick', 'pass', 'auto_pass', 'finish', 'reveal', 'start', 'tribute']);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (skipTypes.has(event.type)) continue;
      if (event.type !== 'play' && event.type !== 'auto_play') return false;
      return (event.cards || []).some((card) => isIdentityCardId(card.id));
    }
    return false;
  }

  /**
   * 最后一手含身份牌时，先让身份动画/角色揭晓队列播完再弹结算，
   * 避免结算抢先盖住身份牌现身。轮询最多 6 秒后兜底打开。
   */
  function scheduleResultOpen(room) {
    const key = resultKey(room);
    if (app.resultPendingKey === key && app.resultPollTimer) return;
    app.resultPendingKey = key;
    clearTimeout(app.resultPollTimer);
    const startedAt = Date.now();
    const attempt = () => {
      app.resultPollTimer = null;
      const current = app.room;
      if (!current || current.phase !== 'ended' || !current.result) {
        app.resultPendingKey = null;
        return;
      }
      if (resultKey(current) !== key) {
        app.resultPendingKey = null;
        return;
      }
      const identityBusy = Boolean(app.identityShowing || app.identityQueue.length);
      const roleLayer = el['role-claim-layer'];
      const roleBusy = Boolean(roleLayer && !roleLayer.hidden && roleLayer.childElementCount > 0);
      const fxBusy = Boolean(app.playFxActive || app.dealActive);
      if ((!identityBusy && !roleBusy && !fxBusy) || Date.now() - startedAt > 6000) {
        app.resultPendingKey = null;
        if (app.resultKey === key && !el['result-modal'].hidden) return;
        openResult(false);
        return;
      }
      app.resultPollTimer = setTimeout(attempt, 120);
    };
    app.resultPollTimer = setTimeout(attempt, 160);
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
      } else if (event.type === 'play' || event.type === 'auto_play') {
        queuePlayFx(event);
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
    for (const id of ['deal-animation', 'finish-animation', 'role-claim-layer', 'tribute-fly-layer', 'play-animation', 'private-identity']) {
      if (!el[id]) continue;
      el[id].hidden = true;
      el[id].innerHTML = '';
    }
    app.playFxQueue = [];
    app.playFxActive = false;
    document.body.classList.remove('play-fx-running');
    clearTimeout(app.playFxTimer);
    app.playFxTimer = null;
  }

  function playAnnouncement(event) {
    const cards = event.cards || [];
    const type = event.combo?.type;
    const label = event.combo?.label || '';
    if (cards.length === 0) return label;
    const first = cards[0];
    const suit = SUITS[first.suit]?.name || '';
    if (type === 'single') return `${suit}${first.rank}`;
    if (type === 'pair') return `对${first.rank}`;
    if (type === 'trips') return `三条${first.rank}`;
    return label;
  }

  function speakPlay(event) {
    if (!app.sound || !app.sfxSound || !('speechSynthesis' in window)) return;
    const words = playAnnouncement(event);
    if (!words) return;
    try {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(words);
      utterance.lang = 'zh-CN';
      utterance.rate = 1.08;
      utterance.pitch = 1.08;
      utterance.volume = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch {
      // 浏览器不支持语音时保留动画和文字提示。
    }
  }

  function queuePlayFx(event) {
    app.playFxQueue.push(event);
    if (!app.playFxActive) showNextPlayFx();
  }

  function showNextPlayFx() {
    if (app.playFxActive) return;
    const event = app.playFxQueue.shift();
    const layer = el['play-animation'];
    if (!event || !layer) {
      app.playFxActive = false;
      updateActionArea();
      return;
    }
    const player = playerAtSeat(event.seat);
    const cards = event.cards || [];
    const words = playAnnouncement(event);
    app.playFxActive = true;
    document.body.classList.add('play-fx-running');
    const source = event.seat === app.room?.youSeat
      ? el['self-pod']
      : document.querySelector(`.game-stage .player-pod[data-seat="${event.seat}"]`);
    const sourceRect = source?.getBoundingClientRect();
    if (sourceRect) {
      layer.style.setProperty('--fx-from-x', `${sourceRect.left + sourceRect.width / 2 - window.innerWidth / 2}px`);
      layer.style.setProperty('--fx-from-y', `${sourceRect.top + sourceRect.height / 2 - window.innerHeight / 2}px`);
    } else {
      layer.style.setProperty('--fx-from-x', '0px');
      layer.style.setProperty('--fx-from-y', '0px');
    }
    layer.hidden = false;
    layer.innerHTML = `
      <div class="play-fx">
        <div class="play-fx-cards">
          ${cards.map((card) => {
            const suit = SUITS[card.suit] || SUITS.s;
            return `<span class="play-fx-card ${suit.red ? 'red' : ''}">
              <b>${esc(card.rank)}</b><i>${suit.symbol}</i>
            </span>`;
          }).join('')}
        </div>
      </div>
    `;
    playSound('play', event.combo?.type || 'single');
    speakPlay(event);
    updateActionArea();
    clearTimeout(app.playFxTimer);
    app.playFxTimer = setTimeout(() => {
      layer.hidden = true;
      layer.innerHTML = '';
      app.playFxActive = false;
      document.body.classList.remove('play-fx-running');
      app.playFxTimer = null;
      updateActionArea();
      if (app.playFxQueue.length) showNextPlayFx();
    }, 1000);
  }

  function clearDealTimers() {
    for (const timer of app.dealTimers) clearTimeout(timer);
    app.dealTimers = [];
  }

  function dealTargetRect(seat, room) {
    const node = seat === room.youSeat
      ? el.hand
      : document.querySelector(`.game-stage .player-pod[data-seat="${seat}"]`);
    return node?.getBoundingClientRect() || null;
  }

  function flyDealCard(fromX, fromY, toRect) {
    const layer = el['deal-animation'];
    if (!layer) return;
    const node = document.createElement('span');
    node.className = 'deal-card deal-fly';
    node.innerHTML = '<i>A3</i>';
    node.style.left = `${fromX}px`;
    node.style.top = `${fromY}px`;
    layer.appendChild(node);
    const toX = toRect ? toRect.left + toRect.width / 2 : fromX;
    const toY = toRect ? toRect.top + toRect.height / 2 : fromY;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const animation = node.animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.6) rotate(-12deg)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(1) rotate(0deg)', opacity: 1, offset: 0.22 },
        { transform: `translate(calc(-50% + ${dx * 0.55}px), calc(-50% + ${dy * 0.55 - 26}px)) scale(1.04) rotate(7deg)`, opacity: 1, offset: 0.62 },
        { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(0.72) rotate(0deg)`, opacity: 0 },
      ],
      { duration: 470, easing: 'cubic-bezier(.18,.8,.28,1)', fill: 'both' },
    );
    animation.onfinish = () => node.remove();
  }

  function updateDealUi(room) {
    renderPods(room);
    renderHand(room);
  }

  function playDealAnimation(room, onDone = null) {
    const layer = el['deal-animation'];
    if (!layer || !room) {
      app.dealActive = false;
      updateActionArea();
      return;
    }
    clearDealTimers();
    app.dealActive = true;
    app.dealCounts = [0, 0, 0, 0];
    layer.hidden = false;
    layer.innerHTML = `
      <div class="deal-title">发牌中…</div>
      <div class="deal-tip">一张张发，手牌慢慢长起来</div>
    `;
    document.body.classList.add('deal-running');
    playSound('deal');
    const centerX = window.innerWidth / 2;
    const centerY = Math.max(120, window.innerHeight * 0.36);
    const order = [];
    for (let round = 0; round < 13; round += 1) {
      order.push(room.youSeat, (room.youSeat + 1) % 4, (room.youSeat + 2) % 4, (room.youSeat + 3) % 4);
    }
    const step = 30;
    order.forEach((seat, index) => {
      const timer = setTimeout(() => {
        app.dealCounts[seat] = Math.min(13, (app.dealCounts[seat] || 0) + 1);
        flyDealCard(centerX, centerY, dealTargetRect(seat, room));
        updateDealUi(room);
        if (index % 8 === 0) playSound('dealCard');
      }, index * step);
      app.dealTimers.push(timer);
    });
    const finish = setTimeout(() => {
      app.dealActive = false;
      app.dealCounts = [13, 13, 13, 13];
      document.body.classList.remove('deal-running');
      layer.hidden = true;
      layer.innerHTML = '';
      playSound('roundDraw');
      if (onDone) {
        onDone();
        return;
      }
      renderGame(app.room || room);
      app.identityIntroActive = true;
      updateActionArea();
      setTimeout(() => showPrivateIdentity(app.room || room), 220);
    }, order.length * step + 520);
    app.dealTimers.push(finish);
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
    playSound('identityCard');
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
      syncBgm();
      return;
    }
    for (const [key, screen] of Object.entries(screens)) {
      if (!screen) continue;
      screen.classList.toggle('is-active', key === name);
      screen.hidden = key !== name;
    }
    app.currentScreen = name;
    document.body.classList.toggle('in-game', name === 'game' || name === 'tribute');
    if (name !== 'game') {
      closeEmoteMenu();
      closeGiftMenu();
    }
    if (name === 'game') updateStageScale();
    if (name === 'landing' || name === 'room') closeFullscreenTip();
    if (name !== 'game') closeLog();
    if (name === 'landing') {
      document.title = 'A3 · 欢乐暗牌';
    }
    if (name === 'tribute') playSound('tributeStart');
    syncBgm();
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
    for (const id of ['home-create-btn', 'home-join-btn', 'home-single-btn', 'home-join-submit']) {
      if (el[id]) el[id].disabled = disabled;
    }
  }

  function setFormBusy(busy) {
    const disabled = busy || !app.connected;
    for (const id of ['home-create-btn', 'home-join-btn', 'home-single-btn']) {
      if (el[id]) el[id].disabled = disabled;
    }
    if (el['home-join-submit']) el['home-join-submit'].disabled = disabled;
  }

  function setLandingError(message) {
    const text = message || '';
    if (el['landing-error']) el['landing-error'].textContent = text;
    if (el['home-join-error']) el['home-join-error'].textContent = text;
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
    if (!room || !me || room.phase === 'ended') return;
    // 单人/联机一致：playing/tribute 都可以切换自己的托管。
    send({ type: 'trust', enabled: !me.autoPlay });
  }

  function openJoinModal(prefillCode) {
    const modal = el['home-join-modal'];
    if (!modal) return;
    const initial = typeof prefillCode === 'string' ? prefillCode : app.inviteCode || '';
    app.inviteCode = null;
    app.modalReturnFocus = document.activeElement;
    setLandingError('');
    modal.hidden = false;
    syncModalState();
    const input = el['home-join-code'];
    if (input) {
      input.value = initial.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
      input.focus();
      input.select?.();
    }
  }

  function closeJoinModal(preserveError = false) {
    const modal = el['home-join-modal'];
    if (!modal) return;
    const wasOpen = !modal.hidden;
    modal.hidden = true;
    if (!preserveError) setLandingError('');
    syncModalState();
    if (wasOpen && app.modalReturnFocus && typeof app.modalReturnFocus.focus === 'function') {
      try {
        app.modalReturnFocus.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }
  }

  function joinRoom(codeOverride) {
    setLandingError('');
    if (!app.connected) {
      setLandingError('还在连服务器，稍等一下下！');
      return;
    }
    const input = el['home-join-code'];
    const raw = typeof codeOverride === 'string' ? codeOverride : input ? input.value : '';
    const code = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (code.length !== 4) {
      setLandingError('房间号是 4 位哦，再检查一下！');
      if (input) {
        input.focus();
        input.select?.();
      }
      return;
    }
    if (input && input.value !== code) input.value = code;
    const name = requireName();
    if (!name) {
      if (input && input.value) app.inviteCode = input.value;
      closeJoinModal(true);
      el['name-input'].focus({ preventScroll: true });
      return;
    }
    app.intentionalLeave = false;
    app.reconnectingSession = false;
    setFormBusy(true);
    if (!send({ type: 'join', code, name })) {
      setFormBusy(false);
      setLandingError('还在连服务器，稍等一下下！');
    }
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

  function dealCountFor(seat) {
    if (!app.dealActive) return null;
    return app.dealCounts[seat] || 0;
  }

  function turnClockSeconds(room) {
    if (!room || room.phase !== 'playing' || !room.turnDeadline) return null;
    return Math.max(0, Math.round((room.turnDeadline - (Date.now() + app.serverOffset)) / 1000));
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

  function avatarKey(player) {
    if (!player) return '';
    if (player.id) return player.id;
    return player.seat === undefined ? '' : `seat:${player.seat}`;
  }

  /**
   * 头像按 player.id 缓存：服务端把 avatar 全量广播到每个 state，
   * 这里只保留当前房间里出现过的玩家，避免大图 dataUrl 无限累积。
   */
  function rememberRoomAvatars(room) {
    const keep = new Set();
    for (const player of room?.players || []) {
      const key = avatarKey(player);
      if (!key) continue;
      keep.add(key);
      if (player.avatar === null) app.avatarCache.delete(key);
      else if (typeof player.avatar === 'string') {
        if (player.avatar) app.avatarCache.set(key, player.avatar);
        else app.avatarCache.delete(key);
      }
    }
    for (const key of [...app.avatarCache.keys()]) {
      if (!keep.has(key)) app.avatarCache.delete(key);
    }
  }

  function resolveAvatar(player) {
    if (!player) return '';
    const key = avatarKey(player);
    if (player.avatar === null) {
      if (key) app.avatarCache.delete(key);
      return '';
    }
    if (typeof player.avatar === 'string') {
      if (player.avatar) {
        if (key) app.avatarCache.set(key, player.avatar);
        return player.avatar;
      }
      if (key) app.avatarCache.delete(key);
      return '';
    }
    return (key && app.avatarCache.get(key)) || '';
  }

  function avatarDomKey(player) {
    const key = avatarKey(player);
    if (!key) return '';
    return String(key).replace(/[^A-Za-z0-9_-]/g, '');
  }

  function avatarStyleElement() {
    let node = document.getElementById('avatar-sync-styles');
    if (!node) {
      node = document.createElement('style');
      node.id = 'avatar-sync-styles';
      document.head.appendChild(node);
    }
    return node;
  }

  /**
   * 把当前房间的头像按 player.id 写成 4 条以内 CSS 规则，
   * 标记里只放 data-avatar-player，避免同一张 dataUrl 在每个头像/日志行里重复内联。
   */
  function syncAvatarStyles(room) {
    const entries = [];
    for (const player of room?.players || []) {
      const domKey = avatarDomKey(player);
      const avatar = resolveAvatar(player);
      if (!domKey || !avatar) continue;
      entries.push([domKey, avatar]);
    }
    const signature = entries
      .map(([key, avatar]) => `${key}:${avatar.length}:${avatar.slice(0, 24)}:${avatar.slice(-24)}`)
      .join('|');
    if (signature === app.avatarStyleSignature) return;
    app.avatarStyleSignature = signature;
    avatarStyleElement().textContent = entries
      .map(([key, avatar]) => `[data-avatar-player="${key}"]{background-image:url("${avatar}") !important;background-size:cover !important;background-position:center !important;color:transparent !important;}`)
      .join('\n');
  }

  function resetAvatarStyles() {
    app.avatarStyleSignature = '';
    const node = document.getElementById('avatar-sync-styles');
    if (node) node.textContent = '';
  }

  function avatarAttr(player) {
    const domKey = avatarDomKey(player);
    return domKey ? ` data-avatar-player="${esc(domKey)}"` : '';
  }

  function avatarMarkup(player, className = '') {
    const name = player?.name || '玩家';
    const hue = hueFor(player?.seat ?? 0, name);
    return `<span class="${className}"${avatarAttr(player)} style="--hue:${hue}" title="${esc(name)}">${initial(name)}</span>`;
  }

  /* ---------------- Avatar upload ---------------- */

  function openAvatarPicker() {
    const input = el['avatar-input'];
    if (!input) return;
    input.value = '';
    input.click();
  }

  function dataUrlByteLength(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma < 0) return dataUrl.length;
    return Math.floor(((dataUrl.length - comma - 1) * 3) / 4);
  }

  function updateAvatarPreview() {
    const preview = el['avatar-preview'];
    if (!preview) return;
    const hasImage = Boolean(app.avatar && app.avatar.startsWith('data:image/'));
    preview.classList.toggle('has-image', hasImage);
    preview.style.backgroundImage = hasImage ? `url("${app.avatar}")` : '';
    preview.setAttribute('aria-label', hasImage ? '更换头像' : '上传头像');
    preview.title = hasImage ? '点击更换头像' : '点击上传头像';
    const button = el['avatar-upload-btn'];
    if (button) button.textContent = hasImage ? '更换头像' : '上传头像';
  }

  function sendAvatarToServer() {
    if (!app.avatar || !app.connected || !app.session || !app.room) return false;
    if (app.lastSentAvatar === app.avatar) return false;
    if (!send({ type: 'avatar', dataUrl: app.avatar })) return false;
    app.lastSentAvatar = app.avatar;
    return true;
  }

  function applyAvatar(dataUrl, sendNow = false) {
    app.avatar = dataUrl || '';
    if (app.avatar) localStorage.setItem(AVATAR_KEY, app.avatar);
    else localStorage.removeItem(AVATAR_KEY);
    updateAvatarPreview();
    if (sendNow) sendAvatarToServer();
  }

  function encodeAvatar(image) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!width || !height) throw new Error('avatar empty');
    const side = Math.min(width, height);
    const sourceX = Math.floor((width - side) / 2);
    const sourceY = Math.floor((height - side) / 2);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas.width = 0;
      canvas.height = 0;
      throw new Error('canvas unsupported');
    }
    const types = ['image/webp', 'image/jpeg'];
    let result = '';
    try {
      // 居中裁成正方形后，从大尺寸/高质量开始，逐级降尺寸与质量直到 ≤100KB。
      for (const type of types) {
        for (const size of AVATAR_OUTPUT_SIZES) {
          canvas.width = size;
          canvas.height = size;
          ctx.clearRect(0, 0, size, size);
          // JPEG 无透明通道，先铺白底避免透明 PNG 裁切后发黑。
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, size, size);
          ctx.drawImage(image, sourceX, sourceY, side, side, 0, 0, size, size);
          for (const quality of AVATAR_QUALITIES) {
            const candidate = canvas.toDataURL(type, quality);
            if (!candidate.startsWith(`data:${type}`)) break;
            if (
              candidate.length <= AVATAR_MAX_DATA_URL_LENGTH &&
              dataUrlByteLength(candidate) <= AVATAR_TARGET_BYTES
            ) {
              result = candidate;
              break;
            }
          }
          if (result) break;
        }
        if (result) break;
      }
    } finally {
      canvas.width = 0;
      canvas.height = 0;
    }
    if (!result) throw new Error('avatar too large');
    return result;
  }

  function compressAvatar(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => {
        reader.onload = null;
        reader.onerror = null;
        reject(new Error('avatar read failed'));
      };
      reader.onload = () => {
        reader.onload = null;
        reader.onerror = null;
        const raw = String(reader.result || '');
        const image = new Image();
        image.onerror = () => {
          image.onload = null;
          image.onerror = null;
          image.src = '';
          reject(new Error('avatar decode failed'));
        };
        image.onload = () => {
          image.onload = null;
          image.onerror = null;
          try {
            resolve(encodeAvatar(image));
          } catch (error) {
            reject(error);
          } finally {
            image.src = '';
          }
        };
        image.src = raw;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleAvatarFile(file) {
    if (!file) return;
    if (!file.type || !file.type.startsWith('image/')) {
      showToast('请选择图片文件哦！', 'error');
      return;
    }
    if (file.size > AVATAR_MAX_INPUT_BYTES) {
      showToast('图片不能超过 2MB，换一张小一点儿的吧！', 'error');
      return;
    }
    try {
      const dataUrl = await compressAvatar(file);
      applyAvatar(dataUrl, true);
      showToast('头像换好啦！', 'gold');
    } catch {
      showToast('这张图片处理失败，换一张试试？', 'error');
    }
  }

  /* ---------------- Emoji picker / gift baskets ---------------- */

  function emoteMenuOpen() {
    return Boolean(el['emote-menu'] && !el['emote-menu'].hidden);
  }

  function giftMenuOpen() {
    return Boolean(el['gift-menu'] && !el['gift-menu'].hidden);
  }

  function emoteSendLocked() {
    return Date.now() < app.emoteLockUntil;
  }

  function beginEmoteLock() {
    app.emoteLockUntil = Date.now() + EMOTE_LOCK_MS;
    updateEmoteControls();
    clearTimeout(app.emoteLockTimer);
    app.emoteLockTimer = setTimeout(() => {
      app.emoteLockTimer = null;
      app.emoteLockUntil = 0;
      updateEmoteControls();
    }, EMOTE_LOCK_MS + 30);
  }

  function updateEmoteControls() {
    const locked = emoteSendLocked();
    if (el['emote-menu']) {
      for (const node of el['emote-menu'].querySelectorAll('.emoji-item')) node.disabled = locked;
    }
    if (el['gift-menu']) {
      for (const node of el['gift-menu'].querySelectorAll('.gift-item')) node.disabled = locked;
    }
    for (const node of document.querySelectorAll('.gift-basket-btn')) node.disabled = locked;
    if (el['emote-btn']) {
      el['emote-btn'].classList.toggle('locked', locked);
      el['emote-btn'].title = locked ? '表情冷却中…' : '表情互动';
    }
  }

  function ensureEmojiPicker() {
    const menu = el['emote-menu'];
    if (!menu) return;
    if (menu.dataset.filled !== '1') {
      menu.innerHTML = EMOJI_LIST.map((emoji) =>
        `<button type="button" class="emoji-item" data-emoji="${esc(emoji)}" aria-label="发送表情 ${esc(emoji)}">${esc(emoji)}</button>`,
      ).join('');
      menu.dataset.filled = '1';
    }
    updateEmoteControls();
  }

  function openEmoteMenu() {
    if (!el['emote-menu']) return;
    closeGiftMenu();
    ensureEmojiPicker();
    el['emote-menu'].hidden = false;
    if (el['emote-btn']) el['emote-btn'].setAttribute('aria-expanded', 'true');
    updateEmoteControls();
  }

  function closeEmoteMenu() {
    if (!el['emote-menu'] || el['emote-menu'].hidden) return;
    el['emote-menu'].hidden = true;
    if (el['emote-btn']) el['emote-btn'].setAttribute('aria-expanded', 'false');
  }

  function toggleEmoteMenu() {
    if (emoteMenuOpen()) {
      closeEmoteMenu();
      return;
    }
    if (emoteSendLocked()) {
      showToast('表情还在播放，稍等一下下~', 'error');
      return;
    }
    openEmoteMenu();
  }

  function sendEmoji(emoji) {
    if (!emoji) return;
    if (emoteSendLocked()) {
      showToast('表情还在播放，稍等一下下~', 'error');
      return;
    }
    if (!app.room) return;
    closeEmoteMenu();
    if (!send({ type: 'emote', kind: 'emoji', emoji })) return;
    beginEmoteLock();
  }

  function openGiftMenu(seat, anchor) {
    const menu = el['gift-menu'];
    if (!menu || !Number.isInteger(seat)) return;
    const room = app.room;
    const target = playerAtSeat(seat);
    if (!room || !target || target.isYou || target.id === room.yourId) return;
    if (emoteSendLocked()) {
      showToast('表情还在播放，稍等一下下~', 'error');
      return;
    }
    closeEmoteMenu();
    app.giftTargetSeat = seat;
    menu.hidden = false;
    menu.dataset.seat = String(seat);
    const targetRect = (anchor && typeof anchor.getBoundingClientRect === 'function')
      ? anchor.getBoundingClientRect()
      : document.querySelector(`.game-stage .player-pod[data-seat="${seat}"]`)?.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    let left = 8;
    let top = 8;
    if (targetRect) {
      left = targetRect.left + targetRect.width / 2 - menuRect.width / 2;
      top = targetRect.top - menuRect.height - 10;
      // 优先放在玩家面板上方；顶部空间不足时翻到下方。
      if (top < 8) top = targetRect.bottom + 10;
    }
    left = Math.max(8, Math.min(window.innerWidth - menuRect.width - 8, left));
    top = Math.max(8, Math.min(window.innerHeight - menuRect.height - 8, top));
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.style.right = 'auto';
    updateEmoteControls();
  }

  function closeGiftMenu() {
    if (!el['gift-menu'] || el['gift-menu'].hidden) return;
    el['gift-menu'].hidden = true;
    app.giftTargetSeat = null;
    updateEmoteControls();
  }

  function sendGift(kind) {
    if (!GIFT_ICONS[kind]) return;
    if (emoteSendLocked()) {
      showToast('礼物还在飞，稍等一下下~', 'error');
      return;
    }
    const room = app.room;
    const seat = app.giftTargetSeat;
    if (!room || !Number.isInteger(seat)) {
      closeGiftMenu();
      return;
    }
    const target = playerAtSeat(seat);
    if (!target || target.id === room.yourId) {
      closeGiftMenu();
      return;
    }
    if (!['playing', 'tribute', 'ended'].includes(room.phase)) {
      showToast('现在还不能送花/砸蛋哦！', 'error');
      closeGiftMenu();
      return;
    }
    closeGiftMenu();
    if (!send({ type: 'emote', kind, targetSeat: seat })) return;
    beginEmoteLock();
  }

  function avatarAnchor(seat) {
    const room = app.room;
    if (!room || !Number.isFinite(Number(seat))) return null;
    const seatNumber = Number(seat);
    if (seatNumber === room.youSeat) {
      return document.querySelector('#self-pod .self-avatar') || el['self-pod'];
    }
    return document.querySelector(`.game-stage .player-pod[data-seat="${seatNumber}"] .pod-avatar`) ||
      document.querySelector(`.game-stage .player-pod[data-seat="${seatNumber}"]`);
  }

  function animationPoint(node) {
    const rect = node?.getBoundingClientRect?.();
    if (!rect || (rect.width === 0 && rect.height === 0)) return null;
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  /** 通用 emoji 气泡：锚定在发送者头像位置，3s 后移除；顶部空间不足时翻到下方。 */
  function showEmojiBubble(message) {
    const layer = el['emote-layer'];
    const emoji = typeof message.emoji === 'string' ? message.emoji : '';
    if (!layer || !emoji) return;
    while (layer.querySelectorAll('.emote-bubble').length >= 12) {
      layer.querySelector('.emote-bubble')?.remove();
    }
    const seat = Number(message.seat);
    const anchor = Number.isFinite(seat) ? avatarAnchor(seat) : null;
    const bubble = document.createElement('div');
    bubble.className = 'emote-bubble';
    bubble.textContent = emoji;
    layer.appendChild(bubble);
    const avatarRect = anchor?.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;
    const bubbleRect = bubble.getBoundingClientRect();
    let left = viewportW / 2;
    let top = viewportH / 2;
    let below = false;
    if (avatarRect) {
      left = avatarRect.left + avatarRect.width / 2;
      top = avatarRect.top - 6;
      if (top - bubbleRect.height - 18 < 6) {
        below = true;
        top = avatarRect.bottom + 6;
      }
    }
    const halfWidth = bubbleRect.width / 2;
    left = Math.max(halfWidth + 8, Math.min(viewportW - halfWidth - 8, left));
    if (below) {
      bubble.classList.add('below');
      top = Math.max(8, Math.min(viewportH - bubbleRect.height - 16, top));
    } else {
      top = Math.max(bubbleRect.height + 18, Math.min(viewportH - 8, top));
    }
    bubble.style.left = `${Math.round(left)}px`;
    bubble.style.top = `${Math.round(top)}px`;
    setTimeout(() => {
      bubble.classList.add('out');
      setTimeout(() => bubble.remove(), 240);
    }, 2760);
  }

  /** 送花/砸蛋：1500ms 飞行 → 1500ms 绽放/碎裂，总计 3s。 */
  function playGiftAnimation(message) {
    const layer = el['emote-layer'];
    const kind = message?.kind;
    if (!layer || !GIFT_ICONS[kind]) return;
    const senderSeat = Number(message.seat);
    const targetSeat = Number(message.targetSeat);
    const targetPoint = Number.isFinite(targetSeat) ? animationPoint(avatarAnchor(targetSeat)) : null;
    if (!targetPoint) return;
    const senderPoint = Number.isFinite(senderSeat) ? animationPoint(avatarAnchor(senderSeat)) : null;
    const start = senderPoint || {
      x: window.innerWidth / 2,
      y: window.innerHeight * 0.72,
    };
    const fly = document.createElement('div');
    fly.className = `gift-fly ${kind}`;
    fly.textContent = GIFT_ICONS[kind];
    fly.style.left = `${Math.round(start.x)}px`;
    fly.style.top = `${Math.round(start.y)}px`;
    fly.style.setProperty('--gift-dx', `${Math.round(targetPoint.x - start.x)}px`);
    fly.style.setProperty('--gift-dy', `${Math.round(targetPoint.y - start.y)}px`);
    layer.appendChild(fly);
    setTimeout(() => {
      fly.remove();
      const landing = document.createElement('div');
      landing.className = kind === 'flower' ? 'gift-bloom' : 'gift-smash';
      landing.textContent = GIFT_LANDING_ICONS[kind];
      landing.style.left = `${Math.round(targetPoint.x)}px`;
      landing.style.top = `${Math.round(targetPoint.y)}px`;
      layer.appendChild(landing);
      setTimeout(() => landing.remove(), 1500);
    }, 750);
  }

  function handleEmote(message) {
    const kind = message?.kind;
    if (kind === 'emoji') showEmojiBubble(message);
    else if (GIFT_ICONS[kind]) playGiftAnimation(message);
    // 自己的表情/礼物以服务端广播时间为准锁 3s，确保动画完整播完。
    if (message.playerId && message.playerId === app.playerId) beginEmoteLock();
  }

  function renderRoom(room) {
    el['room-code-display'].textContent = room.code;
    el['room-code-display'].setAttribute('aria-label', `房间号 ${room.code}`);
    const hostCanKick = room.hostId === room.yourId && !room.singlePlayer;
    const hostCanAddAi = room.hostId === room.yourId && !room.singlePlayer && room.phase === 'lobby';
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
            ${hostCanAddAi ? `<button type="button" class="add-ai-btn" data-add-ai="${seat}">＋ 加电脑</button>` : ''}
          </div>
        `);
        continue;
      }
      const isYou = player.id === room.yourId;
      const isHost = player.id === room.hostId;
      const canKick = hostCanKick && !isYou;
      const classes = [
        'room-slot',
        'filled',
        isYou ? 'you' : '',
        player.ready ? 'ready' : '',
        player.connected === false ? 'offline' : '',
      ].filter(Boolean).join(' ');
      const badges = [];
      if (player.isBot) badges.push('<span class="bot-badge">电脑</span>');
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
          ${canKick ? `<button type="button" class="kick-btn" data-kick-player="${esc(player.id)}" data-kick-name="${esc(player.name)}" title="请出房间" aria-label="把 ${esc(player.name)} 请出房间">×</button>` : ''}
          <div class="slot-avatar"${avatarAttr(player)} style="--hue:${hueFor(seat, player.name)}">${initial(player.name)}</div>
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
    updateBorrowWindToggle(room);
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

  function updateBorrowWindToggle(room) {
    const button = el['borrow-wind-toggle'];
    if (!button) return;
    const isHost = room.hostId === room.yourId;
    button.disabled = !isHost || room.phase !== 'lobby';
    button.classList.toggle('on', Boolean(room.borrowWindEnabled));
    button.setAttribute('aria-checked', room.borrowWindEnabled ? 'true' : 'false');
    button.title = isHost ? '点击切换借风规则' : '借风规则由房主设置';
    el['borrow-wind-toggle-label'].textContent = room.borrowWindEnabled ? '开启' : '关闭';
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

  function isTouchUi() {
    return window.matchMedia?.('(pointer: coarse)').matches || window.innerWidth < 900;
  }

  function isPortraitViewport() {
    if (window.matchMedia) {
      try {
        return window.matchMedia('(orientation: portrait)').matches;
      } catch {
        // fall through
      }
    }
    return window.innerHeight > window.innerWidth;
  }

  /**
   * 竖屏时尝试锁横屏。requestFullscreen 只能在用户手势内调用，
   * 所以初始化时只尝试 lock，首次 pointerdown 再带全屏尝试一次。
   * 成功不提示；失败保留 task-19 的 orientation guard 引导。
   */
  async function attemptLandscapeLock({ requestFullscreen = false } = {}) {
    if (!isPortraitViewport()) return false;
    const orientation = screen.orientation;
    if (!orientation || typeof orientation.lock !== 'function') return false;
    try {
      const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
      if (requestFullscreen && !fullscreenElement) {
        const target = document.documentElement;
        const request = target.requestFullscreen || target.webkitRequestFullscreen;
        if (request) await request.call(target);
      }
      await orientation.lock('landscape');
      updateFullscreenUi();
      updateStageScale();
      return true;
    } catch {
      // 浏览器不允许时静默失败，guard 提示仍然可见。
      return false;
    }
  }

  async function enterFullscreen() {
    try {
      const target = document.documentElement;
      const request = target.requestFullscreen || target.webkitRequestFullscreen;
      if (!request) {
        showToast('这个浏览器不支持全屏，试试复制链接到手机浏览器打开！', 'error');
        return false;
      }
      await request.call(target);
      if (screen.orientation?.lock) {
        try {
          await screen.orientation.lock('landscape');
        } catch {
          // 部分手机浏览器不允许锁定方向，横屏提示仍然有效。
        }
      }
    } catch {
      showToast('全屏没成功，复制链接到手机浏览器再试一次吧！', 'error');
      return false;
    }
    updateFullscreenUi();
    return true;
  }

  function openFullscreenTip() {
    if (!el['fullscreen-tip']) return;
    el['fullscreen-tip-url'].textContent = location.href;
    el['fullscreen-tip'].hidden = false;
    el['copy-fullscreen-mobile'].focus({ preventScroll: true });
  }

  function closeFullscreenTip() {
    if (el['fullscreen-tip']) el['fullscreen-tip'].hidden = true;
  }

  async function continueFullscreen() {
    closeFullscreenTip();
    await enterFullscreen();
  }

  async function toggleFullscreen() {
    const fullscreenElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (fullscreenElement) {
      try {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) await exit.call(document);
        if (screen.orientation?.unlock) screen.orientation.unlock();
      } catch {
        showToast('退出全屏失败，按 Esc 试试！', 'error');
      }
      updateFullscreenUi();
      return;
    }
    if (isTouchUi()) {
      // Real fullscreen from the tap gesture: this asks the mobile browser to
      // enter its immersive fullscreen mode and hide the address/action bars.
      const entered = await enterFullscreen();
      if (!entered) openFullscreenTip();
      return;
    }
    await enterFullscreen();
  }

  function updateFullscreenUi() {
    const active = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    if (active) closeFullscreenTip();
    for (const button of [el['tribute-fullscreen-btn']]) {
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

  function playTributeDeal(room, onDone) {
    const layer = el['deal-animation'];
    if (!layer) {
      onDone?.();
      return;
    }
    clearDealTimers();
    layer.hidden = false;
    layer.innerHTML = `
      <div class="deal-title">发下一局手牌…</div>
      <div class="deal-tip">发完牌再进入供牌</div>
      <div class="tribute-deal-grid">
        ${room.players.map((player) => `
          <div class="tribute-deal-seat" data-seat="${player.seat}" style="--hue:${hueFor(player.seat, player.name)}">
            <span class="tribute-deal-avatar">${initial(player.name)}</span>
            <b>${esc(player.name)}</b>
            <em data-deal-count="${player.seat}">0 张</em>
          </div>
        `).join('')}
      </div>
    `;
    document.body.classList.add('deal-running');
    const centerX = window.innerWidth / 2;
    const centerY = Math.max(120, window.innerHeight * 0.34);
    const order = [];
    for (let round = 0; round < 13; round += 1) {
      order.push(room.youSeat, (room.youSeat + 1) % 4, (room.youSeat + 2) % 4, (room.youSeat + 3) % 4);
    }
    const counts = [0, 0, 0, 0];
    const step = 27;
    order.forEach((seat, index) => {
      const timer = setTimeout(() => {
        counts[seat] = Math.min(13, counts[seat] + 1);
        const label = layer.querySelector(`[data-deal-count="${seat}"]`);
        if (label) label.textContent = `${counts[seat]} 张`;
        const target = layer.querySelector(`.tribute-deal-seat[data-seat="${seat}"]`)?.getBoundingClientRect();
        flyDealCard(centerX, centerY, target);
      }, index * step);
      app.dealTimers.push(timer);
    });
    const finish = setTimeout(() => {
      document.body.classList.remove('deal-running');
      layer.hidden = true;
      layer.innerHTML = '';
      onDone?.();
    }, order.length * step + 520);
    app.dealTimers.push(finish);
  }

  function tributeAutoCards(room) {
    return (room.tributeBySeat || []).flatMap((entry) =>
      (entry.cards || []).map((card) => ({ ...card, fromSeat: entry.seat, fromName: entry.name })),
    );
  }

  function startTributeAuto(room) {
    const key = `${room.code}:${room.round}`;
    if (app.tributeAutoKey === key) return;
    clearInterval(app.tributeAutoTimer);
    clearTimeout(app.tributeAutoFinishTimer);
    app.tributeAutoKey = key;
    const cards = tributeAutoCards(room);
    if (!cards.length) {
      app.tributeAutoActive = false;
      if (el['tribute-auto']) el['tribute-auto'].hidden = true;
      return;
    }
    app.tributeAutoActive = true;
    if (el['tribute-auto']) el['tribute-auto'].hidden = false;
    if (el['tribute-instruction']) el['tribute-instruction'].textContent = '自动选中供牌，1.5 秒后确认进入牌池…';
    el['tribute-auto-cards'].innerHTML = cards.map((card) => {
      const suit = SUITS[card.suit] || SUITS.s;
      return `<span class="tribute-auto-card ${suit.red ? 'red' : ''}" data-card-id="${esc(card.id)}">
        <b>${esc(card.rank)}</b><i>${suit.symbol}</i>
        <em>${esc(card.fromName || '')}</em>
      </span>`;
    }).join('');
    let remaining = 1.5;
    el['tribute-auto-countdown'].textContent = '1.5s';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearInterval(app.tributeAutoTimer);
      clearTimeout(app.tributeAutoFinishTimer);
      app.tributeAutoTimer = null;
      app.tributeAutoFinishTimer = null;
      app.tributeAutoActive = false;
      for (const [index, card] of cards.entries()) {
        const node = el['tribute-auto-cards'].querySelector(`[data-card-id="${card.id}"]`);
        flyTributeCard(card, node, el['tribute-pool'], index * 90);
      }
      setTimeout(() => {
        if (el['tribute-auto']) el['tribute-auto'].hidden = true;
        if (app.room?.phase === 'tribute') {
          el['tribute-instruction'].textContent = app.room.completed
            ? '供牌完成，马上开打！'
            : app.room.instruction || '正在准备供牌…';
          renderTributePools(app.room);
          updateTributeAction();
        }
      }, 650);
    };
    app.tributeAutoTimer = setInterval(() => {
      remaining = Math.max(0, Number((remaining - 0.1).toFixed(1)));
      el['tribute-auto-countdown'].textContent = `${remaining.toFixed(1)}s`;
      if (remaining <= 0) finish();
    }, 100);
    // Background tabs throttle repeated timers; a single deadline timeout
    // keeps the 1.5s auto-confirm bounded even when the page is not focused.
    app.tributeAutoFinishTimer = setTimeout(finish, 1550);
    renderTributePools(room);
    updateTributeAction();
  }

  function handleTributeState(room) {
    const key = `${room.code}:${room.round}:${room.previous?.winner || ''}`;
    const dealKey = `${room.code}:${room.round}`;
    if (app.tributeDealDoneKey !== dealKey) {
      if (app.tributeDealRunning) return;
      app.tributeDealRunning = true;
      // Clear the previous round's hand, then deal the new hand visibly in the
      // real hand area before switching to the tribute page.
      app.dealActive = true;
      app.dealCounts = [0, 0, 0, 0];
      app.handSignature = '';
      if (el['hand']) el['hand'].innerHTML = '';
      showScreen('game');
      renderPods(room);
      renderHand(room);
      playDealAnimation(room, () => {
        app.tributeDealDoneKey = dealKey;
        app.tributeDealRunning = false;
        handleTributeState(app.room || room);
      });
      return;
    }
    if (app.tributeKey !== key) {
      app.tributeKey = key;
      app.tributeSelection.clear();
      app.tributeHandSignature = '';
      app.tributeActionKey = null;
      app.lastTributeEventId = maxEventId(room.events);
      app.tributeAutoKey = null;
      app.tributeAutoActive = false;
      clearInterval(app.tributeAutoTimer);
      clearTimeout(app.tributeAutoFinishTimer);
      app.tributeAutoTimer = null;
      app.tributeAutoFinishTimer = null;
      if (el['tribute-auto']) el['tribute-auto'].hidden = true;
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
    startTributeAuto(room);
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
          <span class="tribute-avatar"${avatarAttr(player)}>${initial(player.name)}</span>
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

  function mergeTributePoolEntries(room, key) {
    const visible = Array.isArray(room[key]) ? room[key] : [];
    const picked = Array.isArray(room[key === 'pool' ? 'pickedPool' : 'pickedReturnPool'])
      ? room[key === 'pool' ? 'pickedPool' : 'pickedReturnPool']
      : [];
    if (picked.length === 0) return visible.map((entry) => ({ ...entry, picked: Boolean(entry.picked) }));
    const merged = [...visible, ...picked].map((entry) => ({ ...entry, picked: Boolean(entry.picked) }));
    // 被挑走的牌保留在牌池原位置，用 order 还原展示顺序。
    merged.sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0));
    return merged;
  }

  function renderTributePools(room) {
    const action = room.yourAction;
    const poolActive = !room.completed && !app.tributeAutoActive && action?.type === 'tribute_pick';
    const returnActive = !room.completed && !app.tributeAutoActive && action?.type === 'return_pick';

    if (app.tributeAutoActive) {
      el['tribute-pool'].innerHTML = '<p class="tribute-empty">自动选牌中，1.5 秒后进入牌池…</p>';
      el['tribute-return-pool'].innerHTML = '<p class="tribute-empty">还牌池准备中…</p>';
      el['tribute-pool'].classList.remove('is-active');
      el['tribute-return-pool'].classList.remove('is-active');
      el['tribute-pool-note'].textContent = '自动确认中';
      el['tribute-return-note'].textContent = '稍等一下';
      return;
    }

    const poolEntries = mergeTributePoolEntries(room, 'pool');
    const returnEntries = mergeTributePoolEntries(room, 'returnPool');
    el['tribute-pool'].innerHTML = poolEntries.length
      ? poolEntries.map((entry) => tributeCard(entry.card, 'pool', poolActive && !entry.picked, entry.fromName, entry)).join('')
      : '<p class="tribute-empty">暂无上供牌</p>';
    el['tribute-return-pool'].innerHTML = returnEntries.length
      ? returnEntries.map((entry) => tributeCard(entry.card, 'returnPool', returnActive && !entry.picked, entry.fromName, entry)).join('')
      : '<p class="tribute-empty">还没有还牌</p>';
    el['tribute-pool'].classList.toggle('is-active', poolActive);
    el['tribute-return-pool'].classList.toggle('is-active', returnActive);
    const pickedPoolCount = poolEntries.filter((entry) => entry.picked).length;
    const pickedReturnCount = returnEntries.filter((entry) => entry.picked).length;
    el['tribute-pool-note'].textContent = poolActive
      ? '点一张你想要的牌'
      : pickedPoolCount
        ? `输家供出的牌 · 已挑走 ${pickedPoolCount} 张`
        : '输家供出的牌';
    el['tribute-return-note'].textContent = returnActive
      ? '点一张你想要的牌'
      : pickedReturnCount
        ? `赢家还出的牌 · 已挑走 ${pickedReturnCount} 张`
        : '赢家还出的牌';
  }

  function tributePickedBadge(entry) {
    const seat = Number(entry.pickedBySeat);
    const picker = Number.isInteger(seat) ? playerAtSeat(seat) : null;
    const pickerName = entry.pickedByName || picker?.name || (entry.auto ? '自动选择' : '已挑走');
    const avatar = resolveAvatar(picker);
    return `<span class="tribute-card-picker" style="position:absolute;left:3px;bottom:2px;z-index:2;display:inline-flex;align-items:center;gap:4px;max-width:calc(100% - 6px);min-height:26px;padding:2px 7px 2px 2px;border-radius:999px;background:rgba(4,32,58,0.92);box-shadow:0 0 0 1px rgba(255,231,160,0.45);color:#ffe7a0;font-size:11px;font-weight:900;line-height:1.2;">
      <span style="display:grid;width:26px;height:26px;flex:0 0 auto;place-items:center;overflow:hidden;border-radius:50%;background:#0b3b63;color:#ffe7a0;font-size:11px;font-weight:900;">${avatar ? `<img src="${esc(avatar)}" alt="" style="width:100%;height:100%;object-fit:cover;">` : initial(pickerName)}</span>
      <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(pickerName)}</span>
    </span>`;
  }

  function tributeCard(card, source, clickable, fromName = '', meta = {}) {
    const suit = SUITS[card.suit] || SUITS.s;
    const selected = app.tributeSelection.has(card.id);
    const picked = Boolean(meta.picked);
    const title = picked
      ? `${fromName ? `${fromName} 的牌 · ` : ''}已被 ${meta.pickedByName || '他人'} 挑走`
      : (fromName ? `${fromName} 的牌` : suit.name + card.rank);
    // 被挑走的牌保留原位并灰化牌面；挑选者角标不受灰化滤镜影响。
    const pickedFaceStyle = picked ? 'style="filter:grayscale(1);opacity:0.5;"' : '';
    return `<button type="button"
      class="tribute-pick-card ${suit.red ? 'red' : ''} ${selected ? 'selected' : ''} ${clickable ? 'clickable' : ''} ${picked ? 'picked' : ''}"
      data-tribute-source="${source}" data-card-id="${esc(card.id)}" data-picked="${picked ? 'true' : 'false'}"
      aria-pressed="${selected ? 'true' : 'false'}"
      ${picked ? 'aria-disabled="true" style="background:#e4decf;border-color:#b8ae95;"' : ''}
      title="${esc(title)}"
      ${clickable ? '' : 'disabled'}>
      <span class="tribute-card-rank" ${pickedFaceStyle}>${esc(card.rank)}</span>
      <span class="tribute-card-suit" ${pickedFaceStyle}>${suit.symbol}</span>
      <span class="tribute-card-watermark" ${pickedFaceStyle}>${suit.symbol}</span>
      ${picked ? tributePickedBadge(meta) : fromName ? `<span class="tribute-card-from">${esc(fromName)}</span>` : ''}
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
    if (app.tributeAutoActive) return;
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
    playSound('tributePick');
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
    if (app.tributeAutoActive) {
      el['tribute-clear-btn'].hidden = true;
      el['tribute-confirm-btn'].disabled = true;
      el['tribute-confirm-btn'].textContent = '自动选牌中…';
      el['tribute-selection-info'].textContent = '正在自动选中供牌，1.5 秒后确认并进入牌池。';
      el['tribute-waiting'].hidden = true;
      return;
    }
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
    if (!room || room.phase !== 'tribute' || app.pending || !room.yourAction || app.tributeAutoActive) return;
    const action = room.yourAction;
    const cards = [...app.tributeSelection];
    if (action.type === 'return_select' && cards.length !== action.count) return;
    if (action.type !== 'return_select' && cards.length !== 1) return;

    if (action.type === 'tribute_pick') playSound('tributeConfirm');
    else if (action.type === 'return_select') playSound('tributeReturnSend');
    else if (action.type === 'return_pick') playSound('tributeReturnReceive');
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
      ? '已结束'
      : `第 ${room.round || 1} 局`;
    updateSoundUi();
    updateTrustButton(room);
    updateSingleSettings(room);
    renderSharedScore(room);
    renderLandlordStrip(room);
    renderCounter(room);
    renderPods(room);
    renderCenter(room);
    renderHand(room);
    updateActionArea();
    renderLog(room);
    announceReports(room);
  }

  function updateTrustButton(room) {
    const button = el['game-trust-btn'];
    if (!button) return;
    const me = playerAtSeat(room.youSeat);
    const activePhase = room.phase === 'playing' || room.phase === 'tribute';
    button.hidden = false;
    button.classList.toggle('on', Boolean(me?.autoPlay));
    button.textContent = me?.autoPlay ? '取消' : '托管';
    button.title = me?.autoPlay ? '取消自动出牌' : '开启自动出牌（单机/联机都可用）';
    button.disabled = !activePhase || app.pending || app.dealActive;
  }

  function updateSingleSettings(room) {
    const visible = Boolean(room.singlePlayer);
    for (const button of [el['single-counter-btn'], el['single-tribute-btn'], el['single-borrow-btn']]) {
      if (button) button.hidden = !visible;
    }
    if (!visible) return;
    el['single-counter-btn'].textContent = '记牌';
    el['single-counter-btn'].classList.toggle('on', Boolean(room.counterEnabled));
    el['single-counter-btn'].title = `记牌器：${room.counterEnabled ? '开启' : '关闭'}（点击切换）`;
    el['single-tribute-btn'].textContent = '供牌';
    el['single-tribute-btn'].classList.toggle('on', Boolean(room.tributeEnabled));
    el['single-tribute-btn'].title = `供牌规则：${room.tributeEnabled ? '开启' : '关闭'}（下一局生效）`;
    el['single-borrow-btn'].textContent = '借风';
    el['single-borrow-btn'].classList.toggle('on', Boolean(room.borrowWindEnabled));
    el['single-borrow-btn'].title = `借风规则：${room.borrowWindEnabled ? '开启' : '关闭'}（下一局生效）`;

  }

  function renderCounter(room) {
    const counts = room.cardCounter;
    const visible = Boolean(room.counterEnabled && counts);
    el['counter-panel'].hidden = !visible;
    el['game-counter-btn'].hidden = !visible;
    if (!visible) {
      el['screen-game'].classList.remove('counter-open');
      el['counter-chips'].innerHTML = '';
      if (el['counter-collapse-btn']) el['counter-collapse-btn'].hidden = true;
      return;
    }
    if (el['counter-collapse-btn']) {
      el['counter-collapse-btn'].hidden = false;
      el['counter-collapse-btn'].textContent = app.counterCollapsed ? '展开' : '收起';
      el['counter-collapse-btn'].title = app.counterCollapsed ? '展开记牌器' : '收起记牌器';
    }
    el['counter-chips'].hidden = app.counterCollapsed;
    el['counter-panel'].classList.toggle('collapsed', app.counterCollapsed);
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

  function renderSharedScore(room) {
    const node = el['shared-score'];
    if (!node) return;
    // 整桌共用一个“本局积分” S，随任意玩家出牌更新（不再累计，也不再受积分开关影响）。
    const value = Number(room.roundScore ?? room.sharedScore ?? 0);
    const label = node.querySelector('.shared-score-label');
    if (label) label.textContent = '本局积分';
    const valueNode = node.querySelector('.shared-score-value');
    if (valueNode) valueNode.textContent = String(value);
    node.hidden = false;
    node.title = `本局积分 ${value}`;
    node.setAttribute('aria-label', `本局积分 ${value}`);
  }

  function personalScoreBadge(room, player) {
    if (!room || !player) return '';
    const own = Boolean(player.isYou) || player.id === room.yourId || player.seat === room.youSeat;
    const raw = own
      ? (room.yourScore ?? room.scores?.[player.seat] ?? 0)
      : (room.scores?.[player.seat] ?? 0);
    const total = Number(raw) || 0;
    return `<span class="personal-score" title="个人累计积分 ${total}" aria-label="个人累计积分 ${total}">积分 ${total}</span>`;
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

  function playerBadges(player, skipIdentity = false, skipTrust = false) {
    const badges = [];
    if (player.isBot) badges.push('<span class="badge bot-badge">电脑</span>');
    if (player.autoPlay && !player.isBot && !skipTrust) badges.push('<span class="badge trust-badge">托管中</span>');
    if (player.connected === false) badges.push('<span class="badge offline-badge">离线</span>');
    if (player.finished) {
      badges.push(`<span class="badge finish-badge">第 ${player.place} 顺位</span>`);
    }
    if (!skipIdentity && player.landlordRevealed) {
      badges.push(`
        <span class="badge landlord-badge">${player.doubleRevealed ? '双地主' : '地主'}</span>
      `);
    } else if (!skipIdentity && player.farmerRevealed) {
      badges.push('<span class="badge farmer-badge">农民</span>');
    }
    return badges.join('');
  }

  function reportBeacon(player) {
    if (player.finished || player.handCount > 2 || player.handCount < 1) return '';
    return `<span class="report-beacon cartoon-siren" title="${player.handCount === 1 ? '报单' : '报双'}" aria-label="${player.handCount === 1 ? '报单' : '报双'}">
      <span class="siren-rays"><i></i><i></i><i></i></span>
      <span class="siren-dome"></span>
      <span class="siren-base"></span>
    </span>`;
  }

  function privateRoleMarkup(room) {
    const role = room.yourRole;
    if (!role) return '';
    const landlord = Boolean(role.isLandlord);
    return `<span class="private-role-badge ${landlord ? 'landlord' : 'farmer'}">
      <b>${landlord ? '地主' : '农民'}${role.doubleLandlord ? '（双）' : ''}</b>
    </span>`;
  }

  function speakLine(text, { rate = 1.04, pitch = 1.06 } = {}) {
    if (!app.sound || !app.sfxSound || !('speechSynthesis' in window)) return;
    try {
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      utterance.rate = rate;
      utterance.pitch = pitch;
      utterance.volume = 1.0;
      window.speechSynthesis.speak(utterance);
    } catch {
      // 没有语音能力时保留画面反馈。
    }
  }

  function announceReports(room) {
    if (app.dealActive || room.phase !== 'playing') return;
    for (const player of room.players) {
      if (player.seat === room.youSeat || player.finished) continue;
      if (player.handCount < 1 || player.handCount > 2) continue;
      const key = `${room.code}:${room.round}:${player.seat}:${player.handCount}`;
      if (app.reportAnnounced.has(key)) continue;
      app.reportAnnounced.add(key);
      playSound('report');
      speakLine(`${player.name}，我就剩${player.handCount}张牌啦`, { rate: 0.98, pitch: 0.94 });
    }
    syncBgm();
  }

  function showPrivateIdentity(room) {
    if (!room?.yourRole || room.phase !== 'playing') {
      app.identityIntroActive = false;
      updateActionArea();
      return;
    }
    const key = `${room.code}:${room.round}`;
    if (app.privateIdentityKey === key) return;
    const layer = el['private-identity'];
    if (!layer) return;
    app.privateIdentityKey = key;
    app.identityIntroActive = true;
    updateActionArea();
    const landlord = Boolean(room.yourRole.isLandlord);
    const double = Boolean(room.yourRole.doubleLandlord);
    const cards = (room.yourRole.cards || []).map((card) => {
      const suit = SUITS[card.suit] || SUITS.s;
      return `<span class="private-id-card ${suit.red ? 'red' : ''}">
        <b>${esc(card.rank)}</b><i>${suit.symbol}</i>
      </span>`;
    }).join('');
    const source = el['self-pod']?.getBoundingClientRect();
    if (source) {
      layer.style.setProperty('--id-from-x', `${source.left + source.width / 2 - window.innerWidth / 2}px`);
      layer.style.setProperty('--id-from-y', `${source.top + source.height / 2 - window.innerHeight / 2}px`);
    } else {
      layer.style.setProperty('--id-from-x', '0px');
      layer.style.setProperty('--id-from-y', '0px');
    }
    layer.hidden = false;
    layer.innerHTML = `
      <div class="private-id-card-panel ${landlord ? 'landlord' : 'farmer'}">
        <span class="private-id-emblem">${landlord ? IDENTITY_EMBLEM_LANDLORD : IDENTITY_EMBLEM_FARMER}</span>
        <h2>${landlord ? (double ? '你是双地主' : '你是地主') : '你是农民'}</h2>
        ${cards ? `<div class="private-id-cards">${cards}</div>` : '<div class="private-id-seal">农</div>'}
      </div>
    `;
    playSound('identityCard');
    speakLine(landlord ? (double ? '你是双地主' : '你是地主') : '你是农民', { rate: 0.98, pitch: landlord ? 0.92 : 1.15 });
    clearTimeout(app.privateIdentityTimer);
    app.privateIdentityTimer = setTimeout(() => {
      layer.hidden = true;
      layer.innerHTML = '';
      app.privateIdentityTimer = null;
      app.identityIntroActive = false;
      updateActionArea();
    }, 2700);
  }

  function trickPlayFor(room, seat) {
    return (room.trickPlays || []).find((entry) => entry.seat === seat) || null;
  }

  function trickMarkup(entry, small = false) {
    if (!entry) return '';
    if (entry.passed) return '<span class="trick-pass">跳过</span>';
    return `<span class="trick-cards ${small ? 'small' : ''}">${entry.cards.map((card) => {
      const suit = SUITS[card.suit] || SUITS.s;
      return `<span class="trick-card ${suit.red ? 'red' : ''}" title="${esc(suit.name + card.rank)}">
        <b>${esc(card.rank)}</b><i>${suit.symbol}</i>
      </span>`;
    }).join('')}</span>`;
  }

  function podMarkup(player, room) {
    const shownCount = dealCountFor(player.seat);
    const visibleCount = shownCount === null ? player.handCount : shownCount;
    const isTurn = room.phase === 'playing' && room.turnSeat === player.seat && !app.dealActive;
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
    const trick = trickPlayFor(room, player.seat);
    return `
      <div class="${classes}" style="--hue:${hueFor(player.seat, player.name)}" data-seat="${player.seat}">
        <div class="pod-avatar"${avatarAttr(player)}>${initial(player.name)}</div>
        <div class="pod-body">
          <div class="pod-name" title="${esc(player.name)}">${esc(player.name)}${player.isYou ? ' · 你' : ''}</div>
          <div class="pod-badges">${app.dealActive ? '' : playerBadges(player)}${app.dealActive ? '' : reportBeacon(player)}${app.dealActive ? '' : personalScoreBadge(room, player)}</div>
        </div>
        ${isTurn ? `<span class="turn-clock" title="回合剩余时间"><span class="clock-bell clock-bell-left"></span><span class="clock-bell clock-bell-right"></span><span class="clock-foot clock-foot-left"></span><span class="clock-foot clock-foot-right"></span><b>${turnClockSeconds(room)}</b></span>` : ''}
        <div class="pod-stack" aria-hidden="true">
          <span class="card-back-mini"></span><span class="card-back-mini"></span><span class="card-back-mini"></span>
          <span class="stack-count ${!player.finished && player.handCount <= 2 ? 'low' : ''}">${player.finished ? '✓' : visibleCount}</span>
        </div>
        ${app.dealActive ? '' : `<button type="button" class="gift-basket-btn" data-seat="${player.seat}" title="给 ${esc(player.name)} 送花或砸蛋" aria-label="给 ${esc(player.name)} 送花或砸蛋"${emoteSendLocked() ? ' disabled' : ''}>🧺</button>`}
      </div>
      ${trick ? `<div class="seat-play">${trickMarkup(trick)}</div>` : ''}
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
    const meShown = dealCountFor(me.seat);
    const isTurn = room.phase === 'playing' && room.turnSeat === room.youSeat && !app.dealActive;
    el['self-pod'].className = [
      'self-pod',
      isTurn ? 'turn' : '',
      me.landlordRevealed ? 'landlord' : '',
      me.farmerRevealed ? 'farmer' : '',
      me.autoPlay ? 'trusted' : '',
      me.handCount === 1 ? 'report-one' : '',
      me.handCount === 2 ? 'report-two' : '',
    ].filter(Boolean).join(' ');
    el['self-pod'].dataset.seat = String(me.seat);
    el['self-pod'].innerHTML = `
      <div class="self-avatar"${avatarAttr(me)} style="--hue:${hueFor(me.seat, me.name)}">${initial(me.name)}</div>
      <div class="self-info">
        <div class="self-name">${esc(me.name)} · 你</div>
        <div class="self-tags">${app.dealActive ? '' : playerBadges(me, true)}${app.dealActive ? '' : privateRoleMarkup(room)}${app.dealActive ? '' : personalScoreBadge(room, me)}</div>
      </div>
      ${isTurn ? `<span class="turn-clock self-turn-clock" title="回合剩余时间"><span class="clock-bell clock-bell-left"></span><span class="clock-bell clock-bell-right"></span><span class="clock-foot clock-foot-left"></span><span class="clock-foot clock-foot-right"></span><b>${turnClockSeconds(room)}</b></span>` : ''}
    `;

    const selfTrick = trickPlayFor(room, room.youSeat);
    el['self-trick'].hidden = !selfTrick;
    el['self-trick'].innerHTML = selfTrick
      ? `<span class="self-trick-label">本轮</span>${trickMarkup(selfTrick, true)}`
      : '';
  }

  function renderCenter(room) {
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

    // Keep the last play in the DOM for rule checks/tests, but the visual
    // design intentionally hides it; seat plays and the play FX carry it.
    const last = room.lastPlay;
    if (last) {
      el['last-play'].hidden = false;
      el['last-play-owner'].textContent = `${playerAtSeat(last.seat)?.name || '玩家'}${last.auto ? ' · 托管' : ''}`;
      el['last-play-type'].textContent = last.combo?.label || '牌型';
      el['last-play-cards'].innerHTML = last.cards.map((card) => tableCard(card)).join('');
    } else {
      el['last-play'].hidden = true;
      el['last-play-cards'].innerHTML = '';
    }
    el['pass-bubbles'].innerHTML = '';
    el['center-empty'].hidden = false;
    el['center-empty'].textContent = room.phase === 'ended'
      ? '本局结束'
      : room.mustIncludeDiamond4
        ? '首手必须包含 ♦4'
        : '出牌中…';

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
    const allCards = sortHand(room.hand || []);
    const visibleCount = app.dealActive ? (app.dealCounts[room.youSeat] || 0) : allCards.length;
    const cards = allCards.slice(0, visibleCount);
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

    if (room.phase !== 'playing') {
      el['selection-info'].textContent = '';
    } else if (!isYourTurn) {
      el['selection-info'].textContent = `等待${name}出牌中`;
    } else if (evaluation.reason === 'cannot-beat') {
      el['selection-info'].classList.add('invalid');
      el['selection-info'].textContent = '大不过上家';
    } else if (evaluation.reason === 'invalid-combo') {
      el['selection-info'].classList.add('invalid');
      el['selection-info'].textContent = '牌型不合法';
    } else {
      el['selection-info'].textContent = '';
    }

    const canPlay =
      room.phase === 'playing' &&
      isYourTurn &&
      evaluation.ok &&
      !app.pending &&
      !app.playFxActive &&
      !app.dealActive &&
      !app.identityIntroActive;

    el['play-btn'].disabled = !canPlay;
    el['play-btn'].textContent = app.pending ? '提交中…' : '出牌！';
    const canPass = room.phase === 'playing' && isYourTurn && Boolean(room.lastPlay) && !app.pending && !app.playFxActive && !app.dealActive && !app.identityIntroActive;
    el['pass-btn'].disabled = !canPass;
    el['pass-btn'].textContent = '过！';
    el['hint-btn'].disabled = !(room.phase === 'playing' && isYourTurn && !app.pending && !app.playFxActive && !app.dealActive && !app.identityIntroActive);

    el['action-hint'].textContent = '';

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
    const clockValue = turnRemaining === null ? null : Math.max(0, Math.round(turnRemaining));
    // 闹钟只显示秒数；最后 5s 进入 alert（3 个 1.667s 循环正好结束）。
    for (const clock of document.querySelectorAll('.turn-clock')) {
      const valueNode = clock.querySelector('b');
      if (valueNode) valueNode.textContent = clockValue === null ? '' : String(clockValue);
      clock.classList.toggle('alert', turnRemaining !== null && turnRemaining <= 5);
    }
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
    if (room?.phase === 'playing' && room.yourAutoPassAt && !room.autoAction) {
      const passRemaining = Math.max(0, (room.yourAutoPassAt - now) / 1000);
      autoNode.hidden = false;
      autoNode.classList.remove('offline');
      autoNode.textContent = passRemaining <= 0
        ? '无牌可出，正在自动跳过…'
        : `无牌可出，${passRemaining.toFixed(1)}s 后自动跳过`;
      return;
    }
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
    if (cards.length === 0) return { ok: false, reason: 'empty', message: '' };
    if (cards.length > 5) return { ok: false, reason: 'invalid-combo', message: '一次最多选 5 张啦！' };
    const combo = classifyClient(cards);
    if (!combo) {
      return {
        ok: false,
        reason: 'invalid-combo',
        message: '牌型不合法：单牌 / 对子 / 三条 / 顺子 / 同花 / 三带二 / 四带一 / 同花顺 / 皇家同花顺',
      };
    }
    if (room.mustIncludeDiamond4 && !cards.some((card) => card.id === 'd4')) {
      return { ok: false, reason: 'must-diamond4', message: '第一手得带上 ♦4 哦！' };
    }
    if (room.lastPlay) {
      const previous = classifyClient(room.lastPlay.cards);
      if (!previous || !canBeatClient(combo, previous)) {
        return {
          ok: false,
          reason: 'cannot-beat',
          message: `这手 ${combo.label} 压不过上家的 ${room.lastPlay.combo?.label || '牌型'}`,
        };
      }
    }
    return { ok: true, reason: 'ok', combo, message: '' };
  }

  /* ---------------- Actions ---------------- */

  function playSelected() {
    if (!app.room || app.pending || app.playFxActive || app.dealActive || app.identityIntroActive) return;
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
    if (!app.room || app.pending || app.playFxActive || app.dealActive || app.identityIntroActive) return;
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
    clearResultPending();
    clearIdentityAlerts();
    hideFxLayers();
    hideReconnect();
    resetAvatarStyles();
    closeModal('result');
    closeModal('rules');
    closeLog();
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
    if (!force && app.resultKey === key && !el['result-modal'].hidden) {
      renderResultRules();
      return;
    }
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

    const identityBySeat = new Map((result.identities || []).map((entry) => [entry.seat, entry]));
    const orderedEntries = [
      ...(result.rankings || []),
      ...(result.unfinished || []),
    ];
    // 结算固定 5 列：顺位 / 玩家 / 阵营身份 / 本局变化 / 当前个人积分。
    const deltas = Array.isArray(result.scoreDeltas) ? result.scoreDeltas : [];
    const totals = Array.isArray(result.scoreTotals) ? result.scoreTotals : (room.scores || []);
    el['result-teams'].innerHTML = `
      <div class="score-board">
        <div class="score-board-head">
          <span>顺位</span><span>玩家</span><span>阵营身份</span><span>本局变化</span><span>当前积分</span>
        </div>
        ${orderedEntries.map((entry) => {
          const identity = identityBySeat.get(entry.seat) || { team: entry.team, cards: [] };
          const landlord = identity.team === 'landlord';
          const player = playerAtSeat(entry.seat) || { seat: entry.seat, name: entry.name };
          const delta = Number(deltas[entry.seat] || 0);
          const total = Number(totals[entry.seat] ?? 0);
          return `<div class="score-board-row ${landlord ? 'landlord' : 'farmer'}">
            <span class="score-place">${entry.place ? String(entry.place).padStart(2, '0') : '—'}</span>
            <span class="score-name" style="display:flex;align-items:center;gap:6px;">${avatarMarkup(player, 'log-avatar')}<span>${esc(entry.name)}</span></span>
            <span class="score-identity">
              <b>${landlord ? '地主' : '农民'}</b>
              <span class="mini-identities">${(identity.cards || []).map(miniIdentity).join('')}</span>
            </span>
            <span class="score-delta ${delta > 0 ? 'positive' : delta < 0 ? 'negative' : ''}">${delta > 0 ? '+' : ''}${delta}</span>
            <span class="score-total">${total}</span>
          </div>`;
        }).join('')}
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
    renderResultRules();

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
    closeEmoteMenu();
    closeGiftMenu();
    syncModalState();
    const yourTeam = room.yourRole ? (room.yourRole.isLandlord ? 'landlord' : 'farmers') : null;
    const won = !yourTeam || !result.winner || result.winner === 'draw' || result.winner === yourTeam;
    playSound(won ? 'win' : 'lose');
    syncBgm();
  }

  function renderResultRules() {
    const room = app.room;
    if (!room) return;
    const canEdit = Boolean(room.singlePlayer) || room.hostId === room.yourId;
    // 积分规则已全局取消：结算规则面板只保留供牌、借风两项。
    const rules = [
      ['result-tribute-toggle', 'result-tribute-label', 'tributeEnabled'],
      ['result-borrow-toggle', 'result-borrow-label', 'borrowWindEnabled'],
    ];
    for (const [buttonId, labelId, key] of rules) {
      const enabled = Boolean(room[key]);
      el[buttonId].disabled = !canEdit;
      el[buttonId].classList.toggle('on', enabled);
      el[buttonId].closest('.result-rule-row')?.classList.toggle('is-on', enabled);
      el[buttonId].setAttribute('aria-checked', enabled ? 'true' : 'false');
      el[buttonId].title = canEdit ? '点击切换下一局规则' : '只有房主可以修改';
      el[labelId].textContent = enabled ? '开启' : '关闭';
    }
  }

  function teamMember(entry) {
    const identities = (entry.cards || []).map(miniIdentity).join('');
    return `<div class="team-member">
      <span>${esc(entry.name)}</span>
      <span class="mini-identities">${identities}</span>
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
    if (name === 'home-join') {
      closeJoinModal();
      return;
    }
    const modal = name === 'rules'
      ? el['rules-modal']
      : name === 'counter'
        ? el['counter-modal']
        : el['result-modal'];
    if (!modal) return;
    modal.hidden = true;
    syncModalState();
    syncBgm();
    if (app.modalReturnFocus && typeof app.modalReturnFocus.focus === 'function') {
      try {
        app.modalReturnFocus.focus({ preventScroll: true });
      } catch {
        // ignore
      }
    }
  }

  function syncModalState() {
    const open = Boolean(
      (el['rules-modal'] && !el['rules-modal'].hidden) ||
      (el['result-modal'] && !el['result-modal'].hidden) ||
      (el['counter-modal'] && !el['counter-modal'].hidden) ||
      (el['home-join-modal'] && !el['home-join-modal'].hidden) ||
      (el['audio-settings-modal'] && !el['audio-settings-modal'].hidden),
    );
    document.body.classList.toggle('modal-open', open);
  }

  /* ---------------- Identity alert ---------------- */

  function queueIdentityAlert(event) {
    app.identityQueue.push(event);
    if (!app.identityShowing) showNextIdentityAlert();
  }

  function clearIdentityAlerts() {
    clearTimeout(app.identityTimer);
    clearInterval(app.identityCountdownTimer);
    app.identityTimer = null;
    app.identityCountdownTimer = null;
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
      <h2>${double ? '双地主闪亮登场！' : '身份牌现身！'}</h2>
      <p><b>${esc(name)}</b> 打出了身份牌，地主身份藏不住啦！</p>
      <div class="identity-showcase">
        ${shownCards.map((card) => {
          const suit = SUITS[card.suit] || SUITS.s;
          return `<div class="identity-card-large ${suit.red ? 'red' : ''}">${esc(card.rank)}<span>${suit.symbol}</span></div>`;
        }).join('')}
      </div>
      <button type="button" class="identity-dismiss">知道啦</button>
    `;
    el['identity-alert-layer'].appendChild(alert);
    const identityTarget = document.querySelector(
      event.seat === app.room?.youSeat
        ? '.game-stage .self-pod'
        : `.game-stage .player-pod[data-seat="${event.seat}"]`,
    );
    const identityTargetRect = identityTarget?.getBoundingClientRect();
    if (identityTargetRect) {
      const alertRect = alert.getBoundingClientRect();
      alert.style.setProperty(
        '--id-from-x',
        `${identityTargetRect.left + identityTargetRect.width / 2 - (alertRect.left + alertRect.width / 2)}px`,
      );
      alert.style.setProperty(
        '--id-from-y',
        `${identityTargetRect.top + identityTargetRect.height / 2 - (alertRect.top + alertRect.height / 2)}px`,
      );
      alert.classList.add('identity-from-seat');
    }

    const flash = document.createElement('div');
    flash.className = 'identity-flash';
    document.body.appendChild(flash);
    setTimeout(() => flash.remove(), 700);

    let closed = false;
    const close = (shrink = false) => {
      if (closed) return;
      closed = true;
      clearTimeout(app.identityTimer);
      clearInterval(app.identityCountdownTimer);
      app.identityTimer = null;
      app.identityCountdownTimer = null;

      const finish = () => {
        alert.remove();
        app.identityShowing = false;
        showNextIdentityAlert();
      };

      if (!shrink || !alert.animate) {
        alert.classList.add('out');
        setTimeout(finish, 260);
        return;
      }

      const self = event.seat === app.room?.youSeat;
      const target = document.querySelector(
        self ? '.game-stage .self-pod' : `.game-stage .player-pod[data-seat="${event.seat}"]`,
      );
      const alertRect = alert.getBoundingClientRect();
      const targetRect = target?.getBoundingClientRect();
      let dx = 0;
      let dy = 0;
      if (targetRect) {
        dx = targetRect.left + targetRect.width / 2 - (alertRect.left + alertRect.width / 2);
        dy = targetRect.top + targetRect.height / 2 - (alertRect.top + alertRect.height / 2);
      }
      alert.animate(
        [
          { transform: 'translate(0, 0) scale(1)', opacity: 1 },
          { transform: `translate(${dx * 0.55}px, ${dy * 0.55}px) scale(0.48)`, opacity: 0.85, offset: 0.62 },
          { transform: `translate(${dx}px, ${dy}px) scale(0.06)`, opacity: 0 },
        ],
        { duration: 520, easing: 'cubic-bezier(.55,.06,.9,.3)', fill: 'forwards' },
      );
      setTimeout(finish, 520);
    };

    alert.querySelector('.identity-dismiss').addEventListener('click', () => close(true));

    let remaining = 1.5;
    const counter = alert.querySelector('.identity-countdown');
    app.identityCountdownTimer = setInterval(() => {
      remaining = Math.max(0, Number((remaining - 0.1).toFixed(1)));
      if (counter) counter.textContent = `${remaining.toFixed(1)}s`;
      if (remaining <= 0) {
        clearInterval(app.identityCountdownTimer);
        app.identityCountdownTimer = null;
        close(true);
      }
    }, 100);

    app.identityTimer = setTimeout(() => close(true), 1550);
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

  function logCardMarkup(card) {
    const suit = SUITS[card.suit] || SUITS.s;
    return `<span class="mini-identity log-card ${suit.red ? 'red' : ''}" title="${esc(suit.name + card.rank)}">
      <b>${esc(card.rank)}</b><span>${suit.symbol}</span>
    </span>`;
  }

  /**
   * 对局记录只保留“谁出了什么牌”：头像 + 牌面，无文字、无时间、不换行。
   */
  function renderLog(room) {
    if (!room || el['log-drawer'].hidden) return;
    const events = (Array.isArray(room.events) ? room.events : []).filter(
      (event) => event.type === 'play' || event.type === 'auto_play',
    );
    if (events.length === 0) {
      el['log-list'].innerHTML = '<li class="log-empty">暂时还没有出牌记录</li>';
      return;
    }
    el['log-list'].innerHTML = events.map((event) => {
      const player = playerAtSeat(event.seat);
      const cards = Array.isArray(event.cards) ? event.cards : [];
      return `<li class="log-item ${esc(event.type)}" data-seat="${event.seat}">
        ${avatarMarkup(player, 'log-avatar')}
        <div class="log-cards">${cards.map(logCardMarkup).join('')}</div>
      </li>`;
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
    clearResultPending();
    clearIdentityAlerts();
    hideReconnect();
    resetAvatarStyles();
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

  // 一局完整的脚本化对局：发牌 → 首手 → 牌型与身份 → 过牌收轮 →
  // 对子 / 单牌 / 三条 → 农民包揽前二。所有出牌都通过了 lib/engine 的合法性校验。
  const TUTORIAL_SEATS = [
    { name: '青禾', avatar: '青', you: true },
    { name: '小满', avatar: '小' },
    { name: '老K', avatar: '老' },
    { name: '南风', avatar: '南' },
  ];

  // 四家起手牌（与场景中的出牌完全对应，剩余张数由此推出）。
  const TUTORIAL_INITIAL_HANDS = [
    ['h10', 'hJ', 'hQ', 'hK', 'hA', 's8', 's9', 's10', 'sQ', 'sK', 'd6', 'c6', 'd9'],
    ['d5', 'h5', 's5', 'sA', 'dA', 'd8', 'h8', 'dK', 'c4', 'h4', 's4', 'h9', 'd10'],
    ['d2', 'c2', 'h2', 's2', 's3', 'dJ', 'sJ', 'h6', 'dQ', 'cA', 'd3', 'c3', 'h3'],
    ['d4', 'c5', 's6', 'd7', 'c8', 'c9', 'c10', 'cJ', 'cQ', 'cK', 'c7', 'h7', 's7'],
  ];

  // 基础规则学完后（场景下标）显示「可选规则」，继续时进入自由对局阶段。
  const TUTORIAL_RULES_GATE = 9;
  const TUTORIAL_RULES_CONTINUE = 10;
  const TUTORIAL_FREE_SECONDS = 20;

  // 基础阶段的关键讲解节点（在对应场景执行前弹出，不遮挡手牌/牌桌）。
  const TUTORIAL_POPUP_INFO = {
    0: {
      eyebrow: '开局 · 牌序',
      title: '每人 13 张，♦4 先出',
      text: '一副牌 52 张，四人各 13 张。你的 13 张里没有身份牌，所以你是农民。这局 ♦4 在南风 手里，南风 先出，第一手必须包含 ♦4。电脑会自动出牌；轮到你时会自动选好教程要出的牌，点「出牌」继续。',
    },
    2: {
      eyebrow: '牌型 · 同花',
      title: '同花压顺子，花色怎么比？',
      text: '五张同花色是同花，等级高于顺子。同花之间先比花色（♠ > ♥ > ♣ > ♦），同花色再按点数从高到低；单牌、对子同点数也要比花色，三条及以上只比核心点数。你的手牌已经自动选好这 5 张黑桃，点「出牌」压过顺子。',
    },
    4: {
      eyebrow: '身份 · 第二张身份牌',
      title: '♠3 要现身了',
      text: '现在只亮了一张身份牌 ♠A：小满 是地主。老K 接下来会打出 ♠3，第二张身份牌一亮，两名地主就锁定为 小满 和 老K；你和 南风 是农民队友，目标变成两人包揽前二。',
    },
    5: {
      eyebrow: '阵营 · 队友配合',
      title: '身份全明，农民联手',
      text: '两张身份牌都公开：小满、老K 是地主，你、南风 是农民。地主先出完或双地主进前二才赢，农民两人包揽前二就赢。南风 用同花顺压过四带一，替农民抢回牌权。',
    },
    6: {
      eyebrow: '牌型 · 皇家同花顺',
      title: '皇家同花顺，最大牌型',
      text: '10-J-Q-K-A 同花色是皇家同花顺，没有牌型能压过它。手牌已经自动选好这 5 张红桃，点「出牌」打出，牌权就回到你手里。',
    },
    7: {
      eyebrow: '轮次 · 跟牌与过牌',
      title: '压不过就「过」',
      text: '跟牌要么同类型更大（单牌跟单牌、对子跟对子），要么按牌型等级更高；压不过或想留牌都可以过。小满 没有比皇家同花顺更大的牌，会点「过」。',
    },
    8: {
      eyebrow: '轮次 · 收轮',
      title: '三家都过，你收轮',
      text: '其余在场玩家全部过牌后，最后出牌的玩家收下这一轮，重新领出时可以换任意牌型。',
    },
  };

  // 自由对局阶段的“标准牌序”：与 21 步场景一致。
  // 电脑优先按这份脚本走；玩家按标准牌序出牌时整局演示与场景数据完全一致。
  const TUTORIAL_FREE_SCRIPT = [
    { type: 'play', seat: 1, cards: ['d8', 'h8'] },
    { type: 'play', seat: 2, cards: ['dJ', 'sJ'] },
    { type: 'pass', seat: 3 },
    { type: 'pass', seat: 1 },
    { type: 'play', seat: 2, cards: ['h6'] },
    { type: 'pass', seat: 3 },
    { type: 'play', seat: 1, cards: ['dK'] },
    { type: 'pass', seat: 2 },
    { type: 'pass', seat: 3 },
    { type: 'play', seat: 1, cards: ['c4', 'h4', 's4'] },
    { type: 'pass', seat: 2 },
    { type: 'play', seat: 3, cards: ['c7', 'h7', 's7'] },
  ];
  const TUTORIAL_GOLDEN_PLAYS = [['d6', 'c6'], ['d9']];

  const TUTORIAL_MATCH_SCENES = [
    {
      kind: 'deal',
      seat: null,
      eyebrow: '开局',
      title: '每人 13 张，♦4 先出',
      text: '一副牌 52 张，四个人各 13 张。你的 13 张里没有身份牌，所以你是农民。这局 ♦4 在南风 手里，南风 先出，且第一手必须包含 ♦4。',
      rule: '♦4 先手 · 首手必须含 ♦4 · 每人 13 张',
      turn: '准备开牌',
      played: [],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 3,
      combo: '顺子',
      eyebrow: '牌序 · 首出',
      title: '南风 首出顺子 4-8',
      text: '南风 把 ♦4 带进顺子 4-5-6-7-8，首手就合法了。顺子是五张连续点数；2 和 3 不参与顺子。不同点数只看最高牌；只有最高点数相同时，才比较最高牌的花色。',
      rule: '顺子：五张连续点数 · 2、3 不参与',
      turn: '南风 出牌',
      played: ['d4', 'c5', 's6', 'd7', 'c8'],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 0,
      combo: '同花',
      eyebrow: '牌型 · 同花',
      title: '你跟同花，压过顺子',
      text: '五张都是黑桃，这是同花。同花等级比顺子高，可以直接压。同花先比花色，同花色再按点数从高到低比较；单牌、对子同点数时也要比花色，三条及以上只比核心点数。',
      rule: '同花 > 顺子 · 同花先比花色，再比点数',
      turn: '你 出牌',
      played: ['s8', 's9', 's10', 'sQ', 'sK'],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 1,
      combo: '三带二',
      eyebrow: '牌型 · 三带二 / 身份公开',
      title: '小满 三带二，♠A 亮了',
      text: '三张 5 带一对 A 是三带二，等级比同花高。小满 打出的 ♠A 是身份牌，全场立刻知道：小满 是地主。',
      rule: '三带二：三条 + 一对 · ♠A 是身份牌',
      turn: '小满 出牌',
      played: ['d5', 'h5', 's5', 'sA', 'dA'],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 2,
      combo: '四带一',
      eyebrow: '牌型 · 四带一 / 身份公开',
      title: '四带一！老K 也亮了',
      text: '四张 2 带一张单牌，是四带一，比三带二高。老K 打出的 ♠3 是另一张身份牌：两名地主锁定为 小满 和 老K，你和 南风 是农民队友。',
      rule: '四带一：四张同点 + 一张 · 两张身份牌全亮',
      turn: '老K 出牌',
      played: ['d2', 'c2', 'h2', 's2', 's3'],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 3,
      combo: '同花顺',
      eyebrow: '牌型 · 同花顺',
      title: '南风 同花顺反压',
      text: '五张同花色且连续，是同花顺，压过四带一。两位农民已经互相确认队友，南风 这一手替农民抢回牌权。',
      rule: '同花顺：五张同花连续 · 高于四带一',
      turn: '南风 出牌',
      played: ['c9', 'c10', 'cJ', 'cQ', 'cK'],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 0,
      combo: '皇家同花顺',
      eyebrow: '牌型 · 皇家同花顺',
      title: '皇家同花顺，最高牌型',
      text: '10-J-Q-K-A 同花色就是皇家同花顺，没有牌型能压过它。你压住 南风 的同花顺，牌权回到自己手里。',
      rule: '皇家同花顺 = 最高牌型',
      turn: '你 出牌',
      played: ['h10', 'hJ', 'hQ', 'hK', 'hA'],
      passes: [],
      collect: null,
    },
    {
      kind: 'pass',
      seat: 1,
      eyebrow: '轮次 · 过牌',
      title: '压不过就「过」',
      text: '小满 没有比皇家同花顺更大的牌，选择过牌。跟牌要么同类型更大，要么等级更高；压不过、或者想留牌，都可以点「过」。',
      rule: '跟牌：同类型更大 或 更高等级 · 也可以主动过',
      turn: '小满 过牌',
      played: [],
      passes: [1],
      collect: null,
    },
    {
      kind: 'collect',
      seat: 0,
      eyebrow: '轮次 · 收轮',
      title: '三家都过，你收轮',
      text: '其余在场玩家全部过牌后，最后出牌的 你 收下这一轮，重新领出时可以换任意牌型。',
      rule: '收轮：其余在场玩家都过 → 最后出牌者重新领出',
      turn: '你 收轮领出',
      played: [],
      passes: [2, 3],
      collect: 0,
    },
    {
      kind: 'checkpoint',
      seat: null,
      eyebrow: '基础规则完成',
      title: '牌型与轮次，你已经会了',
      text: '单牌、对子同类型先比点数，点数相同再比花色；三条、三带二、四带一只比核心点数；顺子点数相同才比最高牌花色；同花先比花色再比点数；同花顺、皇家同花顺按最高牌与花色比较。现在可以继续把这局打完，或退出教程；顶栏的「可选规则」随时可以查看。',
      rule: '前两名同阵营 → 该阵营胜；否则第 3 名与第 1 名同阵营 → 其胜；否则平局。双地主进前二 → 地主胜，否则农民胜。',
      turn: '基础规则完成',
      played: [],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 0,
      combo: '对子',
      eyebrow: '牌型 · 对子',
      title: '你领出对子 6',
      text: '收轮后可以换任意牌型。你出对子 6，看看地主怎么接。对子只能对子跟，先比点数。',
      rule: '对子：先比点数，同点比对子中较大花色，再比另一张',
      turn: '你 出牌',
      played: ['d6', 'c6'],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 1,
      combo: '对子',
      eyebrow: '跟牌 · 对子',
      title: '小满 对子 8 压过',
      text: '对子只能跟对子，8 比 6 大。小满 接住这一手，双方继续加码。',
      rule: '对子：同类型、点数更大才能压',
      turn: '小满 出牌',
      played: ['d8', 'h8'],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 2,
      combo: '对子',
      eyebrow: '跟牌 · 对子',
      title: '老K 再压对子 J',
      text: '地主 老K 用对子 J 继续加码。场上没有更大的对子敢跟了，对子比的就是点数。',
      rule: '对子 J > 对子 8 > 对子 6',
      turn: '老K 出牌',
      played: ['dJ', 'sJ'],
      passes: [],
      collect: null,
    },
    {
      kind: 'collect',
      seat: 2,
      eyebrow: '轮次 · 收轮',
      title: '南风、你、小满都过',
      text: '南风 手里只剩三条，跟不了对子；你也过。三家都不要，老K 收轮重新领出。农民不必每把都抢，留住完整牌型更重要。',
      rule: '收轮：其余在场玩家都过 → 最后出牌者领出',
      turn: '老K 收轮',
      played: [],
      passes: [3, 0, 1],
      collect: 2,
    },
    {
      kind: 'play',
      seat: 2,
      combo: '单牌',
      eyebrow: '牌型 · 单牌',
      title: '老K 领出单牌 6',
      text: '老K 换成单牌 6。单牌只能单牌跟，先比点数；点数相同再比花色（黑桃 > 红心 > 梅花 > 方块）。2 和 3 是最大的点数。',
      rule: '单牌：先比点数，同点比花色',
      turn: '老K 出牌',
      played: ['h6'],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 0,
      combo: '单牌',
      eyebrow: '出完牌',
      title: '你出 9，拿到第 1 顺位',
      text: '你手里最后一张 9 压过 6，牌出完，记录为第 1 顺位。注意：出完者的最后一手仍留在桌面，其他人还能继续压。',
      rule: '出完 → 第 1 顺位 · 最后一手仍可被压',
      turn: '你 出牌 · 出完',
      played: ['d9'],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 1,
      combo: '单牌',
      eyebrow: '跟牌 · 单牌',
      title: '小满 单牌 K 压过你',
      text: '地主 小满 用 K 压过你的 9。你已经是第 1 顺位，农民离胜利只差 南风 也出完。',
      rule: '出完不结束 · 第 2 顺位决定胜负',
      turn: '小满 出牌',
      played: ['dK'],
      passes: [],
      collect: null,
    },
    {
      kind: 'collect',
      seat: 1,
      eyebrow: '轮次 · 收轮',
      title: '老K、南风都过，小满 收轮',
      text: '老K 和 南风 都过牌，小满 收轮领出。南风 手里只剩三条，等的就是这次机会。',
      rule: '收轮后可换任意牌型 · 农民只差最后一人',
      turn: '小满 收轮',
      played: [],
      passes: [2, 3],
      collect: 1,
    },
    {
      kind: 'play',
      seat: 1,
      combo: '三条',
      eyebrow: '牌型 · 三条',
      title: '小满 领出三条 4',
      text: '三张同点数是三条，比对子高。小满 想用最小的三条拖住节奏，可 南风 手里的三条更大。',
      rule: '三条：三张同点数 · 三条 > 对子',
      turn: '小满 出牌',
      played: ['c4', 'h4', 's4'],
      passes: [],
      collect: null,
    },
    {
      kind: 'play',
      seat: 3,
      combo: '三条',
      eyebrow: '出完牌 · 农民胜',
      title: '南风 出完，农民包揽前二',
      text: '老K 过牌，南风 打出三条 7，牌出完，拿到第 2 顺位。青禾 + 南风 包揽前两名，农民阵营获胜！',
      rule: '农民包揽前二 → 农民胜',
      turn: '南风 出牌 · 出完',
      played: ['c7', 'h7', 's7'],
      passes: [2],
      collect: null,
    },
    {
      kind: 'result',
      seat: null,
      eyebrow: '模拟对局结束',
      title: '结算：农民 青禾 + 南风 获胜',
      text: '第 1 顺位 青禾、第 2 顺位 南风，农民包揽前二。双地主进前二则地主胜，否则农民胜；非双地主前两名同阵营则该阵营胜，否则第 3 名与第 1 名同阵营则其胜，最后才是平局。',
      rule: '前二同阵营 → 该阵营胜 · 第 3 与第 1 同阵营 → 其胜 · 否则平局 · 双地主前二 → 地主胜',
      turn: '本局结束',
      played: [],
      passes: [],
      collect: null,
    },
  ];

  const TUTORIAL_RULE_INFO = {
    tribute: {
      title: '供牌',
      text: '上一局不是平局时，下一局发牌后先由输家进贡、赢家还牌，再开始出牌。身份牌不参与供牌，房主可在开局前开启。',
    },
    borrow: {
      title: '借风',
      text: '两张身份牌都公开后，出完牌者最后一手无人接时，改由其仍在场的队友领出；队友不在时按正常下家领出。',
    },
  };

  const TUTORIAL_RULE_KEYS = ['tribute', 'borrow'];

  function tutorialCardById(id) {
    return CARD_CATALOG.find((entry) => entry.id === id);
  }

  function tutorialCardText(id) {
    const card = tutorialCardById(id);
    if (!card) return id;
    return `${SUITS[card.suit].symbol}${card.rank}`;
  }

  function tutorialChip(text, variant = '') {
    return `<span class="tutorial-chip ${variant}">${esc(text)}</span>`;
  }

  // 从场景序列推导当前状态：各家剩余牌、出完顺序、身份公开、本轮过牌标记。
  function tutorialStateAt(index) {
    const playedBySeat = [[], [], [], []];
    const finishOrder = [];
    const revealedSeats = new Set();
    const identitySeen = new Set();
    const passes = new Set();
    for (let i = 0; i <= index; i += 1) {
      const scene = TUTORIAL_MATCH_SCENES[i];
      if (scene.seat !== null && scene.played.length) {
        for (const cardId of scene.played) {
          playedBySeat[scene.seat].push(cardId);
          if (cardId === 'sA' || cardId === 's3') {
            identitySeen.add(cardId);
            revealedSeats.add(scene.seat);
          }
        }
        if (
          playedBySeat[scene.seat].length >= TUTORIAL_INITIAL_HANDS[scene.seat].length &&
          !finishOrder.includes(scene.seat)
        ) {
          finishOrder.push(scene.seat);
        }
      }
      for (const passSeat of scene.passes) passes.add(passSeat);
      if (scene.collect !== null && i < index) passes.clear();
    }
    return {
      playedBySeat,
      finishOrder,
      revealedSeats,
      identitySeen,
      bothIdentitiesRevealed: identitySeen.has('sA') && identitySeen.has('s3'),
      passes,
    };
  }

  function tutorialRole(seat, state) {
    if (seat === 0) return 'farmer';
    if (state.revealedSeats.has(seat)) return 'landlord';
    if (state.bothIdentitiesRevealed) return 'farmer';
    return 'unknown';
  }

  function tutorialRoleLabel(seat, state) {
    const role = tutorialRole(seat, state);
    if (role === 'landlord') return '地主';
    if (role === 'farmer') return '农民';
    return '身份未知';
  }

  function tutorialSeatMarkup(seat, scene, state) {
    const meta = TUTORIAL_SEATS[seat];
    const place = state.finishOrder.indexOf(seat);
    const count = TUTORIAL_INITIAL_HANDS[seat].length - state.playedBySeat[seat].length;
    const classes = ['tutorial-seat', `role-${tutorialRole(seat, state)}`];
    if (seat === 0) classes.push('you');
    if (scene.seat === seat) classes.push('active');
    if (place >= 0) classes.push('finished');
    const flags = [];
    if (place >= 0) flags.push(`<i class="tutorial-seat-flag place">第 ${place + 1} 顺位</i>`);
    else if (state.passes.has(seat)) flags.push('<i class="tutorial-seat-flag pass">过</i>');
    const name = meta.you ? `${meta.name}（你）` : meta.name;
    return `<div class="${classes.join(' ')}">
      <span class="tutorial-seat-avatar">${esc(meta.avatar)}</span>
      <div class="tutorial-seat-copy">
        <b>${esc(name)}</b>
        <em>${esc(tutorialRoleLabel(seat, state))}<span class="tutorial-seat-count"> · 剩 ${count} 张</span></em>
      </div>
      ${flags.join('')}
    </div>`;
  }

  function tutorialRevealChips(scene, index, state) {
    const identityCards = scene.played.filter((id) => id === 'sA' || id === 's3');
    if (!identityCards.length) return '';
    const chips = identityCards.map((id) =>
      `<span class="tutorial-chip identity">身份牌 ${esc(tutorialCardText(id))} · ${esc(TUTORIAL_SEATS[scene.seat].name)} 是地主</span>`,
    );
    const seenBefore = new Set();
    for (let i = 0; i < index; i += 1) {
      for (const id of TUTORIAL_MATCH_SCENES[i].played) {
        if (id === 'sA' || id === 's3') seenBefore.add(id);
      }
    }
    if (seenBefore.size < 2 && state.identitySeen.size === 2) {
      chips.push('<span class="tutorial-chip identity">两名地主锁定 · 青禾、南风 是农民</span>');
    }
    return `<div class="tutorial-reveal-chips">${chips.join('')}</div>`;
  }

  function tutorialPlayedMarkup(scene, index, state) {
    if (scene.kind === 'result') {
      const rows = state.finishOrder.map((seat, place) =>
        `<div class="tutorial-result-row place">
          <b>第 ${place + 1} 顺位</b>
          <span>${esc(TUTORIAL_SEATS[seat].name)}${seat === 0 ? '（你）' : ''}</span>
          <em>农民 · 已出完</em>
        </div>`,
      );
      const unfinished = [1, 2].map((seat) => {
        const count = TUTORIAL_INITIAL_HANDS[seat].length - state.playedBySeat[seat].length;
        return `${TUTORIAL_SEATS[seat].name} 剩 ${count} 张`;
      }).join(' · ');
      rows.push(`<div class="tutorial-result-row">
        <b>未出完</b>
        <span>小满 / 老K</span>
        <em>地主 · ${esc(unfinished)}</em>
      </div>`);
      return `<div class="tutorial-result">
        <p class="tutorial-result-winner">农民胜 · 青禾 + 南风 包揽前二</p>
        ${rows.join('')}
      </div>`;
    }
    if (scene.kind === 'deal') {
      return `<div class="tutorial-deal-badges">
        ${tutorialChip('52 张 · 每人 13 张', 'gold')}
        ${tutorialChip('♦4 在南风手里')}
        ${tutorialChip('第一手必须包含 ♦4')}
      </div>`;
    }
    if (scene.kind === 'checkpoint') {
      const ladder = ['单牌', '对子', '三条', '顺子', '同花', '三带二', '四带一', '同花顺', '皇家同花顺'];
      return `<p class="tutorial-played-caption">牌型等级（从低到高）</p>
        <div class="tutorial-combo-ladder">${ladder
          .map((label, i) => `${i ? '<i>＜</i>' : ''}<span>${label}</span>`)
          .join('')}</div>`;
    }
    if (scene.kind === 'pass') {
      const actor = TUTORIAL_SEATS[scene.seat].name;
      return `<p class="tutorial-played-caption">${esc(actor)} 选择过牌</p>
        <div class="tutorial-pass-badge">过</div>`;
    }
    if (scene.kind === 'collect') {
      const leader = TUTORIAL_SEATS[scene.collect].name;
      return `<p class="tutorial-played-caption">三家都不要，这一轮结束</p>
        <div class="tutorial-collect-badge">${esc(leader)} 收轮，重新领出</div>`;
    }
    const actor = TUTORIAL_SEATS[scene.seat].name;
    const cards = scene.played
      .map((id) => `<span class="tutorial-played-card">${tutorialCard(tutorialCardById(id))}</span>`)
      .join('');
    const revealChips = tutorialRevealChips(scene, index, state);
    return `<p class="tutorial-played-caption">${esc(actor)} 打出 ${esc(scene.combo || '')}</p>
      <div class="tutorial-played-cards">${cards}</div>
      ${revealChips}`;
  }

  function tutorialHandMarkup(state, selection, clickable) {
    const picked = selection || new Set();
    const remaining = TUTORIAL_INITIAL_HANDS[0]
      .filter((id) => !state.playedBySeat[0].includes(id))
      .sort((a, b) => {
        const cardA = tutorialCardById(a);
        const cardB = tutorialCardById(b);
        return (
          RANK_VALUE[cardB.rank] - RANK_VALUE[cardA.rank] ||
          SUITS[cardB.suit].value - SUITS[cardA.suit].value
        );
      });
    if (!remaining.length) {
      return '<p class="tutorial-hand-empty">你的手牌已出完</p>';
    }
    return `<p class="tutorial-hand-label">你的手牌 · 剩 ${remaining.length} 张</p>
      <div class="tutorial-hand-row">${remaining
        .map((id) => tutorialCard(tutorialCardById(id), picked.has(id), clickable))
        .join('')}</div>`;
  }

  /* ---------------- tutorial · basic phase state machine ---------------- */

  function tutorialClearAutoTimer() {
    if (app.tutorialAutoTimer) {
      clearTimeout(app.tutorialAutoTimer);
      app.tutorialAutoTimer = null;
    }
  }

  function tutorialClearTimers() {
    tutorialClearAutoTimer();
    app.tutorialTimerDeadline = 0;
    app.tutorialTimerPaused = false;
    app.tutorialTimerPauseLeft = 0;
    if (el['tutorial-timer']) {
      el['tutorial-timer'].hidden = true;
      el['tutorial-timer'].classList.remove('urgent');
    }
  }

  function tutorialDelayNext(delay) {
    tutorialClearAutoTimer();
    app.tutorialAutoTimer = setTimeout(() => {
      app.tutorialAutoTimer = null;
      if (app.tutorialPhase === 'basic') tutorialNext();
    }, delay);
  }

  function hideTutorialActionRow() {
    for (const id of ['tutorial-play-btn', 'tutorial-hint-btn', 'tutorial-skip-btn']) {
      if (!el[id]) continue;
      el[id].hidden = true;
      el[id].disabled = true;
    }
    if (el['tutorial-play-actions']) el['tutorial-play-actions'].hidden = true;
  }

  function showTutorialBasicPlayButton() {
    if (!el['tutorial-play-btn']) return;
    el['tutorial-hint-btn'].hidden = true;
    el['tutorial-skip-btn'].hidden = true;
    el['tutorial-timer'].hidden = true;
    el['tutorial-play-btn'].hidden = false;
    el['tutorial-play-btn'].disabled = false;
    el['tutorial-play-btn'].textContent = '出牌';
    el['tutorial-play-actions'].hidden = false;
  }

  function hideTutorialPopup() {
    if (el['tutorial-rule-pop']) el['tutorial-rule-pop'].hidden = true;
    if (el['tutorial-scene-actions']) el['tutorial-scene-actions'].innerHTML = '';
  }

  function tutorialShowPopup(index) {
    const info = TUTORIAL_POPUP_INFO[index];
    if (!info) {
      tutorialPerformScene(index);
      return;
    }
    app.tutorialWaiting = 'popup';
    app.tutorialPopupScene = index;
    hideTutorialActionRow();
    pauseTutorialTimer();
    el['tutorial-scene-eyebrow'].textContent = info.eyebrow;
    el['tutorial-scene-title'].textContent = info.title;
    el['tutorial-scene-text'].textContent = info.text;
    el['tutorial-scene-actions'].innerHTML =
      '<button type="button" class="primary-btn" data-tutorial-pop-close>知道了</button>';
    el['tutorial-rule-pop'].hidden = false;
  }

  function tutorialConfirmPopup() {
    if (app.tutorialWaiting !== 'popup') return;
    const index = app.tutorialPopupScene;
    app.tutorialPopupScene = -1;
    hideTutorialPopup();
    app.tutorialWaiting = null;
    resumeTutorialTimer();
    if (app.tutorialPhase === 'basic' && index >= 0) tutorialPerformScene(index);
  }

  function tutorialNext() {
    if (app.tutorialPhase !== 'basic') return;
    const next = app.tutorialMatchIndex + 1;
    if (next >= TUTORIAL_MATCH_SCENES.length) {
      tutorialShowResult('教程完成');
      return;
    }
    const scene = TUTORIAL_MATCH_SCENES[next];
    if (scene.kind === 'result') {
      tutorialShowResult('教程完成');
      return;
    }
    if (TUTORIAL_POPUP_INFO[next]) {
      tutorialShowPopup(next);
      return;
    }
    tutorialPerformScene(next);
  }

  function tutorialPerformScene(index) {
    const scene = TUTORIAL_MATCH_SCENES[index];
    if (!scene) return;
    if (scene.kind === 'checkpoint') {
      app.tutorialMatchIndex = index;
      app.tutorialWaiting = 'gate';
      hideTutorialActionRow();
      renderTutorialMatch();
      tutorialShowGatePopup(scene);
      return;
    }
    if (app.tutorialPhase === 'basic' && scene.kind === 'play' && scene.seat === 0) {
      app.tutorialPendingScene = index;
      app.tutorialWaiting = 'player';
      app.tutorialSelection = new Set(scene.played);
      renderTutorialMatch();
      showTutorialBasicPlayButton();
      return;
    }
    app.tutorialMatchIndex = index;
    app.tutorialWaiting = 'auto';
    renderTutorialMatch();
    hideTutorialActionRow();
    tutorialDelayNext(scene.kind === 'deal' ? 1100 : 1500);
  }

  function tutorialShowGatePopup(scene) {
    el['tutorial-scene-eyebrow'].textContent = scene.eyebrow;
    el['tutorial-scene-title'].textContent = scene.title;
    el['tutorial-scene-text'].textContent = scene.text;
    // 基础完成 checkpoint：直接继续完整对局，或退出教程；可选规则改由顶栏按钮进入。
    el['tutorial-scene-actions'].innerHTML = `
      <button type="button" class="primary-btn" data-tutorial-continue>继续完成对局</button>
      <button type="button" class="secondary-btn" data-tutorial-exit>退出教程</button>
    `;
    el['tutorial-rule-pop'].hidden = false;
  }

  function renderTutorialBasicMatch() {
    const index = app.tutorialMatchIndex;
    const pending = app.tutorialPendingScene;
    const displayIndex = pending >= 0 ? pending - 1 : index;
    const stateIndex = Math.max(0, displayIndex);
    const scene = TUTORIAL_MATCH_SCENES[stateIndex] || TUTORIAL_MATCH_SCENES[0];
    const state = tutorialStateAt(stateIndex);
    const activeScene = pending >= 0 ? { ...scene, seat: 0 } : scene;
    el['tutorial-progress'].textContent = `第 ${Math.max(0, index) + 1} / ${TUTORIAL_MATCH_SCENES.length} 步`;
    el['tutorial-rules-btn'].hidden = index < TUTORIAL_RULES_GATE;
    el['tutorial-seats'].innerHTML = TUTORIAL_SEATS
      .map((_, seat) => tutorialSeatMarkup(seat, activeScene, state))
      .join('');
    const pendingScene = pending >= 0 ? TUTORIAL_MATCH_SCENES[pending] : null;
    el['tutorial-turn'].textContent = pendingScene ? '轮到你出牌' : scene.turn;
    el['tutorial-played'].innerHTML = tutorialPlayedMarkup(scene, stateIndex, state);
    el['tutorial-match-hand'].innerHTML = tutorialHandMarkup(state, app.tutorialSelection, false);
    el['tutorial-scene-rule'].textContent = pendingScene ? pendingScene.rule : scene.rule;
  }

  /* ---------------- tutorial · free phase (single-mode style) ---------------- */

  function tutorialTeamOf(seat) {
    return seat === 1 || seat === 2 ? 'landlord' : 'farmers';
  }

  function tutorialActiveSeats(game) {
    return [0, 1, 2, 3].filter((seat) => !game.finished.includes(seat));
  }

  function tutorialNextActiveSeat(game, fromSeat) {
    for (let step = 1; step <= 4; step += 1) {
      const seat = (fromSeat + step) % 4;
      if (!game.finished.includes(seat)) return seat;
    }
    return null;
  }

  function tutorialCreateGame() {
    const playedBySeat = [[], [], [], []];
    for (let i = 0; i <= TUTORIAL_RULES_GATE; i += 1) {
      const scene = TUTORIAL_MATCH_SCENES[i];
      if (scene.seat !== null && scene.played.length) playedBySeat[scene.seat].push(...scene.played);
    }
    const hands = TUTORIAL_INITIAL_HANDS.map((hand, seat) =>
      hand.filter((id) => !playedBySeat[seat].includes(id)),
    );
    const script = TUTORIAL_FREE_SCRIPT.map((entry) => ({
      ...entry,
      cards: entry.cards ? [...entry.cards] : undefined,
    }));
    const golden = TUTORIAL_GOLDEN_PLAYS.map((cards) => ({ cards: [...cards], used: false }));
    return {
      hands,
      script,
      golden,
      turn: 0,
      lastPlay: null,
      passes: new Set(),
      finished: [],
      lastAction: null,
      phase: 'playing',
    };
  }

  function tutorialEvaluateGame(game) {
    const order = game.finished;
    if (order.length < 2) return null;
    const firstTeam = tutorialTeamOf(order[0]);
    if (tutorialTeamOf(order[1]) === firstTeam) return { winner: firstTeam };
    if (order.length >= 3) {
      if (tutorialTeamOf(order[2]) === firstTeam) return { winner: firstTeam };
      return { winner: 'draw' };
    }
    return null;
  }

  function tutorialFreeBeginTurn() {
    const game = app.tutorialGame;
    if (!game || game.phase !== 'playing') return;
    if (game.turn === 0) {
      app.tutorialWaiting = 'free-player';
      app.tutorialSelection.clear();
      app.tutorialHintIndex = 0;
      renderTutorialMatch();
      showTutorialFreeActions();
      startTutorialTimer();
      return;
    }
    app.tutorialWaiting = 'free-busy';
    hideTutorialActionRow();
    el['tutorial-timer'].hidden = true;
    renderTutorialMatch();
    tutorialClearAutoTimer();
    app.tutorialAutoTimer = setTimeout(() => {
      app.tutorialAutoTimer = null;
      tutorialBotTurn();
    }, 1100);
  }

  function tutorialLegalMoves(handIds, previousCombo) {
    const hand = handIds.map(tutorialCardById);
    const moves = [];
    for (const size of [1, 2, 3, 5]) {
      for (const picked of combinations(hand, size)) {
        const combo = classifyClient(picked);
        if (!combo) continue;
        if (previousCombo && !canBeatClient(combo, previousCombo)) continue;
        moves.push({ cards: picked.map((card) => card.id), combo });
      }
    }
    moves.sort((a, b) => compareClient(a.combo, b.combo) || a.cards.length - b.cards.length);
    return moves;
  }

  function tutorialPickBotMove(seat, game) {
    const moves = tutorialLegalMoves(game.hands[seat], game.lastPlay?.combo || null);
    return moves[0] || null;
  }

  function tutorialTakeScripted(game, seat) {
    const head = game.script[0];
    if (!head || head.seat !== seat) return null;
    if (head.type === 'pass') {
      if (!game.lastPlay) return null;
      game.script.shift();
      return head;
    }
    if (!head.cards.every((id) => game.hands[seat].includes(id))) {
      game.script.shift();
      return null;
    }
    const combo = classifyClient(head.cards.map(tutorialCardById));
    if (!combo) {
      game.script.shift();
      return null;
    }
    if (game.lastPlay && !canBeatClient(combo, game.lastPlay.combo)) {
      game.script.shift();
      return null;
    }
    game.script.shift();
    return { type: 'play', cards: [...head.cards], combo };
  }

  function tutorialBotTurn() {
    const game = app.tutorialGame;
    if (!game || game.phase !== 'playing' || game.turn === 0) return;
    const seat = game.turn;
    const scripted = tutorialTakeScripted(game, seat);
    if (scripted) {
      if (scripted.type === 'pass') tutorialFreeCommitPass(seat);
      else tutorialFreeCommitPlay(seat, scripted.cards);
      return;
    }
    const move = tutorialPickBotMove(seat, game);
    if (move) tutorialFreeCommitPlay(seat, move.cards);
    else tutorialFreeCommitPass(seat);
  }

  function tutorialFreeCommitPlay(seat, cardIds) {
    const game = app.tutorialGame;
    if (!game || game.phase !== 'playing') return;
    const combo = classifyClient(cardIds.map(tutorialCardById));
    if (!combo) return;
    game.hands[seat] = game.hands[seat].filter((id) => !cardIds.includes(id));
    game.lastPlay = { seat, cards: [...cardIds], combo };
    game.passes.clear();
    game.lastAction = { type: 'play', seat, cards: [...cardIds], combo };
    if (game.hands[seat].length === 0 && !game.finished.includes(seat)) game.finished.push(seat);
    const result = tutorialEvaluateGame(game);
    if (result) {
      game.phase = 'ended';
      tutorialShowResult('教程完成');
      return;
    }
    const next = tutorialNextActiveSeat(game, seat);
    if (next === null) {
      game.phase = 'ended';
      tutorialShowResult('教程完成');
      return;
    }
    game.turn = next;
    tutorialFreeBeginTurn();
  }

  function tutorialFreeCommitPass(seat) {
    const game = app.tutorialGame;
    if (!game || game.phase !== 'playing') return;
    game.passes.add(seat);
    game.lastAction = { type: 'pass', seat };
    const active = tutorialActiveSeats(game);
    const lastSeat = game.lastPlay?.seat;
    const shouldReset = lastSeat !== undefined &&
      active.filter((activeSeat) => activeSeat !== lastSeat).every((activeSeat) => game.passes.has(activeSeat));
    if (shouldReset) {
      const leader = active.includes(lastSeat) ? lastSeat : tutorialNextActiveSeat(game, lastSeat);
      if (leader === null) {
        game.phase = 'ended';
        tutorialShowResult('教程完成');
        return;
      }
      game.lastPlay = null;
      game.passes.clear();
      game.lastAction = { type: 'collect', seat: leader };
      game.turn = leader;
    } else {
      const next = tutorialNextActiveSeat(game, seat);
      if (next === null) {
        game.phase = 'ended';
        tutorialShowResult('教程完成');
        return;
      }
      game.turn = next;
    }
    tutorialFreeBeginTurn();
  }

  function tutorialEvaluatePlayerSelection(cards, game) {
    if (!cards.length) return { ok: false, message: '' };
    if (cards.length > 5) return { ok: false, message: '一次最多选 5 张啦！' };
    const combo = classifyClient(cards.map(tutorialCardById));
    if (!combo) return { ok: false, message: '牌型不合法，选单牌 / 对子 / 三条 / 顺子 / 同花 / 三带二 / 四带一 / 同花顺 / 皇家同花顺' };
    if (game.lastPlay && !canBeatClient(combo, game.lastPlay.combo)) {
      return { ok: false, message: `这手 ${combo.label} 压不过上家的 ${game.lastPlay.combo?.label || '牌型'}` };
    }
    return { ok: true, combo };
  }

  function showTutorialFreeActions() {
    const game = app.tutorialGame;
    if (!game) return;
    el['tutorial-hint-btn'].hidden = false;
    el['tutorial-hint-btn'].disabled = false;
    el['tutorial-skip-btn'].hidden = false;
    el['tutorial-skip-btn'].disabled = !game.lastPlay;
    el['tutorial-play-btn'].hidden = false;
    el['tutorial-play-actions'].hidden = false;
    el['tutorial-timer'].hidden = false;
    updateTutorialPlayButton();
  }

  function updateTutorialPlayButton() {
    if (!el['tutorial-play-btn']) return;
    if (app.tutorialWaiting !== 'free-player') {
      el['tutorial-play-btn'].disabled = true;
      return;
    }
    const evaluation = tutorialEvaluatePlayerSelection([...app.tutorialSelection], app.tutorialGame);
    el['tutorial-play-btn'].disabled = !evaluation.ok;
    el['tutorial-play-btn'].textContent = evaluation.ok ? `出牌 · ${evaluation.combo.label}` : '出牌';
  }

  function tutorialFreeSeatMarkup(seat, game) {
    const meta = TUTORIAL_SEATS[seat];
    const place = game.finished.indexOf(seat);
    const role = seat === 1 || seat === 2 ? 'landlord' : 'farmer';
    const classes = ['tutorial-seat', `role-${role}`];
    if (seat === 0) classes.push('you');
    if (game.turn === seat && game.phase === 'playing') classes.push('active');
    if (place >= 0) classes.push('finished');
    const flags = [];
    if (place >= 0) flags.push(`<i class="tutorial-seat-flag place">第 ${place + 1} 顺位</i>`);
    else if (game.passes.has(seat)) flags.push('<i class="tutorial-seat-flag pass">过</i>');
    const name = meta.you ? `${meta.name}（你）` : meta.name;
    const roleLabel = role === 'landlord' ? '地主' : '农民';
    return `<div class="${classes.join(' ')}">
      <span class="tutorial-seat-avatar">${esc(meta.avatar)}</span>
      <div class="tutorial-seat-copy">
        <b>${esc(name)}</b>
        <em>${esc(roleLabel)}<span class="tutorial-seat-count"> · 剩 ${game.hands[seat].length} 张</span></em>
      </div>
      ${flags.join('')}
    </div>`;
  }

  function tutorialFreeTableMarkup(game) {
    const action = game.lastAction;
    if (!action) {
      return `<p class="tutorial-played-caption">本轮到 你 领出</p>
        <div class="tutorial-collect-badge">选好牌后点「出牌」开始这一轮</div>`;
    }
    if (action.type === 'play') {
      const actor = TUTORIAL_SEATS[action.seat].name;
      const cards = action.cards
        .map((id) => `<span class="tutorial-played-card">${tutorialCard(tutorialCardById(id))}</span>`)
        .join('');
      return `<p class="tutorial-played-caption">${esc(actor)} 打出 ${esc(action.combo?.label || '')}</p>
        <div class="tutorial-played-cards">${cards}</div>`;
    }
    if (action.type === 'pass') {
      return `<p class="tutorial-played-caption">${esc(TUTORIAL_SEATS[action.seat].name)} 选择过牌</p>
        <div class="tutorial-pass-badge">过</div>`;
    }
    if (action.type === 'collect') {
      return `<p class="tutorial-played-caption">其余玩家都不要，这一轮结束</p>
        <div class="tutorial-collect-badge">${esc(TUTORIAL_SEATS[action.seat].name)} 收轮，重新领出</div>`;
    }
    return '';
  }

  function tutorialFreeHandMarkup(game) {
    const hand = sortByPower(game.hands[0].map(tutorialCardById));
    if (!hand.length) return '<p class="tutorial-hand-empty">你的手牌已出完</p>';
    const clickable = app.tutorialWaiting === 'free-player';
    return `<p class="tutorial-hand-label">你的手牌 · 剩 ${hand.length} 张${clickable ? ' · 点牌选择' : ''}</p>
      <div class="tutorial-hand-row">${hand
        .map((card) => tutorialCard(card, app.tutorialSelection.has(card.id), clickable))
        .join('')}</div>`;
  }

  function tutorialFreeRuleText(game) {
    if (game.phase === 'ended') return '这一局结束啦，点「回到首页」离开教程。';
    if (game.turn === 0) {
      if (!game.lastPlay) return '本轮你领出：选任意合法牌型；领出时不能跳过';
      return '跟牌：同类型更大 或 更高等级；压不过就点「跳过」过牌';
    }
    return `等 ${TUTORIAL_SEATS[game.turn].name} 出牌…`;
  }

  function renderTutorialFreeMatch() {
    const game = app.tutorialGame;
    if (!game) return;
    el['tutorial-rules-btn'].hidden = false;
    el['tutorial-seats'].innerHTML = [0, 1, 2, 3]
      .map((seat) => tutorialFreeSeatMarkup(seat, game))
      .join('');
    if (game.phase === 'ended') {
      el['tutorial-turn'].textContent = '本局结束';
    } else if (game.turn === 0) {
      el['tutorial-turn'].textContent = '轮到你出牌';
    } else {
      el['tutorial-turn'].textContent = `${TUTORIAL_SEATS[game.turn].name} 出牌中…`;
    }
    el['tutorial-played'].innerHTML = tutorialFreeTableMarkup(game);
    el['tutorial-match-hand'].innerHTML = tutorialFreeHandMarkup(game);
    el['tutorial-scene-rule'].textContent = tutorialFreeRuleText(game);
  }

  function renderTutorialMatch() {
    if ((app.tutorialPhase === 'free' || app.tutorialPhase === 'ended') && app.tutorialGame) {
      renderTutorialFreeMatch();
      return;
    }
    renderTutorialBasicMatch();
  }

  /* ---------------- tutorial · timers ---------------- */

  function startTutorialTimer() {
    app.tutorialTimerDeadline = Date.now() + TUTORIAL_FREE_SECONDS * 1000;
    app.tutorialTimerPaused = false;
    app.tutorialTimerPauseLeft = 0;
    if (el['tutorial-timer']) {
      el['tutorial-timer'].hidden = false;
      el['tutorial-timer'].classList.remove('urgent');
    }
    updateTutorialTimerUi();
  }

  function pauseTutorialTimer() {
    if (app.tutorialPhase !== 'free' || app.tutorialWaiting !== 'free-player') return;
    if (app.tutorialTimerPaused || !app.tutorialTimerDeadline) return;
    app.tutorialTimerPaused = true;
    app.tutorialTimerPauseLeft = Math.max(0, app.tutorialTimerDeadline - Date.now());
  }

  function resumeTutorialTimer() {
    if (!app.tutorialTimerPaused) return;
    app.tutorialTimerPaused = false;
    if (app.tutorialPhase === 'free' && app.tutorialWaiting === 'free-player') {
      app.tutorialTimerDeadline = Date.now() + app.tutorialTimerPauseLeft;
    }
    updateTutorialTimerUi();
  }

  function updateTutorialTimerUi() {
    const timer = el['tutorial-timer'];
    if (!timer) return;
    if (app.tutorialPhase !== 'free' || app.tutorialWaiting !== 'free-player' || !app.tutorialTimerDeadline) {
      timer.hidden = true;
      timer.classList.remove('urgent');
      return;
    }
    timer.hidden = false;
    const remaining = Math.max(0, (app.tutorialTimerDeadline - Date.now()) / 1000);
    timer.textContent = `${Math.ceil(remaining)}s`;
    timer.classList.toggle('urgent', remaining <= 5);
    if (!app.tutorialTimerPaused && remaining <= 0) tutorialHandleTimeout();
  }

  function tutorialHandleTimeout() {
    if (app.tutorialWaiting !== 'free-player') return;
    const game = app.tutorialGame;
    if (!game || game.phase !== 'playing') return;
    app.tutorialWaiting = 'free-busy';
    el['tutorial-timer'].hidden = true;
    if (game.lastPlay) {
      showToast('时间到，自动过牌', 'gold', 1600);
      tutorialFreeCommitPass(0);
      return;
    }
    const move = tutorialPickBotMove(0, game);
    if (move) {
      showToast('时间到，自动打出最小合法牌', 'gold', 1600);
      tutorialFreeCommitPlay(0, move.cards);
    } else {
      tutorialFreeCommitPass(0);
    }
  }

  /* ---------------- tutorial · player actions ---------------- */

  function tutorialPlaySelected() {
    if (app.tutorialPhase === 'free') {
      tutorialFreePlaySelected();
      return;
    }
    if (app.tutorialPhase !== 'basic' || app.tutorialWaiting !== 'player') return;
    const index = app.tutorialPendingScene;
    if (index < 0) return;
    const scene = TUTORIAL_MATCH_SCENES[index];
    if (!scene || scene.kind !== 'play' || scene.seat !== 0) return;
    const target = new Set(scene.played);
    const exact = app.tutorialSelection.size === target.size &&
      [...target].every((id) => app.tutorialSelection.has(id));
    if (!exact) {
      app.tutorialSelection = new Set(scene.played);
      renderTutorialMatch();
      return;
    }
    tutorialClearAutoTimer();
    app.tutorialSelection.clear();
    app.tutorialPendingScene = -1;
    app.tutorialMatchIndex = index;
    app.tutorialWaiting = 'auto';
    hideTutorialActionRow();
    renderTutorialMatch();
    tutorialDelayNext(800);
  }

  function tutorialFreePlaySelected() {
    if (app.tutorialWaiting !== 'free-player') return;
    const game = app.tutorialGame;
    const cards = [...app.tutorialSelection];
    const evaluation = tutorialEvaluatePlayerSelection(cards, game);
    if (!evaluation.ok) {
      showToast(evaluation.message || '请选择合法的牌', 'error');
      return;
    }
    const golden = game.golden.find((entry) =>
      !entry.used &&
      entry.cards.length === cards.length &&
      entry.cards.every((id) => cards.includes(id)),
    );
    if (golden) golden.used = true;
    app.tutorialSelection.clear();
    app.tutorialWaiting = 'free-busy';
    el['tutorial-timer'].hidden = true;
    tutorialFreeCommitPlay(0, cards);
  }

  function tutorialUseHint() {
    if (app.tutorialPhase !== 'free' || app.tutorialWaiting !== 'free-player') return;
    const game = app.tutorialGame;
    const previous = game.lastPlay?.combo || null;
    const moves = tutorialLegalMoves(game.hands[0], previous);
    if (!moves.length) {
      showToast('没有能压过的牌，点「跳过」过牌', 'error', 2200);
      return;
    }
    let chosen = null;
    const golden = game.golden.find((entry) =>
      !entry.used && entry.cards.every((id) => game.hands[0].includes(id)),
    );
    if (golden) {
      const combo = classifyClient(golden.cards.map(tutorialCardById));
      if (combo && (!previous || canBeatClient(combo, previous))) {
        chosen = { cards: golden.cards, combo };
      }
    }
    if (!chosen) chosen = moves[app.tutorialHintIndex % moves.length];
    app.tutorialHintIndex += 1;
    app.tutorialSelection = new Set(chosen.cards);
    renderTutorialMatch();
    showTutorialFreeActions();
    showToast(`提示：${chosen.combo.label}`, 'gold', 1800);
  }

  function tutorialSkipTurn() {
    if (app.tutorialPhase !== 'free' || app.tutorialWaiting !== 'free-player') return;
    const game = app.tutorialGame;
    if (!game.lastPlay) {
      showToast('本轮由你领出，不能跳过', 'error');
      return;
    }
    app.tutorialSelection.clear();
    app.tutorialWaiting = 'free-busy';
    el['tutorial-timer'].hidden = true;
    tutorialFreeCommitPass(0);
  }

  function handleTutorialHandClick(event) {
    const button = event.target.closest('[data-tutorial-card]');
    if (!button) return;
    if (app.tutorialPhase !== 'free' || app.tutorialWaiting !== 'free-player') return;
    const id = button.dataset.tutorialCard;
    if (!app.tutorialGame || !app.tutorialGame.hands[0].includes(id)) return;
    if (app.tutorialSelection.has(id)) app.tutorialSelection.delete(id);
    else app.tutorialSelection.add(id);
    renderTutorialMatch();
    showTutorialFreeActions();
  }

  /* ---------------- tutorial · lifecycle ---------------- */

  function openTutorialMatch() {
    tutorialClearTimers();
    app.tutorialPhase = 'basic';
    app.tutorialMatchIndex = -1;
    app.tutorialPendingScene = -1;
    app.tutorialPopupScene = -1;
    app.tutorialWaiting = null;
    app.tutorialSelection.clear();
    app.tutorialGame = null;
    app.tutorialRulesViewed = [];
    app.tutorialRuleLast = null;
    app.tutorialHintIndex = 0;
    el['tutorial-rules-sheet'].hidden = true;
    el['tutorial-result-panel'].hidden = true;
    el['tutorial-match'].hidden = false;
    el['tutorial-rules-btn'].hidden = true;
    el['tutorial-timer'].hidden = true;
    hideTutorialPopup();
    hideTutorialActionRow();
    renderTutorialMatch();
    tutorialNext();
  }

  function closeTutorialMatch() {
    tutorialBackHome();
  }

  function tutorialStartFree() {
    if (app.tutorialPhase === 'free') {
      el['tutorial-rules-sheet'].hidden = true;
      hideTutorialPopup();
      resumeTutorialTimer();
      return;
    }
    tutorialClearTimers();
    el['tutorial-rules-sheet'].hidden = true;
    hideTutorialPopup();
    app.tutorialPhase = 'free';
    app.tutorialWaiting = 'free-busy';
    app.tutorialPendingScene = -1;
    app.tutorialPopupScene = -1;
    app.tutorialSelection.clear();
    app.tutorialMatchIndex = TUTORIAL_RULES_CONTINUE;
    app.tutorialGame = tutorialCreateGame();
    el['tutorial-rules-btn'].hidden = false;
    el['tutorial-timer'].hidden = true;
    hideTutorialActionRow();
    renderTutorialMatch();
    tutorialFreeBeginTurn();
  }

  function tutorialShowResult(title) {
    tutorialClearTimers();
    app.tutorialPhase = 'ended';
    app.tutorialWaiting = 'ended';
    hideTutorialActionRow();
    hideTutorialPopup();
    el['tutorial-rules-sheet'].hidden = true;
    el['tutorial-timer'].hidden = true;
    el['tutorial-result-title'].textContent = title || '教程完成';
    el['tutorial-result-panel'].hidden = false;
    renderTutorialMatch();
  }

  function tutorialBackHome() {
    tutorialClearTimers();
    hideTutorialActionRow();
    hideTutorialPopup();
    el['tutorial-rules-sheet'].hidden = true;
    el['tutorial-result-panel'].hidden = true;
    el['tutorial-match'].hidden = true;
    app.tutorialPhase = 'basic';
    app.tutorialWaiting = null;
    app.tutorialMatchIndex = -1;
    app.tutorialPendingScene = -1;
    app.tutorialPopupScene = -1;
    app.tutorialGame = null;
    app.tutorialSelection.clear();
    showScreen('landing');
  }

  /* ---------------- tutorial · optional rules ---------------- */

  function openTutorialRules() {
    pauseTutorialTimer();
    el['tutorial-rules-sheet'].hidden = false;
    renderTutorialRuleSheet();
  }

  function closeTutorialRules() {
    el['tutorial-rules-sheet'].hidden = true;
    resumeTutorialTimer();
  }

  function renderTutorialRuleSheet() {
    const viewed = new Set(app.tutorialRulesViewed);
    for (const key of TUTORIAL_RULE_KEYS) {
      const button = el['tutorial-rules-sheet'].querySelector(`[data-tutorial-rule="${key}"]`);
      if (button) button.classList.toggle('is-viewed', viewed.has(key));
    }
    el['tutorial-rule-actions'].hidden = viewed.size < TUTORIAL_RULE_KEYS.length;
    const last = app.tutorialRuleLast ? TUTORIAL_RULE_INFO[app.tutorialRuleLast] : null;
    const progress = viewed.size === 0
      ? '逐条点开「供牌 / 借风」，两条都看完就能选择下一步。'
      : viewed.size < TUTORIAL_RULE_KEYS.length
        ? `已看 ${viewed.size} / ${TUTORIAL_RULE_KEYS.length} 条，再点开剩下的规则。`
        : '两条可选规则都看完了，可以结束教程或继续完成对局。';
    el['tutorial-rule-detail'].innerHTML = `
      <p class="tutorial-rule-progress">${esc(progress)}</p>
      ${last ? `<h3>${esc(last.title)}</h3><p>${esc(last.text)}</p>` : ''}
    `;
  }

  function handleTutorialMatchClick(event) {
    if (event.target.closest('[data-tutorial-pop-close]')) {
      tutorialConfirmPopup();
      return;
    }
    if (event.target.closest('[data-tutorial-rules-open]')) {
      openTutorialRules();
      return;
    }
    if (event.target.closest('[data-tutorial-exit]')) {
      closeTutorialMatch();
      return;
    }
    if (event.target.closest('[data-tutorial-finish]')) {
      tutorialShowResult('教程完成');
      return;
    }
    if (event.target.closest('[data-tutorial-continue]')) {
      if (app.tutorialPhase === 'basic') tutorialStartFree();
      else {
        closeTutorialRules();
        hideTutorialPopup();
      }
      return;
    }
    const rule = event.target.closest('[data-tutorial-rule]');
    if (rule) {
      const key = rule.dataset.tutorialRule;
      if (TUTORIAL_RULE_INFO[key] && !app.tutorialRulesViewed.includes(key)) {
        app.tutorialRulesViewed.push(key);
      }
      if (TUTORIAL_RULE_INFO[key]) app.tutorialRuleLast = key;
      renderTutorialRuleSheet();
    }
  }

  function tutorialCard(card, selected = false, clickable = false) {
    if (!card) return '';
    const suit = SUITS[card.suit] || SUITS.s;
    return `<button type="button" class="tutorial-card-face ${suit.red ? 'red' : ''} ${selected ? 'selected' : ''}"
      ${clickable ? 'data-tutorial-card="' + esc(card.id) + '"' : 'disabled'}>
      <b>${esc(card.rank)}</b><i>${suit.symbol}</i>
    </button>`;
  }

  function init() {
    cacheElements();
    bindEvents();
    const initialAssets = Promise.allSettled([prefetchSfx(), prefetchBgm()]);
    updateSoundUi();
    applyTheme();
    const loadingSkip = document.getElementById('loading-skip');
    if (loadingSkip) loadingSkip.addEventListener('click', closeLoadingScreen);
    const finishLoading = () => {
      const maxWait = new Promise((resolve) => setTimeout(resolve, 5000));
      Promise.allSettled([Promise.race([initialAssets, maxWait]), new Promise((resolve) => setTimeout(resolve, 400))])
        .then(closeLoadingScreen);
    };
    if (document.readyState === 'complete') finishLoading();
    else window.addEventListener('load', finishLoading, { once: true });
    // Absolute fallback: never trap the player on the loading veil.
    setTimeout(closeLoadingScreen, 9000);
    updateFullscreenUi();
    updateStageScale();
    // 竖屏首次加载先静默尝试一次锁横屏（无手势时通常会失败，失败保留 guard）。
    attemptLandscapeLock();
    if (app.avatar && !app.avatar.startsWith('data:image/')) {
      app.avatar = '';
      localStorage.removeItem(AVATAR_KEY);
    }
    updateAvatarPreview();

    el['name-input'].value = app.name;
    const params = new URLSearchParams(location.search);
    const roomFromUrl = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4);
    if (roomFromUrl) {
      app.inviteCode = roomFromUrl;
      if (app.name && !app.session) setTimeout(() => openJoinModal(roomFromUrl), 120);
    }
    if (!app.name) {
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
