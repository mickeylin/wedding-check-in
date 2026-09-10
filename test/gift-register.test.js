const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function load(overrides = {}) {
  const source = ['Code.gs', 'GiftRegister.gs'].map(file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')).join('\n');
  const context = { Utilities: { formatDate: date => date.toISOString() }, Session: { getScriptTimeZone: () => 'Asia/Taipei' }, ...overrides };
  vm.runInNewContext(source + '\nthis.api = { handleGiftApi_, createGiftModule_, safeApiCall_, giftStatus_, auditGiftEdit, ensureGuestSheet_, generateGuestIds, GIFT_HEADERS, GUEST_HEADERS };', context);
  return context.api;
}

function fixture() {
  const api = load();
  const records = [];
  let serial = 0;
  const guests = new Map(['G001', 'G002'].map(guestId => [guestId, { guestId, displayName: '測試賓客', tableNo: '3', actualCount: 0, status: '' }]));
  const deps = { guests: { findById: id => guests.get(id) },
    lock: { runExclusive: fn => fn() }, uuid: () => 'receipt-' + ++serial,
    clock: () => new Date('2026-09-09T10:00:00Z'), store: {
      list: () => records.map(record => ({ ...record })),
      receive: record => records.push({ ...record }),
      cancel: (record, operator, now, requestId) => Object.assign(records.find(item => item.receiptId === record.receiptId),
        { state: '已撤銷', cancelledBy: operator, cancelledAt: now, cancelRequestId: requestId })
    } };
  const module = api.createGiftModule_(deps);
  const call = (action, other = {}) => module.execute({ action, guestId: 'G001', operator: '工作人員甲', requestId: 'req-' + ++serial, ...other });
  return { api, deps, module, records, guests, call };
}

test('查桌號不建立收件、不修改到場或人數', () => {
  const f = fixture();
  const result = f.call('guest');
  assert.equal(result.tableNo, '3');
  assert.equal(result.giftState, '未收件');
  assert.equal(f.records.length, 0);
  assert.equal(f.guests.get('G001').actualCount, 0);
  assert.equal(f.guests.get('G001').status, '');
});

test('唯讀查詢不排入寫入鎖，收件仍需取得鎖', () => {
  const f = fixture();
  f.deps.lock.runExclusive = () => { throw Object.assign(new Error('write lock busy'), { code: 'BUSY' }); };
  assert.equal(f.call('guest').status, 'GUEST_FOUND');
  assert.throws(() => f.call('receive'), error => error.code === 'BUSY');
});

test('明確收件才建立待清點，金額留白且保留收件人員', () => {
  const f = fixture();
  const result = f.call('receive');
  assert.equal(result.giftState, '待清點');
  assert.equal(result.canCancel, true);
  assert.equal(f.records[0].amount, '');
  assert.equal(f.records[0].receivedBy, '工作人員甲');
  assert.ok(f.records[0].receivedAt);
});

test('另一手機重複收件不覆蓋第一次資料；不同賓客可分別收件', () => {
  const f = fixture();
  f.call('receive');
  assert.equal(f.call('receive', { operator: '乙' }).status, 'ALREADY_RECEIVED');
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].receivedBy, '工作人員甲');
  f.call('receive', { guestId: 'G002' });
  assert.equal(f.records.length, 2);
});

test('撤銷保留原收件，之後可重新收件；舊請求重試不復活紅包', () => {
  const f = fixture();
  const first = f.call('receive', { requestId: 'original' });
  f.call('cancel', { receiptId: first.receiptId });
  assert.equal(f.call('receive', { requestId: 'original' }).giftState, '未收件');
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].state, '已撤銷');
  assert.ok(f.records[0].cancelledAt);
  const second = f.call('receive');
  assert.notEqual(second.receiptId, first.receiptId);
  f.call('cancel', { receiptId: first.receiptId });
  assert.equal(f.records[1].state, '待清點');
});

test('最新 Sheet 狀態阻止手機撤銷：已清點、已填金額含零元、清點時間', () => {
  for (const change of [{ state: '已清點' }, { amount: 0 }, { amount: 3600 }, { countedAt: '2026-09-09' }]) {
    const f = fixture();
    const result = f.call('receive');
    Object.assign(f.records[0], change);
    assert.throws(() => f.call('cancel', { receiptId: result.receiptId }), error => error.code === 'COUNTED');
    assert.equal(f.call('guest').canCancel, false);
  }
});

test('不存在賓客、過期收件ID與忙碌鎖都不寫入', () => {
  const f = fixture();
  assert.throws(() => f.call('receive', { guestId: 'missing' }), error => error.code === 'NOT_FOUND');
  assert.throws(() => f.call('cancel', { receiptId: 'missing' }), error => error.code === 'STALE_RECEIPT');
  f.deps.lock.runExclusive = () => { throw Object.assign(new Error('忙碌'), { code: 'BUSY' }); };
  assert.throws(() => f.call('receive'), error => error.code === 'BUSY');
  assert.equal(f.records.length, 0);
});

test('舊版 checkin API 停用；新操作均要求有效 session', () => {
  const api = load();
  assert.equal(api.safeApiCall_({ action: 'checkin' }, new Date()).status, 'UPGRADE_REQUIRED');
  for (const action of ['guest', 'receive', 'cancel']) {
    assert.equal(api.safeApiCall_({ action }, new Date()).status, 'UNAUTHORIZED');
  }
});

test('人工多包不被一般收件覆蓋，也不提供模糊撤銷', () => {
  const f = fixture();
  f.call('receive');
  f.records.push({ guestId: 'G001', receiptId: 'manual', state: '待清點', amount: '' });
  assert.equal(f.call('receive').status, 'ALREADY_RECEIVED');
  assert.equal(f.records.length, 2);
  assert.equal(f.call('guest').canCancel, false);
});

// A minimal Sheets double runs production migration and edit-trigger adapters.
function sheetDouble(name, data) {
  const sheet = { data, getName: () => name, getLastRow: () => data.length,
    getLastColumn: () => Math.max(...data.map(row => row.length), 0),
    appendRow: row => data.push(row), getDataRange: () => sheet.getRange(1, 1, data.length, sheet.getLastColumn()),
    getRange(r, c, rows = 1, cols = 1) {
      return { getValues: () => Array.from({ length: rows }, (_, y) => Array.from({ length: cols }, (_, x) => data[r - 1 + y]?.[c - 1 + x] ?? '')),
        setValues(values) { values.forEach((row, y) => row.forEach((value, x) => { data[r - 1 + y] ||= []; data[r - 1 + y][c - 1 + x] = value; })); },
        setValue(value) { this.setValues([[value]]); }, getSheet: () => sheet,
        getRow: () => r, getLastRow: () => r + rows - 1, getNumRows: () => rows, getNumColumns: () => cols,
        getA1Notation: () => `R${r}C${c}` };
    } };
  return sheet;
}

test('Sheet 直接清點補時間並留下編輯紀錄，不冒用觸發器擁有人', () => {
  const headers = Array.from(load().GIFT_HEADERS);
  const row = ['id', 'G001', '賓客', '署名', '已清點', 3600, '收件甲', '早上', '清點乙', '', '', 'req', '', '', ''];
  const gifts = sheetDouble('Gifts', [headers, row]);
  const audit = sheetDouble('GiftAudit', [['時間', '操作人員', '動作', '收件ID', '賓客ID', '變更內容']]);
  const ss = { getSheetByName: name => name === 'Gifts' ? gifts : audit, toast() {} };
  const api = load({ LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }, SpreadsheetApp: { flush() {} } });
  api.auditGiftEdit({ source: ss, range: gifts.getRange(2, 5), oldValue: '待清點', value: '已清點' });
  assert.ok(row[9]);
  assert.match(audit.data[1][1], /帳號未提供/);
  assert.equal(JSON.parse(audit.data[1][5]).oldValue, '待清點');
});

test('不完整清點改回待清點；批次紀錄明確標示缺少舊值', () => {
  const headers = Array.from(load().GIFT_HEADERS);
  const gifts = sheetDouble('Gifts', [headers, ['id', 'G001', '賓客', '', '已清點', '', '', '', '', '', '', '', '', '', '']]);
  const audit = sheetDouble('GiftAudit', [['時間', '操作人員', '動作', '收件ID', '賓客ID', '變更內容']]);
  const api = load({ LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }, SpreadsheetApp: { flush() {} } });
  api.auditGiftEdit({ source: { getSheetByName: name => name === 'Gifts' ? gifts : audit, toast() {} }, range: gifts.getRange(2, 4, 1, 3) });
  assert.equal(gifts.data[1][4], '待清點');
  assert.match(JSON.parse(audit.data[1][5]).oldValue, /批次編輯/);
});

test('賓客 schema 補欄、調整順序時保留自訂資料；重跑不變', () => {
  const sheet = sheetDouble('Guests', [['顯示姓名', '自訂欄', '賓客ID'], ['賓客', '保留內容', 'G007']]);
  const api = load();
  const ss = { getSheetByName: () => sheet };
  api.ensureGuestSheet_(ss);
  assert.equal(sheet.data[1][0], 'G007');
  assert.equal(sheet.data[1][10], '保留內容');
  const previous = JSON.stringify(sheet.data);
  api.ensureGuestSheet_(ss);
  assert.equal(JSON.stringify(sheet.data), previous);
});

test('正式 API adapter 每次只讀取兩表各一次；查詢零鎖零 flush，收件仍鎖內重讀', () => {
  const headers = load();
  const guests = sheetDouble('Guests', [Array.from(headers.GUEST_HEADERS), ['g001', 'Tutu', '男方朋友', '5', 2, '', '', '', '', '']]);
  const gifts = sheetDouble('Gifts', [Array.from(headers.GIFT_HEADERS)]);
  let reads = 0;
  let locks = 0;
  let flushes = 0;
  for (const sheet of [guests, gifts]) {
    const getRange = sheet.getRange;
    sheet.getRange = (...args) => {
      const range = getRange(...args);
      const getValues = range.getValues;
      range.getValues = () => { reads++; return getValues(); };
      return range;
    };
  }
  const now = new Date();
  const api = load({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => JSON.stringify({ operator: '測試人員', expiresAt: now.getTime() + 60000 }) }) },
    Utilities: { getUuid: () => 'receipt', formatDate: date => date.toISOString() },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: name => name === 'Guests' ? guests : gifts }), flush: () => { flushes++; } },
    LockService: { getScriptLock: () => ({ tryLock: () => { locks++; return true; }, releaseLock() {} }) }
  });
  const call = action => api.handleGiftApi_({ action, guestId: 'g001', sessionToken: 'test-token', requestId: 'test-request' }, now);
  const result = call('guest');
  assert.equal(result.tableNo, '5');
  assert.equal(reads, 2);
  assert.equal(locks, 0);
  assert.equal(flushes, 0);
  assert.equal(result.lockWaitMs, 0);
  assert.ok(result.serverMs >= 0);
  reads = 0;
  assert.equal(call('receive').status, 'RECEIVED');
  assert.equal(reads, 2);
  assert.equal(locks, 1);
  assert.equal(flushes, 1);
  gifts.data[1][4] = '已清點';
  gifts.data[1][5] = 3600;
  assert.equal(call('guest').giftState, '已清點', '不快取過時收件狀態');
});
