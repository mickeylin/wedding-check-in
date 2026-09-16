const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture(options = {}) {
  const nodes = new Map(), storage = options.storage || new Map(), requests = [];
  let online = true, operator = '甲', serial = 0;
  function node() {
    return { value: '', hidden: false, disabled: false, textContent: '', children: [], dataset: {}, handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; },
      setAttribute() {}, focus() {}, replaceChildren() { this.children = []; },
      append(...children) { this.children.push(...children); } };
  }
  const get = id => { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); };
  get('countFilter').value = '待清點';
  const record = { receiptId: 'original', version: 'v1', guestId: 'g001', displayName: '測試賓客',
    signature: '', amount: '', state: '待清點', receivedBy: '收件甲', receivedAt: '時間', notes: '', exceptionType: '' };
  const context = {
    window: { sessionStorage: {
      getItem: key => storage.get(key), setItem: (key, value) => { if (options.storageFailure) throw new Error('full'); storage.set(key, value); },
      removeItem: key => storage.delete(key)
    }, confirm: () => true },
    document: { querySelector: selector => get(selector.slice(1)), createElement: node },
    elements: { checkinModal: { hidden: true } },
    isBrowserOnline: () => online,
    validateSettings: () => true,
    ensureSession: options.authenticate || (async () => true),
    getSettings: () => ({ apiUrl: 'https://example.test/exec' }),
    readSessionToken: () => 'session-secret', readSessionOperator: () => operator,
    handleUnauthorized() {}, stopScanner: async () => {},
    createRequestId: () => 'req-' + ++serial,
    messageOf: error => error.message,
    jsonpRequest: async (settings, request) => {
      requests.push(request);
      if (request.action === 'countList') return { ok: true, records: [record] };
      return { ok: true, status: 'COUNT_SAVED', record: { ...record, ...JSON.parse(request.data), version: 'v2' } };
    }
  };
  vm.runInNewContext(fs.readFileSync('docs/counting.js', 'utf8'), context);
  async function fire(id, event = 'click') {
    await get(id).handlers[event]({ preventDefault() {} });
    await tick();
  }
  async function edit() {
    await fire('countingMode');
    await get('countRecords').children[0].handlers.click();
    get('countAmount').value = '3600';
  }
  return { get, fire, edit, context, requests, storage, record,
    offline: () => { online = false; }, operator: value => { operator = value; } };
}

test('清點模式載入最新清單，署名預填，只有成功回應才完成', async () => {
  const f = fixture();
  await f.edit();
  assert.equal(f.get('countSignature').value, '測試賓客');
  assert.equal(f.get('receptionScanner').hidden, true);
  assert.equal(f.get('countingPanel').hidden, false);
  let resolve;
  f.context.jsonpRequest = (settings, request) => { f.requests.push(request); return new Promise(done => { resolve = done; }); };
  await f.fire('countEditor', 'submit');
  assert.equal(f.get('countFields').disabled, true);
  assert.doesNotMatch(f.get('countStatus').textContent, /已確認：/);
  resolve({ ok: true, status: 'COUNT_SAVED', record: { ...f.record, state: '已清點', amount: 3600 } });
  await tick();
  assert.equal(f.get('countEditor').hidden, true);
  assert.match(f.get('countStatus').textContent, /已確認/);
});

test('逾時保留不可變請求，重新載入後同一編號重試，操作人員不可替換', async () => {
  const f = fixture();
  await f.edit();
  f.context.jsonpRequest = async (settings, request) => { f.requests.push(request); throw new Error('API 回應逾時'); };
  await f.fire('countEditor', 'submit');
  const original = f.requests.at(-1);
  assert.equal(f.get('countRetry').hidden, false);
  assert.equal(f.get('countFields').disabled, true);
  assert.doesNotMatch([...f.storage.values()].join(''), /session-secret/);
  const restored = fixture({ storage: f.storage });
  await tick();
  restored.operator('乙');
  await restored.fire('countRetry');
  assert.equal(restored.requests.length, 0);
  assert.match(restored.get('countStatus').textContent, /原操作人員/);
  restored.operator('甲');
  await restored.fire('countRetry');
  assert.equal(restored.requests[0].requestId, original.requestId);
  assert.equal(restored.requests[0].data, original.data);
  assert.match(restored.get('countStatus').textContent, /已確認/);
});

test('離線可保留草稿，但不送出金額或顯示已清點', async () => {
  const f = fixture();
  await f.edit(); f.offline();
  await f.fire('countEditor', 'submit');
  assert.equal(f.requests.filter(r => r.action === 'countSave').length, 0);
  assert.match(f.get('countStatus').textContent, /離線/);
  assert.equal(f.get('countEditor').hidden, false);
  const saved = JSON.parse([...f.storage.values()][0]);
  assert.equal(saved.draft.values.amount, '3600');
  assert.equal(saved.pending, null);
});

test('連按儲存不產生兩筆，衝突保留輸入並要求重新載入', async () => {
  const f = fixture();
  await f.edit();
  let resolve;
  f.context.ensureSession = () => new Promise(done => { resolve = done; });
  f.get('countEditor').handlers.submit({ preventDefault() {} });
  f.get('countEditor').handlers.submit({ preventDefault() {} });
  // The editor is locked even while login is still pending.
  assert.equal(f.get('countFields').disabled, true);
  f.context.ensureSession = async () => true;
  f.context.jsonpRequest = async (settings, request) => {
    f.requests.push(request); return { ok: false, status: 'CONFLICT', message: '另一人已修改' };
  };
  resolve(true); await tick(); await tick();
  assert.equal(f.requests.filter(r => r.action === 'countSave').length, 1);
  assert.equal(f.get('countAmount').value, '3600');
  assert.equal(f.get('countFields').disabled, false);
  assert.match(f.get('countStatus').textContent, /重新載入/);
});

test('新增未知紅包可待核對，回應後提示將 E 編號寫在實體袋上', async () => {
  const f = fixture();
  await f.fire('countException');
  f.get('countType').value = '無法確認';
  f.get('countNotes').value = '無署名';
  f.context.jsonpRequest = async (settings, request) => {
    f.requests.push(request);
    return { ok: true, status: 'COUNT_SAVED',
      record: { ...f.record, receiptId: 'new', guestId: '', envelopeCode: 'E001', state: '待核對' } };
  };
  await f.fire('countHold');
  assert.equal(JSON.parse(f.requests[0].data).amount, '');
  assert.match(f.get('countStatus').textContent, /實體紅包上寫「E001」/);
});

test('草稿儲存失敗時不送出清點請求', async () => {
  const f = fixture({ storageFailure: true });
  await f.edit(); await f.fire('countEditor', 'submit');
  assert.equal(f.requests.filter(r => r.action === 'countSave').length, 0);
  assert.match(f.get('countStatus').textContent, /儲存空間/);
});
