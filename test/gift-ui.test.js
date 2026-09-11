const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadUi() {
  const nodes = new Map();
  function node() {
    return { value: '', hidden: false, disabled: false, children: [],
      addEventListener() {}, focus() {}, remove() {},
      append(child) { this.children.push(child); },
      prepend(child) { this.children.unshift(child); }, replaceChildren() { this.children = []; } };
  }
  const storage = new Map([['wedding-check-in-session-token', 'valid']]);
  const window = { sessionStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
    localStorage: { getItem() {}, setItem() {} }, confirm: () => true, crypto: { randomUUID: () => 'request' } };
  const context = { window, document: { querySelector: selector => { if (!nodes.has(selector)) nodes.set(selector, node()); return nodes.get(selector); }, createElement: node }, Date, Map, URL };
  const source = ['checkin-gate.js', 'app.js'].map(file => fs.readFileSync(path.join(__dirname, '..', 'docs', file), 'utf8')).join('\n');
  vm.runInNewContext(source + '\nthis.ui = { start: startScanner, stop: stopScanner, query: queryGuest, mutate: mutateGift, next: continueToNextGuest, render: renderGiftResult, save: saveSettings, sessionToken: readSessionToken, snapshot: typeof applyGuestSnapshot === "function" ? applyGuestSnapshot : null, searchSnapshot: typeof searchGuestSnapshot === "function" ? searchGuestSnapshot : null };', context);
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

test('收件提交中擋連點與下一位；成功後才顯示撤銷', async () => {
  const f = loadUi();
  await f.ui.query('G001');
  let resolve;
  f.context.jsonpRequest = (settings, request) => { f.requests.push(request); return new Promise(done => { resolve = done; }); };
  const pending = f.ui.mutate('receive');
  await f.ui.mutate('receive');
  assert.equal(f.requests.filter(request => request.action === 'receive').length, 1);
  assert.equal(f.nodes.get('#nextGuestButton').disabled, true);
  assert.match(f.nodes.get('#checkinModalMessage').textContent, /G001/);
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

test('回應逾時隱藏寫入按鈕並要求核對，不自動重試', async () => {
  const f = loadUi();
  await f.ui.query('G001');
  f.context.jsonpRequest = async () => { throw new Error('API 回應逾時'); };
  await f.ui.mutate('receive');
  assert.equal(f.nodes.get('#receiveButton').hidden, true);
  assert.equal(f.nodes.get('#cancelReceiptButton').hidden, true);
  assert.match(f.nodes.get('#checkinModalMessage').textContent, /可能已寫入/);
  assert.equal(f.nodes.get('#nextGuestButton').disabled, false);
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
