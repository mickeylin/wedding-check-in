const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadUi(options = {}) {
  const nodes = new Map();
  function node() {
    return { value: '', hidden: false, disabled: false, children: [],
      addEventListener() {}, focus() {}, remove() {},
      append(child) { this.children.push(child); },
      prepend(child) { this.children.unshift(child); }, replaceChildren() { this.children = []; } };
  }
  const storage = new Map([
    ['wedding-check-in-session-token', 'valid'],
    ['wedding-check-in-session-operator', options.sessionOperator || '工作人員']
  ]);
  const local = options.localStorage || new Map();
  const localStorage = options.localStorageApi || {
    getItem: key => local.get(key),
    setItem: (key, value) => local.set(key, value),
    removeItem: key => local.delete(key)
  };
  const window = { sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    localStorage, confirm: () => true, crypto: { randomUUID: () => 'request' },
    setTimeout: () => 0, clearTimeout() {}, addEventListener() {} };
  const context = { window, navigator: { onLine: options.online !== false }, document: { querySelector: selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); }, createElement: node }, Date, Map, URL };
  const source = ['checkin-gate.js', 'gift-queue.js', 'app.js'].map(file => fs.readFileSync(path.join(__dirname, '..', 'docs', file), 'utf8')).join('\n');
  vm.runInNewContext(source + '\nthis.ui = { start: startScanner, stop: stopScanner, query: queryGuest, mutate: mutateGift, next: continueToNextGuest, render: renderGiftResult, save: saveSettings, sessionToken: readSessionToken, snapshot: typeof applyGuestSnapshot === "function" ? applyGuestSnapshot : null, searchSnapshot: typeof searchGuestSnapshot === "function" ? searchGuestSnapshot : null, queue: () => giftQueue, sync: kickGiftQueue, reloadQueue: loadGiftQueue };', context);
  nodes.get('#apiUrl').value = 'https://example.test/exec';
  nodes.get('#operator').value = '工作人員';
  const requests = [];
  const guest = { ok: true, status: 'GUEST_FOUND', guestId: 'G001', displayName: '測試賓客', tableNo: '3', giftState: '未收件', canCancel: false };
  context.jsonpRequest = async (settings, request) => { requests.push(request); return guest; };
  return { context, nodes, requests, guest, ui: context.ui };
}

test('QR 查詢只送 guest；按下一位不新增紅包', async () => {
  const f = loadUi();
  await f.ui.query('G001', { source: 'scanner' });
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].action, 'guest');
  assert.equal(f.nodes.get('#receiveButton').hidden, false);
  assert.match(f.nodes.get('#checkinModalMessage').textContent, /桌號：3/);
  await f.ui.next();
  assert.equal(f.requests.length, 1);
  assert.equal(f.nodes.get('#receiveButton').hidden, true);
});

test('掃描查詢不等待相機 stop，下一位重用串流且手動停止仍有效', async () => {
  const f = loadUi();
  let starts = 0;
  let stops = 0;
  f.context.Html5Qrcode = class {
    async start() { starts++; }
    async stop() { stops++; }
  };
  await f.ui.start();
  await f.ui.query('G001', { source: 'scanner' });
  assert.equal(stops, 0, '不應在 API 查詢前關閉相機');
  await f.ui.next();
  assert.equal(starts, 1);
  await f.ui.stop();
  assert.equal(stops, 1);
});

test('收件先保存手機並立刻允許下一位；背景成功後才顯示撤銷', async () => {
  const f = loadUi();
  await f.ui.query('G001');
  let resolve;
  f.context.jsonpRequest = (settings, request) => { f.requests.push(request); return new Promise(done => { resolve = done; }); };
  await f.ui.mutate('receive');
  const pending = f.ui.sync();
  assert.equal(f.nodes.get('#nextGuestButton').disabled, false);
  assert.match(f.nodes.get('#checkinModalMessage').textContent, /保存在這支手機/);
  await f.ui.mutate('receive');
  assert.equal(f.requests.filter(request => request.action === 'receive').length, 1);
  assert.equal(f.ui.queue()[0].status, 'syncing');
  resolve({ ...f.guest, status: 'RECEIVED', giftState: '待清點', receiptId: 'receipt', canCancel: true,
    serverMs: 1200, lockWaitMs: 20, authMs: 5, guestLookupMs: 3, giftReadMs: 300,
    giftWriteMs: 400, flushMs: 200 });
  await pending;
  assert.equal(f.nodes.get('#receiveButton').hidden, true);
  assert.equal(f.nodes.get('#cancelReceiptButton').hidden, false);
  assert.equal(f.nodes.get('#nextGuestButton').disabled, false);
  assert.match(f.nodes.get('#timingStatus').textContent, /驗證工作階段/);
  assert.match(f.nodes.get('#timingStatus').textContent, /確認寫入/);
});

test('回應逾時保留本機紀錄，重試沿用相同請求編號', async () => {
  const f = loadUi();
  await f.ui.query('G001');
  f.context.jsonpRequest = async (settings, request) => {
    f.requests.push(request);
    if (f.requests.length === 2) throw new Error('API 回應逾時');
    return { ...f.guest, status: 'REPLAY', giftState: '待清點', receiptId: 'receipt', canCancel: true };
  };
  await f.ui.mutate('receive');
  await f.ui.sync();
  assert.equal(f.ui.queue()[0].status, 'retry_wait');
  const firstRequestId = f.requests[1].requestId;
  await f.ui.sync();
  assert.equal(f.requests[2].requestId, firstRequestId);
  assert.equal(f.ui.queue()[0].status, 'synced');
  assert.equal(f.nodes.get('#receiveButton').hidden, true);
  assert.equal(f.nodes.get('#cancelReceiptButton').hidden, false);
});

test('斷網收件不呼叫後端，重新載入後待同步紀錄仍存在', async () => {
  const localStorage = new Map();
  const f = loadUi({ online: false, localStorage });
  await f.ui.query('G001');
  const requestsBeforeReceive = f.requests.length;

  await f.ui.mutate('receive');
  await f.ui.sync();

  assert.equal(f.requests.length, requestsBeforeReceive);
  assert.equal(f.ui.queue()[0].status, 'queued');
  assert.match(f.nodes.get('#giftQueueSummary').textContent, /尚未進入 Google Sheet/);

  const reloaded = loadUi({ online: false, localStorage });
  assert.equal(reloaded.ui.queue()[0].guestId, 'G001');
  assert.equal(reloaded.ui.queue()[0].status, 'queued');
});

test('手機儲存失敗時不建立假收件，也不隱藏重新收件按鈕', async () => {
  const f = loadUi({ localStorageApi: {
    getItem() {}, removeItem() {}, setItem() { throw new Error('storage full'); }
  } });
  await f.ui.query('G001');

  await f.ui.mutate('receive');

  assert.equal(f.ui.queue().length, 0);
  assert.equal(f.nodes.get('#receiveButton').hidden, false);
  assert.match(f.nodes.get('#checkinModalMessage').textContent, /沒有安全記錄/);
});

test('另一支手機已先收件時轉為待核對，不把本機待辦當成同步成功', async () => {
  const f = loadUi();
  await f.ui.query('G001');
  f.context.jsonpRequest = async (settings, request) => {
    f.requests.push(request);
    return { ...f.guest, status: 'ALREADY_RECEIVED', giftState: '待清點', receiptId: 'other-receipt', canCancel: false };
  };

  await f.ui.mutate('receive');
  await f.ui.sync();

  assert.equal(f.ui.queue()[0].status, 'attention');
  assert.match(f.nodes.get('#checkinModalMessage').textContent, /待核對區/);
  assert.match(f.nodes.get('#giftQueueSummary').textContent, /待核對/);
});

test('待同步紀錄不保存 PIN 或 token，且只允許原收件人員續傳', async () => {
  const localStorage = new Map();
  const first = loadUi({ online: false, localStorage });
  first.nodes.get('#pin').value = 'secret-pin';
  await first.ui.query('G001');
  first.nodes.get('#operator').value = '只改畫面未重新登入';
  await first.ui.mutate('receive');

  const serialized = localStorage.get('wedding-check-in-gift-queue-v1');
  assert.doesNotMatch(serialized, /secret-pin|valid/);
  assert.match(serialized, /工作人員/);
  assert.doesNotMatch(serialized, /只改畫面/);

  const second = loadUi({ localStorage, sessionOperator: '另一位人員' });
  second.nodes.get('#operator').value = '另一位人員';
  await second.ui.sync();
  assert.equal(second.ui.queue()[0].status, 'queued');
  assert.match(second.nodes.get('#giftQueueSummary').textContent, /原收件人員/);
  assert.equal(second.requests.length, 0);
});

test('撤銷帶入收件ID；後端已清點時不再允許操作', async () => {
  const f = loadUi();
  f.ui.render({ ...f.guest, giftState: '待清點', receiptId: 'original', canCancel: true });
  f.context.jsonpRequest = async (settings, request) => { f.requests.push(request); return { ok: false, status: 'COUNTED', message: '已清點，請到 Sheet 更正' }; };
  await f.ui.mutate('cancel');
  assert.equal(f.requests[0].receiptId, 'original');
  assert.equal(f.nodes.get('#cancelReceiptButton').hidden, true);
});

test('手機測速顯示查詢總時間與後端時間，不暴露賓客或 token', async () => {
  const f = loadUi();
  let clock = 10000;
  f.context.Date = class extends Date { static now() { return clock; } };
  f.context.jsonpRequest = async () => { clock += 4853; return { ...f.guest, serverMs: 784, lockWaitMs: 0 }; };
  await f.ui.query('G001');
  const text = f.nodes.get('#timingStatus')?.textContent || '';
  assert.match(text, /4\.85/);
  assert.match(text, /0\.78/);
  assert.match(text, /4\.07/);
  assert.doesNotMatch(text, /G001|測試賓客|valid/);
});

test('儲存設定時立即建立 session，不把登入延遲留給第一筆查詢', async () => {
  const f = loadUi();
  f.nodes.get('#pin').value = 'test-pin';
  f.context.jsonpRequest = async (settings, request) => {
    f.requests.push(request);
    return { ok: true, status: 'SESSION_CREATED', sessionToken: 'fresh-session' };
  };

  const connected = await f.ui.save();

  assert.equal(connected, true);
  assert.deepEqual(f.requests.map(request => request.action), ['session']);
  assert.equal(f.ui.sessionToken(), 'fresh-session');
});

test('已登入快照讓賓客查詢立即顯示，不等待 Apps Script 往返', async () => {
  const f = loadUi();
  assert.equal(typeof f.ui.snapshot, 'function');
  f.ui.snapshot([{ ...f.guest, guestId: 'g001' }]);
  f.context.jsonpRequest = async (settings, request) => {
    f.requests.push(request);
    return { ...f.guest, guestId: 'g001', serverMs: 1600, lockWaitMs: 0 };
  };

  await f.ui.query('g001');

  assert.equal(f.nodes.get('#checkinModal').hidden, false);
  assert.match(f.nodes.get('#checkinModalMessage').textContent, /桌號：3/);
  assert.equal(f.requests.length, 0, '顯示賓客不應等待遠端請求');
  assert.match(f.nodes.get('#timingStatus').textContent, /本機快照/);
});

test('姓名與分類查找也使用登入快照', () => {
  const f = loadUi();
  f.ui.snapshot([
    { ...f.guest, guestId: 'g001', displayName: 'Tutu', category: '男方朋友' },
    { ...f.guest, guestId: 'g002', displayName: '共同好友', category: '共同朋友' },
    { ...f.guest, guestId: 'g003', displayName: '女方家人', category: '女方家人' }
  ]);

  const byName = f.ui.searchSnapshot('tutu', '');
  const byCategory = f.ui.searchSnapshot('', '男方朋友');

  assert.deepEqual(Array.from(byName.results, guest => guest.guestId), ['g001']);
  assert.deepEqual(Array.from(byCategory.results, guest => guest.guestId), ['g002', 'g001']);
});
