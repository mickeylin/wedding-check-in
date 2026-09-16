const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const crypto = require('node:crypto');
const test = require('node:test');

function fixture() {
  let serial = 0, fail = '', flushes = 0;
  const source = ['Code.gs', 'GiftRegister.gs', 'CountGifts.gs'].map(p => fs.readFileSync(p, 'utf8')).join('\n');
  const tables = {};
  function sheet(name, rows) {
    const data = rows;
    const s = { data, getLastRow: () => data.length, getName: () => name,
      appendRow(row) {
        if (fail === name + ':append') { fail = ''; throw new Error('injected append failure'); }
        data.push(Array.from(row, v => typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v));
      },
      getDataRange: () => s.getRange(1, 1, data.length, Math.max(...data.map(row => row.length))),
      getRange(r, c, h = 1, w = 1) {
        return { getValues: () => Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => data[r - 1 + y]?.[c - 1 + x] ?? '')),
          setValues(values) {
            if (fail === name + ':write') { fail = ''; throw new Error('injected write failure'); }
            values.forEach((row, y) => row.forEach((v, x) => {
              data[r - 1 + y] ||= [];
              data[r - 1 + y][c - 1 + x] = typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v;
            }));
          },
          setValue(v) { this.setValues([[v]]); }
        };
      } };
    tables[name] = s; return s;
  }
  const context = {
    Utilities: { getUuid: () => 'receipt-' + ++serial, DigestAlgorithm: { SHA_256: 'sha256' }, Charset: { UTF_8: 'utf8' },
      computeDigest: (alg, str) => crypto.createHash(alg).update(str).digest(),
      base64EncodeWebSafe: bytes => Buffer.from(bytes).toString('base64url'), formatDate: date => date.toISOString() },
    Session: { getScriptTimeZone: () => 'Asia/Taipei' },
    PropertiesService: { getScriptProperties: () => ({ getProperty: key => key.endsWith('expired') ? null :
      JSON.stringify({ operator: key.endsWith('other') ? '乙' : '甲', expiresAt: new Date('2099-01-01').getTime() }) }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ({ getSheetByName: name => tables[name] }), flush: () => {
      flushes++;
      if (fail === 'flush:' + flushes) { fail = ''; throw new Error('injected flush failure'); }
    } },
    LockService: { getScriptLock: () => ({ tryLock: () => fail !== 'lock', releaseLock() {} }) }
  };
  vm.runInNewContext(source + '\nthis.api = { handleCountApi_, safeApiCall_, requireGiftSchema_, GIFT_HEADERS, GUEST_HEADERS, GIFT_AUDIT_HEADERS, giftStatus_, giftRecord_ };', context);
  const api = context.api;
  sheet('Guests', [Array.from(api.GUEST_HEADERS), ['g001', '測試賓客', '男方朋友', '5', '']]);
  sheet('Gifts', [Array.from(api.GIFT_HEADERS),
    ['original', 'g001', '測試賓客', '', '待清點', '', '收件甲', '2026-09-17', '', '', '', 'receive-1', '', '', '', '', '']]);
  sheet('GiftAudit', [Array.from(api.GIFT_AUDIT_HEADERS)]);
  const call = (action, data, requestId = 'request-0001', sessionToken = 'valid') => api.handleCountApi_({
    action, sessionToken, requestId, data: JSON.stringify(data)
  }, new Date('2026-09-17T10:00:00Z'));
  const list = () => call('countList').records;
  const edit = () => ({ receiptId: 'original', version: list()[0].version, guestId: 'g001',
    signature: '王先生', amount: '3600', notes: '', reason: '', exceptionType: '', state: '已清點' });
  return { api, tables, call, list, edit, fail: value => { fail = value; flushes = 0; } };
}

test('清點與更正寫入署名金額、人員時間，審計保留前後值與原因', () => {
  const f = fixture();
  const first = f.call('countSave', f.edit());
  assert.equal(first.record.amount, 3600);
  assert.equal(first.record.countedBy, '甲');
  assert.equal(first.record.state, '已清點');
  assert.equal(first.record.countedAt, '2026-09-17T10:00:00.000Z');
  const change = { ...f.edit(), amount: '6000', reason: '重新核對鈔票' };
  f.call('countSave', change, 'request-0002', 'other');
  assert.equal(f.list()[0].countedBy, '乙');
  const audit = JSON.parse(f.tables.GiftAudit.data[2][5]);
  assert.equal(audit.before[5], 3600);
  assert.equal(audit.after[5], 6000);
  assert.equal(audit.reason, '重新核對鈔票');
  assert.equal(f.tables.GiftAudit.data[2][2], 'COUNT_APPLIED');
});

test('另一手機與直接 Sheet 修改均使舊版本儲存失敗，不覆蓋金額', () => {
  for (const direct of [false, true]) {
    const f = fixture(), original = f.edit();
    if (direct) f.tables.Gifts.data[1][10] = '管理者更新';
    else f.call('countSave', original, 'request-0001', 'other');
    assert.throws(() => f.call('countSave', { ...original, amount: '9999' }, 'request-0002'), e => e.code === 'CONFLICT');
    assert.notEqual(f.tables.Gifts.data[1][5], 9999);
  }
});

test('空白不當成零、拒絕非法金額，零元可明確確認；更正需原因', () => {
  const f = fixture();
  for (const amount of ['', '-1', 'NaN', '1e3', '1,000', '1.001', '1000000000']) {
    assert.throws(() => f.call('countSave', { ...f.edit(), amount }), e => e.code === 'BAD_REQUEST');
  }
  assert.equal(f.tables.GiftAudit.data.length, 1);
  f.call('countSave', { ...f.edit(), amount: '0' });
  assert.equal(f.list()[0].amount, 0);
  assert.throws(() => f.call('countSave', f.edit(), 'request-0002'), e => e.code === 'BAD_REQUEST');
});

test('未知送禮人可留白待核對，獨立 E 編號；之後可連結賓客並完成清點', () => {
  const f = fixture();
  const held = f.call('countSave', { state: '待核對', exceptionType: '無法確認', notes: '封口破損，待確認', amount: '' });
  assert.equal(held.record.envelopeCode, 'E001');
  assert.equal(held.record.amount, '');
  const saved = f.call('countSave', { ...held.record, guestId: 'g001', signature: '王先生', amount: '1200', state: '已清點' }, 'request-0002');
  assert.equal(saved.record.guestId, 'g001');
  assert.equal(saved.record.envelopeCode, 'E001');
});

test('第二包及名單外各有編號，原收件不被覆蓋，重試不新增紅包', () => {
  const f = fixture();
  const input = { state: '已清點', exceptionType: '多包', guestId: 'G001', signature: '第二位', amount: '2000' };
  const first = f.call('countSave', input);
  assert.equal(first.record.envelopeCode, 'E001');
  assert.equal(first.record.guestId, 'g001');
  assert.equal(f.call('countSave', input).status, 'COUNT_REPLAY');
  assert.equal(f.tables.Gifts.data.length, 3);
  assert.equal(f.tables.Gifts.data[1][5], '');
  assert.equal(f.call('countSave', { ...input, guestId: '', exceptionType: '名單外' }, 'request-0002').record.envelopeCode, 'E002');
});

test('驗證 session、原操作者、requestId 與原內容，不允許竄改後重送', () => {
  const f = fixture(), input = f.edit();
  assert.throws(() => f.call('countList', {}, '', 'expired'), e => e.code === 'UNAUTHORIZED');
  f.call('countSave', input);
  assert.throws(() => f.call('countSave', input, 'request-0001', 'other'), e => e.code === 'REQUEST_REUSED');
  assert.throws(() => f.call('countSave', { ...input, amount: '1' }), e => e.code === 'REQUEST_REUSED');
});

test('審計寫入失敗時不更新禮金；禮金寫入或確認失敗時重試可恢復', () => {
  for (const failure of ['GiftAudit:append', 'Gifts:write', 'GiftAudit:write', 'flush:1', 'flush:2', 'flush:3']) {
    const f = fixture(), input = f.edit();
    f.fail(failure);
    assert.throws(() => f.call('countSave', input), /injected/);
    if (failure === 'GiftAudit:append') assert.equal(f.list()[0].amount, '');
    f.call('countSave', input);
    assert.equal(f.list()[0].amount, 3600);
    assert.equal(f.tables.GiftAudit.data.length, 2);
    assert.equal(f.tables.GiftAudit.data[1][2], 'COUNT_APPLIED');
  }
});

test('新增例外寫入中斷時保留編號，重試後僅有一筆', () => {
  const f = fixture(), input = { state: '待核對', exceptionType: '名單外', notes: '等待署名' };
  f.fail('Gifts:append');
  assert.throws(() => f.call('countSave', input), /injected/);
  const second = f.call('countSave', { ...input, notes: '另一包' }, 'request-0002');
  assert.equal(second.record.envelopeCode, 'E002');
  const recovered = f.call('countSave', input);
  assert.equal(recovered.record.envelopeCode, 'E001');
  assert.equal(f.tables.Gifts.data.length, 4);
});

test('未完成寫入期間其他人不能清點同包；直接改表後也不強行回放', () => {
  const f = fixture(), input = f.edit();
  f.fail('Gifts:write');
  assert.throws(() => f.call('countSave', input));
  assert.throws(() => f.call('countSave', input, 'request-0002', 'other'), e => e.code === 'BUSY');
  f.tables.Gifts.data[1][5] = 999;
  assert.throws(() => f.call('countSave', input), e => e.code === 'RECOVERY_CONFLICT');
  assert.equal(f.tables.Gifts.data[1][5], 999);
});

test('重試舊的已完成操作不覆蓋後續更正，公式型署名視為文字', () => {
  const f = fixture(), input = { ...f.edit(), signature: '=SUM(A1)' };
  f.call('countSave', input);
  const change = { ...f.edit(), signature: '+姓名', reason: '署名修正', amount: '500' };
  f.call('countSave', change, 'request-0002');
  const replay = f.call('countSave', input);
  assert.equal(replay.record.amount, 500);
  assert.equal(replay.record.signature, '+姓名');
});

test('schema 升級只補空白尾欄，不覆蓋自訂欄，重跑安全', () => {
  const f = fixture(), sheet = f.tables.Gifts;
  sheet.data[0] = sheet.data[0].slice(0, 15);
  f.api.requireGiftSchema_({ getSheetByName: () => sheet }, 'Gifts', f.api.GIFT_HEADERS, true);
  assert.equal(sheet.data[0][15], '紅包編號');
  f.api.requireGiftSchema_({ getSheetByName: () => sheet }, 'Gifts', f.api.GIFT_HEADERS, true);
  sheet.data[0][15] = '自訂欄';
  assert.throws(() => f.api.requireGiftSchema_({ getSheetByName: () => sheet }, 'Gifts', f.api.GIFT_HEADERS, true), e => e.code === 'CONFIG_ERROR');
  assert.equal(sheet.data[0][15], '自訂欄');
});

test('已撤銷、非預期賓客與第二包誤用均不更動帳本', () => {
  const f = fixture(), input = f.edit();
  assert.throws(() => f.call('countSave', { ...input, guestId: 'other' }), e => e.code === 'BAD_REQUEST');
  assert.throws(() => f.call('countSave', { ...input, exceptionType: '多包' }), e => e.code === 'BAD_REQUEST');
  assert.throws(() => f.call('countSave', { state: '已清點', signature: '人', amount: 1, exceptionType: '多包', guestId: 'missing' }), e => e.code === 'BAD_REQUEST');
  f.tables.Gifts.data[1][4] = '已撤銷';
  assert.throws(() => f.call('countSave', input), e => e.code === 'CONFLICT');
  assert.equal(f.list().length, 0);
  assert.equal(f.tables.GiftAudit.data.length, 1);
});

test('已處理紀錄遭刪除時不能以審計快照冒充目前帳本成功', () => {
  const f = fixture(), input = f.edit();
  f.call('countSave', input);
  f.tables.Gifts.data.splice(1, 1);
  assert.throws(() => f.call('countSave', input), e => e.code === 'RECOVERY_CONFLICT');
});

test('多包狀態需全部完成才算已清點，清點待核對與收件撞單分開', () => {
  const f = fixture(), status = f.api.giftStatus_;
  assert.equal(status([{ state: '已清點' }, { state: '待清點' }]).giftState, '待清點');
  assert.equal(status([{ state: '已清點' }, { state: '待核對' }]).giftState, '清點待核對');
  assert.equal(status([{ state: '已清點' }, { state: '已清點' }]).giftState, '已清點');
});
