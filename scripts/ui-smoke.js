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
        this.errors.push(`exception: ${message.params.exceptionDetails?.text || 'unknown'}`);
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
  await cdp.waitFor("document.readyState === 'complete' && !!document.getElementById('create-btn')", 10000, 'app load');
  await cdp.waitFor("!document.getElementById('create-btn').disabled", 10000, 'websocket connection');
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

    const names = ['青禾', '小满', '老K', '南风'];
    await setName(pages[0].cdp, names[0]);
    await pages[0].cdp.evaluate("document.getElementById('create-btn').click()");
    await pages[0].cdp.waitFor(
      "document.getElementById('screen-room').classList.contains('is-active') && document.getElementById('room-code-display').textContent.trim() !== '----'",
      8000,
      'room created',
    );
    const code = await pages[0].cdp.evaluate("document.getElementById('room-code-display').textContent.trim()");
    if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error(`bad room code ${code}`);
    console.log('room:', code);

    for (let i = 1; i < 4; i += 1) {
      await setName(pages[i].cdp, names[i]);
      await pages[i].cdp.evaluate(`(() => {
        const input = document.getElementById('room-code-input');
        input.value = ${JSON.stringify(code)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('join-btn').click();
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

    for (const page of pages) {
      await page.cdp.waitFor(
        "document.getElementById('screen-game').classList.contains('is-active') && document.querySelectorAll('#hand [data-card-id]').length === 13",
        10000,
        'game screen with 13 cards',
      );
    }
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
    await pages[0].cdp.waitFor(
      "document.getElementById('game-trust-btn').textContent.trim() === '取消'",
      4000,
      'trust on',
    );
    await pages[0].cdp.evaluate("document.getElementById('game-trust-btn').click()");
    await pages[0].cdp.waitFor(
      "document.getElementById('game-trust-btn').textContent.trim() === '托管'",
      4000,
      'trust off',
    );
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-game-start.png'));

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
        ended: document.getElementById('game-phase-label').textContent.includes('结束'),
        result: !document.getElementById('result-modal').hidden,
        yours: document.querySelector('.turn-banner')?.classList.contains('yours') || false,
        hand: [...document.querySelectorAll('#hand [data-card-id]')].map((node) => node.dataset.cardId),
        last: document.getElementById('last-play').hidden
          ? []
          : [...document.querySelectorAll('#last-play-cards [data-card-id]')].map((node) => node.dataset.cardId),
        mustDiamond: !document.getElementById('center-empty').hidden &&
          document.getElementById('center-empty').textContent.includes('首手'),
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
        const ended = document.getElementById('game-phase-label').textContent.includes('结束');
        const yours = document.querySelector('.turn-banner')?.classList.contains('yours') || false;
        const result = !document.getElementById('result-modal').hidden;
        return ended || result || !yours;
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

    // 结算弹窗截图。
    await pages[0].cdp.send('Page.bringToFront');
    await sleep(450);
    const resultOpen = await pages[0].cdp.evaluate("!document.getElementById('result-modal').hidden");
    if (!resultOpen) {
      await pages[0].cdp.evaluate("document.getElementById('game-result-btn').click()");
      await sleep(600);
    }
    await pages[0].cdp.screenshot(path.join(OUT_DIR, 'ui-result.png'));

    const finalState = await pages[0].cdp.evaluate(`(() => ({
      winner: document.getElementById('result-title').textContent,
      reason: document.getElementById('result-reason').textContent,
      rankings: [...document.querySelectorAll('#result-ranking li')].map((node) => node.innerText),
      handCards: document.querySelectorAll('#hand [data-card-id]').length,
    }))()`);

    await pages[2].cdp.send('Page.bringToFront');
    await sleep(400);
    await pages[2].cdp.evaluate("document.querySelector('#result-modal .modal-close')?.click(); true");
    await sleep(350);
    await pages[2].cdp.evaluate("document.querySelector('[data-open-rules]').click(); true");
    await sleep(700);
    await pages[2].cdp.screenshot(path.join(OUT_DIR, 'ui-rules.png'));

    await pages[2].cdp.evaluate("document.querySelector('[data-close-modal=\"rules\"]')?.click(); true");
    await sleep(200);

    // 房主再来一局：四人仍在房间时直接发下一局。
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

    // 单机模式：一名真人 + 三名电脑玩家。
    const singlePage = await createPage();
    pages.push(singlePage);
    await setName(singlePage.cdp, '单机测试');
    await singlePage.cdp.evaluate("document.getElementById('single-btn').click()");
    await singlePage.cdp.waitFor(`(() => {
      const game = document.getElementById('screen-game').classList.contains('is-active');
      const cards = document.querySelectorAll('#hand [data-card-id]').length;
      const bots = document.querySelectorAll('.bot-badge').length;
      return game && cards === 13 && bots === 3;
    })()`, 10000, 'single-player game');
    const singleInfo = await singlePage.cdp.evaluate(`(() => ({
      phase: document.getElementById('game-phase-label').textContent,
      trustHidden: document.getElementById('game-trust-btn').hidden,
      counter: !document.getElementById('counter-panel').hidden,
    }))()`);
    if (!singleInfo.phase.includes('单机')) throw new Error('single-player label missing');
    if (!singleInfo.trustHidden) throw new Error('trust button should be hidden in single-player');
    if (!singleInfo.counter) throw new Error('single-player counter should be enabled');
    await sleep(400);
    await singlePage.cdp.screenshot(path.join(OUT_DIR, 'ui-single.png'));
    console.log('single-player: 3 bots ready');

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
