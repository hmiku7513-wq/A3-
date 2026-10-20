'use strict';

process.env.PORT = '0';
process.env.HOST = '127.0.0.1';

const fs = require('node:fs');
const path = require('node:path');
const { once } = require('node:events');
const { server, rooms, startGame, closeForTests } = require('../server');

const CDP_HTTP = process.env.CDP_HTTP || 'http://127.0.0.1:9223';
const OUT_DIR = path.resolve(__dirname, '..', 'screenshots');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Page {
  constructor(target, ws) {
    this.target = target;
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        this.pending.get(message.id)(message);
        this.pending.delete(message.id);
      }
    });
  }

  static async create(width = 1440, height = 1000) {
    const response = await fetch(`${CDP_HTTP}/json/new?about:blank`, { method: 'PUT' });
    const target = await response.json();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP open timeout')), 5000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const page = new Page(target, ws);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return page;
  }

  async send(method, params = {}) {
    const requestId = ++this.id;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`${method} timeout`));
      }, 20000);
      this.pending.set(requestId, (message) => {
        clearTimeout(timer);
        if (message.error) reject(new Error(message.error.message));
        else resolve(message.result);
      });
    });
    this.ws.send(JSON.stringify({ id: requestId, method, params }));
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
      throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    }
    return result.result?.value;
  }

  async waitFor(expression, timeout = 8000, label = expression) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await this.evaluate(expression)) return;
      await sleep(60);
    }
    throw new Error(`timeout: ${label}`);
  }

  async screenshot(file) {
    await this.send('Page.bringToFront');
    await sleep(1000);
    const shot = await this.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    console.log('screenshot:', path.relative(process.cwd(), file));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
    fetch(`${CDP_HTTP}/json/close/${this.target.id}`).catch(() => {});
  }
}

async function main() {
  if (!server.listening) await once(server, 'listening');
  const port = server.address().port;
  const appUrl = `http://127.0.0.1:${port}`;
  const pages = [];
  try {
    for (let i = 0; i < 4; i += 1) {
      const page = await Page.create();
      await page.send('Page.addScriptToEvaluateOnNewDocument', {
        source: "try { localStorage.removeItem('a3.session.v1'); } catch (e) {}",
      });
      await page.send('Page.navigate', { url: appUrl });
      await page.waitFor("document.readyState === 'complete' && !!document.getElementById('home-create-btn')", 10000, 'load');
      await page.waitFor("!document.getElementById('home-create-btn').disabled", 10000, 'connected');
      pages.push(page);
    }
    console.log('tribute tabs ready', port);

    const names = ['青禾', '小满', '老K', '南风'];
    await pages[0].evaluate(`(() => {
      const input = document.getElementById('name-input');
      input.value = ${JSON.stringify(names[0])};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('home-create-btn').click();
      return true;
    })()`);
    await pages[0].waitFor("document.getElementById('screen-room').classList.contains('is-active') && document.getElementById('room-code-display').textContent.trim() !== '----'", 8000, 'room');
    const code = await pages[0].evaluate("document.getElementById('room-code-display').textContent.trim()");

    for (let i = 1; i < 4; i += 1) {
      await pages[i].evaluate(`(() => {
        const name = document.getElementById('name-input');
        name.value = ${JSON.stringify(names[i])};
        name.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('home-join-btn').click();
        const input = document.getElementById('home-join-code');
        input.value = ${JSON.stringify(code)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('home-join-submit').click();
        return true;
      })()`);
      await pages[i].waitFor("document.getElementById('screen-room').classList.contains('is-active')", 8000, `join ${i}`);
    }
    for (let i = 1; i < 4; i += 1) {
      await pages[i].evaluate("document.getElementById('ready-btn').click()");
    }
    await pages[0].waitFor("!document.getElementById('start-btn').disabled", 8000, 'start enabled');
    await pages[0].evaluate("document.getElementById('tribute-toggle').click()");
    await pages[0].waitFor("document.getElementById('tribute-toggle').getAttribute('aria-checked') === 'true'", 5000, 'tribute enabled');

    const room = rooms.get(code);
    const host = room.players.find((player) => player.id === room.hostId);
    room.phase = 'ended';
    room.lastResult = {
      winner: 'landlord',
      winnerLabel: '地主赢啦！',
      reason: '测试用上局结果。',
      landlordSeats: [0, 1],
      farmerSeats: [2, 3],
      finishOrder: [0, 1],
    };
    room.lastResultRound = 1;
    room.round = 1;
    startGame(room, host);

    for (const page of pages) {
      await page.waitFor("document.getElementById('screen-tribute').classList.contains('is-active')", 8000, 'tribute screen');
    }
    await sleep(400);
    await pages[0].screenshot(path.join(OUT_DIR, 'ui-tribute.png'));

    let guard = 0;
    const seen = new Set();
    while (guard < 30) {
      guard += 1;
      const states = await Promise.all(pages.map((page) => page.evaluate(`(() => ({
        tribute: document.getElementById('screen-tribute').classList.contains('is-active'),
        game: document.getElementById('screen-game').classList.contains('is-active'),
        pool: document.querySelectorAll('#tribute-pool .tribute-pick-card.clickable').length,
        returns: document.querySelectorAll('#tribute-return-pool .tribute-pick-card.clickable').length,
        hand: document.querySelectorAll('#tribute-hand [data-card-id]:not([disabled])').length,
        info: document.getElementById('tribute-selection-info').textContent,
        confirm: document.getElementById('tribute-confirm-btn').textContent,
      }))()`)));
      if (states.some((state) => state.game)) break;
      const activeIndex = states.findIndex((state) => state.pool > 0 || state.returns > 0 || state.hand > 0);
      if (activeIndex === -1) {
        await sleep(200);
        continue;
      }
      const page = pages[activeIndex];
      const state = states[activeIndex];

      if (state.pool > 0) {
        seen.add('pick');
        await page.evaluate(`(() => {
          document.querySelector('#tribute-pool .tribute-pick-card.clickable').click();
          document.getElementById('tribute-confirm-btn').click();
          return true;
        })()`);
      } else if (state.hand > 0) {
        seen.add('return');
        const match = state.confirm.match(/(\d+)\/(\d+)/);
        const count = match ? Number(match[2]) : 1;
        await page.evaluate(`(() => {
          const cards = [...document.querySelectorAll('#tribute-hand [data-card-id]:not([disabled])')].slice(-${count});
          for (const card of cards) card.click();
          document.getElementById('tribute-confirm-btn').click();
          return true;
        })()`);
      } else if (state.returns > 0) {
        seen.add('receive');
        await page.evaluate(`(() => {
          document.querySelector('#tribute-return-pool .tribute-pick-card.clickable').click();
          document.getElementById('tribute-confirm-btn').click();
          return true;
        })()`);
      }
      await sleep(450);
    }

    if (guard >= 30) throw new Error('tribute did not finish');
    for (const page of pages) {
      await page.waitFor("document.getElementById('screen-game').classList.contains('is-active') && document.querySelectorAll('#hand [data-card-id]').length === 13", 10000, 'game after tribute');
    }
    await sleep(700);
    await pages[0].screenshot(path.join(OUT_DIR, 'ui-after-tribute.png'));
    console.log('seen tribute actions:', [...seen].join(','));
    console.log('TRIBUTE UI SMOKE PASSED');
  } finally {
    for (const page of pages) page.close();
    await closeForTests();
  }
}

main().then(() => {
  setTimeout(() => process.exit(0), 200);
}).catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
