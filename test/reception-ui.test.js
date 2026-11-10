const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ local = new Map(), online = true, respond, operator = '甲', ensure } = {}) {
  const nodes = new Map(), calls = [];
  function node() {
    const handlers = {};
    return { value: '', textContent: '', hidden: false, disabled: false, children: [],
      addEventListener: (event, fn) => { handlers[event] = fn; }, fire() { return handlers.click?.(); },
      append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, focus() {} };
  }
  const get = key => { if (!nodes.has(key)) nodes.set(key, node()); return nodes.get(key); };
  const ctx = {
    document: { querySelector: get, createElement: node },
    window: { localStorage: { getItem: k => local.get(k), setItem: (k, v) => local.set(k, v), removeItem: k => local.delete(k) },
      confirm: () => true, addEventListener() {} },
    selectedGuest: { ok: true, guestId: 'G1', members: '成哥、家人', partySize: 3, cakeGroupId: 'C1' },
    getSettings: () => ({ apiUrl: 'https://api.test/exec' }), readSessionOperator: () => operator,
    ensureSession: async () => { if (ensure) ensure(ctx); return true; }, readSessionToken: () => 'token',
    isBrowserOnline: () => online, messageOf: e => e.message, createRequestId: () => 'request-unique',
    updateGiftButtons() {}, handleUnauthorized() {},
    jsonpRequest: async (settings, request) => { calls.push(request);
      return respond ? respond(request) : { ok: true, status: 'COUNT_SAVED', record: { envelopeCode: 'E001' } }; } };
  vm.runInNewContext(fs.readFileSync('docs/reception.js', 'utf8'), ctx);
  return { ctx, get, local, calls,
    show: async () => { ctx.window.Reception.show(ctx.selectedGuest); await tick(); },
    click: async key => { get(key).fire(); await tick(); } };
}
test('接待卡顯示同行資訊，掃卡不發送喜餅請求', async () => {
  const f = fixture();
  await f.show();
  assert.equal(f.calls.length, 0);
  assert.match(f.get('#partyMembers').textContent, /成哥/);
});

test('例外收件逾時後保留原請求，重新開啟可核對並取得 E 編號', async () => {
  const local = new Map();
  const first = fixture({ local, respond: () => { throw new Error('timeout'); } });
  await first.show();
  first.get('#extraEnvelopeSignature').value = '測試署名';
  await first.click('#receiveExtraButton');
  assert.equal(first.get('#receiveExtraButton').disabled, true);
  const restored = fixture({ local });
  await restored.click('#receptionRetry');
  assert.equal(restored.calls[0].requestId, first.calls[0].requestId);
  assert.equal(restored.calls[0].data, first.calls[0].data);
  assert.match(restored.get('#receptionFeedback').textContent, /E001/);
  assert.equal(local.size, 0);
});

test('舊版待核對的喜餅操作僅由原人員及原帳本重試', async () => {
  const local = new Map([['wedding-reception-operation-v1', JSON.stringify({ action: 'cakeIssue', guestId: 'G1',
    apiUrl: 'https://api.test/exec', operator: '甲', requestId: 'original-request', attempts: 1, data: { western: 1, chinese: 0 } })]]);
  const other = fixture({ local, operator: '乙' }); await other.click('#receptionRetry');
  assert.equal(other.calls.length, 0); assert.equal(local.size, 1);
  const refreshed = fixture({ local, ensure: c => { c.readSessionOperator = () => '乙'; } }); await refreshed.click('#receptionRetry');
  assert.equal(refreshed.calls.length, 0); assert.equal(local.size, 1);
  const differentApi = fixture({ local });
  differentApi.ctx.getSettings = () => ({ apiUrl: 'https://other.test/exec' });
  await differentApi.click('#receptionRetry');
  assert.equal(differentApi.calls.length, 0); assert.equal(local.size, 1);
  const original = fixture({ local, respond: () => ({ ok: true, status: 'CAKE_REPLAY' }) });
  await original.click('#receptionRetry');
  assert.equal(original.calls[0].action, 'cakeIssue');
  assert.equal(original.calls[0].requestId, 'original-request');
  assert.match(original.get('#receptionFeedback').textContent, /已核對/);
  assert.equal(local.size, 0);
});
test('第二包由接待登記待清點，金額留白且E編號留在視窗', async () => {
  const f = fixture({ respond: r => r.action === 'receiveExtra'
    ? { ok: true, status: 'COUNT_SAVED', record: { envelopeCode: 'E007' } } : { ok: false } });
  await f.show(); f.get('#extraEnvelopeType').value = '多包'; f.get('#extraEnvelopeSignature').value = '家人';
  await f.click('#receiveExtraButton'); const data = JSON.parse(f.calls.find(c => c.action === 'receiveExtra').data);
  assert.equal(data.amount, ''); assert.equal(data.state, '待清點'); assert.equal(data.guestId, 'G1');
  assert.match(f.get('#receptionFeedback').textContent, /E007/);
});

test('同卡背景紅包同步保留正在輸入的署名，下一位則清除舊資料', async () => {
  const f = fixture(); await f.show();
  f.get('#extraEnvelopeSignature').value = '正在填寫';
  f.ctx.window.Reception.show(f.ctx.selectedGuest);
  assert.equal(f.get('#extraEnvelopeSignature').value, '正在填寫');
  assert.equal(f.calls.length, 0);
  f.ctx.selectedGuest = null; f.ctx.window.Reception.show(null);
  assert.equal(f.get('#partyMembers').textContent, ''); assert.equal(f.get('#extraEnvelopePanel').hidden, true);
});
