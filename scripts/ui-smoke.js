'use strict';

/* Headless UI smoke test: drives four real browser tabs through a full game. */

const fs = require('node:fs');
const path = require('node:path');
const { CARD_BY_ID, classify, findLegalMoves } = require('../lib/cards');

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9223';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:3213';
const OUT_DIR = path.resolve(__dirname, '..', 'screenshots');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.errors = [];
  }

  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP connect timeout')), 5000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP connect error'));
      }, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.id) {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message}`));
        else pending.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        const details = message.params.exceptionDetails;
        this.errors.push(`exception: ${details?.text || 'unknown'} ${details?.exception?.description || ''}`);
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.errors.push(`console.error: ${message.params.args.map((arg) => arg.value).join(' ')}`);
      }
      const callbacks = this.listeners.get(message.method) || [];
      for (const callback of callbacks) callback(message.params);
    });
  }

  on(method, callback) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(callback);
  }

  async send(method, params = {}) {
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timeout`));
      }, 15000);
      this.pending.set(id, {
        method,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`JS exception: ${result.exceptionDetails.text} ${result.exceptionDetails.exception?.description || ''}`);
    }
    return result.result?.value;
  }

  async waitFor(expression, timeout = 8000, label = expression) {
    const start = Date.now();
    let lastError;
    while (Date.now() - start < timeout) {
      try {
        if (await this.evaluate(expression)) return;
      } catch (error) {
        lastError = error;
      }
      await sleep(60);
    }
    throw new Error(`timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
  }

  async screenshot(file) {
    await this.send('Page.bringToFront');
    await sleep(1200);
    const result = await this.send('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport: false,
    });
    fs.writeFileSync(file, Buffer.from(result.data, 'base64'));
    console.log('screenshot:', path.relative(process.cwd(), file));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

async function createPage({ width = 1440, height = 1000, mobile = false } = {}) {
  const response = await fetch(`${CDP_HTTP}/json/new?about:blank`, { method: 'PUT' });
  if (!response.ok) throw new Error(`create target failed: ${response.status}`);
  const target = await response.json();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height,
    deviceScaleFactor: 1,
    mobile,
  });
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.removeItem('a3.session.v1'); } catch (e) {}",
  });
  await cdp.send('Page.navigate', { url: APP_URL });
  await cdp.waitFor("document.readyState === 'complete' && !!document.getElementById('home-create-btn')", 10000, 'app load');
  await cdp.waitFor("!document.getElementById('home-create-btn').disabled", 10000, 'websocket connection');
  return { cdp, targetId: target.id };
}

async function setName(cdp, name) {
  await cdp.evaluate(`(() => {
    const input = document.getElementById('name-input');
    input.value = ${JSON.stringify(name)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return input.value;
  })()`);
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const pages = [];
  const cleanup = async () => {
    for (const page of pages) {
      page.cdp.close();
      try {
        await fetch(`${CDP_HTTP}/json/close/${page.targetId}`);
      } catch {
        // ignore
      }
    }
  };

  try {
    for (let i = 0; i < 4; i += 1) {
      pages.push(await createPage());
    }
    console.log('four browser tabs ready');

    // Social: upload a real image file, expect canvas compression + preview + localStorage.
    await pages[0].cdp.evaluate(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 1400;
      canvas.height = 1000;
      const ctx = canvas.getContext('2d');
      const gradient = ctx.createLinearGradient(0, 0, 1400, 1000);
      gradient.addColorStop(0, '#1f6f43');
      gradient.addColorStop(0.5, '#ffd45e');
      gradient.addColorStop(1, '#0b3b63');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 1400, 1000);
      for (let i = 0; i < 180; i += 1) {
        ctx.fillStyle = 'hsla(' + ((i * 47) % 360) + ', 70%, 55%, 0.55)';
        ctx.beginPath();
        ctx.arc((i * 137) % 1400, (i * 83) % 1000, 18 + (i % 55), 0, Math.PI * 2);
        ctx.fill();
      }
      const dataUrl = canvas.toDataURL('image/jpeg', 0.96);
      const byteString = atob(dataUrl.split(',')[1]);
      const bytes = new Uint8Array(byteString.length);
      for (let i = 0; i < byteString.length; i += 1) bytes[i] = byteString.charCodeAt(i);
      const blob = new Blob([bytes], { type: 'image/jpeg' });
      const file = new File([blob], 'avatar.jpg', { type: 'image/jpeg' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.getElementById('avatar-input');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
    await pages[0].cdp.waitFor(
      "document.getElementById('avatar-preview').classList.contains('has-image') && !!localStorage.getItem('a3.avatar') && localStorage.getItem('a3.avatar').length <= 140000",
      8000,
      'avatar compressed and previewed',
    );
    console.log('avatar: compressed, previewed and stored');

    // Tutorial: a playable simulated match. Basic turns auto-select the target cards,
    // the player confirms with the play button; the free phase adds timer/hint/skip.
    await pages[0].cdp.evaluate("document.getElementById('home-tutorial-btn').click()");
    await pages[0].cdp.waitFor(
      "!document.getElementById('tutorial-match').hidden && document.querySelectorAll('#tutorial-seats .tutorial-seat').length === 4",
      4000,
      'tutorial match open with four seats',
    );
    let tutorialAutoSelectSeen = false;
    let tutorialPlayClicks = 0;
    for (let step = 0; step < 200; step += 1) {
      const state = await pages[0].cdp.evaluate(`(() => ({
        rulesReady: !document.getElementById('tutorial-rules-btn').hidden,
        playVisible: !document.getElementById('tutorial-play-btn').hidden,
        playDisabled: document.getElementById('tutorial-play-btn').disabled,
        timerVisible: !document.getElementById('tutorial-timer').hidden,
        hintVisible: !document.getElementById('tutorial-hint-btn').hidden,
        popupConfirm: !document.getElementById('tutorial-rule-pop').hidden && !!document.querySelector('[data-tutorial-pop-close]'),
        selected: document.querySelectorAll('#tutorial-match-hand .tutorial-card-face.selected').length,
        resultVisible: !document.getElementById('tutorial-result-panel').hidden,
      }))()`);
      if (state.resultVisible) break;
      if (state.popupConfirm) {
        await pages[0].cdp.evaluate("document.querySelector('[data-tutorial-pop-close]').click()");
        await sleep(160);
        continue;
      }
      if (state.rulesReady && !state.playVisible) break;
      if (state.playVisible && !state.playDisabled) {
        if (state.timerVisible || state.hintVisible) {
          throw new Error('basic tutorial should not show timer/hint');
        }
        if (state.selected > 0) tutorialAutoSelectSeen = true;
        await pages[0].cdp.evaluate("document.getElementById('tutorial-play-btn').click()");
        tutorialPlayClicks += 1;
        await sleep(180);
        continue;
      }
      await sleep(120);
    }
    if (!tutorialAutoSelectSeen) throw new Error('basic tutorial did not auto-select target cards');
    if (!tutorialPlayClicks) throw new Error('basic tutorial player never clicked play');
    await pages[0].cdp.waitFor("!document.getElementById('tutorial-rules-btn').hidden", 5000, 'optional rules unlocked');
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-tutorial-basic.png'));

    await pages[0].cdp.evaluate("document.getElementById('tutorial-rules-btn').click()");
    await pages[0].cdp.waitFor("!document.getElementById('tutorial-rules-sheet').hidden", 3000, 'optional rules sheet');
    for (const rule of ['tribute', 'borrow', 'scoring']) {
      await pages[0].cdp.evaluate(`document.querySelector('[data-tutorial-rule="${rule}"]').click()`);
    }
    await pages[0].cdp.waitFor("!document.getElementById('tutorial-rule-actions').hidden", 3000, 'optional rules done');
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-tutorial-rules.png'));
    await pages[0].cdp.evaluate("document.querySelector('[data-tutorial-continue]').click()");
    await pages[0].cdp.waitFor(`(() => {
      const timer = document.getElementById('tutorial-timer');
      const hint = document.getElementById('tutorial-hint-btn');
      const skip = document.getElementById('tutorial-skip-btn');
      const selected = document.querySelectorAll('#tutorial-match-hand .tutorial-card-face.selected').length;
      return !timer.hidden && !hint.hidden && !skip.hidden && selected === 0;
    })()`, 4000, 'free phase timer/hint/skip and no auto-select');
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-tutorial-free.png'));

    // Finish the free phase to reach the result panel (only "回到首页").
    let tutorialHintTried = false;
    for (let step = 0; step < 200; step += 1) {
      const state = await pages[0].cdp.evaluate(`(() => ({
        result: !document.getElementById('tutorial-result-panel').hidden,
        playVisible: !document.getElementById('tutorial-play-btn').hidden,
        playDisabled: document.getElementById('tutorial-play-btn').disabled,
        skipVisible: !document.getElementById('tutorial-skip-btn').hidden,
        skipDisabled: document.getElementById('tutorial-skip-btn').disabled,
        hintVisible: !document.getElementById('tutorial-hint-btn').hidden,
        popupConfirm: !document.getElementById('tutorial-rule-pop').hidden && !!document.querySelector('[data-tutorial-pop-close]'),
      }))()`);
      if (state.result) break;
      if (state.popupConfirm) {
        await pages[0].cdp.evaluate("document.querySelector('[data-tutorial-pop-close]').click()");
        await sleep(140);
        continue;
      }
      if (state.playVisible && !state.playDisabled) {
        tutorialHintTried = false;
        await pages[0].cdp.evaluate("document.getElementById('tutorial-play-btn').click()");
        await sleep(180);
        continue;
      }
      if (state.hintVisible && !tutorialHintTried) {
        tutorialHintTried = true;
        await pages[0].cdp.evaluate("document.getElementById('tutorial-hint-btn').click()");
        await sleep(160);
        continue;
      }
      if (state.skipVisible && !state.skipDisabled) {
        tutorialHintTried = false;
        await pages[0].cdp.evaluate("document.getElementById('tutorial-skip-btn').click()");
        await sleep(180);
        continue;
      }
      await sleep(140);
    }
    await pages[0].cdp.waitFor("!document.getElementById('tutorial-result-panel').hidden", 10000, 'tutorial result panel');
    const tutorialResult = await pages[0].cdp.evaluate(`(() => ({
      buttons: [...document.querySelectorAll('#tutorial-result-panel button')].map((node) => node.id || node.textContent),
      cards: document.querySelectorAll('.tutorial-result .tutorial-result-row').length,
    }))()`);
    if (tutorialResult.buttons.length !== 1 || tutorialResult.buttons[0] !== 'tutorial-home-btn') {
      throw new Error(`tutorial result should only offer home, got: ${tutorialResult.buttons.join(',')}`);
    }
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-tutorial-result.png'));
    await pages[0].cdp.evaluate("document.getElementById('tutorial-home-btn').click()");
    await pages[0].cdp.waitFor("document.getElementById('tutorial-match').hidden", 3000, 'tutorial closed');

    const names = ['青禾', '小满', '老K', '南风'];
    await setName(pages[0].cdp, names[0]);
    await pages[0].cdp.evaluate("document.getElementById('home-create-btn').click()");
    await pages[0].cdp.waitFor(
      "document.getElementById('screen-room').classList.contains('is-active') && document.getElementById('room-code-display').textContent.trim() !== '----'",
      8000,
      'room created',
    );
    await pages[0].cdp.waitFor(
      "(() => { const node = document.querySelector('#room-slots .room-slot.you .slot-avatar'); return !!node && node.hasAttribute('data-avatar-player') && getComputedStyle(node).backgroundImage.includes('data:image'); })()",
      6000,
      'room avatar rendered',
    );
    const code = await pages[0].cdp.evaluate("document.getElementById('room-code-display').textContent.trim()");
    if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error(`bad room code ${code}`);
    console.log('room:', code);

    for (let i = 1; i < 4; i += 1) {
      await setName(pages[i].cdp, names[i]);
      await pages[i].cdp.evaluate(`(() => {
        document.getElementById('home-join-btn').click();
        const input = document.getElementById('home-join-code');
        input.value = ${JSON.stringify(code)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('home-join-submit').click();
        return true;
      })()`);
      await pages[i].cdp.waitFor(
        "document.getElementById('screen-room').classList.contains('is-active')",
        8000,
        `player ${i} in room`,
      );
    }

    for (let i = 1; i < 4; i += 1) {
      await pages[i].cdp.evaluate("document.getElementById('ready-btn').click()");
    }
    await pages[0].cdp.waitFor(
      "!document.getElementById('start-btn').disabled && !document.getElementById('start-btn').hidden",
      8000,
      'start enabled',
    );
    await sleep(250);
    await pages[0].cdp.evaluate("document.getElementById('counter-toggle').click()");
    await pages[0].cdp.waitFor(
      "document.getElementById('counter-toggle').getAttribute('aria-checked') === 'true'",
      5000,
      'counter enabled',
    );
    await sleep(250);
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-room.png'));
    await pages[0].cdp.evaluate("document.getElementById('start-btn').click()");
    await sleep(450);
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-deal.png'));

    for (const page of pages) {
      await page.cdp.waitFor(
        "document.getElementById('screen-game').classList.contains('is-active') && document.querySelectorAll('#hand [data-card-id]').length === 13",
        10000,
        'game screen with 13 cards',
      );
    }
    await pages[0].cdp.waitFor(
      "!document.getElementById('private-identity').hidden",
      4000,
      'private identity reveal',
    );
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-private-id.png'));
    await pages[0].cdp.waitFor(
      "document.getElementById('private-identity').hidden",
      4000,
      'private identity complete',
    );
    await pages[0].cdp.waitFor(
      "!document.getElementById('counter-panel').hidden && document.querySelectorAll('#counter-chips .counter-chip').length === 13",
      5000,
      'card counter visible',
    );
    await pages[0].cdp.evaluate("document.getElementById('counter-panel').click()");
    await pages[0].cdp.waitFor(
      "!document.getElementById('counter-modal').hidden && document.querySelectorAll('#counter-detail .counter-stack').length === 13",
      5000,
      'counter detail modal',
    );
    await sleep(250);
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-counter-detail.png'));
    await pages[0].cdp.evaluate("document.querySelector('#counter-modal [data-close-modal=\"counter\"]').click()");
    await sleep(250);
    await pages[0].cdp.evaluate("document.getElementById('game-trust-btn').click()");
    await sleep(500);
    await pages[0].cdp.evaluate("document.getElementById('game-trust-btn').click()");
    await sleep(500);
    await pages[0].cdp.waitFor(
      "!document.body.classList.contains('deal-running')",
      6000,
      'deal animation complete',
    );
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-game-start.png'));
    await pages[0].cdp.evaluate("document.getElementById('game-log-btn').click()");
    await pages[0].cdp.waitFor("!document.getElementById('log-drawer').hidden", 3000, 'log drawer');
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-log.png'));
    await pages[0].cdp.evaluate("document.getElementById('log-close-btn').click()");
    await pages[0].cdp.waitFor("document.getElementById('log-drawer').hidden", 2000, 'log close');
    await pages[0].cdp.waitFor(
      "(() => { const node = document.querySelector('#self-pod .self-avatar'); return !!node && node.hasAttribute('data-avatar-player') && getComputedStyle(node).backgroundImage.includes('data:image'); })()",
      6000,
      'game avatar rendered',
    );

    // Emoji: dynamic picker → send → own bubble → 3s lock/unlock.
    await pages[0].cdp.evaluate("document.getElementById('emote-btn').click()");
    await pages[0].cdp.waitFor(
      "!document.getElementById('emote-menu').hidden && document.querySelectorAll('#emote-menu .emoji-item[data-emoji]').length >= 20",
      3000,
      'emoji picker with 20+ items',
    );
    const emojiValue = await pages[0].cdp.evaluate(
      "document.querySelector('#emote-menu .emoji-item[data-emoji]').dataset.emoji",
    );
    await pages[0].cdp.evaluate(
      "document.querySelector('#emote-menu .emoji-item[data-emoji]').click()",
    );
    await pages[0].cdp.waitFor(
      "document.querySelector('#emote-layer .emote-bubble')?.textContent === " + JSON.stringify(emojiValue),
      5000,
      'own emoji bubble',
    );
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-emoji-bubble.png'));
    const lockedMenuHidden = await pages[0].cdp.evaluate(`(() => {
      document.getElementById('emote-btn').click();
      return document.getElementById('emote-menu').hidden;
    })()`);
    if (!lockedMenuHidden) throw new Error('emoji send lock should block reopening picker');
    await pages[0].cdp.waitFor(
      "document.querySelectorAll('#emote-layer .emote-bubble').length === 0",
      7000,
      'emoji bubble removed after 3s',
    );
    await pages[0].cdp.waitFor(
      "document.getElementById('emote-btn').title === '表情互动'",
      6000,
      'emoji unlocked after 3s',
    );
    const unlockedPickerOpen = await pages[0].cdp.evaluate(`(() => {
      document.getElementById('emote-btn').click();
      const open = !document.getElementById('emote-menu').hidden;
      if (open) document.getElementById('emote-btn').click();
      return open;
    })()`);
    if (!unlockedPickerOpen) throw new Error('emoji picker should open again after 3s');
    await sleep(600);
    console.log('emoji: picker, bubble, 3s lock/unlock ok');

    // Gift: another player's basket → flower → fly → bloom → 3s cleanup.
    await pages[0].cdp.evaluate("document.querySelector('.game-stage .player-pod .gift-basket-btn').click()");
    await pages[0].cdp.waitFor("!document.getElementById('gift-menu').hidden", 3000, 'gift menu open');
    const giftTargetSeat = await pages[0].cdp.evaluate("document.getElementById('gift-menu').dataset.seat");
    if (!/^[0-9]$/.test(String(giftTargetSeat || ''))) throw new Error(`bad gift target seat: ${giftTargetSeat}`);
    await pages[0].cdp.evaluate("document.querySelector('#gift-menu [data-gift=\"flower\"]').click()");
    await pages[0].cdp.waitFor("document.querySelectorAll('#emote-layer .gift-fly').length > 0", 3000, 'gift fly');
    await pages[0].cdp.waitFor("document.querySelectorAll('#emote-layer .gift-bloom').length > 0", 4000, 'gift bloom');
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-gift-bloom.png'));
    await pages[0].cdp.waitFor(
      "document.querySelectorAll('#emote-layer .gift-fly, #emote-layer .gift-bloom').length === 0",
      7000,
      'gift animation finished (3s)',
    );
    console.log('gift: basket → fly → bloom → cleanup ok');

    // Scoring: single global round score in the topbar + personal cumulative scores on pods.
    const scoreUi = await pages[0].cdp.evaluate(`(() => ({
      label: document.getElementById('shared-score').querySelector('.shared-score-label')?.textContent || '',
      value: document.getElementById('shared-score').querySelector('.shared-score-value')?.textContent || '',
      personal: document.querySelector('#self-pod .personal-score')?.textContent || '',
      podScores: document.querySelectorAll('.player-pod .personal-score').length,
      legacyLabel: document.getElementById('shared-score').textContent.includes('全局积分'),
    }))()`);
    if (scoreUi.label !== '本局积分') throw new Error(`shared score label should be 本局积分, got ${scoreUi.label}`);
    if (!/^[0-9]+$/.test(scoreUi.value) || Number(scoreUi.value) < 2) {
      throw new Error(`bad roundScore in topbar: ${scoreUi.value}`);
    }
    if (!/[0-9]/.test(scoreUi.personal)) throw new Error('self personal score missing');
    if (scoreUi.podScores < 3) throw new Error(`expected 3 pod personal scores, got ${scoreUi.podScores}`);
    if (scoreUi.legacyLabel) throw new Error('legacy 全局积分 label still present');
    console.log('score: round', scoreUi.value, '| self personal', scoreUi.personal.trim());

    // Mobile layout check on a guest tab.
    await pages[1].cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390,
      height: 844,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(400);
    await pages[1].cdp.screenshot(path.join(OUT_DIR, 'ui-game-mobile.png'));
    await pages[1].cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 844,
      height: 390,
      deviceScaleFactor: 1,
      mobile: true,
    });
    await sleep(400);
    await pages[1].cdp.screenshot(path.join(OUT_DIR, 'ui-game-landscape.png'));
    await pages[1].cdp.evaluate("document.getElementById('game-counter-btn').click()");
    await pages[1].cdp.waitFor(
      "!document.getElementById('counter-modal').hidden",
      3000,
      'mobile counter detail',
    );
    await sleep(250);
    await pages[1].cdp.screenshot(path.join(OUT_DIR, 'ui-counter-mobile.png'));
    await pages[1].cdp.evaluate("document.querySelector('#counter-modal [data-close-modal=\"counter\"]').click()");
    await pages[1].cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await sleep(250);

    let guard = 0;
    let firstPlaySeen = false;
    let identitySeen = false;
    let identityText = '';
    let resultSeen = false;
    let hintTested = false;

    while (guard < 150) {
      guard += 1;
      if (guard >= 150) throw new Error('UI game did not finish');
      await sleep(80);

      const states = await Promise.all(pages.map((page) => page.cdp.evaluate(`(() => ({
        inGame: document.getElementById('screen-game').classList.contains('is-active'),
        ended: !document.getElementById('result-modal').hidden,
        result: !document.getElementById('result-modal').hidden,
        yours: document.querySelector('.turn-banner')?.classList.contains('yours') || false,
        hand: [...document.querySelectorAll('#hand [data-card-id]')].map((node) => node.dataset.cardId),
        last: document.getElementById('last-play').hidden
          ? []
          : [...document.querySelectorAll('#last-play-cards [data-card-id]')].map((node) => node.dataset.cardId),
        mustDiamond: !document.getElementById('center-empty').hidden &&
          document.getElementById('center-empty').textContent.includes('4'),
        toastError: document.querySelector('.toast.error')?.textContent || '',
      }))()`)));

      if (states.some((state) => state.toastError)) {
        throw new Error(`UI error toast: ${states.find((state) => state.toastError).toastError}`);
      }

      const ended = states.some((state) => state.ended || state.result);
      if (ended) {
        resultSeen = true;
        break;
      }

      const activeIndex = states.findIndex((state) => state.yours);
      if (activeIndex === -1) continue;
      const page = pages[activeIndex];
      const state = states[activeIndex];
      await page.cdp.waitFor(
        "document.getElementById('play-animation').hidden",
        3500,
        'play animation complete',
      );
      const previousCombo = state.last.length ? classify(state.last.map((id) => CARD_BY_ID[id])) : null;
      const moves = findLegalMoves(
        state.hand.map((id) => CARD_BY_ID[id]),
        previousCombo,
        { mustIncludeDiamond4: state.mustDiamond },
      );

      if (!firstPlaySeen && moves.length > 0) firstPlaySeen = true;

      if (!hintTested) {
        await page.cdp.evaluate("document.getElementById('hint-btn').click()");
        await sleep(260);
        const hinted = await page.cdp.evaluate(
          "document.querySelectorAll('#hand [data-card-id].selected').length",
        );
        if (!hinted) throw new Error('hint did not select any cards');
        await page.cdp.screenshot(path.join(OUT_DIR, 'ui-selection.png'));
        await page.cdp.evaluate("document.getElementById('clear-btn').click()");
        hintTested = true;
      }

      if (moves.length === 0) {
        const passEnabled = await page.cdp.evaluate("!document.getElementById('pass-btn').disabled");
        if (!passEnabled) throw new Error('no legal moves and pass button disabled');
        await page.cdp.evaluate("document.getElementById('pass-btn').click()");
      } else {
        const identityMoves = moves.filter((move) =>
          move.cards.some((card) => card.id === 'sA' || card.id === 's3'),
        );
        const move = identityMoves[0] || moves[0];
        const ids = move.cards.map((card) => card.id);
        await page.cdp.evaluate(`(() => {
          const clear = document.getElementById('clear-btn');
          if (!clear.hidden) clear.click();
          for (const id of ${JSON.stringify(ids)}) {
            document.querySelector('#hand [data-card-id="' + id + '"]').click();
          }
          return true;
        })()`);
        await sleep(80);
        const playEnabled = await page.cdp.evaluate("!document.getElementById('play-btn').disabled");
        if (!playEnabled) {
          const info = await page.cdp.evaluate("document.getElementById('selection-info').textContent");
          throw new Error(`play button disabled for ${ids.join(',')}: ${info}`);
        }
        await page.cdp.evaluate("document.getElementById('play-btn').click()");
        if (!firstPlaySeen) firstPlaySeen = true;
        if (!identitySeen && ids.some((id) => id === 'sA' || id === 's3')) {
          // wait below for alert
        }
      }

      await page.cdp.waitFor(`(() => {
        const result = !document.getElementById('result-modal').hidden;
        const yours = document.querySelector('.turn-banner')?.classList.contains('yours') || false;
        return result || !yours;
      })()`, 8000, `action by seat ${activeIndex}`).catch(async (error) => {
        const info = await page.cdp.evaluate(`(() => ({
          selection: document.getElementById('selection-info').textContent,
          toast: document.querySelector('.toast')?.textContent || '',
          banner: document.querySelector('.turn-banner')?.textContent || '',
        }))()`);
        throw new Error(`${error.message} :: ${JSON.stringify(info)}`);
      });

      await sleep(140);
      const alertText = await pages[0].cdp.evaluate("document.querySelector('.identity-alert')?.innerText || ''");
      if (alertText && !identitySeen) {
        identitySeen = true;
        identityText = alertText;
        await sleep(450);
        await page.cdp.screenshot(path.join(OUT_DIR, 'ui-identity.png'));
      }
      if (alertText) {
        await Promise.all(pages.map((entry) =>
          entry.cdp.evaluate("document.querySelector('.identity-dismiss')?.click(); true"),
        ));
        await sleep(300);
      }
    }

    if (!resultSeen) throw new Error('result was not reached');
    await sleep(700);
    await Promise.all(pages.map((page) =>
      page.cdp.evaluate("document.querySelector('.identity-dismiss')?.click(); true"),
    ));
    await sleep(350);

    await pages[0].cdp.send('Page.bringToFront');
    await sleep(450);
    const resultOpen = await pages[0].cdp.evaluate("!document.getElementById('result-modal').hidden");
    if (!resultOpen) {
      await pages[0].cdp.waitFor(
        "!document.getElementById('result-modal').hidden",
        8000,
        'result modal auto-open',
      );
    }
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-result.png'));
    await pages[0].cdp.evaluate("document.getElementById('result-borrow-toggle').click()");
    await pages[0].cdp.waitFor(
      "document.getElementById('result-borrow-toggle').getAttribute('aria-checked') === 'true'",
      4000,
      'result borrow on',
    );
    await pages[0].cdp.evaluate("document.getElementById('result-borrow-toggle').click()");
    await pages[0].cdp.waitFor(
      "document.getElementById('result-borrow-toggle').getAttribute('aria-checked') === 'false'",
      4000,
      'result borrow off',
    );

    const finalState = await pages[0].cdp.evaluate(`(() => ({
      winner: document.getElementById('result-title').textContent,
      reason: document.getElementById('result-reason').textContent,
      rankings: [...document.querySelectorAll('#result-ranking li')].map((node) => node.innerText),
      handCards: document.querySelectorAll('#hand [data-card-id]').length,
      roundLabel: document.getElementById('shared-score').querySelector('.shared-score-label')?.textContent || '',
      headCols: [...document.querySelectorAll('#result-teams .score-board-head span')].map((node) => node.textContent),
      deltas: [...document.querySelectorAll('#result-teams .score-delta')].map((node) => node.textContent),
      totals: [...document.querySelectorAll('#result-teams .score-total')].map((node) => node.textContent),
      resultRuleRows: document.querySelectorAll('#result-modal .result-rule-row').length,
      scoringToggleVisible: (() => { const node = document.getElementById('result-scoring-toggle'); return Boolean(node && node.offsetParent !== null); })(),
      resultSharedHidden: (() => { const node = document.getElementById('result-shared-score'); return !node || node.offsetParent === null || node.hidden; })(),
      resultSharedEmpty: (() => { const node = document.getElementById('result-shared-score'); return !node || node.innerHTML.trim() === ''; })(),
    }))()`);

    if (finalState.roundLabel !== '本局积分') {
      throw new Error(`topbar label should stay 本局积分, got ${finalState.roundLabel}`);
    }
    if (finalState.headCols.length !== 5) {
      throw new Error(`result table should have 5 columns, got ${finalState.headCols.join('|')}`);
    }
    if (finalState.deltas.length !== 4 || finalState.totals.length !== 4) {
      throw new Error(`result should show 4 deltas and 4 totals, got ${finalState.deltas.length}/${finalState.totals.length}`);
    }
    const deltaSum = finalState.deltas.reduce((sum, text) => sum + Number(text || 0), 0);
    if (deltaSum !== 0) throw new Error(`zero-sum expected, got ${deltaSum}`);
    if (finalState.totals.some((text) => !/^-?[0-9]+$/.test(text.trim()))) {
      throw new Error(`bad personal total: ${finalState.totals.join('|')}`);
    }
    if (finalState.resultRuleRows !== 2) {
      throw new Error(`result rules should only show tribute/borrow, got ${finalState.resultRuleRows} rows`);
    }
    if (finalState.scoringToggleVisible) throw new Error('result scoring toggle should not be visible');
    if (!finalState.resultSharedHidden) throw new Error('result-shared-score should stay hidden');
    if (!finalState.resultSharedEmpty) throw new Error('result-shared-score should not be rendered by app');
    console.log('result score: deltas', finalState.deltas.join(','), '| totals', finalState.totals.join(','));

    await pages[0].cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 844,
      height: 390,
      deviceScaleFactor: 1,
      mobile: true,
      screenOrientation: { type: 'landscapePrimary', angle: 90 },
    });
    await sleep(250);
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-result-landscape.png'));
    await pages[0].cdp.send('Emulation.clearDeviceMetricsOverride');

    await pages[2].cdp.send('Page.bringToFront');
    await sleep(400);
    // 结算页不再允许关闭:Esc 不应关掉结果弹层(右上角按钮是退出房间)。
    await pages[2].cdp.evaluate(
      "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true",
    );
    await sleep(200);
    const resultStillOpen = await pages[2].cdp.evaluate(
      "!document.getElementById('result-modal').hidden",
    );
    if (!resultStillOpen) throw new Error('result modal should not close with Escape');
    await pages[2].cdp.evaluate("document.querySelector('[data-open-rules]').click(); true");
    await sleep(700);
    await pages[2].cdp.screenshot(path.join(OUT_DIR, 'ui-rules.png'));

    await pages[2].cdp.evaluate("document.querySelector('[data-close-modal=\"rules\"]')?.click(); true");
    await sleep(200);

    await pages[0].cdp.evaluate("document.getElementById('restart-btn').click()");
    for (const page of pages) {
      await page.cdp.waitFor(`(() => {
        const game = document.getElementById('screen-game').classList.contains('is-active');
        const cards = document.querySelectorAll('#hand [data-card-id]').length;
        const result = !document.getElementById('result-modal').hidden;
        return game && cards === 13 && !result;
      })()`, 10000, 'rematch dealt');
    }
    console.log('rematch: dealt 13 cards to all four players');

    const singlePage = await createPage();
    pages.push(singlePage);
    await setName(singlePage.cdp, '单机测试');
    await singlePage.cdp.evaluate("document.getElementById('home-single-btn').click()");
    await singlePage.cdp.waitFor(`(() => {
      const game = document.getElementById('screen-game').classList.contains('is-active');
      const cards = document.querySelectorAll('#hand [data-card-id]').length;
      const bots = document.querySelectorAll('.bot-badge').length;
      return game && cards === 13 && bots === 3;
    })()`, 10000, 'single-player game').catch(async (error) => {
      console.log('single debug', await singlePage.cdp.evaluate(`JSON.stringify({
        screen: document.querySelector('.screen.is-active')?.id,
        hand: document.querySelectorAll('#hand [data-card-id]').length,
        bots: document.querySelectorAll('.bot-badge').length,
        body: document.body.className,
        toast: document.querySelector('.toast')?.textContent || '',
        deal: !document.getElementById('deal-animation').hidden,
        privateId: !document.getElementById('private-identity').hidden,
      })`));
      console.log('single browser errors', singlePage.cdp.errors.join(' | '));
      throw error;
    });
    await singlePage.cdp.waitFor(
      "!document.body.classList.contains('deal-running')",
      6000,
      'single deal complete',
    );
    await sleep(400);
    const singleInfo = await singlePage.cdp.evaluate(`(() => ({
      phase: document.getElementById('game-phase-label').textContent,
      trustHidden: document.getElementById('game-trust-btn').hidden,
      trustDisabled: document.getElementById('game-trust-btn').disabled,
      counter: !document.getElementById('counter-panel').hidden,
      singleButtons: !document.getElementById('single-counter-btn').hidden,
      sharedScoreVisible: !document.getElementById('shared-score').hidden,
      selfPersonal: document.querySelector('#self-pod .personal-score')?.textContent || '',
      botPersonal: document.querySelectorAll('.player-pod .personal-score').length,
      giftBaskets: document.querySelectorAll('.player-pod .gift-basket-btn').length,
    }))()`);
    if (!singleInfo.singleButtons) throw new Error('single-player settings buttons missing');
    if (singleInfo.trustHidden) throw new Error('trust button should be visible in single-player');
    if (singleInfo.trustDisabled) throw new Error('trust button should be enabled in single-player');
    if (!singleInfo.counter) throw new Error('single-player counter should be enabled');
    if (!singleInfo.sharedScoreVisible) throw new Error('single-player shared score should be visible');
    if (!/[0-9]/.test(singleInfo.selfPersonal)) throw new Error('single-player self personal score missing');
    if (singleInfo.botPersonal !== 3) throw new Error(`single-player should show 3 bot personal scores, got ${singleInfo.botPersonal}`);
    if (singleInfo.giftBaskets !== 3) throw new Error(`single-player should show 3 bot gift baskets, got ${singleInfo.giftBaskets}`);
    await singlePage.cdp.screenshot(path.join(OUT_DIR, 'ui-single.png'));

    // Single-player trust: the button must send trust and reflect autoPlay from server state.
    await singlePage.cdp.evaluate("document.getElementById('game-trust-btn').click()");
    await singlePage.cdp.waitFor(
      "document.getElementById('game-trust-btn').textContent.trim() === '取消'",
      6000,
      'single-player trust enabled',
    );
    await singlePage.cdp.evaluate("document.getElementById('game-trust-btn').click()");
    await singlePage.cdp.waitFor(
      "document.getElementById('game-trust-btn').textContent.trim() === '托管'",
      6000,
      'single-player trust cancelled',
    );
    console.log('single-player: trust toggled on/off');

    // Single-player gift: bot basket → egg → fly → smash.
    await singlePage.cdp.evaluate("document.querySelector('.player-pod .gift-basket-btn').click()");
    await singlePage.cdp.waitFor("!document.getElementById('gift-menu').hidden", 3000, 'single gift menu');
    await singlePage.cdp.evaluate("document.querySelector('#gift-menu [data-gift=\"egg\"]').click()");
    await singlePage.cdp.waitFor("document.querySelectorAll('#emote-layer .gift-fly').length > 0", 3000, 'single gift fly');
    await singlePage.cdp.waitFor("document.querySelectorAll('#emote-layer .gift-smash').length > 0", 4000, 'single egg smash');
    await singlePage.cdp.waitFor(
      "document.querySelectorAll('#emote-layer .gift-fly, #emote-layer .gift-smash').length === 0",
      7000,
      'single gift cleanup',
    );
    console.log('single-player: 3 bots ready; gift basket egg/smash ok');

    const browserErrors = pages.flatMap((page) => page.cdp.errors);
    if (browserErrors.length) {
      throw new Error(`browser errors:\n${browserErrors.join('\n')}`);
    }

    console.log('first play:', firstPlaySeen);
    console.log('identity alert:', identitySeen);
    if (identitySeen) console.log(identityText.split('\n').filter(Boolean).join(' | '));
    console.log('final:', JSON.stringify(finalState, null, 2));
    console.log('UI SMOKE PASSED');
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
