const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture({ local = new Map(), online = true, respond, operator = '甲', ensure } = {}) {
  const nodes = new Map(), calls = [];
  const clock = { now: Date.now() };
  function node() {
    const handlers = {};
    return { value: '', textContent: '', hidden: false, disabled: false, children: [],
      addEventListener: (event, fn) => { handlers[event] = fn; }, fire() { return handlers.click?.(); },
      append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, focus() {} };
  }
  const get = key => { if (!nodes.has(key)) nodes.set(key, node()); return nodes.get(key); };
  const cake = { id: 'C1', name: '大伯家', western: 1, chinese: 1,
    issued: { western: 0, chinese: 0 }, remaining: { western: 1, chinese: 1 }, issues: [] };
  const ctx = { Date: class extends Date { static now() { return clock.now; } },
    document: { querySelector: get, createElement: node },
    window: { localStorage: { getItem: k => local.get(k), setItem: (k, v) => local.set(k, v), removeItem: k => local.delete(k) },
      confirm: () => true, prompt: () => '誤登未交付', addEventListener() {} },
    selectedGuest: { ok: true, guestId: 'G1', members: '成哥、家人', partySize: 3, cakeGroupId: 'C1' },
    getSettings: () => ({ apiUrl: 'https://api.test/exec' }), readSessionOperator: () => operator,
    ensureSession: async () => { if (ensure) ensure(ctx); return true; }, readSessionToken: () => 'token',
    isBrowserOnline: () => online, messageOf: e => e.message, createRequestId: () => 'request-unique',
    updateGiftButtons() {}, handleUnauthorized() {},
    jsonpRequest: async (settings, request) => { calls.push(request);
      return respond ? respond(request) : { ok: true, status: 'CAKE_SAVED', cake }; } };
  vm.runInNewContext(fs.readFileSync('docs/reception.js', 'utf8'), ctx);
  return { ctx, get, local, calls, cake, clock,
    show: async () => { ctx.window.Reception.show(ctx.selectedGuest); await tick(); },
    click: async key => { get(key).fire(); await tick(); } };
}
test('只查詢不發餅，確認後才傳盒數並在視窗顯示交付提示', async () => {
  const f = fixture(); await f.show();
  assert.deepEqual(f.calls.map(c => c.action), ['cakeStatus']);
  assert.match(f.get('#partyMembers').textContent, /3 人/);
  await f.click('#cakeIssue'); assert.equal(f.calls[1].action, 'cakeIssue');
  assert.equal(JSON.parse(f.calls[1].data).western, 1);
  assert.equal(f.calls[1].sessionToken, 'token');
  assert.match(f.get('#receptionFeedback').textContent, /發餅已確認/); assert.equal(f.local.size, 0);
});

test('同一共領家庭快速換卡時，共用尚未完成的狀態請求', async () => {
  let finish;
  const f = fixture({ respond: () => new Promise(resolve => { finish = resolve; }) });
  await f.show();
  f.ctx.window.Reception.show(null);
  f.ctx.selectedGuest = { ...f.ctx.selectedGuest, guestId: 'G2' };
  await f.show();
  assert.equal(f.calls.length, 1);
  finish({ ok: true, cake: f.cake }); await tick();
  assert.match(f.get('#cakeStatus').textContent, /1 盒可領/);
});

test('登入快照立即顯示共領狀態，同家庭10秒內換卡不再往返API；手動更新仍讀伺服器', async () => {
  const f = fixture();
  f.ctx.window.Reception.seed([f.cake], new Date(f.clock.now).toISOString());
  await f.show();
  assert.equal(f.calls.length, 0); assert.match(f.get('#cakeStatus').textContent, /1 盒可領/);
  assert.match(f.get('#cakeGroupLabel').textContent, /上次狀態/);
  f.ctx.window.Reception.show(null); f.ctx.selectedGuest = { ...f.ctx.selectedGuest, guestId: 'G2' };
  await f.show(); assert.equal(f.calls.length, 0);
  await f.click('#cakeRefresh'); assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].action, 'cakeStatus');
});

test('過期快照先顯示並背景更新，舊查詢回應不能覆蓋已成功的發放結果', async () => {
  let finish;
  const issued = { id: 'C1', name: '大伯家', western: 1, chinese: 1,
    issued: { western: 1, chinese: 1 }, remaining: { western: 0, chinese: 0 }, issues: [] };
  const f = fixture({ respond: request => request.action === 'cakeStatus'
    ? new Promise(resolve => { finish = resolve; }) : { ok: true, status: 'CAKE_SAVED', cake: issued } });
  f.ctx.window.Reception.seed([f.cake], new Date(f.clock.now - 20000).toISOString());
  await f.show();
  assert.match(f.get('#cakeGroupLabel').textContent, /更新中/);
  assert.match(f.get('#cakeStatus').textContent, /1 盒可領/);
  await f.click('#cakeIssue'); assert.match(f.get('#cakeStatus').textContent, /已領取/);
  finish({ ok: true, cake: f.cake }); await tick();
  assert.match(f.get('#cakeStatus').textContent, /已領取/);
  assert.equal(f.get('#cakeIssue').hidden, true);
  f.ctx.window.Reception.show(null); f.ctx.selectedGuest = { ...f.ctx.selectedGuest, guestId: 'G2' };
  await f.show(); assert.equal(f.calls.length, 2); assert.match(f.get('#cakeStatus').textContent, /已領取/);
});

test('不同API、操作人員或登入session不可沿用另一份共領快照', async () => {
  for (const change of [f => { f.ctx.getSettings = () => ({ apiUrl: 'https://other.test/exec' }); },
    f => { f.ctx.readSessionOperator = () => '乙'; }, f => { f.ctx.readSessionToken = () => 'new-token'; }]) {
    const f = fixture(); f.ctx.window.Reception.seed([f.cake], new Date(f.clock.now).toISOString());
    change(f); await f.show(); assert.equal(f.calls.length, 1);
  }
});
test('逾時重整後禁止新發放，以原請求重試並提醒不要重發', async () => {
  const local = new Map();
  const f = fixture({ local, respond: r => { if (r.action === 'cakeStatus') return { ok: true, cake: f.cake }; throw new Error('timeout'); } });
  await f.show(); await f.click('#cakeIssue');
  assert.equal(f.get('#cakeIssue').disabled, true); const original = f.calls[1]; assert.equal(local.size, 1);
  const restored = fixture({ local }); await restored.show(); assert.equal(restored.get('#cakeIssue').disabled, true);
  await restored.click('#receptionRetry'); const retry = restored.calls.find(c => c.action === 'cakeIssue');
  assert.equal(retry.requestId, original.requestId); assert.equal(retry.data, original.data);
  assert.match(restored.get('#receptionFeedback').textContent, /勿再次拿餅/); assert.equal(local.size, 0);
});
test('離線不能發餅，原操作不能由別人或登入刷新後換人續送', async () => {
  const f = fixture({ online: false }); await f.show(); await f.click('#cakeIssue');
  assert.equal(f.calls.length, 0); assert.match(f.get('#cakeStatus').textContent, /固定一人/);
  const local = new Map([['wedding-reception-operation-v1', JSON.stringify({ action: 'cakeIssue', guestId: 'G1',
    apiUrl: 'https://api.test/exec', operator: '甲', requestId: 'original-request', attempts: 1, data: { western: 1, chinese: 0 } })]]);
  const other = fixture({ local, operator: '乙' }); await other.click('#receptionRetry');
  assert.equal(other.calls.length, 0); assert.equal(local.size, 1);
  const refreshed = fixture({ local, ensure: c => { c.readSessionOperator = () => '乙'; } }); await refreshed.click('#receptionRetry');
  assert.equal(refreshed.calls.length, 0); assert.equal(local.size, 1);
});
test('第二包由接待登記待清點，金額留白且E編號留在視窗', async () => {
  const f = fixture({ respond: r => r.action === 'receiveExtra'
    ? { ok: true, status: 'COUNT_SAVED', record: { envelopeCode: 'E007' } } : { ok: true, cake: f.cake } });
  await f.show(); f.get('#extraEnvelopeType').value = '多包'; f.get('#extraEnvelopeSignature').value = '家人';
  await f.click('#receiveExtraButton'); const data = JSON.parse(f.calls.find(c => c.action === 'receiveExtra').data);
  assert.equal(data.amount, ''); assert.equal(data.state, '待清點'); assert.equal(data.guestId, 'G1');
  assert.match(f.get('#receptionFeedback').textContent, /E007/);
});

test('同卡背景紅包同步不清掉正在輸入的領餅盒數，下一位則清除舊資料', async () => {
  const f = fixture(); await f.show();
  f.get('#cakeWestern').value = '0'; f.get('#extraEnvelopeSignature').value = '正在填寫';
  f.ctx.window.Reception.show(f.ctx.selectedGuest);
  assert.equal(f.get('#cakeWestern').value, '0');
  assert.equal(f.get('#extraEnvelopeSignature').value, '正在填寫');
  assert.equal(f.calls.length, 1);
  f.ctx.selectedGuest = null; f.ctx.window.Reception.show(null);
  assert.equal(f.get('#partyMembers').textContent, ''); assert.equal(f.get('#cakePanel').hidden, true);
});
