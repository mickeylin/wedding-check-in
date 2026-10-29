const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');
function fixture() {
  const ctx = {}, reads = {}, tables = {};
  vm.runInNewContext(['Code.gs', 'GiftRegister.gs', 'Reception.gs'].map(file => fs.readFileSync(file, 'utf8')).join('\n') +
    '\nthis.api={createCakeSnapshot_,createGiftSnapshot_,handleCakeApi_,CAKE_GROUP_HEADERS,CAKE_LOG_HEADERS,GUEST_HEADERS,GIFT_HEADERS};', ctx);
  const sheet = (name, data) => {
    tables[name] = { data, getName: () => name, getLastRow: () => data.length,
      getRange(r, c, h, w) { return { getValues() {
        reads[name] = (reads[name] || 0) + 1;
        return Array.from({ length: h }, (_, y) => Array.from({ length: w }, (_, x) => data[r - 1 + y]?.[c - 1 + x] ?? ''));
      } }; }, getDataRange() { return this.getRange(1, 1, data.length, Math.max(...data.map(row => row.length))); } };
  };
  const api = ctx.api;
  sheet('CakeGroups', [Array.from(api.CAKE_GROUP_HEADERS), ['C1', '共領家庭', 1, 1], ['C2', '另一家庭', 1, '']]);
  sheet('CakeLog', [Array.from(api.CAKE_LOG_HEADERS), ['issue', 'C1', 'G1', '發放', 1, 0, '甲', '2026-10-29', 'request-0001', '', '']]);
  sheet('Guests', [Array.from(api.GUEST_HEADERS).concat(['同行姓名', '人數', '喜餅共領ID']), ['G1', '測試家庭', '親友', '3', '', '同行甲', 2, 'C1']]);
  sheet('Gifts', [Array.from(api.GIFT_HEADERS)]);
  const ss = { getSheetByName: name => tables[name] };
  return { ctx, api, ss, reads, tables };
}
test('全場共領快照每張表只讀一次，不為各接待卡重複讀表', () => {
  const f = fixture(), snapshot = f.api.createCakeSnapshot_(f.ss);
  assert.equal(snapshot.length, 2); assert.equal(snapshot[0].remaining.western, 0);
  assert.equal(snapshot[1].remaining.chinese, null);
  assert.deepEqual(f.reads, { CakeGroups: 1, CakeLog: 1 });
});
test('登入賓客快照同時帶回共領快照；喜餅表出錯不阻止紅包接待登入', () => {
  const f = fixture();
  assert.equal(f.api.createGiftSnapshot_(f.ss).cakeSnapshot.length, 2);
  f.tables.CakeGroups.data[0][0] = 'wrong';
  const snapshot = f.api.createGiftSnapshot_(f.ss);
  assert.equal(snapshot.guests.length, 1); assert.equal(snapshot.cakeSnapshotUnavailable, true);
  assert.equal(snapshot.cakeSnapshot, undefined);
});
test('狀態API重用登入索引，不讀Guests；配額及發放帳本各讀一次', () => {
  const f = fixture();
  f.ctx.getSpreadsheet_ = () => f.ss;
  f.ctx.verifySessionToken_ = () => ({ operator: '甲' });
  f.ctx.findCachedGiftGuest_ = () => ({ guestId: 'G1', cakeGroupId: 'C1' });
  const result = f.api.handleCakeApi_({ action: 'cakeStatus', guestId: 'G1' }, new Date());
  assert.equal(result.cake.remaining.western, 0); assert.equal(typeof result.serverMs, 'number');
  assert.deepEqual(f.reads, { CakeGroups: 1, CakeLog: 1 });
});
