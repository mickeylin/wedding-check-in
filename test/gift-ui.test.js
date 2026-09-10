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
  vm.runInNewContext(source + '\nthis.ui = { start: startScanner, stop: stopScanner, query: queryGuest, mutate: mutateGift, next: continueToNextGuest, render: renderGiftResult };', context);
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
  resolve({ ...f.guest, status: 'RECEIVED', giftState: '待清點', receiptId: 'receipt', canCancel: true });
  await pending;
  assert.equal(f.nodes.get('#receiveButton').hidden, true);
  assert.equal(f.nodes.get('#cancelReceiptButton').hidden, false);
  assert.equal(f.nodes.get('#nextGuestButton').disabled, false);
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
