const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const context = {};
vm.runInNewContext(fs.readFileSync('docs/count-queue.js', 'utf8'), context);
const model = context.CountQueueModel;
const input = (requestId, receiptId = 'receipt-1') => ({ requestId, operator: '甲', apiUrl: 'https://example.test/exec',
  label: 'g001', data: { receiptId, version: 'v1', signature: '測試', amount: '3600', state: '已清點' } });

test('清點佇列防止同一包重複排入，但允許其他包繼續', () => {
  const first = model.enqueue([], input('request-1'));
  assert.equal(first.ok, true);
  assert.equal(model.enqueue(first.items, input('request-2')).reason, 'DUPLICATE_LOCAL');
  assert.equal(model.enqueue(first.items, input('request-3', 'receipt-2')).ok, true);
});

test('重整後同步中改為可安全重試，保留同一請求與清點內容', () => {
  const queued = model.enqueue([], input('request-1')).items;
  const syncing = model.update(queued, 'request-1', { status: 'syncing', attempts: 1 });
  const recovered = model.recover(syncing);
  assert.equal(recovered[0].status, 'retry_wait');
  assert.equal(recovered[0].requestId, 'request-1');
  assert.equal(recovered[0].data.amount, '3600');
});
