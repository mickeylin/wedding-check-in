const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

function fixture() {
  let records = [], serial = 0, failAfterWrite = false, locked = false, recordReads = 0;
  const ctx = {};
  vm.runInNewContext(['Code.gs', 'GiftRegister.gs', 'Reception.gs'].map(file => fs.readFileSync(file, 'utf8')).join('\n') +
    '\nthis.api = { createCakeModule_, cakeView_, guestRecordFromRow_ };', ctx);
  const group = { id: 'C1', name: '共領家庭', western: 1, chinese: 1 };
  const deps = { guest: id => ['G1', 'G2'].includes(id) ? { guestId: id, cakeGroupId: 'C1' } : null,
    groups: () => [group], records: () => { recordReads++; return records.map(row => ({ ...row })); },
    append(record) { assert.equal(locked, true); records.push({ ...record });
      if (failAfterWrite) { failAfterWrite = false; throw new Error('flush timeout'); } },
    uuid: () => 'issue-' + ++serial, now: () => '2026-10-29T00:00:00Z',
    lock: { runExclusive(fn) { assert.equal(locked, false); locked = true; try { return fn(); } finally { locked = false; } } } };
  const api = ctx.api.createCakeModule_(deps);
  const call = (action, data = {}, options = {}) => api.execute({ action, data, guestId: 'G1',
    requestId: 'request-0001', operator: '甲', ...options });
  return { call, group, records, reads: () => recordReads, parse: ctx.api.guestRecordFromRow_, fail: () => { failAfterWrite = true; } };
}

test('唯讀共領狀態只讀一次發放帳本，不重讀同一份資料', () => {
  const f = fixture();
  f.call('cakeStatus');
  assert.equal(f.reads(), 1);
});

test('不同QR共用喜餅配額，後到手機不能再領；單純查詢不發放', () => {
  const f = fixture();
  assert.equal(f.call('cakeStatus').cake.remaining.western, 1);
  assert.equal(f.records.length, 0);
  f.call('cakeIssue', { western: 1, chinese: 1 });
  assert.equal(f.call('cakeStatus', {}, { guestId: 'G2' }).cake.remaining.chinese, 0);
  assert.throws(() => f.call('cakeIssue', { western: 1, chinese: 0 }, { guestId: 'G2', requestId: 'request-0002' }), { code: 'ALREADY_ISSUED' });
  assert.equal(f.records.length, 1);
});

test('部分發放可後補，未知配額留白且不阻擋已知品項', () => {
  const f = fixture(); f.group.chinese = '';
  assert.equal(f.call('cakeStatus').cake.chinese, null);
  f.call('cakeIssue', { western: 1, chinese: 0 });
  assert.throws(() => f.call('cakeIssue', { western: 0, chinese: 1 }, { requestId: 'request-0002' }), { code: 'UNKNOWN_QUOTA' });
  f.group.chinese = 1;
  assert.equal(f.call('cakeIssue', { western: 0, chinese: 1 }, { requestId: 'request-0003' }).cake.remaining.chinese, 0);
});

test('寫入後逾時重試沿用同請求，不重複發放也不容許改操作者或數量', () => {
  const f = fixture(); f.fail();
  assert.throws(() => f.call('cakeIssue', { western: 1, chinese: 0 }), /flush timeout/);
  assert.equal(f.call('cakeIssue', { western: 1, chinese: 0 }).status, 'CAKE_REPLAY');
  assert.equal(f.records.length, 1);
  assert.throws(() => f.call('cakeIssue', { western: 1, chinese: 0 }, { operator: '乙' }), { code: 'REQUEST_REUSED' });
  assert.throws(() => f.call('cakeIssue', { western: 0, chinese: 1 }), { code: 'REQUEST_REUSED' });
});

test('更正需原因、僅撤銷指定發放一次，原紀錄留存且重試不影響後續發放', () => {
  const f = fixture(), first = f.call('cakeIssue', { western: 1, chinese: 0 });
  assert.throws(() => f.call('cakeCancel', { originalId: first.record.id }, { requestId: 'request-0002' }), { code: 'BAD_REQUEST' });
  const data = { originalId: first.record.id, reason: '誤登，尚未交付' };
  f.call('cakeCancel', data, { requestId: 'request-0002' });
  f.call('cakeIssue', { western: 1, chinese: 0 }, { requestId: 'request-0003', guestId: 'G2' });
  const replay = f.call('cakeCancel', data, { requestId: 'request-0002' });
  assert.equal(replay.status, 'CAKE_REPLAY'); assert.equal(replay.cake.remaining.western, 0);
  assert.equal(f.records.length, 3);
  assert.throws(() => f.call('cakeCancel', data, { requestId: 'request-0004' }), { code: 'ALREADY_CANCELLED' });
});

test('非法盒數、未知賓客及錯誤配額均拒絕，不以空白當零', () => {
  const f = fixture();
  for (const n of [-1, .5, '1', null]) assert.throws(() => f.call('cakeIssue', { western: n, chinese: 0 }), { code: 'BAD_REQUEST' });
  assert.throws(() => f.call('cakeStatus', {}, { guestId: 'missing' }), { code: 'NOT_FOUND' });
  f.group.western = '1'; assert.throws(() => f.call('cakeStatus'), { code: 'CONFIG_ERROR' });
  assert.equal(f.records.length, 0);
});

test('賓客接待欄位與舊五欄相容', () => {
  const f = fixture();
  const row = f.parse(['G1', '測試家庭', '親友', '3', '兒童椅', '同行甲、同行乙', 3, 'C1']);
  assert.equal(row.members, '同行甲、同行乙'); assert.equal(row.partySize, 3); assert.equal(row.cakeGroupId, 'C1');
  assert.equal(f.parse(['G2', '舊賓客', '', '', '']).cakeGroupId, '');
});
