const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function model() {
  const window = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'docs', 'gift-queue.js'), 'utf8'), { window });
  return window.GiftQueueModel;
}

function input(overrides = {}) {
  return { requestId: 'request-1', guestId: 'g001', displayName: 'Tutu', tableNo: '5',
    operator: '工作人員', savedAt: 1000, ...overrides };
}

test('本機佇列保留收件關係與原操作人員，並阻止同賓客重複排入', () => {
  const queue = model();
  const first = queue.enqueue([], input());
  const duplicate = queue.enqueue(first.items, input({ requestId: 'request-2' }));

  assert.equal(first.ok, true);
  assert.equal(first.item.status, 'queued');
  assert.equal(first.item.operator, '工作人員');
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, 'DUPLICATE_LOCAL');
  assert.equal(duplicate.items.length, 1);
});

test('重新載入會把未確認的同步中紀錄改回可安全重試', () => {
  const queue = model();
  const recovered = queue.recover([{ ...input(), status: 'syncing', attempts: 1 }]);

  assert.equal(recovered[0].status, 'retry_wait');
  assert.match(recovered[0].lastError, /同一請求編號/);
  assert.equal(queue.nextSyncable(recovered).requestId, 'request-1');
});

test('撞單會持續阻止同賓客再次收件，直到人工在 Sheet 核對', () => {
  const queue = model();
  const attention = [{ ...input(), status: 'attention' }];
  const duplicate = queue.enqueue(attention, input({ requestId: 'request-2' }));

  assert.equal(queue.summary(attention).attention, 1);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.existing.status, 'attention');
});
